import { sleep } from "../utils/sleep.js";

export function extractSmsCode(text, { allowVariableLength = true } = {}) {
  const normalized = String(text || "").replace(/\s+/g, " ");
  const six = normalized.match(/(?<!\d)(\d{6})(?!\d)/);
  if (six) return six[1];
  if (allowVariableLength) {
    const variable = normalized.match(/(?<!\d)(\d{4,8})(?!\d)/);
    if (variable) return variable[1];
  }
  return "";
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

export async function fetchPaypalSmsCode(phoneLease, options = {}) {
  const smsUrl = String(phoneLease?.sms_url || "").trim();
  if (!smsUrl) throw new Error("paypal phone sms_url is empty");
  const initialDelayMs = Number(options.initialDelayMs ?? 10000);
  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs ?? 3000));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 180000));
  const requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs ?? 15000));
  const ignoreCodes = new Set((options.ignoreCodes || []).map((item) => String(item).trim()).filter(Boolean));

  if (initialDelayMs > 0) {
    await sleep(initialDelayMs);
  }

  const startedAt = Date.now();
  let lastResponse = "";
  while (Date.now() - startedAt < timeoutMs) {
    const url = smsUrl.includes("?") ? `${smsUrl}&t=${Date.now()}` : `${smsUrl}?t=${Date.now()}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const response = await fetch(url, {
        headers: { Accept: "application/json,text/plain,*/*" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastResponse = await response.text();
      if (!response.ok) {
        await sleep(pollIntervalMs);
        continue;
      }
      const { state, payload } = parseSmsBody(lastResponse);
      if (state === "yes") {
        const code = extractSmsCode(payload);
        if (code && !ignoreCodes.has(code)) return code;
      }
    } catch (error) {
      lastResponse = `request_error=${error.message}`;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`paypal phone otp timeout for ${phoneLease.phone}, last_response=${lastResponse.slice(0, 160)}`);
}
