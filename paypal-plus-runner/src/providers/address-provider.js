const MEIGUODIZHI_COUNTRY_CONFIG = {
  AR: { path: "/ar-address", city: "Buenos Aires", aliases: ["AR", "ARGENTINA"] },
  AU: { path: "/au-address", city: "Sydney", aliases: ["AU", "AUS", "AUSTRALIA"] },
  CA: { path: "/ca-address", city: "Toronto", aliases: ["CA", "CANADA"] },
  CN: { path: "/cn-address", city: "Shanghai", aliases: ["CN", "CHINA"] },
  DE: { path: "/de-address", city: "Berlin", aliases: ["DE", "DEU", "GERMANY", "DEUTSCHLAND"] },
  ES: { path: "/es-address", city: "Madrid", aliases: ["ES", "ESP", "SPAIN"] },
  FR: { path: "/fr-address", city: "Paris", aliases: ["FR", "FRA", "FRANCE"] },
  GB: { path: "/uk-address", city: "London", aliases: ["GB", "UK", "UNITED KINGDOM", "BRITAIN", "ENGLAND"] },
  HK: { path: "/hk-address", city: "Hong Kong", aliases: ["HK", "HONG KONG"] },
  ID: { path: "/id-address", city: "Jakarta", aliases: ["ID", "INDONESIA"] },
  IT: { path: "/it-address", city: "Rome", aliases: ["IT", "ITA", "ITALY"] },
  JP: { path: "/jp-address", city: "Tokyo", aliases: ["JP", "JPN", "JAPAN"] },
  KR: { path: "/kr-address", city: "Seoul", aliases: ["KR", "KOR", "KOREA", "SOUTH KOREA"] },
  MY: { path: "/my-address", city: "Kuala Lumpur", aliases: ["MY", "MALAYSIA"] },
  NL: { path: "/nl-address", city: "Amsterdam", aliases: ["NL", "NETHERLANDS", "HOLLAND"] },
  PH: { path: "/ph-address", city: "Manila", aliases: ["PH", "PHILIPPINES"] },
  RU: { path: "/ru-address", city: "Moscow", aliases: ["RU", "RUSSIA"] },
  SG: { path: "/sg-address", city: "Singapore", aliases: ["SG", "SINGAPORE"] },
  TH: { path: "/th-address", city: "Bangkok", aliases: ["TH", "THAILAND"] },
  TR: { path: "/tr-address", city: "Istanbul", aliases: ["TR", "TURKEY", "TURKIYE"] },
  TW: { path: "/tw-address", city: "Taipei", aliases: ["TW", "TAIWAN"] },
  US: { path: "/", city: "New York", aliases: ["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA", "AMERICA"] },
  VN: { path: "/vn-address", city: "Ho Chi Minh City", aliases: ["VN", "VIETNAM"] },
};

function normalizeText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function resolveCountryCode(value = "", fallback = "US") {
  const normalized = normalizeText(value || fallback).toUpperCase();
  if (!normalized) return String(fallback || "US").toUpperCase();
  if (MEIGUODIZHI_COUNTRY_CONFIG[normalized]) return normalized;
  const matched = Object.entries(MEIGUODIZHI_COUNTRY_CONFIG).find(([, config]) => (
    config.aliases.some((alias) => alias.toUpperCase() === normalized)
  ));
  return matched ? matched[0] : normalized;
}

function normalizePostalCode(countryCode, rawPostalCode = "", fallbackPostalCode = "") {
  const normalizedCountry = resolveCountryCode(countryCode, "US");
  const postalCode = normalizeText(rawPostalCode);
  const fallback = normalizeText(fallbackPostalCode);
  if (normalizedCountry === "US") {
    return (postalCode || fallback || "10001").slice(0, 5);
  }
  return postalCode || fallback || (normalizedCountry === "JP" ? "1000004" : "10001");
}

function extractJapanesePrefecture(raw = {}) {
  const stateFull = normalizeText(raw.State_Full);
  if (stateFull) return stateFull;
  const translated = normalizeText(raw.Trans_Address);
  if (translated.includes(",")) {
    const parts = translated.split(",").map((part) => normalizeText(part)).filter(Boolean);
    const last = parts.at(-1);
    if (last) return last;
  }
  return "";
}

export function normalizeAddress(raw = {}, fallback = {}) {
  const fb = fallback || {};
  const countryCode = resolveCountryCode(raw.countryCode || fb.countryCode || "US");
  const street = normalizeText(raw.Trans_Address || raw.Address || raw.street || fb.street || "123 Main St");
  const city = normalizeText(raw.City || raw.city || fb.city || "New York");
  const state = countryCode === "JP"
    ? normalizeText(extractJapanesePrefecture(raw) || fb.state || raw.State || raw.state || "Tokyo")
    : normalizeText(raw.State_Full || raw.State || raw.state || fb.state || "New York");
  return {
    street,
    city,
    state,
    zip: normalizePostalCode(countryCode, raw.Zip_Code || raw.zip || raw.postalCode, fb.zip),
    countryCode,
  };
}

function resolveMeiguodizhiRequest(profile = {}, fallback = {}) {
  const countryCode = resolveCountryCode(profile.countryCode || profile.hostedAddressCountryCode || fallback.countryCode || "US");
  const countryConfig = MEIGUODIZHI_COUNTRY_CONFIG[countryCode] || MEIGUODIZHI_COUNTRY_CONFIG.US;
  const configuredPath = normalizeText(profile.hostedAddressPath);
  const path = configuredPath && (configuredPath !== "/" || countryCode === "US")
    ? configuredPath
    : countryConfig.path;
  return {
    countryCode,
    path,
    city: normalizeText(profile.hostedAddressCity || countryConfig.city || fallback.city),
    method: normalizeText(profile.hostedAddressMethod || "refresh"),
  };
}

export async function fetchHostedAddress(config = {}, { fetchImpl = fetch } = {}) {
  const profile = config.checkoutProfile || {};
  const fallback = profile.fallbackAddress || {};
  const endpoint = String(profile.addressEndpoint || "").trim();
  if (!endpoint || profile.addressProvider === "fallback") {
    return { ...normalizeAddress({}, fallback), source: "fallback" };
  }
  const request = resolveMeiguodizhiRequest(profile, fallback);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        city: request.city,
        path: request.path,
        method: request.method,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    if (data?.status && data.status !== "ok") {
      throw new Error(data.message || data.status);
    }
    return {
      ...normalizeAddress({ ...(data?.address || data || {}), countryCode: request.countryCode }, fallback),
      source: `meiguodizhi:${request.countryCode}`,
    };
  } catch (error) {
    return { ...normalizeAddress({}, fallback), source: "fallback", warning: error.message };
  }
}
