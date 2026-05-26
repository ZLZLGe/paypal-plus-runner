import crypto from "node:crypto";
import { randomSid } from "../utils/ids.js";
import { chooseAsnForTemplate, renderProxyTemplate } from "../roxy/proxy-asn.js";
import { buildCheckoutHeaders, buildCheckoutPayload } from "./checkout-api.js";
import { normalizeCheckoutResult } from "./result-normalizer.js";
import { curlRequest } from "./curl-transport.js";
import { startGostChain, stopGostChain } from "./gost-chain.js";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";
const PAY_OPENAI_URL_PATTERN = /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\/c\/pay\//i;

function looksLikeCloudflare(text) {
  const lowered = String(text || "").toLowerCase();
  return lowered.includes("_cf_chl_opt")
    || lowered.includes("enable javascript and cookies to continue")
    || lowered.includes("cf-chl");
}

function parseResponseJson(text) {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" ? parsed : { data: parsed };
  } catch {
    return { detail: text || "upstream returned non-json response" };
  }
}

function findHostedCheckoutUrl(payload) {
  const stack = [payload];
  while (stack.length) {
    const current = stack.shift();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!current || typeof current !== "object") continue;
    for (const value of Object.values(current)) {
      if (typeof value === "string" && PAY_OPENAI_URL_PATTERN.test(value.trim())) {
        return value.trim();
      }
      if (value && typeof value === "object") stack.push(value);
    }
  }
  return "";
}

function buildStripePayload(publishableKey) {
  const fields = new URLSearchParams();
  fields.set("browser_locale", "zh-CN");
  fields.set("browser_timezone", "Asia/Shanghai");
  fields.set("elements_session_client[client_betas][0]", "custom_checkout_server_updates_1");
  fields.set("elements_session_client[client_betas][1]", "custom_checkout_manual_approval_1");
  fields.set("elements_session_client[elements_init_source]", "custom_checkout");
  fields.set("elements_session_client[referrer_host]", "chatgpt.com");
  fields.set("elements_session_client[stripe_js_id]", crypto.randomUUID());
  fields.set("elements_session_client[locale]", "zh-CN");
  fields.set("elements_session_client[is_aggregation_expected]", "false");
  fields.set("elements_options_client[stripe_js_locale]", "auto");
  fields.set("elements_options_client[saved_payment_method][enable_save]", "never");
  fields.set("elements_options_client[saved_payment_method][enable_redisplay]", "never");
  fields.set("key", publishableKey);
  fields.set("_stripe_version", "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1");
  return fields.toString();
}

function detectCountryCode(probeText) {
  const text = String(probeText || "").trim();
  if (!text) return "";
  try {
    const data = JSON.parse(text);
    const candidates = [
      data.countryCode,
      data.country_code,
      data.country_code2,
      data.country,
      data.iso_code,
      data.location?.country_code,
      data.location?.countryCode,
    ];
    const found = candidates.find((item) => /^[A-Za-z]{2}$/.test(String(item || "").trim()));
    if (found) return String(found).trim().toUpperCase();
  } catch {
    // Some probe services return plain text; fall back to a conservative regex.
  }
  const match = text.match(/["'\s:=,](JP)["'\s,}]/i);
  return match ? "JP" : "";
}

function normalizeProxyUrl(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(proxy)) return `http://${proxy}`;
  if (!/^(https?|socks4a?|socks5h?):\/\//i.test(proxy)) {
    throw new Error(`unsupported proxy URL scheme: ${proxy}`);
  }
  return proxy;
}

async function probeProxy({ proxyUrl, local }) {
  const response = await curlRequest({
    url: String(local.probeUrl || "https://iplark.com/ipapi/public/ip"),
    method: "GET",
    proxyUrl,
    timeoutMs: Number(local.probeTimeoutMs || local.requestTimeoutMs || 45000),
    connectTimeoutMs: Number(local.connectTimeoutMs || 15000),
    headers: { Accept: "application/json,text/plain,*/*" },
  });
  const countryCode = detectCountryCode(response.text);
  return {
    ok: response.status >= 200 && response.status < 400,
    status: response.status,
    body: response.text.slice(0, 1200),
    countryCode,
    exitIp: response.remoteIp || "",
  };
}

async function createStripeHostedCheckoutUrl({ checkoutSessionId, publishableKey, proxyUrl, local }) {
  if (!checkoutSessionId || !publishableKey) return { hostedCheckoutUrl: "", stripeData: {} };
  const response = await curlRequest({
    url: `https://api.stripe.com/v1/payment_pages/${checkoutSessionId}/init`,
    method: "POST",
    proxyUrl,
    timeoutMs: Number(local.stripeInitTimeoutMs || local.requestTimeoutMs || 45000),
    connectTimeoutMs: Number(local.connectTimeoutMs || 15000),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    },
    body: buildStripePayload(publishableKey),
  });
  const stripeData = parseResponseJson(response.text);
  if (response.status >= 400) {
    const message = stripeData?.error?.message || stripeData.message || stripeData.detail || "stripe init failed";
    throw new Error(`stripe init failed HTTP ${response.status}: ${message}`);
  }
  return {
    hostedCheckoutUrl: String(stripeData.stripe_hosted_url || findHostedCheckoutUrl(stripeData) || ""),
    stripeData,
  };
}

