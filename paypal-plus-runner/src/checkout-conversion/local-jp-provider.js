import crypto from "node:crypto";
import path from "node:path";
import { randomSid } from "../utils/ids.js";
import { chooseAsnForTemplate, renderProxyTemplate } from "../roxy/proxy-asn.js";
import { buildCheckoutHeaders, buildCheckoutPayload } from "./checkout-api.js";
import { normalizeCheckoutResult } from "./result-normalizer.js";
import { curlRequest } from "./curl-transport.js";
import { curlCffiRequest } from "./curl-cffi-transport.js";
import { startGostChain, stopGostChain } from "./gost-chain.js";
import { detectCountryCode, extractIp, lookupCountryCodeForIp } from "./geo-probe.js";
import { isHostedCheckoutUrl, isStripeHostedCheckoutUrl } from "./hosted-url.js";
import { sleep } from "../utils/sleep.js";

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

function summarizeCheckoutPayload(payload = {}) {
  return {
    entryPoint: String(payload.entry_point || ""),
    planName: String(payload.plan_name || ""),
    checkoutUiMode: String(payload.checkout_ui_mode || ""),
    billingCountry: String(payload.billing_details?.country || ""),
    billingCurrency: String(payload.billing_details?.currency || ""),
    promoCampaignId: String(payload.promo_campaign?.promo_campaign_id || ""),
    isCouponFromQueryParam: payload.promo_campaign?.is_coupon_from_query_param ?? null,
  };
}

function diagnosticValue(pathName, value) {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const text = String(value);
  if (/token|secret|session|client|url|key/i.test(pathName) && !/promo_campaign_id$/i.test(pathName)) {
    return "[present]";
  }
  return text.length > 160 ? `${text.slice(0, 160)}...[truncated]` : text;
}

function collectPromoDiagnostics(payload, { maxItems = 20 } = {}) {
  const diagnostics = [];
  const stack = [{ value: payload, path: "" }];
  const seen = new Set();
  while (stack.length && diagnostics.length < maxItems) {
    const { value, path: pathName } = stack.shift();
    if (!value || typeof value !== "object") continue;
    if (seen.has(value)) continue;
    seen.add(value);
    for (const [key, item] of Object.entries(value)) {
      const nextPath = pathName ? `${pathName}.${key}` : key;
      if (/promo|coupon|discount|trial|free/i.test(nextPath) && (item === null || typeof item !== "object")) {
        diagnostics.push({ path: nextPath, value: diagnosticValue(nextPath, item) });
      }
      if (item && typeof item === "object") stack.push({ value: item, path: nextPath });
    }
  }
  return diagnostics;
}

function summarizeCheckoutApiResponse(response = {}, data = {}) {
  return {
    status: Number(response.status || 0),
    ok: Number(response.status || 0) >= 200 && Number(response.status || 0) < 400,
    alreadyPaid: isAlreadyPaidResponse(data),
    checkoutSessionPresent: Boolean(data.checkout_session_id || data.checkoutSessionId),
    publishableKeyPresent: Boolean(data.publishable_key || data.publishableKey),
    hostedUrlPresent: Boolean(findHostedCheckoutUrl(data)),
    responseKeys: Object.keys(data || {}).slice(0, 20),
    promoDiagnostics: collectPromoDiagnostics(data),
  };
}

function summarizeStripeInitResponse(response = {}, data = {}) {
  return {
    status: Number(response.status || 0),
    ok: Number(response.status || 0) >= 200 && Number(response.status || 0) < 400,
    hostedUrlPresent: Boolean(data.stripe_hosted_url || findHostedCheckoutUrl(data)),
    responseKeys: Object.keys(data || {}).slice(0, 20),
    promoDiagnostics: collectPromoDiagnostics(data),
  };
}

