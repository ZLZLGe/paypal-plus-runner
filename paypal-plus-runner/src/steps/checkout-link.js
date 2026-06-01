import { resolveCheckoutOpenTarget } from "../checkout-conversion/hosted-url.js";
import {
  getReadyCheckoutLinkForAccount,
  markCheckoutLinkPaying,
  saveReadyCheckoutLink,
} from "../db/checkout-link-store.js";
import { safeGotoWithRetry } from "../browser/page-utils.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rowToCheckoutLink(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    gptPhoneAccountId: row.gpt_phone_account_id,
    runId: row.run_id,
    checkoutLongUrl: row.checkout_long_url,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
  };
}

export async function saveCheckoutLongLinkStep(context, { logger } = {}) {
  if (!context.db) throw new Error("save-checkout-link requires a database");
  if (!context.gptPhoneAccountId) throw new Error("save-checkout-link requires gpt_phone_account_id");
  if (context.checkout?.alreadyPaid) {
    return { status: "skipped", reason: "already_paid", checkout: context.checkout };
  }
  const target = context.checkoutOpenTarget || resolveCheckoutOpenTarget(context.checkout || {}, context.config);
  const link = saveReadyCheckoutLink(context.db, {
    gptPhoneAccountId: context.gptPhoneAccountId,
    runId: context.runId,
    checkoutLongUrl: target.url,
  });
  context.checkoutLink = rowToCheckoutLink(link);
  context.checkoutLongUrl = target.url;
  logger?.info?.("checkout long link saved", {
    gptPhoneAccountId: context.gptPhoneAccountId,
    checkoutLinkId: link.id,
    status: link.status,
  });
  return {
    status: "done",
    reason: "checkout_long_link_saved",
    checkoutLink: context.checkoutLink,
  };
}

export async function openCheckoutLongLinkStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("open-checkout-link requires a browser page");
  if (!context.db) throw new Error("open-checkout-link requires a database");
  let link = context.checkoutLink?.id ? context.checkoutLink : null;
  if (!link && context.gptPhoneAccountId) {
    link = rowToCheckoutLink(getReadyCheckoutLinkForAccount(context.db, context.gptPhoneAccountId));
  }
  if (!link?.id || !link.checkoutLongUrl) {
    throw new Error("no ready checkout long link for account");
  }
  const updated = markCheckoutLinkPaying(context.db, link.id, { runId: context.runId });
  context.checkoutLink = rowToCheckoutLink(updated);
  context.checkoutLongUrl = context.checkoutLink.checkoutLongUrl;
  logger?.info?.("opening stored checkout long link", {
    checkoutLinkId: context.checkoutLink.id,
    gptPhoneAccountId: context.gptPhoneAccountId,
  });
  const stage = await safeGotoWithRetry(page, context.checkoutLongUrl, {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: positiveInt(context.config.runner?.checkoutOpenNavigationAttempts, 3),
    retryDelayMs: positiveInt(context.config.runner?.checkoutOpenNavigationRetryDelayMs, 1500),
    onRetry: ({ attempt, maxAttempts, error }) => logger?.warn?.("stored checkout link navigation failed; retrying", {
      attempt,
      maxAttempts,
      error: error.message,
      checkoutLinkId: context.checkoutLink.id,
    }),
  });
  return {
    status: "done",
    reason: "checkout_long_link_opened",
    checkoutLink: context.checkoutLink,
    stage,
  };
}
