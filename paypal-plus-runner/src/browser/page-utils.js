import { redactStringForOutput } from "../utils/safe-output.js";

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
  if (/pay\.openai\.com|checkout\.stripe\.com/i.test(host)) {
    return {
      stage: "hosted_checkout",
      url,
      host,
      path,
      stripePaypalRedirectSucceeded: isStripePaypalRedirectSucceededUrl(url),
    };
  }
  const isChatgptHost = /chatgpt\.com|chat\.openai\.com/i.test(host);

  if (isChatgptHost && /\/payments\/success/i.test(path)) {
    return { stage: "payments_success", url, host, path };
  }
  if (isChatgptHost && /\/checkout(?:\/|$)/i.test(path)) {
    return { stage: "chatgpt_checkout", url, host, path };
  }
  if (isChatgptHost && /\/auth\/login(?:\/|$)/i.test(path)) {
    return { stage: "chatgpt_login", url, host, path };
  }
  if (isChatgptHost) return { stage: "chatgpt", url, host, path };
  if (/auth0\.openai\.com|auth\.openai\.com|accounts\.openai\.com/i.test(host)) {
    return { stage: "openai_auth", url, host, path };
  }
  return { stage: "unknown", url, host, path };
}

export function isStripePaypalRedirectSucceededUrl(rawUrl = "") {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    return false;
  }
  const host = String(parsed.hostname || "").toLowerCase();
  if (!/(^|\.)checkout\.stripe\.com$/.test(host)) return false;
  if (!/^\/c\/pay\//i.test(String(parsed.pathname || ""))) return false;
  return String(parsed.searchParams.get("redirect_pm_type") || "").toLowerCase() === "paypal"
    && String(parsed.searchParams.get("redirect_status") || "").toLowerCase() === "succeeded";
}

export async function observePageState(page, { timeoutMs = 1500 } = {}) {
  const stage = await detectPageStage(page);
  const dom = await Promise.race([
    page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const pickText = (selector) => Array.from(document.querySelectorAll(selector))
      .map((el) => String(el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .find(Boolean) || "";
    const amountText = pickText([
      "[data-testid='product-summary-total-amount']",
      "[data-testid='product-summary-total']",
      ".ProductSummary-totalAmount",
      ".ProductSummaryTotalAmount",
    ].join(", "));
    const todayDueMatch = text.match(/(?:今日应付(?:合计)?|due today|amount due today|today'?s total|total due today)[^。\n]{0,160}/i);
    return {
      title: document.title || "",
      textSample: text.slice(0, 300),
      hasLoginForm: Boolean(document.querySelector("[data-testid='login-form']")),
      hasStrictEmailInput: Boolean(document.querySelector("[data-testid='login-form'] form input#email[name='email'][type='email'][aria-label='Email address']")),
      hasVerificationInput: Boolean(document.querySelector("input[autocomplete='one-time-code'], input[name*='code' i], input[inputmode='numeric']")),
      hasPasswordInput: Boolean(document.querySelector("input[type='password']")),
      hasPaypalButton: /paypal/i.test(text),
      hasPaymentsSuccessText: /payment.*success|thanks|thank you|success/i.test(text),
      checkoutAmountText: amountText.slice(0, 120),
      todayDueText: todayDueMatch?.[0] || "",
    };
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`observe page state timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).catch((error) => ({
    title: "",
    textSample: "",
    hasLoginForm: false,
    hasStrictEmailInput: false,
    hasVerificationInput: false,
    hasPasswordInput: false,
    hasPaypalButton: false,
    hasPaymentsSuccessText: false,
    checkoutAmountText: "",
    todayDueText: "",
    observeError: error.message,
  }));

  return { ...stage, ...dom };
}

export function compactPageStateForLog(state = {}) {
  return {
    stage: state.stage || "",
    host: state.host || "",
    path: state.path || "",
    url: state.url ? redactStringForOutput(state.url).slice(0, 500) : "",
    title: String(state.title || "").slice(0, 120),
    hasLoginForm: Boolean(state.hasLoginForm),
    hasStrictEmailInput: Boolean(state.hasStrictEmailInput),
    hasVerificationInput: Boolean(state.hasVerificationInput),
    hasPasswordInput: Boolean(state.hasPasswordInput),
    hasPaypalButton: Boolean(state.hasPaypalButton),
    hasPaymentsSuccessText: Boolean(state.hasPaymentsSuccessText),
    checkoutAmountText: String(state.checkoutAmountText || "").slice(0, 120),
    todayDueText: String(state.todayDueText || "").slice(0, 160),
    observeError: state.observeError || "",
  };
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

export function isRetryableNavigationError(error) {
  return /net::ERR_|ERR_SSL_PROTOCOL_ERROR|ERR_TUNNEL|ERR_PROXY|ERR_CONNECTION|ERR_TIMED_OUT|Timeout/i.test(
    String(error?.message || error || ""),
  );
}

export async function safeGotoWithRetry(page, url, {
  waitUntil = "domcontentloaded",
  timeoutMs = 120000,
  attempts = 3,
  retryDelayMs = 1500,
  blankBetweenAttempts = true,
  onRetry = null,
} = {}) {
  const maxAttempts = Math.max(1, Number.parseInt(String(attempts || 1), 10) || 1);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await safeGoto(page, url, { waitUntil, timeoutMs });
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !isRetryableNavigationError(error)) throw error;
      await onRetry?.({ attempt, maxAttempts, error });
      if (blankBetweenAttempts) {
        await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
      }
      await page.waitForTimeout(retryDelayMs);
    }
  }

  throw lastError;
}
