import { fetchCpaOAuthUrl } from "../providers/cpa-oauth.js";

export async function fetchCpaOAuthUrlStep(context, { logger } = {}) {
  const result = await fetchCpaOAuthUrl(context.config);
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
