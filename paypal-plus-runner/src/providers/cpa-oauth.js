import fs from "node:fs";
import path from "node:path";
import { redactForCliOutput } from "../utils/safe-output.js";

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

function timeoutMs(config = {}) {
  return Math.max(1000, Number(config.cpa?.timeoutMs || config.cpa?.timeout_sec || 30000));
}

function cpaOrigin(config = {}) {
  const baseUrl = normalizeString(config.cpa?.baseUrl || config.cpa?.base_url);
  if (!baseUrl) throw new Error("cpa.baseUrl is empty");
  try {
    return new URL(baseUrl).origin;
  } catch {
    throw new Error("cpa.baseUrl is not a valid URL");
  }
}

function cpaBearer(config = {}) {
  const bearer = normalizeString(config.cpa?.authorizationBearer || config.cpa?.authorization_bearer);
  if (!bearer) throw new Error("cpa.authorizationBearer is empty");
  return bearer;
}

async function fetchCpaJson(config, endpoint, { method = "POST", body = undefined } = {}) {
  const origin = cpaOrigin(config);
  const bearer = cpaBearer(config);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(config));
  try {
    const response = await fetch(`${origin}${endpoint}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
        "X-Management-Key": bearer,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const message = firstNonEmpty(payload.error, payload.message, payload.detail, payload.reason)
        || `CPA API failed HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = redactForCliOutput(payload);
      throw error;
    }
    return { status: response.status, payload, origin };
  } catch (error) {
    if (error?.name === "AbortError") {
      const wrapped = new Error("CPA API request timed out");
      wrapped.retryable = true;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseLocalhostOAuthCallback(rawUrl = "", expectedState = "") {
  const value = normalizeString(rawUrl);
  if (!value) throw new Error("localhost callback URL is empty");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("localhost callback URL is invalid");
  }
  const host = String(parsed.hostname || "").toLowerCase();
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error("OAuth callback host is not localhost");
  }
  const code = normalizeString(parsed.searchParams.get("code"));
  const state = normalizeString(parsed.searchParams.get("state"));
  const error = normalizeString(parsed.searchParams.get("error"));
  const errorDescription = normalizeString(parsed.searchParams.get("error_description"));
  if (error) throw new Error(errorDescription || `OAuth callback error: ${error}`);
  if (!code) throw new Error("OAuth callback missing code");
  const expected = normalizeString(expectedState);
  if (expected && state !== expected) {
    throw new Error("OAuth callback state does not match CPA OAuth state");
  }
  return {
    url: parsed.toString(),
    host,
    path: parsed.pathname,
    code,
    state,
    hasCode: Boolean(code),
    hasState: Boolean(state),
    stateMatched: expected ? state === expected : null,
  };
}

function stateFromOauthUrl(value = "") {
  try {
    return new URL(value).searchParams.get("state") || "";
  } catch {
    return "";
  }
}

export async function fetchCpaOAuthUrl(config = {}) {
  const { payload, origin } = await fetchCpaJson(config, "/v0/management/codex-auth-url", {
    method: "GET",
  });
  const oauthUrl = firstNonEmpty(
    payload.url,
    payload.auth_url,
    payload.authUrl,
    payload.data?.url,
    payload.data?.auth_url,
    payload.data?.authUrl,
  );
  const cpaOAuthState = firstNonEmpty(
    payload.state,
    payload.auth_state,
    payload.authState,
    payload.data?.state,
    payload.data?.auth_state,
    payload.data?.authState,
    stateFromOauthUrl(oauthUrl),
  );
  if (!oauthUrl || !/^https?:\/\//i.test(oauthUrl)) {
    throw new Error("CPA API did not return a valid auth_url");
  }
  return {
    status: "done",
    oauthUrl,
    cpaOAuthState,
    cpaManagementOrigin: origin,
    responseSummary: {
      responseKeys: Object.keys(payload || {}).slice(0, 20),
      hasOauthUrl: Boolean(oauthUrl),
      hasState: Boolean(cpaOAuthState),
    },
  };
}

export async function uploadCpaOAuthCallback({ config = {}, localhostUrl = "", expectedState = "" } = {}) {
  const callback = parseLocalhostOAuthCallback(localhostUrl, expectedState);
  const { payload, origin, status } = await fetchCpaJson(config, "/v0/management/oauth-callback", {
    method: "POST",
    body: {
      provider: "codex",
      redirect_url: callback.url,
    },
  });
  const verifiedStatus = firstNonEmpty(payload.message, payload.status_message, "CPA 已通过接口提交回调");
  return {
    status: "done",
    target: "cpa",
    cpaUploadStatus: "done",
    cpaManagementOrigin: origin,
    httpStatus: status,
    verifiedStatus,
    responseJson: redactForCliOutput(payload),
    callbackSummary: {
      host: callback.host,
      path: callback.path,
      hasCode: callback.hasCode,
      hasState: callback.hasState,
      stateMatched: callback.stateMatched,
    },
  };
}

export function buildCallbackJsonSummary({
  account = {},
  accountIdentifierType = "",
  accountIdentifier = "",
  signupPhoneNumber = "",
  boundEmail = "",
  localhostUrl = "",
  cpaUploadResult = null,
  expectedState = "",
  now = new Date(),
} = {}) {
  const callback = localhostUrl
    ? parseLocalhostOAuthCallback(localhostUrl, expectedState)
    : { host: "", path: "", hasCode: false, hasState: false, stateMatched: null };
  return {
    type: "cpa_upload_result",
    target: "cpa",
    email: boundEmail || account.email || "",
    accountIdentifierType,
    accountIdentifier,
    signupPhoneNumber,
    callback: {
      host: callback.host,
      path: callback.path,
      hasCode: callback.hasCode,
      hasState: callback.hasState,
      stateMatched: callback.stateMatched,
    },
    cpa: {
      uploaded: cpaUploadResult?.cpaUploadStatus === "done",
      verifiedStatus: cpaUploadResult?.verifiedStatus || "",
      origin: cpaUploadResult?.cpaManagementOrigin || "",
    },
    createdAt: now.toISOString(),
  };
}

function safeFileSegment(value = "", fallback = "account") {
  return normalizeString(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || fallback;
}

export async function saveCallbackJsonSummary({ summary, config = {} } = {}) {
  const dir = path.resolve(normalizeString(config.callbackJson?.dir) || "callback-json");
  const email = safeFileSegment(summary?.email || "", "account");
  const fileName = `oauth-${email}-plus.json`;
  const filePath = path.join(dir, fileName);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(redactForCliOutput(summary), null, 2)}\n`, "utf8");
  return {
    status: "done",
    fileName,
    filePath,
    directoryPath: dir,
    callbackJson: redactForCliOutput(summary),
  };
}
