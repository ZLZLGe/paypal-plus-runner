import {
  detectPageStage,
  isStripePaypalRedirectSucceededUrl,
  safeGoto,
  waitForUrlStage,
} from "../browser/page-utils.js";
import { assertPlusSessionJson, readSessionJson } from "../providers/session-json.js";

async function verifyPlusSession(context, { logger } = {}) {
  const page = context.page;
  const timeoutMs = Number(context.config.runner?.plusSessionVerifyTimeoutMs || 180000);
  const pollMs = Number(context.config.runner?.plusSessionVerifyPollMs || 5000);
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    const stage = await detectPageStage(page).catch(() => ({ stage: "unknown", url: page.url() }));
    if (stage.stage !== "chatgpt" && stage.stage !== "payments_success") {
      await safeGoto(page, "https://chatgpt.com/", {
        waitUntil: "domcontentloaded",
        timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
      }).catch((error) => {
        lastError = error;
      });
    }
    try {
      const session = await readSessionJson(page);
      const plus = assertPlusSessionJson(session.sessionJson);
      context.sessionJson = session.sessionJson;
      context.checkoutAccessToken = session.accessToken;
      return { status: "done", reason: "plus_session_confirmed", planType: plus.planType };
    } catch (error) {
      lastError = error;
      logger?.warn?.("Plus session verification not ready", {
        code: error.code || "",
        error: error.message,
      });
    }
    await page.waitForTimeout(pollMs);
  }

  const error = new Error(`Plus return confirmation timed out: ${lastError?.message || "session did not confirm plus"}`);
  error.code = "PLUS_RETURN_NOT_CONFIRMED";
  error.retryable = true;
  throw error;
}

export async function plusReturnConfirmStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("plus-return-confirm requires a browser page");
  if (context.plusAlreadyPaid || context.checkout?.alreadyPaid) {
    return { status: "skipped", reason: "already_paid", checkout: context.checkout || null };
  }
  const stage = await waitForUrlStage(page, (item) => (
    item.stage === "payments_success"
    || (item.stage === "chatgpt" && /plus|pricing|checkout/i.test(item.url))
    || isStripePaypalRedirectSucceededUrl(item.url)
  ), {
    timeoutMs: Number(context.config.runner?.plusReturnTimeoutMs || 180000),
    pollMs: 1000,
  });
  if (isStripePaypalRedirectSucceededUrl(stage.url) || context.stripePaypalRedirectSucceeded) {
    const verified = await verifyPlusSession(context, { logger });
    return { status: "done", reason: "stripe_paypal_redirect_plus_confirmed", stage, verified };
  }
  if (stage.stage === "payments_success") {
    const verified = await verifyPlusSession(context, { logger });
    return { status: "done", reason: "payments_success", stage, verified };
  }
  const current = await detectPageStage(page);
  return { status: "skipped", reason: "success_url_not_observed", stage: current };
}
