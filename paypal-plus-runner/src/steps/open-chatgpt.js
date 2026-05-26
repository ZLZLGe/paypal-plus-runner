import { safeGoto } from "../browser/page-utils.js";

export async function openChatgptStep(context) {
  if (context.config.runner?.skipOpenChatgpt === true) return { status: "skipped", reason: "skipOpenChatgpt" };
  if (!context.page) throw new Error("open-chatgpt requires a browser page");
  const stage = await safeGoto(context.page, "https://chatgpt.com/", {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
  });
  return { status: "done", reason: "chatgpt_opened", stage };
}
