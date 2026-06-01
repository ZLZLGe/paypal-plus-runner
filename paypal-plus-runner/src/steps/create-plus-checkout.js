import { createCheckout } from "../checkout-conversion/index.js";
import { resolveCheckoutOpenTarget } from "../checkout-conversion/hosted-url.js";
import { safeGotoWithRetry } from "../browser/page-utils.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function createPlusCheckoutStep(context, { accessToken = "", logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("create-plus-checkout requires a browser page");
  if (!accessToken) {
    const { readSessionJson } = await import("../providers/session-json.js");
    const session = await readSessionJson(page);
    accessToken = session.accessToken;
    context.sessionJson = session.sessionJson;
  }
  context.checkoutAccessToken = accessToken;
  const checkout = await createCheckout({ accessToken, config: context.config, logger });
  context.checkout = checkout;
  if (checkout.alreadyPaid) {
    context.plusAlreadyPaid = true;
    logger?.info?.("checkout conversion says account is already paid", {
      reason: checkout.alreadyPaidReason,
    });
    return { status: "skipped", reason: "already_paid", checkout };
  }
  const target = resolveCheckoutOpenTarget(checkout, context.config);
  context.checkoutOpenTarget = target;
  context.checkoutLongUrl = target.url;
  logger?.info?.("opening checkout URL", {
    provider: checkout.provider,
    checkoutSessionId: checkout.checkoutSessionId,
    targetType: target.type,
    targetPreference: target.preference,
    processorEntity: checkout.processorEntity,
    country: checkout.country,
    currency: checkout.currency,
    exitRegion: checkout.exitRegion,
    exitIp: checkout.exitIp,
  });
  const stage = await safeGotoWithRetry(page, target.url, {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: positiveInt(context.config.runner?.checkoutOpenNavigationAttempts, 3),
    retryDelayMs: positiveInt(context.config.runner?.checkoutOpenNavigationRetryDelayMs, 1500),
    onRetry: ({ attempt, maxAttempts, error }) => logger?.warn?.("checkout URL navigation failed; retrying", {
      attempt,
      maxAttempts,
      error: error.message,
      targetType: target.type,
      targetPreference: target.preference,
    }),
  });
  return { status: "done", reason: "checkout_opened", checkout, target, stage };
}
