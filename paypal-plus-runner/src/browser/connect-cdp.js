import { chromium } from "playwright-core";

export async function connectOverCdp(wsEndpoint, { timeoutMs = 45000 } = {}) {
  const endpoint = String(wsEndpoint || "").trim();
  if (!endpoint) throw new Error("CDP ws endpoint is empty");
  const browser = await chromium.connectOverCDP(endpoint, { timeout: timeoutMs });
  const context = browser.contexts()[0] || await browser.newContext();
  let page = context.pages().find((item) => !item.isClosed());
  if (!page) page = await context.newPage();
  return { browser, context, page };
}
