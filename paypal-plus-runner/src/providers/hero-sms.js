import { sleep } from "../utils/sleep.js";

export const HERO_SMS_PROVIDER_ID = "hero-sms";
export const HERO_SMS_DEFAULT_BASE_URL = "https://hero-sms.com/stubs/handler_api.php";
export const HERO_SMS_DEFAULT_SERVICE_CODE = "dr";
export const HERO_SMS_DEFAULT_COUNTRY_ID = 16;
export const HERO_SMS_DEFAULT_COUNTRY_LABEL = "United Kingdom";
export const HERO_SMS_DEFAULT_COUNTRY_POOL = [
  { id: 16, label: "United Kingdom" },
  { id: 151, label: "Chile" },
  { id: 33, label: "Colombia" },
  { id: 73, label: "Brazil" },
];

function normalizeSource(settings = {}) {
  return settings?.openaiPhone && typeof settings.openaiPhone === "object"
    ? settings.openaiPhone
    : settings;
}

function normalizeBaseUrl(value = "") {
  const raw = String(value || "").trim() || HERO_SMS_DEFAULT_BASE_URL;
  try {
    return new URL(raw).toString();
  } catch {
    return HERO_SMS_DEFAULT_BASE_URL;
  }
}

function normalizeCountryId(value, fallback = HERO_SMS_DEFAULT_COUNTRY_ID) {
  const parsed = Math.floor(Number(value));
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  const fallbackParsed = Math.floor(Number(fallback));
  return Number.isFinite(fallbackParsed) && fallbackParsed > 0
    ? fallbackParsed
    : HERO_SMS_DEFAULT_COUNTRY_ID;
}

function normalizeCountryLabel(value = "", fallback = HERO_SMS_DEFAULT_COUNTRY_LABEL) {
  return String(value || "").trim() || fallback;
}

function normalizeCountryPool(value, fallback = []) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[,;\n]+/);
  const entries = source.map((item) => {
    if (item && typeof item === "object") {
      const id = normalizeCountryId(item.id ?? item.countryId, 0);
      if (!id) return null;
      return {
        id,
        label: normalizeCountryLabel(item.label || item.countryLabel || item.name || "", String(id)),
      };
    }
    const text = String(item || "").trim();
    if (!text) return null;
    const [idText, ...labelParts] = text.split(/[:=|]/);
    const id = normalizeCountryId(idText, 0);
    if (!id) return null;
    return {
      id,
      label: normalizeCountryLabel(labelParts.join(":").trim(), String(id)),
    };
  }).filter(Boolean);
  const resolved = entries.length ? entries : fallback;
  const seen = new Set();
  return resolved.filter((entry) => {
    if (!entry?.id || seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  });
}

function normalizeServiceCode(value = "", fallback = HERO_SMS_DEFAULT_SERVICE_CODE) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  if (normalized) return normalized;
  const fallbackNormalized = String(fallback || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
  return fallbackNormalized || HERO_SMS_DEFAULT_SERVICE_CODE;
}

function normalizePhoneNumber(value = "") {
  let digits = String(value || "").trim().replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("+")) return digits;
  digits = digits.replace(/\D+/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  return digits ? `+${digits}` : "";
}

function normalizePhoneDigits(value = "") {
  return String(value || "").replace(/\D+/g, "");
}

function normalizePrice(value = "") {
  const text = String(value ?? "").trim();
  if (!text) return "";
  const match = text.match(/\d+(?:[.,]\d+)?/);
  if (!match) return "";
  const numeric = Number(String(match[0]).replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return "";
  return String(Math.round(numeric * 10000) / 10000);
}

function normalizePriceNumber(value) {
  const normalized = normalizePrice(value);
  if (!normalized) return null;
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric * 10000) / 10000 : null;
}

