import { detectPageStage, waitForUrlStage } from "../browser/page-utils.js";

export async function plusReturnConfirmStep(context) {
  const page = context.page;
  if (!page) throw new Error("plus-return-confirm requires a browser page");
  const stage = await waitForUrlStage(page, (item) => (
    item.stage === "payments_success"
    || (item.stage === "chatgpt" && /plus|pricing|checkout/i.test(item.url))
  ), {
    timeoutMs: Number(context.config.runner?.plusReturnTimeoutMs || 180000),
    pollMs: 1000,
  });
  if (stage.stage === "payments_success") {
    return { status: "done", reason: "payments_success", stage };
  }
  const current = await detectPageStage(page);
  return { status: "skipped", reason: "success_url_not_observed", stage: current };
}
