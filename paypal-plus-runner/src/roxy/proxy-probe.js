export async function probeIp({ proxyUrl = "", probeUrl = "https://api.ipify.org?format=json" } = {}) {
  const response = await fetch(probeUrl, { signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return { ok: true, ip: String(json.ip || json.query || ""), raw: json };
  } catch {
    const match = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
    return { ok: Boolean(match), ip: match?.[0] || "", raw: text.slice(0, 1000), proxyUrl };
  }
}
