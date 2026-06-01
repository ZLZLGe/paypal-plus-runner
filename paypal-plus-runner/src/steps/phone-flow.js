import { dispatchChromeRuntimeMessage, injectSignupFlow } from "../browser/inject.js";
import { safeGotoWithRetry } from "../browser/page-utils.js";
import {
  cancelOpenAiPhoneActivation,
  discardOpenAiPhoneReuseActivation,
  pollOpenAiPhoneCode,
  requestOpenAiPhoneAdditionalSms,
  resolveOpenAiPhoneActivation,
} from "../providers/openai-phone.js";
import { dismissChatgptPrivacyDialog } from "./chatgpt-privacy.js";
import { detectLoggedInChatgpt } from "./signup-state.js";
import { buildSignupProfilePayload } from "./signup-profile.js";
import { WorkflowStepRetryError } from "../utils/errors.js";
import {
  markGptAccountFailure,
  markGptAccountRegistered,
  markOpenAiPhoneActivationStatus,
  releaseGptPhoneAccount,
} from "../db/gpt-phone-account-store.js";
import { updateRun } from "../db/run-history-store.js";

const JP_PHONE_ENTRY_TEXT = "電話番号で続行";
const JP_LOGIN_FORM_SELECTOR = "[data-testid='login-form']";
const JP_PHONE_ENTRY_SELECTOR = `${JP_LOGIN_FORM_SELECTOR} button[type='button']`;
const JP_PHONE_FORM_SELECTOR = `${JP_LOGIN_FORM_SELECTOR} form`;
const JP_PHONE_INPUT_SELECTOR = `${JP_PHONE_FORM_SELECTOR} input#phoneNumberInput[name='phoneNumberInput']`;
const JP_SIGNUP_PASSWORD_FORM_SELECTOR = "form[action='/create-account/password']";
const JP_SIGNUP_PASSWORD_INPUT_SELECTOR = `${JP_SIGNUP_PASSWORD_FORM_SELECTOR} input[name='new-password']`;
const JP_LOGIN_PASSWORD_FORM_SELECTOR = "form[action='/log-in/password']";
const JP_LOGIN_PASSWORD_INPUT_SELECTOR = `${JP_LOGIN_PASSWORD_FORM_SELECTOR} input[name='current-password']`;
const JP_COOKIE_DIALOG_SELECTOR = "div[role='dialog'][aria-modal='true']";
const JP_COOKIE_CLOSE_SELECTOR = "button[data-testid='close-button'][aria-label='閉じる'][type='button']";
const JP_COOKIE_DIALOG_HEADING_TEXT = "当社では cookies を使用しています";
const OPENAI_LOGIN_URL_RE = /\/\/auth\.openai\.com\/log-in(?:[/?#]|$)/i;
const LOCALHOST_CALLBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function normalizeActionText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isLocalhostOAuthCallbackUrl(value = "") {
  try {
    const parsed = new URL(String(value || ""));
    return LOCALHOST_CALLBACK_HOSTS.has(String(parsed.hostname || "").toLowerCase())
      && (Boolean(parsed.searchParams.get("code")) || Boolean(parsed.searchParams.get("error")));
  } catch {
    return false;
  }
}

function resolveLocalhostOAuthCallbackUrl(...values) {
  for (const value of values) {
    const candidate = String(value || "").trim();
    if (isLocalhostOAuthCallbackUrl(candidate)) return candidate;
  }
  return "";
}

async function getLocalhostOAuthCallbackUrlFromNavigationHistory(page) {
  if (!page?.context) return "";
  let client = null;
  try {
    client = await page.context().newCDPSession(page);
    const history = await client.send("Page.getNavigationHistory");
    const entries = Array.isArray(history?.entries) ? history.entries : [];
    const currentIndex = Number.isInteger(history?.currentIndex) ? history.currentIndex : entries.length - 1;
    const orderedEntries = [
      entries[currentIndex],
      ...entries.slice(0, currentIndex).reverse(),
      ...entries.slice(currentIndex + 1).reverse(),
    ].filter(Boolean);
    for (const entry of orderedEntries) {
      const localhostUrl = resolveLocalhostOAuthCallbackUrl(entry?.url, entry?.userTypedURL);
      if (localhostUrl) return localhostUrl;
    }
  } catch {
    return "";
  } finally {
    if (client) await client.detach().catch(() => undefined);
  }
  return "";
}

function isOpenAiPhoneCodeTimeout(error = {}) {
  const text = String(error?.message || error || "");
  return /OpenAI phone code timeout|等待 HeroSMS 验证码超时|WAIT_CODE|WAIT_RETRY|WAIT_RESEND/i.test(text);
}

function resolveSignupPhoneCodeTimeoutMs(config = {}) {
  return positiveInt(
    config.openaiPhone?.signupPollTimeoutMs
      ?? config.runner?.signupPhoneCodeTimeoutMs
      ?? 60000,
    60000,
  );
}

function resetSignupPhoneRegistrationState(context = {}) {
  context.signupPhoneActivation = null;
  context.signupPhoneNumber = "";
  context.signupPhoneSubmittedAt = 0;
  context.signupPhoneCodes = [];
  context.signupPhoneCompletedActivation = null;
  context.signupPhoneRegistrationSkipped = false;
  context.signupPhoneRecoveredExistingLogin = false;
  context.preserveOpenAiPhoneActivationOnFailure = false;
  context.accountIdentifierType = "";
  context.accountIdentifier = "";
  context.gptPhoneAccountId = null;
  context.gptPhoneAccount = null;
  context.gptPhoneLifecycleStatus = "";
  if (context.db && context.runId) {
    updateRun(context.db, context.runId, {
      gpt_phone_account_id: null,
      openai_phone_activation_id: null,
      account_lifecycle_status: "",
    });
  }
}

function openAiPhoneResolveOptions(context = {}, { allowNew = true } = {}) {
  return {
    db: context.db || null,
    runId: context.runId || "",
    workerId: context.workerId || "",
    gptPhoneAccountId: context.gptPhoneAccountId || context.gptPhoneAccount?.id || null,
    allowNew,
    leaseMinutes: Number(context.config?.runner?.gptAccountLeaseMinutes || 120),
    gptPassword: context.config?.runner?.gptPassword || "",
  };
}

function attachActivationToContext(context = {}, activation = {}) {
  context.signupPhoneActivation = activation;
  context.signupPhoneNumber = activation.phoneNumber;
  context.accountIdentifierType = "phone";
  context.accountIdentifier = activation.phoneNumber;
  if (activation.gptPhoneAccountId && !context.gptPhoneAccountId) {
    context.gptPhoneAccountId = activation.gptPhoneAccountId;
    context.gptPhoneLifecycleStatus = context.gptPhoneLifecycleStatus || "signup_pending";
    if (context.db && context.runId) {
      updateRun(context.db, context.runId, {
        gpt_phone_account_id: activation.gptPhoneAccountId,
        openai_phone_activation_id: activation.dbActivationId || null,
        account_lifecycle_status: context.gptPhoneLifecycleStatus,
      });
    }
  }
}

async function discardSignupActivationAfterCodeTimeout(context, activation, { logger, timeoutMs } = {}) {
  try {
    const result = await cancelOpenAiPhoneActivation(activation, context.config, { db: context.db });
    discardOpenAiPhoneReuseActivation(activation, context.config);
    logger?.warn?.("signup phone code timeout; cancelled HeroSMS activation before requesting a new phone", {
      phoneNumber: activation.phoneNumber,
      activationId: activation.activationId || "",
      timeoutMs,
      supported: result.supported,
      skipped: result.skipped,
    });
  } catch (cancelError) {
    const discard = discardOpenAiPhoneReuseActivation(activation, context.config);
    if (context.db && activation?.dbActivationId) {
      markOpenAiPhoneActivationStatus(context.db, activation, "failed", {
        error: cancelError.message,
      });
    }
    logger?.warn?.("signup phone code timeout; HeroSMS cancel failed but local reuse was discarded", {
      phoneNumber: activation.phoneNumber,
      activationId: activation.activationId || "",
      timeoutMs,
      error: cancelError.message,
      discardedReuse: Boolean(discard.discarded),
    });
  }
}

function abandonCurrentSignupPhoneAccount(context = {}, activation = {}, { logger, step = "", error = "" } = {}) {
  const gptPhoneAccountId = context.gptPhoneAccountId || activation?.gptPhoneAccountId || null;
  if (context.db && gptPhoneAccountId) {
    releaseGptPhoneAccount(context.db, gptPhoneAccountId, {
      runId: context.runId || "",
      error,
    });
    markGptAccountFailure(context.db, gptPhoneAccountId, {
      status: "disabled",
      step,
      error,
    });
    logger?.warn?.("disabled unusable signup GPT phone account before retry", {
      gptPhoneAccountId,
      step,
      phoneNumber: activation?.phoneNumber || "",
    });
  }
  resetSignupPhoneRegistrationState(context);
}

export function parsePhoneFlowRetryDelayMs(value, fallback = [5000, 10000, 15000, 20000]) {
  if (Array.isArray(value)) {
    const parsed = value.map((item) => positiveInt(item, 0)).filter((item) => item > 0);
    return parsed.length ? parsed : fallback;
  }
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = text.split(/[,\s]+/).map((item) => positiveInt(item, 0)).filter((item) => item > 0);
  return parsed.length ? parsed : fallback;
}

async function closeExactJpCookieDialog(page) {
  const state = await page.evaluate(({ dialogSelector, closeSelector, headingText }) => {
    const normalizeText = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const dialogs = Array.from(document.querySelectorAll(dialogSelector)).filter(visible);
    if (dialogs.length === 0) {
      return { present: false, reason: "cookie_dialog_not_present", dialogCount: 0, closeCount: 0 };
    }
    if (dialogs.length !== 1) {
      return { present: true, reason: "cookie_dialog_ambiguous", dialogCount: dialogs.length, closeCount: 0 };
    }
    const dialog = dialogs[0];
    const heading = normalizeText(dialog.querySelector("h1")?.textContent || "");
    const closeButtons = Array.from(dialog.querySelectorAll(closeSelector)).filter(visible);
    return {
      present: true,
      reason: heading === headingText && closeButtons.length === 1 ? "cookie_dialog_ready" : "cookie_dialog_shape_mismatch",
      dialogCount: dialogs.length,
      closeCount: closeButtons.length,
      heading,
    };
  }, {
    dialogSelector: JP_COOKIE_DIALOG_SELECTOR,
    closeSelector: JP_COOKIE_CLOSE_SELECTOR,
    headingText: JP_COOKIE_DIALOG_HEADING_TEXT,
  });
  if (!state.present) return { closed: false, ...state };
  if (state.reason !== "cookie_dialog_ready") {
    return { closed: false, ...state };
  }

  const dialog = page.locator(JP_COOKIE_DIALOG_SELECTOR);
  const dialogCount = await dialog.count().catch(() => 0);
  if (dialogCount !== 1) {
    return { closed: false, reason: "playwright_cookie_dialog_count_mismatch", dialogCount };
  }
  const closeButton = dialog.locator(JP_COOKIE_CLOSE_SELECTOR);
  const closeCount = await closeButton.count().catch(() => 0);
  if (closeCount !== 1) {
    return { closed: false, reason: "playwright_cookie_close_count_mismatch", dialogCount, closeCount };
  }
  await closeButton.click({ timeout: 5000, noWaitAfter: true });

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const stillPresent = await page.evaluate(({ dialogSelector, headingText }) => {
      const normalizeText = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const dialogs = Array.from(document.querySelectorAll(dialogSelector)).filter(visible);
      return dialogs.some((dialogEl) => normalizeText(dialogEl.querySelector("h1")?.textContent || "") === headingText);
    }, {
      dialogSelector: JP_COOKIE_DIALOG_SELECTOR,
      headingText: JP_COOKIE_DIALOG_HEADING_TEXT,
    });
    if (!stillPresent) {
      return { closed: true, reason: "cookie_dialog_closed", dialogCount, closeCount };
    }
    await page.waitForTimeout(100);
  }
  return { closed: false, reason: "cookie_dialog_close_timeout", dialogCount, closeCount };
}

async function waitForExactJpCookieDialogSettled(page, { timeoutMs = 6000, stableAbsentMs = 1000, pollMs = 200 } = {}) {
  const startedAt = Date.now();
  let absentSince = 0;
  let lastResult = null;
  let closedCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    lastResult = await closeExactJpCookieDialog(page);
    if (lastResult.present) {
      absentSince = 0;
      if (!lastResult.closed) {
        return { ...lastResult, settled: false, closedCount };
      }
      closedCount += 1;
      await page.waitForTimeout(pollMs);
      continue;
    }

    if (!absentSince) absentSince = Date.now();
    if (Date.now() - absentSince >= stableAbsentMs) {
      return {
        closed: closedCount > 0,
        closedCount,
        present: false,
        settled: true,
        reason: closedCount > 0 ? "cookie_dialog_closed_and_absent" : "cookie_dialog_absent_stable",
      };
    }
    await page.waitForTimeout(pollMs);
  }

  return {
    ...(lastResult || { closed: false, present: false, reason: "cookie_dialog_unknown" }),
    settled: false,
    closedCount,
    reason: lastResult?.reason || "cookie_dialog_settle_timeout",
  };
}

