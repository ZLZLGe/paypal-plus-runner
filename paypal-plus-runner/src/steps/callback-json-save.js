import { buildCallbackJsonSummary, saveCallbackJsonSummary } from "../providers/cpa-oauth.js";

export async function callbackJsonSaveStep(context, { logger } = {}) {
  if (context.config.callbackJson?.enabled === false) {
    return { status: "skipped", reason: "callback_json_disabled" };
  }
  const summary = buildCallbackJsonSummary({
    account: context.account,
    accountIdentifierType: context.accountIdentifierType || "",
    accountIdentifier: context.accountIdentifier || "",
    signupPhoneNumber: context.signupPhoneNumber || "",
    boundEmail: context.boundEmail || context.account?.email || "",
    localhostUrl: context.localhostUrl || "",
    cpaUploadResult: context.cpaUploadResult || null,
    expectedState: context.cpaOAuthState || "",
  });
  const saved = await saveCallbackJsonSummary({ summary, config: context.config });
  context.callbackJson = saved.callbackJson;
  context.callbackJsonPath = saved.filePath;
  context.callbackJsonFileName = saved.fileName;
  logger?.info?.("callback JSON summary saved", {
    fileName: saved.fileName,
    filePath: saved.filePath,
    uploaded: saved.callbackJson?.cpa?.uploaded === true,
  });
  return {
    status: "done",
    reason: "callback_json_summary_saved",
    callbackJson: saved.callbackJson,
    callbackJsonPath: saved.filePath,
    callbackJsonFileName: saved.fileName,
  };
}
