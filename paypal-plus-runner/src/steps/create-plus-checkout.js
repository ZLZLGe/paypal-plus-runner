import { createCheckout } from "../checkout-conversion/index.js";
import { safeGoto } from "../browser/page-utils.js";

export async function createPlusCheckoutStep(context, { accessToken = "", logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("create-plus-checkout requires a browser page");
  if (!accessToken) {
    const { readSessionJson } = await import("../providers/session-json.js");
    const session = await readSessionJson(page);
    accessToken = session.accessToken;
    context.sessionJson = session.sessionJson;
  }
  const checkout = await createCheckout({ accessToken, config: context.config });
  context.checkout = checkout;
  if (checkout.alreadyPaid) {
    logger?.info?.("checkout conversion says account is already paid", {
      reason: checkout.alreadyPaidReason,
    });
    return { status: "skipped", reason: "already_paid", checkout };
  }
  const targetUrl = checkout.preferredCheckoutUrl || checkout.hostedCheckoutUrl || checkout.chatgptCheckoutUrl || checkout.checkoutUrl;
  if (!targetUrl) throw new Error("checkout conversion did not return a URL");
  const stage = await safeGoto(page, targetUrl, {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
  });
  return { status: "done", reason: "checkout_opened", checkout, stage };
}