function isAlreadyPaidResponse(data = {}) {
  return /user is already paid/i.test(String(data.detail || data.message || ""));
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

function requireLocalJpHostedUrl(value) {
  const hostedUrl = String(value || "").trim();
  if (!isHostedCheckoutUrl(hostedUrl)) {
    throw new Error("local JP checkout did not generate a hosted long checkout URL");
  }
  return hostedUrl;
}

function requireLocalJpStripeHostedUrl(value) {
  const hostedUrl = String(value || "").trim();
  if (!isStripeHostedCheckoutUrl(hostedUrl)) {
    throw new Error("local JP checkout did not generate a Stripe hosted long checkout URL");
  }
  return hostedUrl;
}

export function isRetryableLocalJpError(error) {
  const message = String(error?.message || "");
  return /checkout JP proxy probe failed|did not detect JP exit|blocked by Cloudflare|local JP checkout did not generate (?:a |a Stripe )?hosted long checkout URL|stripe init failed HTTP (?:408|429|5\d\d)|curl(?:_cffi)? failed|SSL_ERROR|SSL_connect|ERR_SSL|connection to .*:443|connection reset|connection refused|timed out|timeout|proxy connect|CONNECT tunnel/i
    .test(message);
}

function markTerminalAccountError(error) {
  error.retryable = false;
  return error;
}

function markRetryableExternalError(error) {
  error.retryable = true;
  return error;
}

function localJpAttempts(local = {}) {
  const configured = local.proxyRetryAttempts ?? local.maxProxyAttempts ?? 5;
  const attempts = Number.parseInt(String(configured), 10);
  return Number.isFinite(attempts) && attempts > 0 ? attempts : 5;
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
  fields.set("elements_options_client[saved_payment_method][enable_save]", "never");
  fields.set("elements_options_client[saved_payment_method][enable_redisplay]", "never");
  fields.set("key", publishableKey);
  fields.set("_stripe_version", "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1");
  return fields.toString();
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
  let countryCode = detectCountryCode(response.text);
  const exitIp = extractIp(response.text) || response.remoteIp || "";
  if (!countryCode && exitIp) {
    countryCode = await lookupCountryCodeForIp(exitIp, {
      timeoutMs: Number(local.geoLookupTimeoutMs || 15000),
      connectTimeoutMs: Number(local.connectTimeoutMs || 8000),
    });
  }
  return {
    ok: response.status >= 200 && response.status < 400,
    status: response.status,
    body: response.text.slice(0, 1200),
    countryCode,
    exitIp,
  };
}

async function createStripeHostedCheckoutUrl({ checkoutSessionId, publishableKey, proxyUrl, local, logger = null }) {
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
  logger?.info?.("stripe hosted checkout init response summary", summarizeStripeInitResponse(response, stripeData));
  if (response.status >= 400) {
    const message = stripeData?.error?.message || stripeData.message || stripeData.detail || "stripe init failed";
    throw new Error(`stripe init failed HTTP ${response.status}: ${message}`);
  }
  return {
    hostedCheckoutUrl: String(stripeData.stripe_hosted_url || findHostedCheckoutUrl(stripeData) || ""),
    stripeData,
  };
}

function resolvePathFromCwd(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return path.isAbsolute(raw) ? raw : path.resolve(raw);
}

async function checkoutApiRequest({ proxyUrl, local, accessToken, impersonate }) {
  const payload = buildCheckoutPayload(local.checkoutPayloadConfig || {});
  const common = {
    url: CHECKOUT_URL,
    method: "POST",
    proxyUrl,
    timeoutMs: Number(local.requestTimeoutMs || 45000),
    headers: buildCheckoutHeaders(accessToken),
    body: JSON.stringify(payload),
  };
  if (String(local.checkoutTransport || "curl").trim() === "curl_cffi") {
    return curlCffiRequest({
      ...common,
      pythonExecutable: resolvePathFromCwd(local.pythonExecutable || ".venv/bin/python"),
      scriptPath: resolvePathFromCwd(local.curlCffiScriptPath || "scripts/curl_cffi_request.py"),
      impersonate,
    });
  }
  return curlRequest({
    ...common,
    connectTimeoutMs: Number(local.connectTimeoutMs || 15000),
  });
}

async function createCheckoutResponse({ accessToken, conversion, local, proxyUrl, logger = null }) {
  const requestLocal = {
    ...local,
    checkoutPayloadConfig: conversion,
  };
  logger?.info?.("checkout request payload summary", summarizeCheckoutPayload(buildCheckoutPayload(conversion)));
  const primaryImpersonate = String(local.impersonateBrowser || "chrome136").trim();
  const fallbackImpersonate = String(local.fallbackImpersonateBrowser || "chrome133a").trim();
  let response = await checkoutApiRequest({
    proxyUrl,
    local: requestLocal,
    accessToken,
    impersonate: primaryImpersonate,
  });
  if (
    looksLikeCloudflare(response.text)
    && String(local.checkoutTransport || "curl").trim() === "curl_cffi"
    && fallbackImpersonate
    && fallbackImpersonate !== primaryImpersonate
  ) {
    logger?.warn?.("checkout response looked like Cloudflare; retrying with fallback browser impersonation", {
      primaryImpersonate,
      fallbackImpersonate,
    });
    response = await checkoutApiRequest({
      proxyUrl,
      local: requestLocal,
      accessToken,
      impersonate: fallbackImpersonate,
    });
  }
  return response;
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

async function createLocalJpCheckoutAttempt({ accessToken, config, logger = null }) {
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

    const checkoutResponse = await createCheckoutResponse({
      accessToken,
      conversion,
      local,
      proxyUrl: proxy.proxyUrl,
      logger,
    });
    if (looksLikeCloudflare(checkoutResponse.text)) {
      throw new Error("checkout upstream blocked by Cloudflare challenge");
    }

    const checkoutData = parseResponseJson(checkoutResponse.text);
    logger?.info?.("checkout response summary", summarizeCheckoutApiResponse(checkoutResponse, checkoutData));
    if (checkoutResponse.status >= 400 && !isAlreadyPaidResponse(checkoutData)) {
      throw new Error(`local jp checkout failed HTTP ${checkoutResponse.status}: ${JSON.stringify(checkoutData).slice(0, 1000)}`);
    }
    if (isAlreadyPaidResponse(checkoutData)) {
      return normalizeCheckoutResult({
        ...checkoutData,
        alreadyPaid: true,
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
      }, "local_jp_proxy");
    }

    const checkoutSessionId = String(checkoutData.checkout_session_id || checkoutData.checkoutSessionId || "");
    const publishableKey = String(checkoutData.publishable_key || checkoutData.publishableKey || "");
    const openaiHostedCheckoutUrl = findHostedCheckoutUrl(checkoutData);
    const preferStripeHostedUrl = local.preferStripeHostedUrl !== false;
    const shouldInitStripe = local.createStripeHostedUrl !== false
      && checkoutSessionId
      && publishableKey
      && (preferStripeHostedUrl || !openaiHostedCheckoutUrl);
    const stripe = shouldInitStripe
      ? await createStripeHostedCheckoutUrl({ checkoutSessionId, publishableKey, proxyUrl: proxy.proxyUrl, local, logger })
      : { hostedCheckoutUrl: "", stripeData: {} };
    const stripeHostedCheckoutUrl = String(stripe.hostedCheckoutUrl || "").trim();
    const requireStripeHostedUrl = conversion.requireStripeHostedUrl !== false;
    const hostedCheckoutUrl = requireStripeHostedUrl
      ? requireLocalJpStripeHostedUrl(stripeHostedCheckoutUrl)
      : requireLocalJpHostedUrl(stripeHostedCheckoutUrl || openaiHostedCheckoutUrl);

    return normalizeCheckoutResult({
      ...checkoutData,
      checkoutSessionId,
      checkoutUrl: checkoutSessionId ? `https://chatgpt.com/checkout/openai_ie/${checkoutSessionId}` : "",
      chatgptCheckoutUrl: checkoutSessionId ? `https://chatgpt.com/checkout/${conversion.processorEntity || "openai_llc"}/${checkoutSessionId}` : "",
      hostedCheckoutUrl,
      stripeHostedCheckoutUrl,
      openaiHostedCheckoutUrl,
      preferredCheckoutUrl: hostedCheckoutUrl,
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

export async function createLocalJpCheckout({ accessToken, config, logger = null }) {
  const local = config.checkoutConversion?.localJpProxy || {};
  const attempts = localJpAttempts(local);
  const retryDelayMs = Number(local.proxyRetryDelayMs || 1000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const checkout = await createLocalJpCheckoutAttempt({ accessToken, config, logger });
      checkout.proxyAttempt = attempt;
      return checkout;
    } catch (error) {
      lastError = error;
      if (!isRetryableLocalJpError(error) || attempt >= attempts) {
        if (attempt >= attempts && isRetryableLocalJpError(error)) {
          const wrapped = new Error(`local JP checkout failed after ${attempts} proxy attempts: ${error.message}`);
          wrapped.cause = error;
          throw markRetryableExternalError(wrapped);
        }
        throw markTerminalAccountError(error);
      }
      await sleep(retryDelayMs);
    }
  }

  if (lastError && isRetryableLocalJpError(lastError)) {
    throw markRetryableExternalError(lastError);
  }
  throw markTerminalAccountError(lastError || new Error("local JP checkout failed"));
}
