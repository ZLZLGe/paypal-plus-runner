import { normalizeCheckoutResult } from "./result-normalizer.js";

export async function createCloudCheckout({ accessToken, config }) {
  const conversion = config.checkoutConversion || {};
  const cloud = conversion.cloud || {};
  const apiUrl = String(cloud.apiUrl || "").trim();
  if (!apiUrl) throw new Error("checkoutConversion.cloud.apiUrl is empty");
  const headers = {
    Accept: "application/json",
    "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
    "Content-Type": "application/json",
  };
  const useFreeTrialPromo = conversion.useFreeTrialPromo !== false;
  if (cloud.apiKey) headers["X-API-Key"] = String(cloud.apiKey);
  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({
      accessToken,
      paymentMethod: conversion.paymentMethod || "paypal",
      country: conversion.country || "US",
      currency: conversion.currency || "USD",
      processorEntity: conversion.processorEntity || "openai_llc",
      useFreeTrialPromo,
      promoCampaignId: useFreeTrialPromo ? "plus-1-month-free" : "",
    }),
    signal: AbortSignal.timeout(Number(cloud.timeoutMs || 45000)),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text };
  }
  if (!response.ok && !/user is already paid/i.test(String(data.detail || data.message || ""))) {
    throw new Error(`cloud checkout failed HTTP ${response.status}: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return normalizeCheckoutResult(data, "cloud");
}