async function waitForExactAuthLoginClientReady(page, { timeoutMs = 12000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await page.evaluate(() => ({
      url: location.href,
      readyState: document.readyState,
      hasClientBootstrap: Boolean(document.querySelector("script#client-bootstrap[type='application/json']")),
      hasReactRouterContext: Boolean(window.__reactRouterContext),
      hasReactRouterRouteModules: Boolean(window.__reactRouterRouteModules),
      hasAuthLoginRouteModule: Boolean(window.__reactRouterRouteModules?.["routes/auth.login"]),
    })).catch((error) => ({ error: error.message, url: page.url() }));
    if (
      lastState.readyState === "complete"
      && lastState.hasClientBootstrap
      && lastState.hasReactRouterContext
      && lastState.hasReactRouterRouteModules
      && lastState.hasAuthLoginRouteModule
    ) {
      return { ready: true, state: lastState };
    }
    await page.waitForTimeout(pollMs);
  }
  return { ready: false, state: lastState };
}

async function settleExactPhoneEntryPage(page, { logger } = {}) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
  const clientReady = await waitForExactAuthLoginClientReady(page);
  logger?.info?.("exact auth login client ready result", {
    ready: clientReady.ready,
    state: clientReady.state,
  });
  const cookie = await waitForExactJpCookieDialogSettled(page);
  logger?.info?.("exact JP cookie dialog settle result", cookie);
  if (cookie.present && !cookie.closed) {
    throw new Error(`步骤 2：精确 cookie 对话框关闭失败。URL: ${page.url()} reason=${cookie.reason}`);
  }
  const privacy = await dismissChatgptPrivacyDialog(page);
  logger?.info?.("ChatGPT privacy dialog settle result", privacy);
  if (privacy.present && !privacy.settled) {
    throw new Error(`步骤 2：隐私弹窗关闭失败。URL: ${page.url()} reason=${privacy.reason}`);
  }
  return { clientReady, cookie, privacy };
}

async function openExactPhoneEntry(page) {
  const state = await page.evaluate(({ formSelector, entrySelector, phoneText }) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const actionText = (el) => [
      el?.textContent,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const loginForm = document.querySelector(formSelector);
    if (!loginForm || !visible(loginForm)) {
      return { ok: false, reason: "login_form_not_found", selector: formSelector, buttonText: "" };
    }
    const buttons = Array.from(loginForm.querySelectorAll("button[type='button']"))
      .filter(visible)
      .filter((el) => !el.disabled && el.getAttribute("aria-disabled") !== "true");
    const matching = buttons.filter((el) => actionText(el) === phoneText);
    if (matching.length !== 1) {
      return {
        ok: false,
        reason: matching.length > 1 ? "exact_phone_button_ambiguous" : "exact_phone_button_not_found",
        selector: entrySelector,
        count: matching.length,
        buttonText: buttons.map(actionText).filter(Boolean).join(" | ").slice(0, 240),
      };
    }
    return {
      ok: true,
      reason: "exact_phone_button_ready",
      selector: entrySelector,
      buttonText: actionText(matching[0]),
    };
  }, {
    formSelector: JP_LOGIN_FORM_SELECTOR,
    entrySelector: JP_PHONE_ENTRY_SELECTOR,
    phoneText: JP_PHONE_ENTRY_TEXT,
  });
  if (!state.ok) return { clicked: false, ...state };

  const buttons = page.locator(JP_PHONE_ENTRY_SELECTOR).filter({ hasText: JP_PHONE_ENTRY_TEXT });
  const count = await buttons.count().catch(() => 0);
  if (count !== 1) {
    return {
      clicked: false,
      reason: "playwright_jp_phone_button_text_mismatch",
      selector: JP_PHONE_ENTRY_SELECTOR,
      count,
      buttonText: state.buttonText,
    };
  }
  const locator = buttons;
  const text = normalizeActionText(await locator.textContent({ timeout: 1000 }).catch(() => ""));
  const [visible, enabled] = await Promise.all([
    locator.isVisible().catch(() => false),
    locator.isEnabled().catch(() => false),
  ]);
  if (text !== JP_PHONE_ENTRY_TEXT || !visible || !enabled) {
    return {
      clicked: false,
      reason: "playwright_exact_phone_button_unavailable",
      selector: JP_PHONE_ENTRY_SELECTOR,
      buttonText: text,
      visible,
      enabled,
    };
  }
  await locator.click({ timeout: 10000, noWaitAfter: true });
  return { clicked: true, reason: "exact_phone_button_clicked", selector: JP_PHONE_ENTRY_SELECTOR, buttonText: text };
}

async function waitForExactPhoneInput(page, { timeoutMs = 12000 } = {}) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectSignupPhoneEntrySurface(page);
    if (lastState.exactInputCount === 1) return { ready: true, state: lastState };
    await page.waitForTimeout(250);
  }
  return { ready: false, state: lastState };
}

