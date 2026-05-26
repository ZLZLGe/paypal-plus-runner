import { readSessionJson } from "../providers/session-json.js";
import { importToSub2Api } from "../providers/sub2api.js";

export async function sessionJsonImportStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("session-json-import requires a browser page");
  const session = await readSessionJson(page);
  let importResult = { status: "skipped", reason: "session_json_only" };
  if (context.config.flow?.sessionJsonTarget === "sub2api") {
    importResult = await importToSub2Api({
      sessionJson: session.sessionJson,
      account: context.account,
      config: context.config,
    });
  }
  logger?.info?.("session json extracted", {
    email: context.account.email,
    importStatus: importResult.status,
  });
  return {
    status: "done",
    reason: "session_json_extracted",
    sessionJson: session.sessionJson,
    accessToken: session.accessToken,
    importResult,
  };
}
