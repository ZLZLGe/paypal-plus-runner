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

function normalizeCardNumber(value = "") {
  return String(value || "").replace(/\D+/g, "");
}

function normalizeCardExpiry(value = "") {
  const raw = normalizeText(value);
  const match = raw.match(/^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/);
  if (!match) return raw;
  const month = String(Number.parseInt(match[1], 10)).padStart(2, "0");
  const year = match[2].length === 4 ? match[2].slice(-2) : match[2];
  return `${month} / ${year}`;
}

function normalizeDateOfBirth(value = "") {
  const raw = normalizeText(value);
  const match = raw.match(/(\d{1,4})\D+(\d{1,2})\D+(\d{1,4})/);
  if (!match) return "";
  const first = Number.parseInt(match[1], 10);
  const second = Number.parseInt(match[2], 10);
  const third = Number.parseInt(match[3], 10);
  const hasFullYear = match[1].length === 4 || match[3].length === 4;
  if (!hasFullYear) return "";
  const year = match[1].length === 4 ? first : third;
  const month = match[1].length === 4 ? second : first;
  const day = match[1].length === 4 ? third : second;
  if (year < 1900 || year > 2008 || month < 1 || month > 12 || day < 1 || day > 31) {
    return "";
  }
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${String(year).padStart(4, "0")}`;
}

function splitFullName(fullName = "") {
  const normalized = normalizeText(fullName);
  if (!normalized) return { firstName: "", lastName: "", fullName: "" };
  const parts = normalized.split(" ").filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: parts[0], fullName: normalized };
  }
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1),
    fullName: normalized,
  };
}

function isJapaneseKana(value = "") {
  return /^[\u3040-\u30ffー\s]+$/.test(normalizeText(value));
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

function normalizeProviderProfile(raw = {}, fallback = {}) {
  const fullName = normalizeText(
    raw.Full_Name
      || raw.fullName
      || raw.name
      || fallback.fullName
      || "",
  );
  const nameParts = splitFullName(fullName);
  const cardNumber = normalizeCardNumber(raw.Credit_Card_Number || raw.cardNumber || fallback.cardNumber);
  const birthdayRaw = normalizeText(raw.Birthday || raw.birthday || raw.dateOfBirth || fallback.birthday || fallback.dateOfBirth);
  const dateOfBirth = normalizeDateOfBirth(birthdayRaw);
  return {
    fullName: nameParts.fullName,
    firstName: nameParts.firstName,
    lastName: nameParts.lastName,
    kanaFirstName: normalizeText(raw.Kana_First_Name || raw.KanaFirstName || raw.kanaFirstName || fallback.kanaFirstName)
      || (isJapaneseKana(nameParts.firstName) ? nameParts.firstName : ""),
    kanaLastName: normalizeText(raw.Kana_Last_Name || raw.KanaLastName || raw.kanaLastName || fallback.kanaLastName)
      || (isJapaneseKana(nameParts.lastName) ? nameParts.lastName : ""),
    title: normalizeText(raw.Title || raw.title || fallback.title),
    phone: normalizeText(raw.Telephone || raw.phone || fallback.phone),
    email: normalizeText(raw.Temporary_mail || raw.email || fallback.email),
    username: normalizeText(raw.Username || raw.username || fallback.username),
    password: normalizeText(raw.Password || raw.password || fallback.password),
    birthday: birthdayRaw,
    dateOfBirth,
    card: {
      number: cardNumber,
      expiry: normalizeCardExpiry(raw.Expires || raw.cardExpiry || fallback.cardExpiry),
      cvv: normalizeText(raw.CVV2 || raw.cvv || fallback.cvv),
      type: normalizeText(raw.Credit_Card_Type || raw.cardType || fallback.cardType),
      last4: cardNumber.slice(-4),
    },
  };
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
    providerProfile: normalizeProviderProfile(raw, fb.providerProfile || {}),
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