async function openExactPhoneEntryAndWaitForInput(page, { logger, attempts = 3, timeoutMs = 12000 } = {}) {
  const maxAttempts = Math.max(1, Number.parseInt(String(attempts || 1), 10) || 1);
  let lastClickResult = null;
  let lastInputReady = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const cookie = await waitForExactJpCookieDialogSettled(page, {
      timeoutMs: attempt === 1 ? 3000 : 5000,
      stableAbsentMs: 700,
      pollMs: 200,
    });
    logger?.info?.("exact JP cookie dialog pre-click result", { attempt, ...cookie });
    if (cookie.present && !cookie.closed) {
      return {
        ok: false,
        reason: "cookie_dialog_blocking_phone_entry",
        attempt,
        cookie,
        clickResult: lastClickResult,
        inputReady: lastInputReady,
      };
    }
    const privacy = await dismissChatgptPrivacyDialog(page, {
      timeoutMs: attempt === 1 ? 3000 : 5000,
      stableAbsentMs: 700,
      pollMs: 200,
    });
    logger?.info?.("ChatGPT privacy dialog pre-click result", { attempt, ...privacy });
    if (privacy.present && !privacy.settled) {
      return {
        ok: false,
        reason: "privacy_dialog_blocking_phone_entry",
        attempt,
        privacy,
        clickResult: lastClickResult,
        inputReady: lastInputReady,
      };
    }

    const stateBeforeClick = await detectSignupPhoneEntrySurface(page);
    logger?.info?.("exact phone entry pre-click state", {
      attempt,
      reason: stateBeforeClick.reason,
      exactInputCount: stateBeforeClick.exactInputCount,
      phoneSwitchCount: stateBeforeClick.phoneSwitchCount,
      entryButtonCount: stateBeforeClick.entryButtonCount,
      thirdEntryButtonText: stateBeforeClick.thirdEntryButtonText,
      url: stateBeforeClick.url,
    });
    if (stateBeforeClick.exactInputCount === 1) {
      return {
        ok: true,
        reason: "phone_input_already_ready",
        attempt,
        state: stateBeforeClick,
      };
    }
    if (stateBeforeClick.reason !== "phone_entry_button_ready") {
      return {
        ok: false,
        reason: "exact_phone_entry_not_ready",
        attempt,
        state: stateBeforeClick,
        clickResult: lastClickResult,
        inputReady: lastInputReady,
      };
    }

    lastClickResult = await openExactPhoneEntry(page);
    logger?.info?.("exact phone entry click result", { attempt, ...lastClickResult });
    if (!lastClickResult.clicked) {
      return {
        ok: false,
        reason: lastClickResult.reason || "exact_phone_entry_click_failed",
        attempt,
        clickResult: lastClickResult,
        inputReady: lastInputReady,
      };
    }

    lastInputReady = await waitForExactPhoneInput(page, { timeoutMs });
    logger?.info?.("exact phone input wait result", {
      attempt,
      ready: lastInputReady.ready,
      reason: lastInputReady.state?.reason || "",
      url: lastInputReady.state?.url || page.url(),
    });
    if (lastInputReady.ready) {
      return {
        ok: true,
        reason: "phone_input_ready_after_exact_click",
        attempt,
        clickResult: lastClickResult,
        inputReady: lastInputReady,
      };
    }
  }

  return {
    ok: false,
    reason: "phone_input_not_ready_after_exact_click_retries",
    attempts: maxAttempts,
    clickResult: lastClickResult,
    inputReady: lastInputReady,
  };
}

