import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_RELATIVE_AUTH_DIR = ".cli-proxy-api";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value = "") {
  return String(value || "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const normalized = normalizeString(value);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeEmailValue(value = "") {
  const email = normalizeString(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function decodeBase64UrlSegment(segment = "") {
  const normalized = normalizeString(segment).replace(/-/g, "+").replace(/_/g, "/");
  if (!normalized) return "";
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function parseJwtPayload(token = "") {
  const normalized = normalizeString(token);
  if (!normalized) return {};
  const parts = normalized.split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(decodeBase64UrlSegment(parts[1]));
  } catch {
    return {};
  }
}

function getOpenAiAuthSection(payload) {
  if (!isPlainObject(payload)) return {};
  const auth = payload["https://api.openai.com/auth"];
  return isPlainObject(auth) ? auth : {};
}

function getOpenAiProfileSection(payload) {
  if (!isPlainObject(payload)) return {};
  const profile = payload["https://api.openai.com/profile"];
  return isPlainObject(profile) ? profile : {};
}

function normalizeTimestamp(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value > 1e11 ? value : value * 1000;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function timestampFromUnixSeconds(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "";
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function epochSecondsFromValue(value) {
  if (value === undefined || value === null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return Math.trunc(numeric > 1e11 ? numeric / 1000 : numeric);
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? Math.trunc(parsed / 1000) : 0;
}

export function buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt, { now = new Date() } = {}) {
  const normalizedAccountId = normalizeString(accountId);
  if (!normalizedAccountId) return "";
  const nowSeconds = Math.trunc(new Date(now).getTime() / 1000) || Math.trunc(Date.now() / 1000);
  const expires = epochSecondsFromValue(expiresAt) || nowSeconds + 90 * 24 * 60 * 60;
  const authInfo = { chatgpt_account_id: normalizedAccountId };

  if (planType) authInfo.chatgpt_plan_type = normalizeString(planType);
  if (userId) {
    authInfo.chatgpt_user_id = normalizeString(userId);
    authInfo.user_id = normalizeString(userId);
  }

  const payload = {
    iat: nowSeconds,
    exp: expires,
    "https://api.openai.com/auth": authInfo,
  };
  if (email) payload.email = normalizeString(email);

  return `${encodeBase64UrlJson({ alg: "none", typ: "JWT", cpa_synthetic: true })}.${encodeBase64UrlJson(payload)}.`;
}

function normalizePlanTypeForFileName(planType = "") {
  return normalizeString(planType)
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .join("-");
}

function sanitizeFileSegment(value = "", fallback = "") {
  const normalized = normalizeString(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

export function buildCpaAuthFileName(metadata = {}) {
  const email = sanitizeFileSegment(metadata.email || "");
  const planType = normalizePlanTypeForFileName(metadata.planType || metadata.plan_type || metadata.chatgpt_plan_type || "");
  const accountId = sanitizeFileSegment(metadata.accountId || metadata.account_id || metadata.chatgpt_account_id || "");

  if (email && planType === "team" && accountId) {
    const accountHash = crypto.createHash("sha256").update(accountId).digest("hex").slice(0, 8);
    return `codex-${accountHash}-${email}-${planType}.json`;
  }
  if (email && planType) return `codex-${email}-${planType}.json`;
  if (email) return `codex-${email}.json`;
  if (accountId && planType) return `codex-${accountId}-${planType}.json`;
  if (accountId) return `codex-${accountId}.json`;
  return `codex-${Date.now()}.json`;
}

function compactObjectPreserveEmptyStrings(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

function parseSessionJson(sessionJson) {
  if (isPlainObject(sessionJson)) return sessionJson;
  if (typeof sessionJson !== "string" || !sessionJson.trim()) {
    throw new Error("生成 CPA JSON 失败：sessionJson 为空。");
  }
  try {
    const parsed = JSON.parse(sessionJson);
    if (!isPlainObject(parsed)) throw new Error("not_object");
    return parsed;
  } catch {
    throw new Error("生成 CPA JSON 失败：sessionJson 不是合法 JSON 对象。");
  }
}

export function convertSessionJsonToCpaAuthJson(sessionJson, options = {}) {
  const record = parseSessionJson(sessionJson);
  const rawSession = isPlainObject(record.raw_session) ? record.raw_session : {};
  const token = isPlainObject(record.token) ? record.token : {};
  const credentials = isPlainObject(record.credentials) ? record.credentials : {};
  const providerSpecificData = isPlainObject(record.providerSpecificData) ? record.providerSpecificData : {};

  const accessToken = firstNonEmpty(
    record.accessToken,
    record.access_token,
    token.accessToken,
    token.access_token,
    credentials.accessToken,
    credentials.access_token,
    rawSession.accessToken,
    rawSession.access_token,
  );
  if (!accessToken) throw new Error("生成 CPA JSON 失败：缺少 accessToken。");

  const inputIdToken = firstNonEmpty(
    record.idToken,
    record.id_token,
    token.idToken,
    token.id_token,
    credentials.id_token,
    rawSession.idToken,
    rawSession.id_token,
  );
  const refreshToken = firstNonEmpty(
    record.refreshToken,
    record.refresh_token,
    token.refreshToken,
    token.refresh_token,
    credentials.refresh_token,
    rawSession.refreshToken,
    rawSession.refresh_token,
  );
  const sessionToken = firstNonEmpty(
    record.sessionToken,
    record.session_token,
    token.sessionToken,
    token.session_token,
    credentials.session_token,
    rawSession.sessionToken,
    rawSession.session_token,
  );

  const accessPayload = parseJwtPayload(accessToken);
  const idPayload = parseJwtPayload(inputIdToken);
  const accessAuth = getOpenAiAuthSection(accessPayload);
  const idAuth = getOpenAiAuthSection(idPayload);
  const accessProfile = getOpenAiProfileSection(accessPayload);

  const expiresAt = firstNonEmpty(
    timestampFromUnixSeconds(accessPayload.exp),
    normalizeTimestamp(record.expires),
    normalizeTimestamp(record.expiresAt),
    normalizeTimestamp(record.expired),
    normalizeTimestamp(record.expires_at),
    normalizeTimestamp(rawSession.expires),
    normalizeTimestamp(rawSession.expiresAt),
    normalizeTimestamp(rawSession.expired),
    normalizeTimestamp(rawSession.expires_at),
  );
  const email = firstNonEmpty(
    normalizeEmailValue(record.user?.email),
    normalizeEmailValue(record.email),
    normalizeEmailValue(rawSession.user?.email),
    normalizeEmailValue(rawSession.email),
    normalizeEmailValue(credentials.email),
    normalizeEmailValue(providerSpecificData.email),
    normalizeEmailValue(accessProfile.email),
    normalizeEmailValue(idPayload.email),
    normalizeEmailValue(accessPayload.email),
    normalizeEmailValue(options.email),
  );
  const accountId = firstNonEmpty(
    record.account?.id,
    record.account_id,
    record.chatgptAccountId,
    rawSession.account?.id,
    rawSession.account_id,
    providerSpecificData.chatgptAccountId,
    providerSpecificData.chatgpt_account_id,
    credentials.chatgpt_account_id,
    accessAuth.chatgpt_account_id,
    idAuth.chatgpt_account_id,
    record.provider === "codex" ? record.id : "",
  );
  const userId = firstNonEmpty(
    record.user?.id,
    record.user_id,
    record.chatgptUserId,
    rawSession.user?.id,
    rawSession.user_id,
    providerSpecificData.chatgptUserId,
    providerSpecificData.chatgpt_user_id,
    accessAuth.chatgpt_user_id,
    accessAuth.user_id,
    idAuth.chatgpt_user_id,
    idAuth.user_id,
  );
  const planType = firstNonEmpty(
    record.account?.planType,
    record.account?.plan_type,
    record.planType,
    record.plan_type,
    rawSession.account?.planType,
    rawSession.account?.plan_type,
    rawSession.planType,
    rawSession.plan_type,
    providerSpecificData.chatgptPlanType,
    providerSpecificData.chatgpt_plan_type,
    credentials.plan_type,
    accessAuth.chatgpt_plan_type,
    idAuth.chatgpt_plan_type,
  );
  const exportedAt = Object.prototype.hasOwnProperty.call(options, "lastRefresh")
    ? normalizeString(options.lastRefresh)
    : normalizeTimestamp(options.now || new Date());
  const syntheticIdToken = inputIdToken
    ? ""
    : buildSyntheticCodexIdToken(email, accountId, planType, userId, expiresAt, { now: options.now });
  const idToken = firstNonEmpty(inputIdToken, syntheticIdToken);

  const authJson = compactObjectPreserveEmptyStrings({
    type: "codex",
    account_id: accountId,
    chatgpt_account_id: accountId,
    email,
    name: firstNonEmpty(record.name, record.user?.name, rawSession.user?.name, email, options.sourceName, "ChatGPT Account"),
    plan_type: planType,
    chatgpt_plan_type: planType,
    id_token: idToken,
    id_token_synthetic: syntheticIdToken ? true : undefined,
    access_token: accessToken,
    refresh_token: refreshToken || "",
    session_token: sessionToken,
    last_refresh: exportedAt,
    expired: expiresAt,
    disabled: record.disabled === true || rawSession.disabled === true ? true : undefined,
  });

  const warnings = [];
  if (!inputIdToken && syntheticIdToken) {
    warnings.push("缺少真实 id_token，已生成 CPA 兼容的 synthetic id_token。");
  }
  if (!refreshToken) {
    warnings.push("缺少 refresh_token，此 CPA JSON 为无 RT 文件，access_token 过期后不能自动续期。");
  }

  return {
    authJson,
    warnings,
    metadata: {
      email,
      accountId,
      userId,
      planType,
      expiresAt,
      hasRefreshToken: Boolean(refreshToken),
      hasSyntheticIdToken: Boolean(syntheticIdToken),
    },
  };
}

function sanitizeRelativeDir(input = DEFAULT_RELATIVE_AUTH_DIR) {
  const normalized = normalizeString(input || DEFAULT_RELATIVE_AUTH_DIR);
  const segments = normalized
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) return DEFAULT_RELATIVE_AUTH_DIR;
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("生成 CPA JSON 失败：relativeAuthDir 不能包含 . 或 .. 路径段。");
  }
  return segments.join("/");
}

export function resolveCpaJsonDirectory(config = {}) {
  const cpa = config.cpa || {};
  const pluginDir = normalizeString(cpa.pluginDir);
  if (pluginDir) {
    return path.resolve(pluginDir, sanitizeRelativeDir(cpa.relativeAuthDir || DEFAULT_RELATIVE_AUTH_DIR));
  }
  const localJsonDir = normalizeString(cpa.localJsonDir);
  if (localJsonDir) return path.resolve(localJsonDir);
  return path.resolve(normalizeString(config.output?.dir) || "output", "cpa-json");
}

export function shouldSaveLocalCpaJson(config = {}) {
  if (config.cpa?.localJsonEnabled === true) return true;
  if (config.cpa?.localJsonEnabled === false) return false;
  const target = normalizeString(config.flow?.sessionJsonTarget).toLowerCase().replace(/-/g, "_");
  return ["cpa", "cpa_json", "local_cpa_json", "cpa_local_json"].includes(target);
}

export function buildCpaJsonArtifact({ sessionJson, account = {}, config = {}, now = new Date() } = {}) {
  const parsedSession = parseSessionJson(sessionJson);
  const accountEmail = normalizeEmailValue(account.email);
  const sessionRecord = {
    ...parsedSession,
    email: parsedSession.email || accountEmail,
  };
  const converted = convertSessionJsonToCpaAuthJson(sessionRecord, {
    email: accountEmail,
    now,
    sourceName: accountEmail || "ChatGPT Account",
  });
  const fileName = buildCpaAuthFileName(converted.metadata);
  const directoryPath = resolveCpaJsonDirectory(config);
  const filePath = path.join(directoryPath, fileName);
  const jsonText = `${JSON.stringify(converted.authJson, null, 2)}\n`;

  return {
    provider: "codex",
    fileName,
    directoryPath,
    filePath,
    authJson: converted.authJson,
    jsonText,
    warnings: converted.warnings,
    metadata: converted.metadata,
  };
}

export async function saveCpaJsonArtifact(artifact) {
  if (!isPlainObject(artifact)) throw new Error("保存 CPA JSON 失败：artifact 无效。");
  if (!normalizeString(artifact.filePath)) throw new Error("保存 CPA JSON 失败：缺少 filePath。");
  await fs.mkdir(artifact.directoryPath, { recursive: true });
  await fs.writeFile(artifact.filePath, artifact.jsonText, "utf8");
  return {
    provider: artifact.provider || "codex",
    fileName: artifact.fileName,
    directoryPath: artifact.directoryPath,
    filePath: artifact.filePath,
    warnings: Array.isArray(artifact.warnings) ? artifact.warnings.slice() : [],
    metadata: { ...(artifact.metadata || {}) },
    saved: true,
  };
}

export async function importToCpa({ sessionJson, account = {}, config = {}, now = new Date() } = {}) {
  const artifact = buildCpaJsonArtifact({ sessionJson, account, config, now });
  const saved = await saveCpaJsonArtifact(artifact);
  return {
    status: "done",
    target: "local_cpa_json",
    fileName: saved.fileName,
    filePath: saved.filePath,
    directoryPath: saved.directoryPath,
    warnings: saved.warnings,
    metadata: saved.metadata,
  };
}
