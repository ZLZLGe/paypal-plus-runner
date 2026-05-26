import { randomSid } from "../utils/ids.js";
import { chooseAsnForTemplate, renderProxyTemplate } from "../roxy/proxy-asn.js";
import { buildCheckoutHeaders, buildCheckoutPayload } from "./checkout-api.js";
import { normalizeCheckoutResult } from "./result-normalizer.js";

const CHECKOUT_URL = "https://chatgpt.com/backend-api/payments/checkout";

function looksLikeCloudflare(text) {
  const lowered = String(text || "").toLowerCase();
  return lowered.includes("_cf_chl_opt") || lowered.includes("enable javascript and cookies to continue") || lowered.includes("cf-chl");
}

export async function createLocalJpCheckout({ accessToken, config }) {
  const conversion = config.checkoutConversion || {};
  const local = conversion.localJpProxy || {};
  const secondHop = String(local.secondHopProxyUrl || "").trim();
  if (!secondHop) throw new Error("checkoutConversion.localJpProxy.secondHopProxyUrl is empty");
  const sid = randomSid();
  const { asn, region } = chooseAsnForTemplate(secondHop, local.asnPools, "JP");
  const proxyUrl = renderProxyTemplate(secondHop, { sid, asn });

  // Node fetch does not natively support HTTP/SOCKS proxy. This provider currently
  // renders and records the JP proxy URL; actual proxied transport is wired in the
  // browser/HTTP adapter step.
  if (local.mode !== "direct_proxy_url") {
    throw new Error("local_jp_proxy mode requires transport adapter; set mode=direct_proxy_url for scaffold dry-runs");
  }

  const response = await fetch(CHECKOUT_URL, {
    method: "POST",
    headers: buildCheckoutHeaders(accessToken),
    body: JSON.stringify(buildCheckoutPayload(conversion)),
    signal: AbortSignal.timeout(Number(local.requestTimeoutMs || 45000)),
  });
  const text = await response.text();
  if (looksLikeCloudflare(text)) {
    throw new Error("checkout upstream blocked by Cloudflare challenge");
  }
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!response.ok && !/user is already paid/i.test(String(data.detail || data.message || ""))) {
    throw new Error(`local jp checkout failed HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  const sessionId = String(data.checkout_session_id || "");
  return normalizeCheckoutResult({
    ...data,
    checkoutSessionId: sessionId,
    checkoutUrl: sessionId ? `https://chatgpt.com/checkout/openai_ie/${sessionId}` : "",
    chatgptCheckoutUrl: sessionId ? `https://chatgpt.com/checkout/${conversion.processorEntity || "openai_llc"}/${sessionId}` : "",
    preferredCheckoutUrl: data.hostedCheckoutUrl || data.checkoutUrl || "",
    country: conversion.country || "US",
    currency: conversion.currency || "USD",
    processorEntity: conversion.processorEntity || "openai_llc",
    sid,
    asn,
    exitRegion: region,
    proxyUrl,
  }, "local_jp_proxy");
}