export async function detectSignupPhoneEntrySurface(page) {
  return page.evaluate(({ formSelector, entrySelector, phoneInputSelector, phoneText }) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const textOf = (el) => [
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const host = String(location.hostname || "").toLowerCase();
    const isSupportedOpenAIHost = /(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$|(^|\.)auth\.openai\.com$|(^|\.)auth0\.openai\.com$|(^|\.)accounts\.openai\.com$/.test(host);
    const isThirdPartyOAuthDetour = /(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.live\.com$|(^|\.)login\.microsoftonline\.com$/.test(host);
    const loginForm = document.querySelector(formSelector);
    const forms = Array.from(document.querySelectorAll(`${formSelector} form`)).filter(visible);
    const phoneInputs = Array.from(document.querySelectorAll(phoneInputSelector)).filter(visible);
    const entryButtons = loginForm
      ? Array.from(loginForm.querySelectorAll("button[type='button']")).filter(visible)
      : [];
    const matchingEntryButtons = entryButtons.filter((button) => textOf(button) === phoneText);
    const thirdEntryButtonText = entryButtons.length >= 3 ? textOf(entryButtons[2]) : "";
    const hasExactJpPhoneEntryButton = matchingEntryButtons.length === 1;
    return {
      url: location.href,
      host,
      isSupportedOpenAIHost,
      isThirdPartyOAuthDetour,
      exactLoginFormCount: loginForm && visible(loginForm) ? 1 : 0,
      exactFormCount: forms.length,
      exactInputCount: phoneInputs.length,
      exactSubmitCount: Array.from(document.querySelectorAll(`${formSelector} form button[type='submit']`)).filter(visible).length,
      phoneSwitchCount: hasExactJpPhoneEntryButton ? 1 : 0,
      entryButtonCount: entryButtons.length,
      matchingEntryButtonCount: matchingEntryButtons.length,
      thirdEntryButtonText,
      phoneEntrySelector: entrySelector,
      ready: isSupportedOpenAIHost && !isThirdPartyOAuthDetour && (phoneInputs.length === 1 || hasExactJpPhoneEntryButton),
      reason: phoneInputs.length === 1 ? "phone_input_ready" : hasExactJpPhoneEntryButton ? "phone_entry_button_ready" : "phone_entry_not_ready",
      textSample: text.slice(0, 300),
    };
  }, {
    formSelector: JP_LOGIN_FORM_SELECTOR,
    entrySelector: JP_PHONE_ENTRY_SELECTOR,
    phoneInputSelector: JP_PHONE_INPUT_SELECTOR,
    phoneText: JP_PHONE_ENTRY_TEXT,
  });
}

async function detectPostSignupPhoneSubmitState(page) {
  return page.evaluate((selectors) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const signupPasswordForms = Array.from(document.querySelectorAll(selectors.signupPasswordForm)).filter(visible);
    const signupPasswordInputs = Array.from(document.querySelectorAll(selectors.signupPasswordInput)).filter(visible);
    const loginPasswordForms = Array.from(document.querySelectorAll(selectors.loginPasswordForm)).filter(visible);
    const loginPasswordInputs = Array.from(document.querySelectorAll(selectors.loginPasswordInput)).filter(visible);
    const phoneVerificationInputs = Array.from(document.querySelectorAll(
      "input[autocomplete='one-time-code'], input[inputmode='numeric'], input[type='tel'][maxlength='6']",
    )).filter(visible);
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const path = String(location.pathname || "");
    let state = "unknown";
    if (/\/create-account\/password(?:[/?#]|$)/i.test(path) && signupPasswordForms.length === 1 && signupPasswordInputs.length === 1) {
      state = "signup_password_page";
    } else if (/\/log-in\/password(?:[/?#]|$)/i.test(path) && loginPasswordForms.length === 1 && loginPasswordInputs.length === 1) {
      state = "existing_phone_login_password_page";
    } else if (phoneVerificationInputs.length > 0 && /code|verification|確認|認証|验证码|認証コード|verification code/i.test(text)) {
      state = "phone_verification_page";
    }
    return {
      state,
      url: location.href,
      path,
      signupPasswordFormCount: signupPasswordForms.length,
      signupPasswordInputCount: signupPasswordInputs.length,
      loginPasswordFormCount: loginPasswordForms.length,
      loginPasswordInputCount: loginPasswordInputs.length,
      phoneVerificationInputCount: phoneVerificationInputs.length,
      textSample: text.slice(0, 240),
    };
  }, {
    signupPasswordForm: JP_SIGNUP_PASSWORD_FORM_SELECTOR,
    signupPasswordInput: JP_SIGNUP_PASSWORD_INPUT_SELECTOR,
    loginPasswordForm: JP_LOGIN_PASSWORD_FORM_SELECTOR,
    loginPasswordInput: JP_LOGIN_PASSWORD_INPUT_SELECTOR,
  });
}

export async function waitForPostSignupPhoneSubmitState(page, {
  timeoutMs = 15000,
  pollMs = 300,
  finalGraceMs = 8000,
} = {}) {
  const startedAt = Date.now();
  const intervalMs = Math.max(100, Number(pollMs) || 300);
  let lastState = await detectPostSignupPhoneSubmitState(page).catch(() => ({
    state: "unknown",
    url: page.url(),
  }));
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectPostSignupPhoneSubmitState(page).catch(() => lastState);
    if (lastState.state !== "unknown") return lastState;
    await page.waitForTimeout(intervalMs);
  }

  const latePolls = Math.max(0, Math.ceil((Number(finalGraceMs) || 0) / intervalMs));
  for (let index = 0; index < latePolls; index += 1) {
    await page.waitForTimeout(intervalMs);
    const lateState = await detectPostSignupPhoneSubmitState(page).catch(() => lastState);
    if (lateState.state !== "unknown") {
      return {
        ...lateState,
        recoveredAfterTimeout: true,
        latePolls: index + 1,
        previousState: lastState.state,
        previousUrl: lastState.url,
      };
    }
    lastState = lateState;
  }
  return lastState;
}

async function releaseExistingPhoneActivation(context, activation, { logger, attempt } = {}) {
  if (!activation) return;
  try {
    const result = await cancelOpenAiPhoneActivation(activation, context.config, { db: context.db });
    discardOpenAiPhoneReuseActivation(activation, context.config);
    logger?.warn?.("existing OpenAI phone activation cancelled before retry", {
      attempt,
      phoneNumber: activation.phoneNumber,
      supported: result.supported,
      skipped: result.skipped,
      discardedReuse: true,
    });
  } catch (error) {
    const discard = discardOpenAiPhoneReuseActivation(activation, context.config);
    if (context.db && activation?.dbActivationId) {
      markOpenAiPhoneActivationStatus(context.db, activation, "failed", {
        error: error.message,
      });
    }
    logger?.warn?.("existing OpenAI phone activation cancel failed before retry", {
      attempt,
      phoneNumber: activation.phoneNumber,
      error: error.message,
      discardedReuse: Boolean(discard.discarded),
    });
  }
}

export function shouldRecoverExistingSignupPhoneLogin(activation = {}, config = {}) {
  if (config.runner?.recoverReusedSignupPhoneLogin === false) return false;
  return activation?.provider === "hero-sms"
    && activation?.reused === true
    && Boolean(activation.activationId)
    && Boolean(activation.phoneNumber);
}

export function shouldSkipSignupPhoneRegistrationSteps(context = {}) {
  return context.signupPhoneRegistrationSkipped === true
    || context.signupPhoneRecoveredExistingLogin === true;
}

function normalizeComparablePhone(value = "") {
  return String(value || "").replace(/\D+/g, "");
}

export function resolveSignupPhoneActivationForOauth(context = {}) {
  const activation = context.signupPhoneActivation;
  const phoneNumber = String(context.signupPhoneNumber || "").trim();
  if (!activation?.phoneNumber || !phoneNumber) {
    throw new Error("OAuth 手机登录缺少注册阶段手机号激活，禁止重新申请或切换手机号。");
  }
  if (normalizeComparablePhone(activation.phoneNumber) !== normalizeComparablePhone(phoneNumber)) {
    throw new Error(`OAuth 手机登录手机号与注册阶段不一致：activation=${activation.phoneNumber} signup=${phoneNumber}`);
  }
  if (
    context.accountIdentifierType === "phone"
    && context.accountIdentifier
    && normalizeComparablePhone(context.accountIdentifier) !== normalizeComparablePhone(phoneNumber)
  ) {
    throw new Error(`OAuth 手机登录手机号与注册账号标识不一致：identifier=${context.accountIdentifier} signup=${phoneNumber}`);
  }
  return { activation, phoneNumber };
}

async function submitOneSignupPhoneAttempt(context, activation, { logger, attempt } = {}) {
  attachActivationToContext(context, activation);

  const entryUrl = String(context.config.runner?.signupPhoneEntryUrl || context.config.runner?.signupEntryUrl || "https://chatgpt.com/auth/login");
  await safeGotoWithRetry(context.page, entryUrl, {
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: Number(context.config.runner?.openChatgptNavigationAttempts || 3),
  });
  await settleExactPhoneEntryPage(context.page, { logger });
  const state = await detectSignupPhoneEntrySurface(context.page);
  logger?.info?.("detected signup phone entry surface", { attempt, ...state });
  if (state.reason === "phone_entry_button_ready") {
    const opened = await openExactPhoneEntryAndWaitForInput(context.page, {
      logger,
      attempts: Number(context.config.runner?.phoneEntryExactClickAttempts || 3),
      timeoutMs: Number(context.config.runner?.phoneEntryTransitionTimeoutMs || 12000),
    });
    if (!opened.ok) {
      throw new Error(`步骤 2：点击精确手机号入口后没有出现结构化手机号输入框。URL: ${context.page.url()} reason=${opened.reason}`);
    }
  }
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  let result = null;
  try {
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "submit-signup-email",
      payload: {
        nodeId: "submit-signup-email",
        visibleStep: 2,
        signupMethod: "phone",
        phoneNumber: activation.phoneNumber,
        countryId: activation.countryId,
        countryLabel: activation.countryLabel,
        accountIdentifierType: "phone",
        accountIdentifier: activation.phoneNumber,
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
    });
    if (result?.error) throw new Error(result.error);
  } catch (error) {
    const postErrorState = await waitForPostSignupPhoneSubmitState(context.page, {
      timeoutMs: Number(context.config.runner?.signupPhonePostSubmitErrorStateTimeoutMs || 3000),
      finalGraceMs: Number(context.config.runner?.signupPhonePostSubmitStateGraceMs || 8000),
    });
    if (postErrorState.state === "existing_phone_login_password_page") {
      logger?.warn?.("signup phone submit reached existing phone password page after content error", {
        attempt,
        phoneNumber: activation.phoneNumber,
        error: error.message,
        url: postErrorState.url,
      });
      return { result: { recoveredFromContentError: true, error: error.message }, postSubmitState: postErrorState };
    }
    throw error;
  }
  if (context.db && activation.dbActivationId) {
    markOpenAiPhoneActivationStatus(context.db, activation, "submitted");
  }
  const postSubmitState = await waitForPostSignupPhoneSubmitState(context.page, {
    timeoutMs: Number(context.config.runner?.signupPhonePostSubmitStateTimeoutMs || 18000),
    finalGraceMs: Number(context.config.runner?.signupPhonePostSubmitStateGraceMs || 8000),
  });
  logger?.info?.("post signup phone submit exact state", {
    attempt,
    phoneNumber: activation.phoneNumber,
    ...postSubmitState,
  });
  return { result, postSubmitState };
}

export async function submitSignupPhoneStep(context, { logger } = {}) {
  if (!context.page) throw new Error("submit-signup-phone requires a browser page");
  const maxAttempts = Math.max(1, Number.parseInt(String(context.config.runner?.signupPhoneActivationMaxAttempts || 3), 10) || 3);
  let activation = null;
  let result = null;
  let lastExistingPhoneState = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    activation = await resolveOpenAiPhoneActivation(context.config, openAiPhoneResolveOptions(context));
    attachActivationToContext(context, activation);
    const attemptResult = await submitOneSignupPhoneAttempt(context, activation, { logger, attempt });
    result = attemptResult.result;
    const postSubmitState = attemptResult.postSubmitState;

    if (postSubmitState.state === "existing_phone_login_password_page") {
      lastExistingPhoneState = postSubmitState;
      if (shouldRecoverExistingSignupPhoneLogin(activation, context.config)) {
        context.preserveOpenAiPhoneActivationOnFailure = true;
        logger?.warn?.("reused signup phone reached login password page; recovering with known runner password", {
          attempt,
          phoneNumber: activation.phoneNumber,
          url: postSubmitState.url,
        });
        const recovery = await recoverSignupRedirectedLoginStep(context, { logger });
        if (!recovery.recovered) {
          throw new Error(`步骤 2：复用手机号已注册，但登录恢复未执行。URL: ${postSubmitState.url} reason=${recovery.reason || "unknown"}`);
        }
        context.signupPhoneRecoveredExistingLogin = true;
        context.signupPhoneRegistrationSkipped = true;
        context.signupPhoneSubmittedAt = Date.now();
        if (context.db && context.gptPhoneAccountId) {
          markGptAccountRegistered(context.db, context.gptPhoneAccountId, {
            activation,
            gptPassword: context.gptPassword || context.config.runner?.gptPassword || "myPASSword!2026",
            runId: context.runId,
            workerId: context.workerId,
          });
          context.gptPhoneLifecycleStatus = "registered";
          updateRun(context.db, context.runId, {
            account_lifecycle_status: "registered",
          });
        }
        return {
          status: "done",
          reason: "signup_phone_reused_existing_login",
          accountIdentifierType: "phone",
          accountIdentifier: activation.phoneNumber,
          signupPhoneNumber: activation.phoneNumber,
          gptPhoneAccountId: context.gptPhoneAccountId || activation.gptPhoneAccountId || null,
          recovery,
          result,
        };
      }
      await releaseExistingPhoneActivation(context, activation, { logger, attempt });
      abandonCurrentSignupPhoneAccount(context, activation, {
        logger,
        step: "submit-signup-phone",
        error: `signup phone already registered: ${activation.phoneNumber || ""}`,
      });
      if (attempt < maxAttempts) {
        logger?.warn?.("signup phone already registered; retrying with a new HeroSMS number", {
          attempt,
          maxAttempts,
          url: postSubmitState.url,
        });
        continue;
      }
      throw new Error(`步骤 2：手机号已进入登录密码页，说明该手机号已注册，已重试 ${maxAttempts} 次仍未拿到可注册号码。URL: ${postSubmitState.url}`);
    }

    if (postSubmitState.state !== "signup_password_page" && postSubmitState.state !== "phone_verification_page") {
      throw new Error(`步骤 2：手机号提交后未进入精确注册密码页或验证码页，当前状态：${postSubmitState.state}。URL: ${postSubmitState.url}`);
    }

    break;
  }

  if (!activation?.phoneNumber) {
    throw new Error(`步骤 2：未获取到可注册手机号。lastState=${lastExistingPhoneState?.state || "unknown"}`);
  }
  context.signupPhoneSubmittedAt = Date.now();
  return {
    status: "done",
    reason: "signup_phone_submitted",
    accountIdentifierType: "phone",
    accountIdentifier: activation.phoneNumber,
    signupPhoneNumber: activation.phoneNumber,
    gptPhoneAccountId: context.gptPhoneAccountId || activation.gptPhoneAccountId || null,
    result,
  };
}

export async function fetchSignupPhoneCodeStep(context, { logger } = {}) {
  if (shouldSkipSignupPhoneRegistrationSteps(context)) {
    return { status: "skipped", reason: "signup_phone_registration_already_recovered" };
  }
  if (!context.page) throw new Error("fetch-signup-phone-code requires a browser page");
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(
    context.config,
    openAiPhoneResolveOptions(context),
  );
  attachActivationToContext(context, activation);
  const timeoutMs = resolveSignupPhoneCodeTimeoutMs(context.config);
  let code = "";
  try {
    const result = await pollOpenAiPhoneCode(activation, context.config, { timeoutMs });
    code = result.code;
  } catch (error) {
    if (!isOpenAiPhoneCodeTimeout(error)) throw error;
    const retryCount = Number(context.signupPhoneCodeTimeoutRetries || 0) + 1;
    const retryMax = positiveInt(context.config.runner?.signupPhoneActivationMaxAttempts, 3);
    context.signupPhoneCodeTimeoutRetries = retryCount;
    await discardSignupActivationAfterCodeTimeout(context, activation, { logger, timeoutMs });
    abandonCurrentSignupPhoneAccount(context, activation, {
      logger,
      step: "fetch-signup-phone-code",
      error: `signup phone code timeout after ${Math.round(timeoutMs / 1000)}s`,
    });
    throw new WorkflowStepRetryError(
      `注册手机号 ${activation.phoneNumber} 在 ${Math.round(timeoutMs / 1000)} 秒内未收到验证码，已释放并换新手机号重试。`,
      {
        retryFromStep: "submit-signup-phone",
        retryReason: "signup_phone_code_timeout",
        retryMax,
        code: "OPENAI_SIGNUP_PHONE_CODE_TIMEOUT",
      },
    );
  }
  context.signupPhoneCodes = Array.from(new Set([...(context.signupPhoneCodes || []), code].filter(Boolean)));
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "SUBMIT_PHONE_VERIFICATION_CODE",
    source: "runner",
    step: 4,
    payload: {
      visibleStep: 4,
      purpose: "signup",
      code,
      signupProfile: buildSignupProfilePayload(context),
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  context.signupPhoneCompletedActivation = { ...activation, completedAt: new Date().toISOString() };
  context.preserveOpenAiPhoneActivationOnFailure = true;
  if (context.db && activation.dbActivationId) {
    markOpenAiPhoneActivationStatus(context.db, activation, "code_received", {
      completed: context.signupPhoneCompletedActivation,
    });
  }
  if (context.db && context.gptPhoneAccountId) {
    markGptAccountRegistered(context.db, context.gptPhoneAccountId, {
      activation,
      gptPassword: context.gptPassword || context.config.runner?.gptPassword || "myPASSword!2026",
      runId: context.runId,
      workerId: context.workerId,
    });
    context.gptPhoneLifecycleStatus = "registered";
    updateRun(context.db, context.runId, {
      account_lifecycle_status: "registered",
      gpt_phone_account_id: context.gptPhoneAccountId,
      openai_phone_activation_id: activation.dbActivationId || null,
    });
  }
  logger?.info?.("signup phone verification submitted", {
    phoneNumber: activation.phoneNumber,
    resultState: result?.state || "",
  });
  return { status: "done", reason: "signup_phone_code_submitted", result };
}

function isOpenAiLoginPageUrl(page) {
  return OPENAI_LOGIN_URL_RE.test(String(page?.url?.() || ""));
}

async function waitForChatgptLoggedInAfterRedirect(context, { timeoutMs = 15000, pollMs = 500 } = {}) {
  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectLoggedInChatgpt(context.page).catch(() => ({ loggedIn: false, url: context.page?.url?.() || "" }));
    if (lastState.loggedIn) return lastState;
    await context.page.waitForTimeout(pollMs);
  }
  return lastState || { loggedIn: false, url: context.page?.url?.() || "" };
}

async function recoverLoggedInShellAfterLoginStateError(context, { logger, phoneNumber = "", errorMessage = "" } = {}) {
  const loggedInState = await waitForChatgptLoggedInAfterRedirect(context, {
    timeoutMs: positiveInt(context.config.runner?.signupRedirectedLoginLoggedInWaitMs, 15000),
  });
  if (!loggedInState.loggedIn) return null;
  logger?.info?.("signup redirected phone login reached ChatGPT logged-in shell after plugin state error", {
    phoneNumber,
    error: errorMessage,
    url: loggedInState.url || context.page.url(),
  });
  return {
    step6Outcome: "success",
    state: "chatgpt_logged_in",
    skipLoginVerificationStep: true,
    loggedInState,
    recoveredFromPluginStateError: true,
  };
}

export async function detectPhoneLoginProfilePage(page) {
  const fallbackUrl = (() => {
    try {
      return String(page?.url?.() || "");
    } catch {
      return "";
    }
  })();
  if (!page || typeof page.evaluate !== "function") {
    return {
      profilePage: /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i.test(fallbackUrl),
      url: fallbackUrl,
    };
  }
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
    const path = String(location.pathname || "");
    const url = String(location.href || "");
    const title = String(document.title || "");
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const hasProfileRoute = /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i.test(path);
    const inputs = Array.from(document.querySelectorAll("input, select, [role='spinbutton'], [role='combobox']"));
    const hasNameInput = inputs.some((el) => {
      if (!visible(el)) return false;
      const meta = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        el.textContent,
      ].filter(Boolean).join(" ");
      return /name|first|last|given|family|氏名|姓名|名字|姓氏/i.test(meta);
    });
    const hasAgeOrBirthdayInput = inputs.some((el) => {
      if (!visible(el)) return false;
      const meta = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        el.getAttribute("data-type"),
        el.textContent,
      ].filter(Boolean).join(" ");
      return /age|birth|birthday|month|day|year|年齢|何才|出生|生日/i.test(meta);
    });
    const hasProfileCopy = /何才ですか|年齢を確認|tell us about yourself|how old are you|date of birth|氏名|姓名|生日|年齢/i
      .test(`${title} ${text}`);
    return {
      profilePage: Boolean(hasProfileRoute || (hasNameInput && hasAgeOrBirthdayInput) || (hasProfileRoute && hasProfileCopy)),
      url,
      path,
      title,
      hasNameInput,
      hasAgeOrBirthdayInput,
      hasProfileCopy,
    };
  }).catch(() => ({
    profilePage: /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i.test(fallbackUrl),
    url: fallbackUrl,
  }));
}

