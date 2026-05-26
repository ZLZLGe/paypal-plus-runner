export const DEFAULT_ASN_POOLS = {
  US: ["AS7922", "AS20057", "AS20115", "AS22773", "AS7018", "AS21928", "AS6167", "AS5650"],
  JP: ["AS9605", "AS17676", "AS2516", "AS138384", "AS4713", "AS2518", "AS2527", "AS17511"],
};

export function normalizeAsn(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return `AS${raw}`;
  return raw;
}

export function normalizeAsnPools(rawPools = {}) {
  const pools = structuredClone(DEFAULT_ASN_POOLS);
  if (!rawPools || typeof rawPools !== "object") return pools;
  for (const [regionRaw, valuesRaw] of Object.entries(rawPools)) {
    const region = String(regionRaw || "").trim().toUpperCase();
    const values = Array.isArray(valuesRaw) ? valuesRaw : [valuesRaw];
    const normalized = values.map(normalizeAsn).filter(Boolean);
    if (region && normalized.length) pools[region] = normalized;
  }
  return pools;
}

export function extractRegionFromTemplate(template, defaultRegion = "JP") {
  const match = String(template || "").match(/(?:^|[-_])region-([A-Za-z]{2}(?:_[A-Za-z]{2})*)/);
  if (!match) return String(defaultRegion || "JP").toUpperCase();
  return String(match[1]).split("_")[0].toUpperCase();
}

export function chooseAsnForTemplate(template, rawPools = {}, defaultRegion = "JP") {
  const region = extractRegionFromTemplate(template, defaultRegion);
  if (!String(template || "").includes("{ASN}")) return { asn: "", region };
  const pools = normalizeAsnPools(rawPools);
  const candidates = pools[region] || pools[defaultRegion] || [];
  if (!candidates.length) throw new Error(`asn pool is empty for region=${region}`);
  return { asn: candidates[Math.floor(Math.random() * candidates.length)], region };
}

export function renderProxyTemplate(template, { sid, asn = "" }) {
  let value = String(template || "").trim();
  if (value.includes("{SID}")) value = value.replaceAll("{SID}", String(sid || "").trim());
  if (value.includes("{ASN}")) {
    const normalized = normalizeAsn(asn);
    if (!normalized) throw new Error("proxy template contains {ASN}, but asn is empty");
    value = value.replaceAll("{ASN}", normalized);
  }
  return value;
}
