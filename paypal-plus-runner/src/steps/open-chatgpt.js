import { safeGotoWithRetry } from "../browser/page-utils.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function openChatgptStep(context, { logger } = {}) {
  if (context.config.runner?.skipOpenChatgpt === true) return { status: "skipped", reason: "skipOpenChatgpt" };
  if (!context.page) throw new Error("open-chatgpt requires a browser page");
  const stage = await safeGotoWithRetry(context.page, "https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: positiveInt(context.config.runner?.openChatgptNavigationAttempts, 3),
    retryDelayMs: positiveInt(context.config.runner?.openChatgptNavigationRetryDelayMs, 1500),
    onRetry: ({ attempt, maxAttempts, error }) => logger?.warn?.("ChatGPT navigation failed; retrying", {
      attempt,
      maxAttempts,
      error: error.message,
    }),
  });
  return { status: "done", reason: "chatgpt_opened", stage };
}