async function recoverPhoneLoginProfileAlreadyAdvanced(context, { logger, errorMessage = "" } = {}) {
  const profileState = await detectPhoneLoginProfilePage(context.page).catch(() => ({
    profilePage: false,
    url: context.page?.url?.() || "",
  }));
  if (profileState.profilePage) return null;

  const loggedIn = await detectLoggedInChatgpt(context.page).catch(() => ({
    loggedIn: false,
    url: context.page?.url?.() || "",
  }));
  if (!loggedIn.loggedIn) return null;

  context.signupProfileCompletedAfterLogin = true;
  logger?.info?.("phone login profile page already advanced to ChatGPT; treating profile as completed", {
    url: loggedIn.url || context.page?.url?.() || "",
    error: errorMessage,
  });
  return {
    completed: true,
    profileState,
    result: {
      skipped: true,
      reason: "profile_already_advanced_to_chatgpt",
      loggedIn,
      error: errorMessage,
    },
  };
}

export async function completePhoneLoginProfileIfNeeded(context, {
  logger,
  injectRuntime = injectSignupFlow,
  dispatchMessage = dispatchChromeRuntimeMessage,
} = {}) {
  const profileState = await detectPhoneLoginProfilePage(context.page);
  if (!profileState.profilePage) {
    return { completed: false, profileState };
  }
  logger?.info?.("phone login reached signup profile page; completing profile before continuing", {
    url: profileState.url,
    title: profileState.title || "",
  });
  await injectRuntime(context.page, { pluginRoot: context.config.plugin?.root });
  let result = null;
  try {
    result = await dispatchMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "fill-profile",
      payload: {
        nodeId: "fill-profile",
        visibleStep: 5,
        ...buildSignupProfilePayload(context),
      },
    }, {
      onRetry: async () => injectRuntime(context.page, { pluginRoot: context.config.plugin?.root }),
    });
  } catch (error) {
    const recovered = await recoverPhoneLoginProfileAlreadyAdvanced(context, {
      logger,
      errorMessage: error.message,
    });
    if (recovered) return recovered;
    throw error;
  }
  if (result?.error) {
    const recovered = await recoverPhoneLoginProfileAlreadyAdvanced(context, {
      logger,
      errorMessage: result.error,
    });
    if (recovered) {
      return {
        ...recovered,
        profileState,
      };
    }
    throw new Error(result.error);
  }
  context.signupProfileCompletedAfterLogin = true;
  return { completed: true, profileState, result };
}

async function loginWithSignupPhoneOnCurrentPage(context, { logger } = {}) {
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(
    context.config,
    openAiPhoneResolveOptions(context, { allowNew: false }),
  );
  const phoneNumber = context.signupPhoneNumber || context.accountIdentifier || activation.phoneNumber;
  const privacy = await dismissChatgptPrivacyDialog(context.page, {
    timeoutMs: Number(context.config.runner?.chatgptPrivacyDialogTimeoutMs || 6000),
  });
  logger?.info?.("ChatGPT privacy dialog before phone login result", privacy);
  if (privacy.present && !privacy.settled) {
    throw new Error(`手机号登录前隐私弹窗关闭失败。URL: ${context.page.url()} reason=${privacy.reason}`);
  }
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  let login = null;
  try {
    login = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "oauth-login",
      payload: {
        nodeId: "oauth-login",
        visibleStep: 5,
        loginIdentifierType: "phone",
        phoneNumber,
        countryId: activation.countryId,
        countryLabel: activation.countryLabel,
        accountIdentifierType: "phone",
        accountIdentifier: phoneNumber,
        password: context.gptPassword || context.config.runner?.gptPassword || "myPASSword!2026",
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
    });
  } catch (error) {
    const recovered = await recoverLoggedInShellAfterLoginStateError(context, {
      logger,
      phoneNumber,
      errorMessage: error.message,
    });
    if (recovered) return recovered;
    throw error;
  }
  if (login?.error) {
    const recovered = await recoverLoggedInShellAfterLoginStateError(context, {
      logger,
      phoneNumber,
      errorMessage: login.error,
    });
    if (recovered) return recovered;
    throw new Error(login.error);
  }
  if (!loginCompletedWithoutSms(login)) {
    const loggedInState = await waitForChatgptLoggedInAfterRedirect(context, {
      timeoutMs: positiveInt(context.config.runner?.signupRedirectedLoginLoggedInWaitMs, 15000),
    });
    if (loggedInState.loggedIn) {
      login = {
        ...login,
        state: "chatgpt_logged_in",
        skipLoginVerificationStep: true,
        loggedInState,
      };
    }
  }
  logger?.info?.("signup flow redirected to login; submitted same phone login", {
    phoneNumber,
    resultState: login?.state || "",
  });
  return login;
}

