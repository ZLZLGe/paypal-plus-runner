import { curlRequest } from "./curl-transport.js";

export function extractIp(text) {
  const match = String(text || "").match(/(?<!\d)(?:\d{1,3}\.){3}\d{1,3}(?!\d)/);
  return match ? match[0] : "";
}

export function detectCountryCode(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  try {
    const data = JSON.parse(raw);
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
    // Plain-text probes are handled below.
  }
  const match = raw.match(/["'\s:=,](JP)["'\s,}]/i);
  return match ? "JP" : "";
}

export async function lookupCountryCodeForIp(ip, {
  proxyUrl = "",
  timeoutMs = 15000,
  connectTimeoutMs = 8000,
} = {}) {
  const targetIp = extractIp(ip);
  if (!targetIp) return "";
  const urls = [
    `http://ip-api.com/json/${targetIp}?fields=status,countryCode,query`,
    `https://api.country.is/${targetIp}`,
  ];
  for (const url of urls) {
    try {
      const response = await curlRequest({
        url,
        proxyUrl,
        timeoutMs,
        connectTimeoutMs,
        headers: { Accept: "application/json,text/plain,*/*" },
      });
      if (response.status < 200 || response.status >= 400) continue;
      const code = detectCountryCode(response.text);
      if (code) return code;
    } catch {
      // Try the next public geo endpoint.
    }
  }
  return "";
}
