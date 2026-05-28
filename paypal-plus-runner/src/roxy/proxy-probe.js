import { curlRequest } from "../checkout-conversion/curl-transport.js";

export function extractIpFromText(text) {
  const value = String(text || "").trim();
  try {
    const json = JSON.parse(value);
    for (const key of ["ip", "query", "origin"]) {
      const candidate = String(json?.[key] || "").split(",")[0].trim();
      if (candidate) return { ip: candidate, raw: json };
    }
  } catch {
    // Fall through to regex extraction.
  }
  const match = value.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return { ip: match?.[0] || "", raw: value.slice(0, 1000) };
}

export async function probeIp({ proxyUrl = "", probeUrl = "https://api.ipify.org?format=json", timeoutMs = 20000 } = {}) {
  if (proxyUrl) {
    const probeUrls = [
      probeUrl,
      "http://api.ipify.org?format=json",
      "http://ip-api.com/json?fields=status,countryCode,query",
      "https://api.country.is/",
    ].filter(Boolean);
    const proxyUrls = String(proxyUrl).startsWith("socks5://")
      ? [String(proxyUrl).replace(/^socks5:\/\//, "socks5h://"), proxyUrl]
      : [proxyUrl];
    let lastError = "";
    for (const candidateProxyUrl of proxyUrls) {
      for (const candidateUrl of probeUrls) {
        try {
          const response = await curlRequest({
            url: candidateUrl,
            proxyUrl: candidateProxyUrl,
            timeoutMs,
            connectTimeoutMs: Math.min(timeoutMs, 15000),
            headers: { Accept: "application/json,text/plain,*/*" },
          });
          const parsed = extractIpFromText(response.text);
          if (response.status >= 200 && response.status < 400 && parsed.ip) {
            return {
              ok: true,
              status: response.status,
              ip: parsed.ip,
              raw: parsed.raw,
              proxyUrl: candidateProxyUrl,
              remoteIp: response.remoteIp || "",
              probeUrl: candidateUrl,
            };
          }
          lastError = `probe HTTP ${response.status} from ${candidateUrl}`;
        } catch (error) {
          lastError = error.message;
        }
      }
    }
    return { ok: false, ip: "", proxyUrl, error: lastError || "proxy probe failed" };
  }
  const response = await fetch(probeUrl, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const parsed = extractIpFromText(text);
  return { ok: Boolean(parsed.ip), ip: parsed.ip, raw: parsed.raw, proxyUrl };
}

export async function probeWindowExitIp(page, { probeUrl = "https://api.ipify.org?format=json", timeoutMs = 20000 } = {}) {
  let result;
  try {
    result = await page.evaluate(async ({ url, timeout }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch(url, {
          cache: "no-store",
          headers: { Accept: "application/json,text/plain,*/*" },
          signal: controller.signal,
        });
        return { ok: response.ok, status: response.status, text: await response.text() };
      } finally {
        clearTimeout(timer);
      }
    }, { url: probeUrl, timeout: timeoutMs });
  } catch (error) {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    result = await page.evaluate(() => ({
      ok: true,
      status: 200,
      text: String(document.body?.innerText || document.documentElement?.innerText || ""),
    })).catch(() => ({ ok: false, status: 0, text: "", error: error.message }));
  }
  const parsed = extractIpFromText(result.text);
  return { ok: Boolean(result.ok && parsed.ip), status: result.status, ip: parsed.ip, raw: parsed.raw, error: result.error || "" };
}
