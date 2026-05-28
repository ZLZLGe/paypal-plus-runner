const DEFAULT_ORIGINS = [
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://auth.openai.com",
  "https://auth0.openai.com",
  "https://accounts.openai.com",
  "https://pay.openai.com",
  "https://checkout.stripe.com",
  "https://www.paypal.com",
  "https://www.sandbox.paypal.com",
];

async function clearOriginStorage(client, origin) {
  await client.send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "all",
  });
}

export async function cleanupBrowserData(contextOrBrowserContext, { page = null, origins = DEFAULT_ORIGINS, logger = null } = {}) {
  const browserContext = contextOrBrowserContext?.browserContext
    || contextOrBrowserContext?.context
    || contextOrBrowserContext;
  const targetPage = page || contextOrBrowserContext?.page || browserContext?.pages?.()?.find((item) => !item.isClosed());
  if (!browserContext || !targetPage) return { status: "skipped", reason: "missing_browser_context_or_page" };

  await browserContext.clearCookies().catch((error) => {
    logger?.warn?.("browser cookie cleanup failed", { error: error.message });
  });
  if (typeof browserContext.clearPermissions === "function") {
    await browserContext.clearPermissions().catch(() => null);
  }

  const client = await browserContext.newCDPSession(targetPage);
  let clearedOrigins = 0;
  try {
    for (const origin of origins) {
      await clearOriginStorage(client, origin).catch((error) => {
        logger?.warn?.("origin storage cleanup failed", { origin, error: error.message });
      });
      clearedOrigins += 1;
    }
  } finally {
    await client.detach().catch(() => null);
  }
  await targetPage.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => null);
  return { status: "done", reason: "browser_data_cleared", clearedOrigins };
}
