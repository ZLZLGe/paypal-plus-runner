import { uploadCpaOAuthCallback } from "../providers/cpa-oauth.js";

export async function cpaPlatformVerifyStep(context, { logger } = {}) {
  if (!context.localhostUrl) {
    throw new Error("cpa-platform-verify requires context.localhostUrl");
  }
  const result = await uploadCpaOAuthCallback({
    config: context.config,
    localhostUrl: context.localhostUrl,
    expectedState: context.cpaOAuthState || "",
  });
  context.cpaUploadStatus = result.cpaUploadStatus;
  context.cpaUploadResult = result;
  logger?.info?.("CPA OAuth callback uploaded", {
    cpaManagementOrigin: result.cpaManagementOrigin,
    verifiedStatus: result.verifiedStatus,
    callbackSummary: result.callbackSummary,
  });
  return {
    status: "done",
    reason: "cpa_callback_uploaded",
    cpaUploadStatus: result.cpaUploadStatus,
    cpaUploadResult: result,
  };
}