async function submitSignupPhoneLoginCodeIfNeeded(context, { logger } = {}) {
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(
    context.config,
    openAiPhoneResolveOptions(context, { allowNew: false }),
  );
  if (!context.loginPhoneAdditionalSmsRequested) {
    try {
      await requestOpenAiPhoneAdditionalSms(activation, context.config);
    } catch (error) {
      if (!/BAD_STATUS/i.test(String(error?.message || ""))) {
        throw error;
      }
      logger?.warn?.("HeroSMS additional sms request returned BAD_STATUS; polling activation without resend status", {
        phoneNumber: activation.phoneNumber,
        error: error.message,
      });
      context.loginPhoneAdditionalSmsRequestError = error.message;
    }
    context.loginPhoneAdditionalSmsRequested = true;
  }
  const ignoredCodes = context.signupPhoneCodes || [];
  const { code } = await pollOpenAiPhoneCode(activation, context.config, { ignoreCodes: ignoredCodes });
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "SUBMIT_PHONE_VERIFICATION_CODE",
    source: "runner",
    step: 5,
    payload: {
      visibleStep: 5,
      purpose: "login",
      code,
      signupProfile: buildSignupProfilePayload(context),
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  context.preserveOpenAiPhoneActivationOnFailure = true;
  logger?.info?.("signup redirected login phone verification submitted", {
    phoneNumber: activation.phoneNumber,
    resultState: result?.state || "",
  });
  return result;
}

function loginCompletedWithoutSms(login = {}) {
  return Boolean(login?.skipLoginVerificationStep || login?.addEmailPage || login?.oauthConsentPage);
}

function loginResultCanAdvance(login = {}) {
  return loginCompletedWithoutSms(login) || loginVerificationReady(login);
}

function loginVerificationReady(login = {}) {
  const state = String(login?.state || "").trim();
  return login?.step6Outcome === "success"
    && (state === "verification_page" || state === "phone_verification_page");
}

function loginPasswordRetryable(login = {}) {
  const text = [
    login?.step6Outcome,
    login?.state,
    login?.reason,
    login?.message,
  ].filter(Boolean).join(" ");
  return /recoverable/i.test(text) && /password|パスワード|密码/i.test(text);
}

function oauthPhoneLoginRetryable(login = {}) {
  const text = [
    login?.step6Outcome,
    login?.state,
    login?.reason,
    login?.message,
  ].filter(Boolean).join(" ");
  return /recoverable/i.test(text)
    && /phone_login_entry_switch_stalled|missing_phone_login_entry_trigger|email_page|entry_page|手机号登录入口|電話番号/i.test(text);
}

export async function recoverSignupRedirectedLoginStep(context, { logger } = {}) {
  if (!context.page || !isOpenAiLoginPageUrl(context.page)) {
    return { recovered: false, reason: "not_openai_login_page" };
  }

  const retryDelaysMs = parsePhoneFlowRetryDelayMs(
    context.config.runner?.signupRedirectedLoginRetryDelaysMs
      ?? context.config.runner?.authTryAgainRetryDelaysMs,
  );
  let lastLogin = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    lastLogin = await loginWithSignupPhoneOnCurrentPage(context, { logger });
    if (loginCompletedWithoutSms(lastLogin)) {
      context.preserveOpenAiPhoneActivationOnFailure = true;
      return { recovered: true, reason: "phone_login_completed_without_sms", login: lastLogin };
    }
    if (loginVerificationReady(lastLogin)) {
      const code = await submitSignupPhoneLoginCodeIfNeeded(context, { logger });
      return { recovered: true, reason: "phone_login_code_submitted", login: lastLogin, code };
    }
    const profile = await detectPhoneLoginProfilePage(context.page);
    if (profile.profilePage) {
      context.preserveOpenAiPhoneActivationOnFailure = true;
      return { recovered: true, reason: "phone_login_profile_page", login: lastLogin, profile };
    }
    if (loginPasswordRetryable(lastLogin)) {
      const delayMs = retryDelaysMs[attempt];
      if (!delayMs) break;
      logger?.warn?.("signup redirected phone login still on password page; retrying with stepped delay", {
        attempt: attempt + 1,
        total: retryDelaysMs.length,
        delayMs,
        state: lastLogin.state || "",
        reason: lastLogin.reason || "",
        url: lastLogin.url || context.page.url(),
      });
      await context.page.waitForTimeout(delayMs);
      continue;
    }
    break;
  }

  throw new Error(`注册后手机号登录恢复未进入验证码页。state=${lastLogin?.state || "unknown"} reason=${lastLogin?.reason || ""} URL: ${lastLogin?.url || context.page.url()}`);
}

export async function loginExistingPhoneStep(context, { logger } = {}) {
  if (!context.page) throw new Error("login-existing-phone requires a browser page");
  const loggedIn = await detectLoggedInChatgpt(context.page).catch(() => ({ loggedIn: false }));
  if (loggedIn.loggedIn) {
    return { status: "skipped", reason: "already_logged_in", loggedIn };
  }
  const { activation, phoneNumber } = resolveSignupPhoneActivationForOauth(context);
  const entryUrl = String(context.config.runner?.signupPhoneEntryUrl || context.config.runner?.signupEntryUrl || "https://chatgpt.com/auth/login");
  await safeGotoWithRetry(context.page, entryUrl, {
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: Number(context.config.runner?.openChatgptNavigationAttempts || 3),
  });
  await settleExactPhoneEntryPage(context.page, { logger }).catch((error) => {
    logger?.warn?.("existing phone login page settle failed; continuing with oauth-login runtime", {
      phoneNumber,
      error: error.message,
    });
  });
  context.signupPhoneActivation = activation;
  context.signupPhoneNumber = phoneNumber;
  const login = await loginWithSignupPhoneOnCurrentPage(context, { logger });
  if (loginCompletedWithoutSms(login)) {
    return { status: "done", reason: "existing_phone_login_completed_without_sms", login };
  }
  if (loginVerificationReady(login)) {
    const code = await submitSignupPhoneLoginCodeIfNeeded(context, { logger });
    const profile = await completePhoneLoginProfileIfNeeded(context, { logger });
    if (profile.completed) {
      return { status: "done", reason: "existing_phone_login_code_profile_completed", login, code, profile };
    }
    return { status: "done", reason: "existing_phone_login_code_submitted", login, code };
  }
  const profile = await completePhoneLoginProfileIfNeeded(context, { logger });
  if (profile.completed) {
    return { status: "done", reason: "existing_phone_login_profile_completed", login, profile };
  }
  throw new Error(`已有手机号账号登录未完成。state=${login?.state || "unknown"} reason=${login?.reason || ""} URL: ${login?.url || context.page.url()}`);
}

export async function oauthLoginPhoneStep(context, { logger } = {}) {
  if (!context.page) throw new Error("oauth-login-phone requires a browser page");
  if (!context.oauthUrl) throw new Error("oauth-login-phone requires context.oauthUrl from CPA");
  await safeGotoWithRetry(context.page, context.oauthUrl, {
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: Number(context.config.runner?.openChatgptNavigationAttempts || 3),
  });
  logger?.info?.("opened CPA OAuth URL for phone login", {
    hasOauthUrl: true,
    hasState: Boolean(context.cpaOAuthState),
  });
  const { activation: resolvedActivation, phoneNumber } = resolveSignupPhoneActivationForOauth(context);
  const retryDelaysMs = parsePhoneFlowRetryDelayMs(
    context.config.runner?.oauthPhoneLoginRetryDelaysMs
      ?? context.config.runner?.signupRedirectedLoginRetryDelaysMs
      ?? [2500, 5000],
    [2500, 5000],
  );
  let result = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "oauth-login",
      payload: {
        nodeId: "oauth-login",
        visibleStep: 10,
        loginIdentifierType: "phone",
        phoneNumber,
        countryId: resolvedActivation.countryId,
        countryLabel: resolvedActivation.countryLabel,
        accountIdentifierType: "phone",
        accountIdentifier: phoneNumber,
        password: context.gptPassword || context.config.runner?.gptPassword || "myPASSword!",
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
    });
    if (result?.error) throw new Error(result.error);
    if (loginResultCanAdvance(result)) break;

    const delayMs = retryDelaysMs[attempt];
    if (delayMs && oauthPhoneLoginRetryable(result)) {
      logger?.warn?.("OAuth phone login stayed on entry page; retrying after short delay", {
        attempt: attempt + 1,
        total: retryDelaysMs.length + 1,
        delayMs,
        state: result?.state || "",
        reason: result?.reason || "",
        url: result?.url || context.page.url(),
      });
      await context.page.waitForTimeout(delayMs);
      continue;
    }
    break;
  }
  if (!loginResultCanAdvance(result)) {
    throw new Error(
      `OAuth 手机登录未进入验证码页、添加邮箱页或授权页。state=${result?.state || "unknown"} reason=${result?.reason || ""} URL: ${result?.url || context.page.url()}`,
    );
  }
  context.oauthLoginResult = result;
  context.oauthLoginCompletedWithoutSms = loginCompletedWithoutSms(result);
  context.oauthLoginDirectConsentPage = Boolean(result?.oauthConsentPage || result?.directOAuthConsentPage);
  return { status: "done", reason: "oauth_phone_login_submitted", result };
}

