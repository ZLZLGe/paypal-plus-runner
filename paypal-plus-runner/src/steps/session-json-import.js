import { assertPlusSessionJson, readSessionJson } from "../providers/session-json.js";
import { importToSub2Api } from "../providers/sub2api.js";
import { importToCpa, shouldSaveLocalCpaJson } from "../providers/cpa.js";

export async function sessionJsonImportStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("session-json-import requires a browser page");
  const session = await readSessionJson(page);
  const requirePlusSessionPlan = context.config.runner?.requirePlusSessionPlan !== false;
  const plus = requirePlusSessionPlan ? assertPlusSessionJson(session.sessionJson) : { planType: "" };
  const target = String(context.config.flow?.sessionJsonTarget || "session_json").trim().toLowerCase();
  let importResult = { status: "skipped", reason: "session_json_only" };
  let cpaJsonResult = null;

  if (target === "sub2api") {
    importResult = await importToSub2Api({
      sessionJson: session.sessionJson,
      account: context.account,
      config: context.config,
    });
  }
  if (shouldSaveLocalCpaJson(context.config)) {
    cpaJsonResult = await importToCpa({
      sessionJson: session.sessionJson,
      account: context.account,
      config: context.config,
    });
    if (target !== "sub2api") importResult = cpaJsonResult;
  }

  logger?.info?.("session json extracted", {
    email: context.account.email,
    importStatus: importResult.status,
    cpaJsonFile: cpaJsonResult?.fileName || "",
    cpaJsonPath: cpaJsonResult?.filePath || "",
    planType: plus.planType || "",
  });
  return {
    status: "done",
    reason: "session_json_extracted",
    sessionJson: session.sessionJson,
    accessToken: session.accessToken,
    importResult,
    cpaJsonResult,
    cpaJsonPath: cpaJsonResult?.filePath || "",
    cpaJsonFileName: cpaJsonResult?.fileName || "",
  };
}
