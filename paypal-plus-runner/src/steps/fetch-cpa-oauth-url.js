import { fetchCpaOAuthUrl } from "../providers/cpa-oauth.js";

function isRetryableCpaFetchError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  const causeCode = String(error?.cause?.code || "").toLowerCase();
  return error?.retryable === true
    || message.includes("fetch failed")
    || message.includes("timed out")
    || /econn|etimedout|ehost|enet|socket|reset/.test(causeCode);
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchCpaOAuthUrlStep(context, { logger } = {}) {
  const maxAttempts = Math.max(1, Number(context.config.cpa?.oauthUrlFetchAttempts || 3));
  let result = null;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      result = await fetchCpaOAuthUrl(context.config);
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableCpaFetchError(error)) {
        throw error;
      }
      const retryDelayMs = Math.min(5000, 750 * attempt);
      logger?.warn?.("CPA OAuth URL fetch failed; retrying", {
        attempt,
        maxAttempts,
        retryDelayMs,
        error: error.message,
      });
      await wait(retryDelayMs);
    }
  }
  if (!result) throw lastError || new Error("CPA OAuth URL fetch failed");
  context.oauthUrl = result.oauthUrl;
  context.cpaOAuthState = result.cpaOAuthState || "";
  context.cpaManagementOrigin = result.cpaManagementOrigin || "";
  logger?.info?.("fetched CPA OAuth URL", {
    origin: context.cpaManagementOrigin,
    hasOauthUrl: Boolean(context.oauthUrl),
    hasState: Boolean(context.cpaOAuthState),
    responseSummary: result.responseSummary,
  });
  return {
    status: "done",
    reason: "cpa_oauth_url_fetched",
    cpaOAuthState: context.cpaOAuthState,
    cpaManagementOrigin: context.cpaManagementOrigin,
    hasOauthUrl: Boolean(context.oauthUrl),
  };
}