export async function fetchLoginPhoneCodeStep(context, {
  logger,
  requestAdditionalSms = requestOpenAiPhoneAdditionalSms,
  pollPhoneCode = pollOpenAiPhoneCode,
} = {}) {
  if (!context.page) throw new Error("fetch-login-phone-code requires a browser page");
  if (context.oauthLoginCompletedWithoutSms || loginCompletedWithoutSms(context.oauthLoginResult)) {
    return { status: "skipped", reason: "oauth_login_completed_without_sms" };
  }
  const { activation } = resolveSignupPhoneActivationForOauth(context);
  const ignoredCodes = context.signupPhoneCodes || [];
  if (!context.loginPhoneAdditionalSmsRequested) {
    try {
      await requestAdditionalSms(activation, context.config);
    } catch (error) {
      if (!/BAD_STATUS/i.test(String(error?.message || ""))) {
        throw error;
      }
      logger?.warn?.("HeroSMS additional sms request returned BAD_STATUS during OAuth login; polling activation without resend status", {
        phoneNumber: activation.phoneNumber,
        error: error.message,
      });
      context.loginPhoneAdditionalSmsRequestError = error.message;
    }
    context.loginPhoneAdditionalSmsRequested = true;
  }
  const { code } = await pollPhoneCode(activation, context.config, { ignoreCodes: ignoredCodes });
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "SUBMIT_PHONE_VERIFICATION_CODE",
    source: "runner",
    step: 11,
    payload: {
      visibleStep: 11,
      purpose: "login",
      code,
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  const profile = await completePhoneLoginProfileIfNeeded(context, { logger });
  if (profile.completed) {
    return { status: "done", reason: "login_phone_code_profile_completed", result, profile };
  }
  return { status: "done", reason: "login_phone_code_submitted", result };
}

export async function bindEmailStep(context) {
  if (!context.page) throw new Error("bind-email requires a browser page");
  if (context.oauthLoginDirectConsentPage) {
    return { status: "skipped", reason: "oauth_login_already_on_consent_page" };
  }
  if (!context.account?.email) throw new Error("bind-email requires a leased Outlook email");
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "SUBMIT_ADD_EMAIL",
    source: "runner",
    step: 12,
    payload: {
      visibleStep: 12,
      email: context.account.email,
      targetEmail: context.account.email,
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.submitted) {
    context.boundEmail = context.account.email;
    context.boundEmailSubmitted = true;
    context.bindEmailSubmittedAt = Date.now();
  }
  if (result?.error) throw new Error(result.error);
  if (!context.boundEmailSubmitted) {
    context.boundEmail = context.account.email;
    context.boundEmailSubmitted = true;
    context.bindEmailSubmittedAt = Date.now();
  }
  return { status: "done", reason: "bind_email_submitted", result };
}

async function detectOAuthEmailVerifiedPage(page) {
  if (!page) return { verified: false, url: "" };
  return page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const title = String(document.title || "");
    const verified = /メールが確認されました|メールアドレス.*確認済み|email\s+(?:has\s+been\s+)?(?:verified|confirmed)|email_verified["',:\s]+true/i
      .test(`${title} ${text}`);
    return { verified, title, url: location.href };
  }).catch(() => ({ verified: false, url: page.url() }));
}

function markBoundEmailVerified(context, email = "") {
  context.boundEmail = email || context.boundEmail || context.account?.email || "";
  context.boundEmailSubmitted = true;
  context.boundEmailVerified = true;
}

function markBoundEmailCompleted(context, email = "") {
  markBoundEmailVerified(context, email);
  context.boundEmailCompleted = true;
  context.boundEmailNeedsRebind = false;
}

