const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_NORMALIZED = new Set([
  "authorization",
  "authorizationbearer",
  "clientsecret",
  "code",
  "cookie",
  "cookies",
  "html",
  "herosmsapikey",
  "localhosturl",
  "mail",
  "password",
  "raw",
  "rawsession",
  "redirecturl",
  "refreshtoken",
  "session",
  "sessionjson",
  "sessiontoken",
  "state",
  "text",
]);

const SENSITIVE_KEY_PATTERN = /(?:access|id|refresh|session)[_-]?token|session[_-]?json|client[_-]?secret|authorization[_-]?bearer|api[_-]?key|hero[_-]?sms[_-]?api[_-]?key|callback[_-]?json|checkout[_-]?session[_-]?id|checkout.*url|hosted.*url|preferred.*url|chatgpt.*url|publishable[_-]?key/i;
const URL_WITH_SECRET_KEY_PATTERN = /callback[_-]?url|localhost[_-]?url|redirect[_-]?url|checkout.*url|hosted.*url|preferred.*url|chatgpt.*url/i;

function normalizeKey(key) {
  return String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEY_NORMALIZED.has(normalized) || SENSITIVE_KEY_PATTERN.test(String(key || ""));
}

function isUrlWithSecretKey(key) {
  return URL_WITH_SECRET_KEY_PATTERN.test(String(key || ""));
}

function redactUrlSecrets(value) {
  return String(value)
    .replace(/([?&](?:code|state|access_token|id_token|refresh_token|session_token|client_secret)=)[^&#\s"]+/gi, "$1[REDACTED]")
    .replace(/(\/(?:c\/pay|checkout\/[^/\s"]+)\/)cs_(?:live|test)_[A-Za-z0-9]+/gi, "$1cs_[REDACTED]")
    .replace(/\bcs_(?:live|test)_[A-Za-z0-9]+\b/g, "cs_[REDACTED]")
    .replace(/(#fid)[A-Za-z0-9%._~-]+/g, "$1[REDACTED]");
}

function redactTokenLikeStrings(value) {
  return String(value)
    .replace(/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_JWT]")
    .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]");
}

export function redactStringForOutput(value) {
  return redactTokenLikeStrings(redactUrlSecrets(String(value)));
}

export function redactForCliOutput(value, { seen = new WeakSet(), parentKey = "" } = {}) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (isUrlWithSecretKey(parentKey)) return redactStringForOutput(value);
    if (isSensitiveKey(parentKey)) return REDACTED;
    const redacted = redactStringForOutput(value);
    return redacted.length > 1200 ? `${redacted.slice(0, 1200)}...[TRUNCATED]` : redacted;
  }
  if (typeof value !== "object") return value;
  if (isSensitiveKey(parentKey) && !isUrlWithSecretKey(parentKey)) return REDACTED;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactForCliOutput(item, { seen, parentKey }));
  }

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) && !isUrlWithSecretKey(key)
      ? REDACTED
      : redactForCliOutput(item, { seen, parentKey: key });
  }
  return output;
}

export function stringifySafeJson(value) {
  return JSON.stringify(redactForCliOutput(value), null, 2);
}
