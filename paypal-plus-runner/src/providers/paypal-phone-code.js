import { sleep } from "../utils/sleep.js";

function normalizeIgnoreCodes(ignoreCodes = []) {
  const items = ignoreCodes instanceof Set ? [...ignoreCodes] : ignoreCodes;
  return new Set((Array.isArray(items) ? items : []).map((item) => String(item).trim()).filter(Boolean));
}

export function extractSmsCodes(text, { allowVariableLength = true, ignoreCodes = [] } = {}) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const ignored = normalizeIgnoreCodes(ignoreCodes);
  const found = [];
  const seen = new Set();
  const collect = (pattern) => {
    for (const match of normalized.matchAll(pattern)) {
      const code = String(match[1] || "").trim();
      if (!code || ignored.has(code) || seen.has(code)) continue;
      seen.add(code);
      found.push(code);
    }
  };
  collect(/(?<!\d)(\d{6})(?!\d)/g);
  if (allowVariableLength) {
    collect(/(?<!\d)(\d{4,8})(?!\d)/g);
  }
  return found;
}

export function extractSmsCode(text, { allowVariableLength = true, ignoreCodes = [] } = {}) {
  return extractSmsCodes(text, { allowVariableLength, ignoreCodes })[0] || "";
}

export function extractPaypalSmsCodesFromResponse(body, { ignoreCodes = [], allowVariableLength = false } = {}) {
  const parsed = parseSmsBody(body);
  const codes = [];
  const seen = new Set();
  for (const candidate of [parsed.payload, body]) {
    for (const code of extractSmsCodes(candidate, { allowVariableLength, ignoreCodes })) {
      if (seen.has(code)) continue;
      seen.add(code);
      codes.push(code);
    }
  }
  return codes;
}

async function notifyMaybe(callback, ...args) {
  if (typeof callback !== "function") return;
  await callback(...args);
}

async function resolveIgnoreCodes(options = {}, staticIgnoreCodes = []) {
  const dynamic = typeof options.getIgnoreCodes === "function"
    ? await options.getIgnoreCodes()
    : [];
  return normalizeIgnoreCodes([
    ...(staticIgnoreCodes instanceof Set ? [...staticIgnoreCodes] : staticIgnoreCodes),
    ...(dynamic instanceof Set ? [...dynamic] : (Array.isArray(dynamic) ? dynamic : [])),
  ]);
}

function buildSmsFetchUrl(smsUrl) {
  return smsUrl.includes("?") ? `${smsUrl}&t=${Date.now()}` : `${smsUrl}?t=${Date.now()}`;
}

async function requestSmsUrl(smsUrl, requestTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(buildSmsFetchUrl(smsUrl), {
      headers: { Accept: "application/json,text/plain,*/*" },
      signal: controller.signal,
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchPaypalSmsSnapshot(phoneLease, options = {}) {
  const smsUrl = String(phoneLease?.sms_url || "").trim();
  if (!smsUrl) throw new Error("paypal phone sms_url is empty");
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs ?? 15000));
  const result = await requestSmsUrl(smsUrl, requestTimeoutMs);
  return {
    ...result,
    codes: result.ok ? extractPaypalSmsCodesFromResponse(result.body, { allowVariableLength: false }) : [],
  };
}

export function extractPaypalSmsCodeFromResponse(body, { ignoreCodes = [], allowVariableLength = false } = {}) {
  return extractPaypalSmsCodesFromResponse(body, { ignoreCodes, allowVariableLength })[0] || "";
}

export async function fetchPaypalSmsCode(phoneLease, options = {}) {
  const smsUrl = String(phoneLease?.sms_url || "").trim();
  if (!smsUrl) throw new Error("paypal phone sms_url is empty");
  const initialDelayMs = Number(options.initialDelayMs ?? 10000);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs ?? 3000));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 180000));
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs ?? 15000));
  const staticIgnoreCodes = options.ignoreCodes || [];
  const allowVariableLength = options.allowVariableLength === true;

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  const startedAt = Date.now();
  let lastResponse = "";
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await requestSmsUrl(smsUrl, requestTimeoutMs);
      lastResponse = result.body;
      if (!result.ok) {
        await sleep(pollIntervalMs);
        continue;
      }
      const ignoreCodes = await resolveIgnoreCodes(options, staticIgnoreCodes);
      const codes = extractPaypalSmsCodesFromResponse(lastResponse, { allowVariableLength });
      const ignoredCodes = codes.filter((code) => ignoreCodes.has(code));
      if (ignoredCodes.length) {
        await notifyMaybe(options.onCodesIgnored, ignoredCodes, { response: lastResponse, codes, ignoreCodes });
      }
      const code = codes.find((item) => !ignoreCodes.has(item));
      if (code) {
        await notifyMaybe(options.onCodeAccepted, code, { response: lastResponse, codes, ignoreCodes });
        return code;
      }
    } catch (error) {
      lastResponse = `request_error=${error.message}`;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`paypal phone otp timeout for ${phoneLease.phone}, last_response=${lastResponse.slice(0, 160)}`);
}

export function parseSmsBody(body) {
  let text = String(body || "").trim();
  if (!text) return { state: "no", payload: "" };
  if (text.startsWith("\"") && text.endsWith("\"")) {
    try {
      const decoded = JSON.parse(text);
      if (typeof decoded === "string") text = decoded.trim();
    } catch {
      text = text.slice(1, -1).trim();
    }
  }
  if (!text) return { state: "no", payload: "" };
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const payloads = items
        .filter((item) => item && typeof item === "object")
        .flatMap((item) => [
          item.SmsCode,
          item.smsCode,
          item.code,
          item.SmsContent,
          item.smsContent,
          item.content,
          item.message,
        ])
        .map((value) => String(value || "").trim())
        .filter(Boolean);
      if (payloads.length) {
        return { state: "yes", payload: payloads.join(" ") };
      }
    } catch {
      // Fall through to text formats below.
    }
  }
  const lower = text.toLowerCase();
  if (lower.startsWith("yes")) {
    for (const sep of ["|", "丨"]) {
      if (text.includes(sep)) {
        return { state: "yes", payload: text.split(sep).slice(1).join(sep).trim() };
      }
    }
    return { state: "yes", payload: text.slice(3).trim() };
  }
  if (lower.startsWith("no") || lower.startsWith("wait") || lower.startsWith("err")) {
    return { state: "no", payload: text };
  }
  return { state: "unknown", payload: text };
}