async function inspectOAuthContinuationState(page) {
  const fallbackUrl = (() => {
    try {
      return String(page?.url?.() || "");
    } catch {
      return "";
    }
  })();
  const fallback = {
    url: fallbackUrl,
    path: "",
    title: "",
    emailVerifiedPage: false,
    verificationPage: /\/email-verification(?:[/?#]|$)/i.test(fallbackUrl),
    addEmailPage: /\/add-email(?:[/?#]|$)/i.test(fallbackUrl),
    chooseAccountPage: /\/choose-an-account(?:[/?#]|$)/i.test(fallbackUrl),
    oauthConsentPage: /\/sign-in-with-chatgpt\/.*\/consent(?:[/?#]|$)/i.test(fallbackUrl),
    localhostUrl: resolveLocalhostOAuthCallbackUrl(fallbackUrl),
  };
  if (!page || typeof page.evaluate !== "function") return fallback;
  const state = await page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const title = String(document.title || "");
    const path = String(location.pathname || "");
    const url = String(location.href || "");
    const emailVerifiedPage = /メールが確認されました|メールアドレス.*確認済み|email\s+(?:has\s+been\s+)?(?:verified|confirmed)|email_verified["',:\s]+true/i
      .test(`${title} ${text}`);
    const verificationPage = /\/email-verification(?:[/?#]|$)/i.test(path);
    const addEmailPage = /\/add-email(?:[/?#]|$)/i.test(path)
      || Boolean(document.querySelector('form[action*="/add-email" i]'));
    const chooseAccountPage = /\/choose-an-account(?:[/?#]|$)/i.test(path);
    const oauthConsentPage = /\/sign-in-with-chatgpt\/.*\/consent(?:[/?#]|$)/i.test(path)
      || Boolean(document.querySelector('form[action*="/sign-in-with-chatgpt/" i][action*="/consent" i]'))
      || /sign\s+in\s+to\s+codex|log\s+in\s+to\s+codex|使用\s*ChatGPT\s*登录到\s*Codex|authorize|授权/i.test(text);
    return {
      url,
      path,
      title,
      emailVerifiedPage,
      verificationPage,
      addEmailPage,
      chooseAccountPage,
      oauthConsentPage,
    };
  }).catch(() => fallback);
  return {
    ...fallback,
    ...state,
    localhostUrl: resolveLocalhostOAuthCallbackUrl(state?.url, fallbackUrl),
  };
}

async function waitForOAuthContinuationAfterEmailVerified(context, { logger } = {}) {
  const timeoutMs = positiveInt(context.config.runner?.emailVerificationSettleTimeoutMs, 10000);
  const startedAt = Date.now();
  let lastState = await inspectOAuthContinuationState(context.page);
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await inspectOAuthContinuationState(context.page);
    if (lastState.localhostUrl) {
      context.localhostUrl = lastState.localhostUrl;
      return lastState;
    }
    if (lastState.oauthConsentPage || lastState.chooseAccountPage || lastState.addEmailPage) {
      return lastState;
    }
    if (!lastState.emailVerifiedPage && !lastState.verificationPage) {
      return lastState;
    }
    await context.page.waitForTimeout(250);
  }
  logger?.info?.("email verified page did not auto-advance before OAuth reopen", {
    url: lastState.url,
    timeoutMs,
  });
  return lastState;
}

async function triggerEmailVerifiedContinueIfPresent(page) {
  if (!page || typeof page.evaluate !== "function") return { clicked: false, reason: "no_evaluate" };
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || !(element instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden"
        && style.display !== "none"
        && rect.width > 0
        && rect.height > 0;
    };
    const textOf = (element) => String(
      element?.innerText
      || element?.textContent
      || element?.value
      || element?.getAttribute?.("aria-label")
      || ""
    ).replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll([
      "button",
      "a",
      "[role='button']",
      "input[type='submit']",
      "input[type='button']",
    ].join(","))).filter(visible);
    const target = candidates.find((element) => /^(?:continue|next|done|ok|続行|次へ|完了|確認|閉じる)$/i.test(textOf(element)))
      || candidates.find((element) => /continue|next|done|続行|次へ|完了/i.test(textOf(element)))
      || candidates.find((element) => {
        const type = String(element.getAttribute?.("type") || element.type || "").toLowerCase();
        return type === "submit";
      });
    if (!target) return { clicked: false, reason: "no_continue_control", url: location.href };
    const form = target.form || target.closest?.("form") || null;
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit(target instanceof HTMLButtonElement || target instanceof HTMLInputElement ? target : undefined);
    } else {
      target.click();
    }
    return { clicked: true, text: textOf(target), url: location.href };
  }).catch((error) => ({ clicked: false, reason: error?.message || String(error), url: page.url() }));
}

export async function fetchBindEmailCodeStep(context, { logger } = {}) {
  if (context.oauthLoginDirectConsentPage) {
    return { status: "skipped", reason: "oauth_login_already_on_consent_page" };
  }
  if (!context.account?.email) throw new Error("fetch-bind-email-code requires a leased Outlook email");
  const { pollOpenAiEmailCode } = await import("../providers/ms-oauth2api-next-mail.js");
  const { code, mailbox, mail } = await pollOpenAiEmailCode(context.account, context.config, {
    minReceivedAt: Number(context.bindEmailSubmittedAt || 0),
  });
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const verifiedBeforeSubmit = await detectOAuthEmailVerifiedPage(context.page);
  if (verifiedBeforeSubmit.verified) {
    markBoundEmailVerified(context, context.account.email);
    logger?.info?.("bind email already verified before code submit", {
      email: context.account.email,
      url: verifiedBeforeSubmit.url,
    });
    return { status: "done", reason: "bind_email_already_verified", mailbox, mail, result: verifiedBeforeSubmit };
  }
  let result = null;
  try {
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "FILL_CODE",
      source: "runner",
      step: 13,
      payload: {
        visibleStep: 13,
        code,
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
    });
  } catch (error) {
    const verifiedAfterError = await detectOAuthEmailVerifiedPage(context.page);
    if (verifiedAfterError.verified) {
      markBoundEmailVerified(context, context.account.email);
      logger?.info?.("bind email verified while code submit reported an error", {
        email: context.account.email,
        error: error.message,
        url: verifiedAfterError.url,
      });
      return { status: "done", reason: "bind_email_verified_after_submit_error", mailbox, mail, result: verifiedAfterError };
    }
    throw error;
  }
  if (result?.error) {
    const verifiedAfterError = await detectOAuthEmailVerifiedPage(context.page);
    if (verifiedAfterError.verified) {
      markBoundEmailVerified(context, context.account.email);
      logger?.info?.("bind email verified while code submit returned an error", {
        email: context.account.email,
        error: result.error,
        url: verifiedAfterError.url,
      });
      return { status: "done", reason: "bind_email_verified_after_submit_error", mailbox, mail, result: verifiedAfterError };
    }
    throw new Error(result.error);
  }
  markBoundEmailVerified(context, context.account.email);
  return { status: "done", reason: "bind_email_code_submitted", mailbox, mail, result };
}

async function waitForLocalhostOAuthCallback(page, { timeoutMs = 600000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  let lastHistoryCheckAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const currentUrl = page.url();
    if (isLocalhostOAuthCallbackUrl(currentUrl)) return currentUrl;
    const now = Date.now();
    if (/^chrome-error:/i.test(currentUrl) || now - lastHistoryCheckAt >= 1000) {
      lastHistoryCheckAt = now;
      const historyUrl = await getLocalhostOAuthCallbackUrlFromNavigationHistory(page);
      if (historyUrl) return historyUrl;
    }
    await page.waitForTimeout(pollMs);
  }
  return "";
}

async function reopenOAuthUrlAfterEmailVerified(context, { logger } = {}) {
  if (!context.oauthUrl) return false;
  const verified = await detectOAuthEmailVerifiedPage(context.page);
  if (!verified.verified) return false;
  markBoundEmailVerified(context);
  logger?.info?.("email is verified; reopening CPA OAuth URL to reach consent", {
    url: verified.url,
  });
  const clicked = await triggerEmailVerifiedContinueIfPresent(context.page);
  if (clicked.clicked) {
    logger?.info?.("clicked email verified continuation control", {
      text: clicked.text || "",
      url: clicked.url || verified.url,
    });
    await context.page.waitForTimeout(1500);
  }
  const transition = await waitForOAuthContinuationAfterEmailVerified(context, { logger });
  logger?.info?.("post email verification continuation state", {
    url: transition.url,
    addEmailPage: Boolean(transition.addEmailPage),
    chooseAccountPage: Boolean(transition.chooseAccountPage),
    oauthConsentPage: Boolean(transition.oauthConsentPage),
    localhostCallback: Boolean(transition.localhostUrl),
  });
  if (
    transition.localhostUrl
    || transition.oauthConsentPage
    || transition.chooseAccountPage
    || transition.addEmailPage
  ) {
    if (transition.localhostUrl || transition.oauthConsentPage) {
      markBoundEmailCompleted(context);
    } else if (transition.addEmailPage) {
      context.boundEmailNeedsRebind = true;
    }
    return true;
  }
  await safeGotoWithRetry(context.page, context.oauthUrl, {
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: Number(context.config.runner?.openChatgptNavigationAttempts || 3),
  });
  await context.page.waitForTimeout(1000);
  const reopened = await inspectOAuthContinuationState(context.page);
  logger?.info?.("reopened CPA OAuth URL after email verification", {
    url: reopened.url,
    addEmailPage: Boolean(reopened.addEmailPage),
    chooseAccountPage: Boolean(reopened.chooseAccountPage),
    oauthConsentPage: Boolean(reopened.oauthConsentPage),
    localhostCallback: Boolean(reopened.localhostUrl),
  });
  if (reopened.localhostUrl) {
    context.localhostUrl = reopened.localhostUrl;
    markBoundEmailCompleted(context);
  } else if (reopened.oauthConsentPage) {
    markBoundEmailCompleted(context);
  } else if (reopened.addEmailPage) {
    context.boundEmailNeedsRebind = true;
  }
  return true;
}

function isChooseAccountUrl(page) {
  try {
    return new URL(String(page?.url?.() || "")).pathname === "/choose-an-account";
  } catch {
    return /\/choose-an-account(?:[/?#]|$)/i.test(String(page?.url?.() || ""));
  }
}

async function continueOAuthChooseAccountIfNeeded(context, { dispatchMessage, injectFlow, logger } = {}) {
  if (!isChooseAccountUrl(context.page)) return null;
  await injectFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const { activation: resolvedActivation, phoneNumber } = resolveSignupPhoneActivationForOauth(context);
  const result = await dispatchMessage(context.page, {
    type: "EXECUTE_NODE",
    source: "runner",
    nodeId: "oauth-login",
    payload: {
      nodeId: "oauth-login",
      visibleStep: 14,
      loginIdentifierType: "phone",
      phoneNumber,
      countryId: resolvedActivation.countryId,
      countryLabel: resolvedActivation.countryLabel,
      accountIdentifierType: "phone",
      accountIdentifier: phoneNumber,
      password: context.gptPassword || context.config.runner?.gptPassword || "myPASSword!",
    },
  }, {
    onRetry: async () => injectFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  context.oauthLoginResult = result;
  context.oauthLoginCompletedWithoutSms = loginCompletedWithoutSms(result);
  context.oauthLoginDirectConsentPage = Boolean(result?.oauthConsentPage || result?.directOAuthConsentPage);
  if (context.oauthLoginDirectConsentPage && context.boundEmailVerified) {
    markBoundEmailCompleted(context);
  } else if (result?.addEmailPage && context.boundEmailVerified) {
    context.boundEmailNeedsRebind = true;
  }
  logger?.info?.("continued OAuth choose-account page before consent", {
    state: result?.state || "",
    addEmailPage: Boolean(result?.addEmailPage),
    oauthConsentPage: Boolean(result?.oauthConsentPage || result?.directOAuthConsentPage),
    url: result?.url || context.page.url(),
  });
  return result;
}

async function resubmitBoundEmailIfStillRequired(context, { logger } = {}) {
  if (
    !context.boundEmailVerified
    || context.oauthAddEmailResubmittedAfterVerified
    || !context.account?.email
  ) {
    return false;
  }
  const state = await inspectOAuthContinuationState(context.page);
  if (!state.addEmailPage) return false;
  context.oauthAddEmailResubmittedAfterVerified = true;
  context.boundEmailNeedsRebind = true;
  logger?.warn?.("OAuth still requires add-email after verified email; resubmitting the same bound email once", {
    email: context.account.email,
    url: state.url,
  });
  await bindEmailStep(context);
  await fetchBindEmailCodeStep(context, { logger });
  await reopenOAuthUrlAfterEmailVerified(context, { logger });
  return true;
}

export async function confirmOauthCallbackStep(context, {
  dispatchMessage = dispatchChromeRuntimeMessage,
  injectFlow = injectSignupFlow,
  logger,
} = {}) {
  if (!context.page) throw new Error("confirm-oauth-callback requires a browser page");
  await reopenOAuthUrlAfterEmailVerified(context, { logger });
  if (context.localhostUrl) {
    return { status: "done", reason: "oauth_callback_captured", localhostUrl: context.localhostUrl, result: { url: context.localhostUrl } };
  }
  await injectFlow(context.page, { pluginRoot: context.config.plugin?.root });
  await continueOAuthChooseAccountIfNeeded(context, { dispatchMessage, injectFlow, logger });
  if (await resubmitBoundEmailIfStillRequired(context, { logger })) {
    if (context.localhostUrl) {
      return { status: "done", reason: "oauth_callback_captured", localhostUrl: context.localhostUrl, result: { url: context.localhostUrl } };
    }
    await injectFlow(context.page, { pluginRoot: context.config.plugin?.root });
    await continueOAuthChooseAccountIfNeeded(context, { dispatchMessage, injectFlow, logger });
  }
  const timeoutMs = Number(context.config.runner?.oauthCallbackTimeoutMs || 600000);
  const findResult = await dispatchMessage(context.page, {
    type: "STEP8_FIND_AND_CLICK",
    source: "runner",
    step: 14,
    payload: {
      visibleStep: 14,
    },
  }, {
    timeoutMs,
    onRetry: async () => injectFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (findResult?.error) throw new Error(findResult.error);
  if (context.boundEmailVerified) {
    markBoundEmailCompleted(context);
  }

  let localhostUrl = resolveLocalhostOAuthCallbackUrl(
    findResult?.localhostUrl,
    findResult?.callbackUrl,
    findResult?.url,
    context.page.url(),
  );
  if (!localhostUrl) {
    const triggerResult = await dispatchMessage(context.page, {
      type: "STEP8_TRIGGER_CONTINUE",
      source: "runner",
      step: 14,
      payload: {
        visibleStep: 14,
        strategy: "requestSubmit",
      },
    }, {
      timeoutMs: Math.min(timeoutMs, 30000),
      onRetry: async () => injectFlow(context.page, { pluginRoot: context.config.plugin?.root }),
    });
    if (triggerResult?.error) throw new Error(triggerResult.error);
    localhostUrl = resolveLocalhostOAuthCallbackUrl(
      triggerResult?.localhostUrl,
      triggerResult?.callbackUrl,
      triggerResult?.url,
      context.page.url(),
    ) || await waitForLocalhostOAuthCallback(context.page, { timeoutMs });
  }
  if (!localhostUrl) {
    throw new Error("confirm-oauth-callback did not return localhostUrl");
  }
  context.localhostUrl = localhostUrl;
  return { status: "done", reason: "oauth_callback_captured", localhostUrl, result: findResult };
}
