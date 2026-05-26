export async function detectPageStage(page) {
  if (!page) return { stage: "no_page" };
  const url = page.url();
  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return { hostname: "", pathname: "" };
    }
  })();
  const host = String(parsed.hostname || "").toLowerCase();
  const path = String(parsed.pathname || "");

  if (/paypal\./i.test(host)) return { stage: "paypal", url, host, path };
  if (/pay\.openai\.com|checkout\.stripe\.com/i.test(host)) return { stage: "hosted_checkout", url, host, path };
  if (/chatgpt\.com|chat\.openai\.com/i.test(host) && /\/payments\/success/i.test(path)) {
    return { stage: "payments_success", url, host, path };
  }
  if (/chatgpt\.com|chat\.openai\.com/i.test(host)) return { stage: "chatgpt", url, host, path };
  if (/auth0\.openai\.com|auth\.openai\.com|accounts\.openai\.com/i.test(host)) {
    return { stage: "openai_auth", url, host, path };
  }
  return { stage: "unknown", url, host, path };
}

export async function waitForUrlStage(page, predicate, { timeoutMs = 120000, pollMs = 500 } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const stage = await detectPageStage(page);
    if (predicate(stage)) return stage;
    await page.waitForTimeout(pollMs);
  }
  return detectPageStage(page);
}

export async function safeGoto(page, url, { waitUntil = "domcontentloaded", timeoutMs = 120000 } = {}) {
  await page.goto(url, { waitUntil, timeout: timeoutMs });
  return detectPageStage(page);
}