function parsePayload(text = "") {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function describeHeroSmsPayload(payload) {
  if (typeof payload === "string") return payload.trim();
  if (payload && typeof payload === "object") {
    const direct = String(payload.message || payload.msg || payload.error || payload.title || payload.status || "").trim();
    if (direct) return direct;
    try {
      return JSON.stringify(payload);
    } catch {
      return String(payload);
    }
  }
  return String(payload || "").trim();
}

function resolveHeroSmsConfig(settings = {}, deps = {}) {
  const source = normalizeSource(settings);
  const configuredMaxPriceNumber = normalizePriceNumber(source.heroSmsMaxPrice || source.maxPrice);
  const cappedMaxPrice = configuredMaxPriceNumber === null
    ? 0.07
    : Math.min(configuredMaxPriceNumber, 0.07);
  return {
    apiKey: String(source.heroSmsApiKey || source.apiKey || "").trim(),
    baseUrl: normalizeBaseUrl(source.heroSmsBaseUrl || source.baseUrl),
    countryId: normalizeCountryId(source.heroSmsCountryId ?? source.countryId),
    countryLabel: normalizeCountryLabel(source.heroSmsCountryLabel || source.countryLabel),
    serviceCode: normalizeServiceCode(source.heroSmsServiceCode || source.serviceCode),
    minPrice: normalizePrice(source.heroSmsMinPrice || source.minPrice),
    maxPrice: String(cappedMaxPrice),
    countryPool: normalizeCountryPool(source.heroSmsCountryPool || source.countryPool, HERO_SMS_DEFAULT_COUNTRY_POOL),
    requestTimeoutMs: Math.max(1000, Number(source.requestTimeoutMs || deps.requestTimeoutMs || 15000)),
    numberRequestAttempts: Math.max(1, Math.floor(Number(source.heroSmsNumberRequestAttempts || source.numberRequestAttempts || 1))),
    numberRequestRetryDelayMs: Math.max(0, Math.floor(Number(source.heroSmsNumberRequestRetryDelayMs || source.numberRequestRetryDelayMs || 5000))),
    fetchImpl: deps.fetchImpl || globalThis.fetch?.bind(globalThis),
  };
}

function buildHeroSmsUrl(config, query = {}) {
  const url = new URL(config.baseUrl);
  url.searchParams.set("api_key", config.apiKey);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchHeroSmsPayload(settings = {}, query = {}, actionLabel = "HeroSMS request", deps = {}) {
  const config = resolveHeroSmsConfig(settings, deps);
  if (!config.apiKey) {
    throw new Error("HeroSMS API Key 缺失：请在 openaiPhone.heroSmsApiKey 中配置。");
  }
  if (!config.fetchImpl) {
    throw new Error("HeroSMS 网络请求实现不可用。");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await config.fetchImpl(buildHeroSmsUrl(config, query), {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json,text/plain,*/*" },
    });
    const text = await response.text();
    const payload = parsePayload(text);
    if (!response.ok) {
      const error = new Error(`${actionLabel}失败：${describeHeroSmsPayload(payload) || response.status}`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${actionLabel}超时。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isTerminalPayload(payloadOrMessage) {
  const text = describeHeroSmsPayload(payloadOrMessage);
  return /BAD_KEY|WRONG_KEY|BAD_ACTION|BAD_SERVICE|BAD_COUNTRY|NO_BALANCE|BANNED|ACCOUNT_BANNED|INVALID/i.test(text);
}

function isNoNumbersPayload(payloadOrMessage) {
  const text = describeHeroSmsPayload(payloadOrMessage);
  return /NO_NUMBERS|NO_BALANCE_FORWARD|no\s+numbers|not\s+found|empty|no\s+free\s+phones|numbers?\s+not\s+found/i.test(text);
}

export function parseHeroSmsActivation(payload, fallback = {}) {
  const activationFallback = {
    provider: HERO_SMS_PROVIDER_ID,
    serviceCode: normalizeServiceCode(fallback.serviceCode),
    countryId: normalizeCountryId(fallback.countryId),
    countryLabel: normalizeCountryLabel(fallback.countryLabel),
  };
  const statusAction = String(fallback.statusAction || "").trim();

  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const activationId = String(payload.activationId ?? payload.id ?? payload.activation ?? "").trim();
    const phoneNumber = normalizePhoneNumber(payload.phoneNumber ?? payload.number ?? payload.phone ?? "");
    if (activationId && phoneNumber) {
      return {
        ...activationFallback,
        activationId,
        phoneNumber,
        ...(statusAction ? { statusAction } : {}),
      };
    }
  }

  const text = describeHeroSmsPayload(payload);
  const match = text.match(/^ACCESS_NUMBER:([^:]+):(.+)$/i);
  if (!match) return null;
  const activationId = String(match[1] || "").trim();
  const phoneNumber = normalizePhoneNumber(match[2] || "");
  if (!activationId || !phoneNumber) return null;
  return {
    ...activationFallback,
    activationId,
    phoneNumber,
    ...(statusAction ? { statusAction } : {}),
  };
}

function collectHeroSmsActivations(payload, fallback = {}, entries = []) {
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectHeroSmsActivations(item, fallback, entries));
    return entries;
  }
  if (!payload || typeof payload !== "object") return entries;

  const activation = parseHeroSmsActivation(payload, fallback);
  if (activation) entries.push(activation);
  for (const value of Object.values(payload)) {
    if (value && typeof value === "object") {
      collectHeroSmsActivations(value, fallback, entries);
    }
  }
  return entries;
}

export function extractHeroSmsCode(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/\b(\d{4,8})\b/);
  return match?.[1] || "";
}

function extractCodeFromStatus(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return extractHeroSmsCode(payload.sms?.code)
      || extractHeroSmsCode(payload.call?.code)
      || extractHeroSmsCode(payload.code)
      || "";
  }
  const text = describeHeroSmsPayload(payload);
  const okMatch = text.match(/^STATUS_OK:(.+)$/i);
  return okMatch ? extractHeroSmsCode(okMatch[1]) : "";
}

export async function fetchHeroSmsBalance(settings = {}, deps = {}) {
  const payload = await fetchHeroSmsPayload(settings, { action: "getBalance" }, "HeroSMS getBalance", deps);
  const balance = Number(String(describeHeroSmsPayload(payload)).replace(/^ACCESS_BALANCE:/i, "").trim());
  return { balance, raw: payload };
}

export async function fetchHeroSmsPrices(settings = {}, deps = {}) {
  const config = resolveHeroSmsConfig(settings, deps);
  return fetchHeroSmsPayload(settings, {
    action: "getPrices",
    service: config.serviceCode,
    country: config.countryId,
  }, "HeroSMS getPrices", deps);
}

export async function fetchHeroSmsActiveActivations(settings = {}, deps = {}) {
  const config = resolveHeroSmsConfig(settings, deps);
  const payload = await fetchHeroSmsPayload(settings, {
    action: "getActiveActivations",
  }, "HeroSMS getActiveActivations", deps);
  return collectHeroSmsActivations(payload, {
    serviceCode: config.serviceCode,
    countryId: config.countryId,
    countryLabel: config.countryLabel,
    statusAction: "getStatus",
  });
}

export async function recoverHeroSmsActivationByPhone(settings = {}, phoneNumber = "", deps = {}) {
  const targetDigits = normalizePhoneDigits(phoneNumber);
  if (!targetDigits) return null;
  const activations = await fetchHeroSmsActiveActivations(settings, deps);
  return activations.find((activation) => {
    const currentDigits = normalizePhoneDigits(activation.phoneNumber);
    return currentDigits && (currentDigits.endsWith(targetDigits) || targetDigits.endsWith(currentDigits));
  }) || null;
}

function collectHeroSmsPriceEntries(payload, entries = []) {
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectHeroSmsPriceEntries(item, entries));
    return entries;
  }
  if (!payload || typeof payload !== "object") return entries;

  const directCost = normalizePriceNumber(payload.cost ?? payload.price);
  const directCount = Number(payload.physicalCount ?? payload.count ?? payload.stock ?? payload.available ?? payload.qty);
  if (directCost !== null) {
    entries.push({
      price: directCost,
      count: Number.isFinite(directCount) ? Math.max(0, directCount) : 1,
    });
  }

  for (const [key, value] of Object.entries(payload)) {
    const keyedPrice = normalizePriceNumber(key);
    if (keyedPrice !== null) {
      const count = Number(value?.physicalCount ?? value?.count ?? value);
      entries.push({
        price: keyedPrice,
        count: Number.isFinite(count) ? Math.max(0, count) : 1,
      });
    }
    collectHeroSmsPriceEntries(value, entries);
  }
  return entries;
}

async function resolveHeroSmsPriceCandidates(settings = {}, config = resolveHeroSmsConfig(settings), deps = {}) {
  const minLimit = normalizePriceNumber(config.minPrice);
  const maxLimit = normalizePriceNumber(config.maxPrice);
  const candidates = [];
  const push = (value) => {
    const price = normalizePriceNumber(value);
    if (price === null) return;
    if (minLimit !== null && price < minLimit) return;
    if (maxLimit !== null && price > maxLimit) return;
    candidates.push(price);
  };

  try {
    const pricesPayload = await fetchHeroSmsPrices(settings, deps);
    collectHeroSmsPriceEntries(pricesPayload)
      .filter((entry) => entry.count > 0)
      .sort((left, right) => left.price - right.price)
      .forEach((entry) => push(entry.price));
  } catch {
    // Price lookup is best effort; the explicit configured cap still applies below.
  }
  if (maxLimit !== null) push(maxLimit);
  return Array.from(new Set(candidates)).sort((left, right) => left - right);
}

async function resolveHeroSmsCountryPriceCandidates(settings = {}, config = resolveHeroSmsConfig(settings), deps = {}) {
  const minLimit = normalizePriceNumber(config.minPrice);
  const maxLimit = normalizePriceNumber(config.maxPrice) ?? 0.07;
  const rows = [];
  const failures = [];

  for (const country of config.countryPool) {
    try {
      const pricesPayload = await fetchHeroSmsPrices({
        ...settings,
        openaiPhone: {
          ...(settings.openaiPhone || {}),
          heroSmsCountryId: country.id,
          heroSmsCountryLabel: country.label,
        },
      }, deps);
      collectHeroSmsPriceEntries(pricesPayload)
        .filter((entry) => entry.count > 0)
        .forEach((entry) => {
          const price = normalizePriceNumber(entry.price);
          if (price === null) return;
          if (minLimit !== null && price < minLimit) return;
          if (price > maxLimit) return;
          rows.push({
            countryId: country.id,
            countryLabel: country.label,
            price,
            count: entry.count,
          });
        });
    } catch (error) {
      failures.push(`${country.label}:${error.message}`);
    }
  }

  const seen = new Set();
  const candidates = rows
    .sort((left, right) => left.price - right.price || right.count - left.count || left.countryId - right.countryId)
    .filter((row) => {
      const key = `${row.countryId}:${row.price}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  if (!candidates.length) {
    const reason = failures.length ? `；价格查询失败：${failures.join(" | ")}` : "";
    throw new Error(`HeroSMS 无可用 ${config.serviceCode} 号码：目标国家在 <=${maxLimit} 价格内无库存${reason}`);
  }
  return candidates;
}

export async function requestHeroSmsActivation(settings = {}, deps = {}) {
  const config = resolveHeroSmsConfig(settings, deps);
  const actions = ["getNumberV2", "getNumber"];
  const failures = [];

  for (let requestAttempt = 1; requestAttempt <= config.numberRequestAttempts; requestAttempt += 1) {
    const priceAttempts = await resolveHeroSmsCountryPriceCandidates(settings, config, deps);
    for (const candidate of priceAttempts) {
      for (const action of actions) {
        try {
          const query = {
            action,
            service: config.serviceCode,
            country: candidate.countryId,
          };
          if (config.minPrice) query.minPrice = config.minPrice;
          query.maxPrice = candidate.price;
          query.fixedPrice = "true";
          const payload = await fetchHeroSmsPayload(settings, query, `HeroSMS ${action}`, deps);
          const activation = parseHeroSmsActivation(payload, {
            serviceCode: config.serviceCode,
            countryId: candidate.countryId,
            countryLabel: candidate.countryLabel,
            statusAction: action === "getNumberV2" ? "getStatusV2" : "getStatus",
          });
          if (activation) return { ...activation, price: candidate.price };
          const text = describeHeroSmsPayload(payload);
          if (action === "getNumberV2" && /BAD_ACTION/i.test(text)) {
            failures.push(`${candidate.countryLabel}@${candidate.price}:${text || "getNumberV2 unavailable"}`);
            continue;
          }
          if (isTerminalPayload(text) && !isNoNumbersPayload(text)) {
            throw new Error(`HeroSMS ${action}失败：${text}`);
          }
          failures.push(`${candidate.countryLabel}@${candidate.price}:${text || "空响应"}`);
        } catch (error) {
          const payloadOrMessage = error?.payload || error?.message;
          if (action === "getNumberV2" && /BAD_ACTION/i.test(describeHeroSmsPayload(payloadOrMessage))) {
            failures.push(`${candidate.countryLabel}@${candidate.price}:${describeHeroSmsPayload(payloadOrMessage) || "getNumberV2 unavailable"}`);
            continue;
          }
          if (isTerminalPayload(payloadOrMessage) && !isNoNumbersPayload(payloadOrMessage)) {
            throw new Error(`HeroSMS 获取手机号失败：${describeHeroSmsPayload(payloadOrMessage) || "未知错误"}`);
          }
          failures.push(`${candidate.countryLabel}@${candidate.price}:${describeHeroSmsPayload(payloadOrMessage) || error?.message || "未知错误"}`);
        }
      }
    }
    if (requestAttempt < config.numberRequestAttempts && config.numberRequestRetryDelayMs > 0) {
      await sleep(config.numberRequestRetryDelayMs);
    }
  }

  throw new Error(`HeroSMS 获取手机号失败：${Array.from(new Set(failures)).join(" | ") || "无可用号码"}`);
}

export async function setHeroSmsActivationStatus(settings = {}, activation = {}, status, deps = {}) {
  const activationId = String(activation?.activationId || activation?.id || "").trim();
  if (!activationId) return "";
  const payload = await fetchHeroSmsPayload(settings, {
    action: "setStatus",
    id: activationId,
    status: Math.floor(Number(status) || 0),
  }, `HeroSMS setStatus(${Math.floor(Number(status) || 0)})`, deps);
  return describeHeroSmsPayload(payload);
}

export async function requestHeroSmsAdditionalSms(settings = {}, activation = {}, deps = {}) {
  const message = await setHeroSmsActivationStatus(settings, activation, 3, deps);
  return { message, activation };
}

export async function finishHeroSmsActivation(settings = {}, activation = {}, deps = {}) {
  return setHeroSmsActivationStatus(settings, activation, 6, deps);
}

export async function cancelHeroSmsActivation(settings = {}, activation = {}, deps = {}) {
  return setHeroSmsActivationStatus(settings, activation, 8, deps);
}

export async function pollHeroSmsActivationCode(settings = {}, activation = {}, options = {}, deps = {}) {
  const activationId = String(activation?.activationId || activation?.id || "").trim();
  if (!activationId) {
    throw new Error("缺少 HeroSMS 手机号接码订单。");
  }

  const source = normalizeSource(settings);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || source.pollTimeoutMs || 180000));
  const intervalMs = Math.max(1000, Number(options.intervalMs || source.pollIntervalMs || 3000));
  const ignored = new Set((options.ignoreCodes || activation.ignoredCodes || [])
    .map((entry) => extractHeroSmsCode(entry))
    .filter(Boolean));
  const statusActions = Array.from(new Set([
    String(activation.statusAction || "").trim() || "getStatus",
    "getStatus",
  ]));
  const startedAt = Date.now();
  let lastResponse = "";
  let pollCount = 0;
  let statusActionIndex = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const statusAction = statusActions[Math.min(statusActionIndex, statusActions.length - 1)];
    const payload = await fetchHeroSmsPayload(settings, {
      action: statusAction,
      id: activationId,
    }, `HeroSMS ${statusAction}`, deps).catch((error) => {
      if (statusAction !== "getStatus" && /BAD_ACTION/i.test(describeHeroSmsPayload(error?.payload || error?.message))) {
        statusActionIndex = statusActions.indexOf("getStatus");
        return null;
      }
      throw error;
    });
    if (payload === null) {
      await sleep(Math.min(intervalMs, 1000));
      continue;
    }

    pollCount += 1;
    lastResponse = describeHeroSmsPayload(payload);
    const code = extractCodeFromStatus(payload);
    if (code && !ignored.has(code)) {
      return { code, lastResponse, pollCount };
    }
    if (code && ignored.has(code)) {
      await sleep(intervalMs);
      continue;
    }

    if (/^STATUS_(WAIT_CODE|WAIT_RETRY|WAIT_RESEND)(?::.+)?$/i.test(lastResponse) || (payload && typeof payload === "object")) {
      await sleep(intervalMs);
      continue;
    }
    if (/^STATUS_CANCEL$/i.test(lastResponse)) {
      throw new Error("HeroSMS 订单在短信到达前已被取消。");
    }
    throw new Error(`HeroSMS 查询验证码失败：${lastResponse || "空响应"}`);
  }

  throw new Error(`等待 HeroSMS 验证码超时。最后状态：${lastResponse || "未知"}。`);
}
