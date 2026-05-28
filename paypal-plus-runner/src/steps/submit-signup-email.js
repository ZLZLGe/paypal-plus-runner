import { safeGoto } from "../browser/page-utils.js";
import { RunnerError } from "../utils/errors.js";

export const STRICT_SIGNUP_EMAIL_SELECTORS = Object.freeze({
  loginForm: "[data-testid='login-form']",
  form: "[data-testid='login-form'] form",
  emailInput: "[data-testid='login-form'] form input#email[name='email'][type='email'][aria-label='Email address']",
  submitButton: "[data-testid='login-form'] form button[type='submit']",
  signupButton: "[data-testid='signup-button']",
  loginButton: "[data-testid='login-button']",
});

const EMAIL_INPUT_WITHIN_FORM_SELECTOR = "input#email[name='email'][type='email'][aria-label='Email address']";
const SUBMIT_BUTTON_WITHIN_FORM_SELECTOR = "button[type='submit']";
const STRICT_SUBMIT_TEXT_RE = /^continue$/i;
const THIRD_PARTY_ACTION_TEXT_RE = /google|apple|microsoft|phone|sso|single\s+sign[-\s]*on|workspace/i;

function hostFromUrl(rawUrl = "") {
  try {
    return String(new URL(String(rawUrl || "")).hostname || "").toLowerCase();
  } catch {
    return "";
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isThirdPartyOAuthHost(host = "") {
  const normalizedHost = String(host || "").toLowerCase();
  return /(^|\.)accounts\.google\.com$/.test(normalizedHost)
    || /(^|\.)appleid\.apple\.com$/.test(normalizedHost)
    || /(^|\.)login\.live\.com$/.test(normalizedHost)
    || /(^|\.)login\.microsoftonline\.com$/.test(normalizedHost);
}

export function isOpenAISignupHost(host = "") {
  const normalizedHost = String(host || "").toLowerCase();
  return /(^|\.)chatgpt\.com$/.test(normalizedHost)
    || /(^|\.)chat\.openai\.com$/.test(normalizedHost)
    || /(^|\.)auth\.openai\.com$/.test(normalizedHost)
    || /(^|\.)auth0\.openai\.com$/.test(normalizedHost)
    || /(^|\.)accounts\.openai\.com$/.test(normalizedHost);
}

export function isThirdPartyOAuthDetourUrl(rawUrl = "") {
  return isThirdPartyOAuthHost(hostFromUrl(rawUrl));
}

function stripTags(value = "") {
  return String(value || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function hasAttribute(html, name, expectedValue) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = String(expectedValue).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escapedName}\\s*=\\s*["']${escapedValue}["']`, "i").test(String(html || ""));
}

function findExactEmailInputInHtml(html = "") {
  const inputMatches = String(html || "").match(/<input\b[^>]*>/gi) || [];
  return inputMatches.some((input) => hasAttribute(input, "type", "email")
    && hasAttribute(input, "id", "email")
    && hasAttribute(input, "name", "email")
    && hasAttribute(input, "aria-label", "Email address"));
}

function findStrictSubmitButtonInHtml(html = "") {
  const buttonMatches = String(html || "").match(/<button\b[^>]*>[\s\S]*?<\/button>/gi) || [];
  return buttonMatches.some((button) => {
    if (!hasAttribute(button, "type", "submit")) return false;
    const text = stripTags(button);
    return STRICT_SUBMIT_TEXT_RE.test(text) && !THIRD_PARTY_ACTION_TEXT_RE.test(text);
  });
}

export function inspectStrictSignupEmailEntryHtml(html = "", rawUrl = "") {
  const host = hostFromUrl(rawUrl);
  if (isThirdPartyOAuthHost(host)) {
    return {
      ok: false,
      reason: "third_party_oauth_detour",
      host,
      hasExactEmailInput: false,
      hasStrictSubmitButton: false,
    };
  }
  if (host && !isOpenAISignupHost(host)) {
    return {
      ok: false,
      reason: "unsupported_signup_host",
      host,
      hasExactEmailInput: false,
      hasStrictSubmitButton: false,
    };
  }

  const source = String(html || "");
  const loginFormMatch = /\bdata-testid\s*=\s*["']login-form["']/i.exec(source);
  const loginFormSlice = loginFormMatch ? source.slice(loginFormMatch.index, loginFormMatch.index + 50000) : "";
  const hasLoginForm = Boolean(loginFormMatch);
  const hasForm = /<form\b/i.test(loginFormSlice);
  const hasExactEmailInput = hasLoginForm && hasForm && findExactEmailInputInHtml(loginFormSlice);
  const hasStrictSubmitButton = hasLoginForm && hasForm && findStrictSubmitButtonInHtml(loginFormSlice);
  return {
    ok: hasExactEmailInput && hasStrictSubmitButton,
    reason: hasExactEmailInput && hasStrictSubmitButton ? "strict_signup_email_entry" : "missing_strict_signup_email_entry",
    host,
    hasLoginForm,
    hasForm,
    hasExactEmailInput,
    hasStrictSubmitButton,
  };
}

export async function detectStrictSignupEmailEntrySurface(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const enabled = (el) => Boolean(el)
      && !el.disabled
      && el.getAttribute?.("aria-disabled") !== "true"
      && !el.hasAttribute?.("data-visually-disabled")
      && !/\bcursor-not-allowed\b|\bopacity-50\b/i.test(String(el.className || ""));
    const actionText = (el) => [
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const host = String(location.hostname || "").toLowerCase();
    const isThirdPartyOAuthDetour = /(^|\.)accounts\.google\.com$/.test(host)
      || /(^|\.)appleid\.apple\.com$/.test(host)
      || /(^|\.)login\.live\.com$/.test(host)
      || /(^|\.)login\.microsoftonline\.com$/.test(host);
    const isSupportedOpenAIHost = /(^|\.)chatgpt\.com$/.test(host)
      || /(^|\.)chat\.openai\.com$/.test(host)
      || /(^|\.)auth\.openai\.com$/.test(host)
      || /(^|\.)auth0\.openai\.com$/.test(host)
      || /(^|\.)accounts\.openai\.com$/.test(host);
    const strictLoginForms = Array.from(document.querySelectorAll("[data-testid='login-form']")).filter(visible);
    const forms = Array.from(document.querySelectorAll("[data-testid='login-form'] form")).filter(visible);
    const form = forms.length === 1 ? forms[0] : null;
    const emailInputs = form
      ? Array.from(form.querySelectorAll("input#email[name='email'][type='email'][aria-label='Email address']")).filter(visible)
      : [];
    const submitButtons = form
      ? Array.from(form.querySelectorAll("button[type='submit']")).filter(visible)
      : [];
    const strictSubmitButtons = submitButtons.filter((el) => {
      const text = actionText(el);
      return /^continue$/i.test(text) && !/google|apple|microsoft|phone|sso|single\s+sign[-\s]*on|workspace/i.test(text);
    });
    const emailInput = emailInputs.length === 1 ? emailInputs[0] : null;
    const submitButton = strictSubmitButtons.length === 1 ? strictSubmitButtons[0] : null;
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const homeAuthEntries = Array.from(document.querySelectorAll("[data-testid='signup-button'], [data-testid='login-button']"))
      .filter(visible)
      .map((el) => ({
        testId: el.getAttribute("data-testid") || "",
        text: actionText(el),
        href: el.href || el.getAttribute?.("href") || "",
      }));
    return {
      url: location.href,
      host,
      isThirdPartyOAuthDetour,
      isSupportedOpenAIHost,
      hasStrictLoginForm: strictLoginForms.length === 1,
      strictLoginFormCount: strictLoginForms.length,
      strictFormCount: forms.length,
      strictEmailInputCount: emailInputs.length,
      strictSubmitButtonCount: strictSubmitButtons.length,
      submitButtonTexts: submitButtons.map((el) => actionText(el)).filter(Boolean).slice(0, 8),
      isEmailEntryReady: !isThirdPartyOAuthDetour
        && isSupportedOpenAIHost
        && strictLoginForms.length === 1
        && forms.length === 1
        && emailInputs.length === 1
        && strictSubmitButtons.length === 1
        && enabled(emailInput)
        && enabled(submitButton),
      hasExactAuthEntryButton: homeAuthEntries.length > 0,
      homeAuthEntries,
      text: text.slice(0, 300),
    };
  }).catch(() => ({
    url: page.url(),
    host: "",
    isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
    isSupportedOpenAIHost: isOpenAISignupHost(hostFromUrl(page.url())),
    hasStrictLoginForm: false,
    strictLoginFormCount: 0,
    strictFormCount: 0,
    strictEmailInputCount: 0,
    strictSubmitButtonCount: 0,
    submitButtonTexts: [],
    isEmailEntryReady: false,
    hasExactAuthEntryButton: false,
    homeAuthEntries: [],
    text: "",
  }));
}

async function waitForStrictSignupEmailEntrySurface(page, { timeoutMs = 15000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  let state = await detectStrictSignupEmailEntrySurface(page);
  while (Date.now() - startedAt < timeoutMs) {
    state = await detectStrictSignupEmailEntrySurface(page);
    if (state.isThirdPartyOAuthDetour || state.isEmailEntryReady) return state;
    await page.waitForTimeout(pollMs);
  }
  return state;
}

async function clickExactLoggedOutAuthEntry(page) {
  const parsed = (() => {
    try {
      return new URL(page.url());
    } catch {
      return { hostname: "", pathname: "" };
    }
  })();
  if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(parsed.hostname || "")) {
    return { ok: false, reason: "not_chatgpt_home", url: page.url() };
  }

  for (const selector of [STRICT_SIGNUP_EMAIL_SELECTORS.signupButton, STRICT_SIGNUP_EMAIL_SELECTORS.loginButton]) {
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    if (count > 1) return { ok: false, reason: "ambiguous_exact_auth_entry", selector, count, url: page.url() };
    if (count !== 1) continue;
    const [visible, enabled, text, href] = await Promise.all([
      locator.isVisible().catch(() => false),
      locator.isEnabled().catch(() => false),
      locator.textContent({ timeout: 1000 }).catch(() => ""),
      locator.getAttribute("href", { timeout: 1000 }).catch(() => ""),
    ]);
    if (!visible || !enabled) {
      return {
        ok: false,
        reason: "exact_auth_entry_unavailable",
        selector,
        visible,
        enabled,
        url: page.url(),
      };
    }
    await locator.click({ timeout: 10000 });
    return {
      ok: true,
      reason: "clicked_exact_auth_entry",
      selector,
      text: String(text || "").replace(/\s+/g, " ").trim(),
      href: href || "",
      url: page.url(),
    };
  }

  return { ok: false, reason: "missing_exact_auth_entry", url: page.url() };
}

export async function openSignupEmailEntry(context, { logger } = {}) {
  const page = context.page;
  const timeoutMs = positiveInt(context.config.runner?.signupEntryRecoveryTimeoutMs, 20000);
  const pageLoadTimeoutMs = positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000);
  let state = await waitForStrictSignupEmailEntrySurface(page, { timeoutMs: 3000, pollMs: 250 });
  if (isThirdPartyOAuthDetourUrl(state.url || page.url())) {
    logger?.warn?.("signup email entry recovery leaving third-party oauth detour", {
      url: state.url || page.url(),
    });
    await safeGoto(page, "https://chatgpt.com/auth/login", {
      waitUntil: "domcontentloaded",
      timeoutMs: pageLoadTimeoutMs,
    }).catch((error) => {
      logger?.warn?.("third-party detour recovery navigation failed", { error: error.message });
    });
    state = await waitForStrictSignupEmailEntrySurface(page, { timeoutMs: 3000, pollMs: 250 });
  }
  if (state.isEmailEntryReady) return { ok: true, reason: "strict_entry_already_ready", state };

  const parsed = (() => {
    try {
      return new URL(page.url());
    } catch {
      return { hostname: "", pathname: "" };
    }
  })();
  const isChatgptHome = /chatgpt\.com|chat\.openai\.com/i.test(parsed.hostname || "")
    && !/\/auth|\/log-in|\/create-account|email-verification/i.test(parsed.pathname || "");
  if (isChatgptHome && state.hasExactAuthEntryButton && !state.hasStrictLoginForm) {
    const clicked = await clickExactLoggedOutAuthEntry(page);
    logger?.info?.("signup email opened exact auth entry", {
      clicked: clicked.ok,
      reason: clicked.reason,
      selector: clicked.selector,
      text: clicked.text,
      url: clicked.url,
    });
    if (clicked.ok) {
      state = await waitForStrictSignupEmailEntrySurface(page, { timeoutMs, pollMs: 250 });
      if (state.isEmailEntryReady) {
        return { ok: true, reason: "clicked_exact_auth_entry", clicked, state };
      }
    }
  }

  const authUrls = [
    "https://chatgpt.com/auth/login",
    "https://chatgpt.com/auth/login?next=%2F",
    String(context.config.runner?.signupEntryUrl || "").trim(),
  ].filter(Boolean);
  let lastNavigation = null;
  for (const url of [...new Set(authUrls)]) {
    lastNavigation = { url };
    await safeGoto(page, url, {
      waitUntil: "domcontentloaded",
      timeoutMs: pageLoadTimeoutMs,
    }).catch((error) => {
      lastNavigation = { url, error: error.message };
    });
    state = await waitForStrictSignupEmailEntrySurface(page, { timeoutMs, pollMs: 250 });
    if (state.isEmailEntryReady) {
      return { ok: true, reason: "navigated_strict_auth_entry", navigation: lastNavigation, state };
    }
  }

  return {
    ok: false,
    reason: "missing_strict_email_entry_after_recovery",
    navigation: lastNavigation,
    state,
  };
}

export async function directSubmitSignupEmail(page, email, { timeoutMs = 30000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectStrictSignupEmailEntrySurface(page).catch((error) => ({
      ok: false,
      reason: "strict_surface_detection_failed",
      error: error.message,
      url: page.url(),
    }));

    if (lastState.isThirdPartyOAuthDetour || isThirdPartyOAuthDetourUrl(lastState.url || page.url())) {
      return { ...lastState, ok: false, reason: "third_party_oauth_detour" };
    }
    if (lastState.isSupportedOpenAIHost === false) {
      return { ...lastState, ok: false, reason: "unsupported_signup_host" };
    }
    if (lastState.isEmailEntryReady) {
      const form = page.locator(STRICT_SIGNUP_EMAIL_SELECTORS.form);
      const emailInput = form.locator(EMAIL_INPUT_WITHIN_FORM_SELECTOR);
      const submitButton = form.locator(SUBMIT_BUTTON_WITHIN_FORM_SELECTOR);
      const [formCount, emailInputCount, submitButtonCount] = await Promise.all([
        form.count().catch(() => 0),
        emailInput.count().catch(() => 0),
        submitButton.count().catch(() => 0),
      ]);
      if (formCount !== 1 || emailInputCount !== 1 || submitButtonCount !== 1) {
        return {
          ok: false,
          reason: "strict_selector_count_mismatch",
          url: page.url(),
          formCount,
          emailInputCount,
          submitButtonCount,
          state: lastState,
        };
      }

      const [emailEnabled, submitEnabled, submitText] = await Promise.all([
        emailInput.isEnabled().catch(() => false),
        submitButton.isEnabled().catch(() => false),
        submitButton.textContent({ timeout: 1000 }).catch(() => ""),
      ]);
      const normalizedSubmitText = String(submitText || "").replace(/\s+/g, " ").trim();
      if (!emailEnabled) {
        return { ok: false, reason: "strict_email_input_disabled", url: page.url(), state: lastState };
      }
      if (!submitEnabled) {
        return {
          ok: false,
          reason: "strict_submit_button_disabled",
          url: page.url(),
          submitText: normalizedSubmitText,
          state: lastState,
        };
      }
      if (!STRICT_SUBMIT_TEXT_RE.test(normalizedSubmitText) || THIRD_PARTY_ACTION_TEXT_RE.test(normalizedSubmitText)) {
        return {
          ok: false,
          reason: "unexpected_strict_submit_button_text",
          url: page.url(),
          submitText: normalizedSubmitText,
          state: lastState,
        };
      }

      await emailInput.fill(email, { timeout: Math.min(10000, Math.max(1000, timeoutMs - (Date.now() - startedAt))) });
      await submitButton.click({
        timeout: Math.min(10000, Math.max(1000, timeoutMs - (Date.now() - startedAt))),
        noWaitAfter: true,
      });
      return {
        ok: true,
        reason: "strict_playwright_submit",
        url: page.url(),
        selector: {
          form: STRICT_SIGNUP_EMAIL_SELECTORS.form,
          emailInput: EMAIL_INPUT_WITHIN_FORM_SELECTOR,
          submitButton: SUBMIT_BUTTON_WITHIN_FORM_SELECTOR,
        },
        submitText: normalizedSubmitText,
      };
    }
    await page.waitForTimeout(pollMs);
  }
  return lastState ? { ...lastState, ok: false, reason: "strict_email_entry_timeout" } : { ok: false, reason: "timeout", url: page.url() };
}

export async function submitSignupEmailStep(context, { logger } = {}) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("submit-signup-email requires a browser page");
  let entry = await openSignupEmailEntry(context, { logger });
  if (!entry.ok) {
    throw new RunnerError(`步骤 2：未找到精确 OpenAI 邮箱入口。URL: ${context.page.url()}; recovery=${entry.reason || "unknown"}`, {
      code: "OPENAI_SIGNUP_EMAIL_SUBMIT_FAILED",
      retryable: true,
    });
  }
  let direct = await directSubmitSignupEmail(context.page, context.account.email, {
    timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
    pollMs: 250,
  });
  if (direct.ok) {
    context.signupEmailSubmittedAt = Date.now();
    await context.page.waitForTimeout(1500).catch(() => undefined);
    if (isThirdPartyOAuthDetourUrl(context.page.url())) {
      logger?.warn?.("direct signup email submission entered third-party oauth; retrying email entry", {
        url: context.page.url(),
      });
      entry = await openSignupEmailEntry(context, { logger });
      if (!entry.ok) {
        throw new RunnerError(`步骤 2：误入第三方登录后未恢复邮箱入口。URL: ${context.page.url()}; recovery=${entry.reason || "unknown"}`, {
          code: "OPENAI_SIGNUP_EMAIL_SUBMIT_FAILED",
          retryable: true,
        });
      }
      direct = await directSubmitSignupEmail(context.page, context.account.email, {
        timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
        pollMs: 250,
      });
      if (!direct.ok) {
        throw new RunnerError(`步骤 2：误入第三方登录后邮箱重提交失败：${direct.reason || "unknown"}`, {
          code: "OPENAI_SIGNUP_EMAIL_SUBMIT_FAILED",
          retryable: true,
        });
      }
      context.signupEmailSubmittedAt = Date.now();
    }
    return {
      status: "done",
      reason: "signup_email_submitted",
      result: { ok: true, direct, entry },
    };
  }

  if (direct.reason === "third_party_oauth_detour") {
    entry = await openSignupEmailEntry(context, { logger });
    if (entry.ok) {
      direct = await directSubmitSignupEmail(context.page, context.account.email, {
        timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
        pollMs: 250,
      });
      if (direct.ok) {
        context.signupEmailSubmittedAt = Date.now();
        return {
          status: "done",
          reason: "signup_email_submitted_after_entry_recovery",
          result: { ok: true, direct, entry },
        };
      }
    }
  }

  if (!direct.ok) {
    throw new RunnerError(`步骤 2：精确 OpenAI 邮箱提交失败：${direct.reason || "unknown"}。URL: ${context.page.url()}`, {
      code: "OPENAI_SIGNUP_EMAIL_SUBMIT_FAILED",
      retryable: true,
    });
  }
  context.signupEmailSubmittedAt = Date.now();
  return {
    status: "done",
    reason: "signup_email_submitted",
    result: { ok: true, direct, entry },
  };
}