async function resolveCheckoutProxy({ local, sid, renderedSecondHop }) {
  const mode = String(local.mode || "direct_proxy_url").trim();
  if (mode === "direct_proxy_url") {
    return {
      mode,
      proxyUrl: normalizeProxyUrl(renderedSecondHop),
      chain: null,
      gost: {},
    };
  }
  if (mode === "gost_chain") {
    const chain = await startGostChain({
      firstHopProxyUrl: local.firstHopProxyUrl,
      secondHopProxyUrl: renderedSecondHop,
      sid,
      localHost: local.localHost || "127.0.0.1",
      localPort: Number(local.localPort || 0),
      startupTimeoutMs: Number(local.gostStartupTimeoutMs || 8000),
      portRetryAttempts: Number(local.gostPortRetryAttempts || 5),
      executable: local.gostExecutable || "",
    });
    return {
      mode,
      proxyUrl: chain.proxyUrl,
      chain,
      gost: {
        gostPid: chain.pid,
        gostLogPath: chain.logPath,
        firstHopProxyUrl: chain.firstHop,
        secondHopProxyUrl: chain.secondHop,
      },
    };
  }
  throw new Error(`unsupported checkoutConversion.localJpProxy.mode: ${mode}`);
}

export async function createLocalJpCheckout({ accessToken, config }) {
  const conversion = config.checkoutConversion || {};
  const local = conversion.localJpProxy || {};
  const secondHop = String(local.secondHopProxyUrl || "").trim();
  if (!secondHop) throw new Error("checkoutConversion.localJpProxy.secondHopProxyUrl is empty");
  const sid = randomSid();
  const { asn, region } = chooseAsnForTemplate(secondHop, local.asnPools, "JP");
  const renderedSecondHop = renderProxyTemplate(secondHop, { sid, asn });
  const proxy = await resolveCheckoutProxy({ local, sid, renderedSecondHop });

  try {
    let probe = { ok: false, status: 0, body: "", countryCode: "", exitIp: "" };
    if (local.runProbe !== false) {
      probe = await probeProxy({ proxyUrl: proxy.proxyUrl, local });
      if (!probe.ok) throw new Error(`checkout JP proxy probe failed HTTP ${probe.status}: ${probe.body.slice(0, 300)}`);
      if (local.requireJpExit !== false && probe.countryCode !== "JP") {
        throw new Error(`checkout JP proxy probe did not detect JP exit: country=${probe.countryCode || "unknown"} body=${probe.body.slice(0, 300)}`);
      }
    }

    const checkoutResponse = await curlRequest({
      url: CHECKOUT_URL,
      method: "POST",
      proxyUrl: proxy.proxyUrl,
      timeoutMs: Number(local.requestTimeoutMs || 45000),
      connectTimeoutMs: Number(local.connectTimeoutMs || 15000),
      headers: buildCheckoutHeaders(accessToken),
      body: JSON.stringify(buildCheckoutPayload(conversion)),
    });
    if (looksLikeCloudflare(checkoutResponse.text)) {
      throw new Error("checkout upstream blocked by Cloudflare challenge");
    }

    const checkoutData = parseResponseJson(checkoutResponse.text);
    if (checkoutResponse.status >= 400 && !/user is already paid/i.test(String(checkoutData.detail || checkoutData.message || ""))) {
      throw new Error(`local jp checkout failed HTTP ${checkoutResponse.status}: ${JSON.stringify(checkoutData).slice(0, 1000)}`);
    }

    const checkoutSessionId = String(checkoutData.checkout_session_id || checkoutData.checkoutSessionId || "");
    const publishableKey = String(checkoutData.publishable_key || checkoutData.publishableKey || "");
    const shouldInitStripe = local.createStripeHostedUrl !== false && !findHostedCheckoutUrl(checkoutData);
    const stripe = shouldInitStripe
      ? await createStripeHostedCheckoutUrl({ checkoutSessionId, publishableKey, proxyUrl: proxy.proxyUrl, local })
      : { hostedCheckoutUrl: findHostedCheckoutUrl(checkoutData), stripeData: {} };

    return normalizeCheckoutResult({
      ...checkoutData,
      checkoutSessionId,
      checkoutUrl: checkoutSessionId ? `https://chatgpt.com/checkout/openai_ie/${checkoutSessionId}` : "",
      chatgptCheckoutUrl: checkoutSessionId ? `https://chatgpt.com/checkout/${conversion.processorEntity || "openai_llc"}/${checkoutSessionId}` : "",
      hostedCheckoutUrl: stripe.hostedCheckoutUrl || findHostedCheckoutUrl(checkoutData),
      preferredCheckoutUrl: stripe.hostedCheckoutUrl || findHostedCheckoutUrl(checkoutData) || "",
      country: conversion.country || "US",
      currency: conversion.currency || "USD",
      processorEntity: conversion.processorEntity || "openai_llc",
      sid,
      asn,
      exitRegion: region,
      exitIp: probe.exitIp,
      proxyUrl: proxy.proxyUrl,
      checkoutProxyMode: proxy.mode,
      probe,
      ...proxy.gost,
      stripe: stripe.stripeData,
    }, "local_jp_proxy");
  } finally {
    if (proxy.chain) await stopGostChain(proxy.chain);
  }
}
