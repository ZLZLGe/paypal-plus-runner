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
    return {
      ok: false,
      ip: "",
      proxyUrl,
      error: "proxy probing is disabled in node fetch; use curl or browser context for proxied probes",
    };
  }
  const response = await fetch(probeUrl, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  const parsed = extractIpFromText(text);
  return { ok: Boolean(parsed.ip), ip: parsed.ip, raw: parsed.raw, proxyUrl };
}

export async function probeWindowExitIp(page, { probeUrl = "https://api.ipify.org?format=json", timeoutMs = 20000 } = {}) {
  const result = await page.evaluate(async ({ url, timeout }) => {
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
  const parsed = extractIpFromText(result.text);
  return { ok: Boolean(result.ok && parsed.ip), status: result.status, ip: parsed.ip, raw: parsed.raw };
}
