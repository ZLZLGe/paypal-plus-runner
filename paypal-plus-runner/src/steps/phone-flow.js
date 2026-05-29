import { dispatchChromeRuntimeMessage, injectSignupFlow } from "../browser/inject.js";
import { safeGotoWithRetry } from "../browser/page-utils.js";
import {
  cancelOpenAiPhoneActivation,
  discardOpenAiPhoneReuseActivation,
  pollOpenAiPhoneCode,
  requestOpenAiPhoneAdditionalSms,
  resolveOpenAiPhoneActivation,
} from "../providers/openai-phone.js";

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

function normalizeActionText(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
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
  return { clientReady, cookie };
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

async function waitForPostSignupPhoneSubmitState(page, { timeoutMs = 15000, pollMs = 300 } = {}) {
  const startedAt = Date.now();
  let lastState = await detectPostSignupPhoneSubmitState(page).catch(() => ({
    state: "unknown",
    url: page.url(),
  }));
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectPostSignupPhoneSubmitState(page).catch(() => lastState);
    if (lastState.state !== "unknown") return lastState;
    await page.waitForTimeout(pollMs);
  }
  return lastState;
}

async function releaseExistingPhoneActivation(context, activation, { logger, attempt } = {}) {
  if (!activation) return;
  try {
    const result = await cancelOpenAiPhoneActivation(activation, context.config);
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
    logger?.warn?.("existing OpenAI phone activation cancel failed before retry", {
      attempt,
      phoneNumber: activation.phoneNumber,
      error: error.message,
      discardedReuse: Boolean(discard.discarded),
    });
  }
}

async function submitOneSignupPhoneAttempt(context, activation, { logger, attempt } = {}) {
  context.signupPhoneActivation = activation;
  context.signupPhoneNumber = activation.phoneNumber;
  context.accountIdentifierType = "phone";
  context.accountIdentifier = activation.phoneNumber;

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
    const postErrorState = await detectPostSignupPhoneSubmitState(context.page).catch(() => ({
      state: "unknown",
      url: context.page.url(),
    }));
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
  const postSubmitState = await waitForPostSignupPhoneSubmitState(context.page, {
    timeoutMs: Number(context.config.runner?.signupPhonePostSubmitStateTimeoutMs || 18000),
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
    activation = await resolveOpenAiPhoneActivation(context.config);
    const attemptResult = await submitOneSignupPhoneAttempt(context, activation, { logger, attempt });
    result = attemptResult.result;
    const postSubmitState = attemptResult.postSubmitState;

    if (postSubmitState.state === "existing_phone_login_password_page") {
      lastExistingPhoneState = postSubmitState;
      await releaseExistingPhoneActivation(context, activation, { logger, attempt });
      context.signupPhoneActivation = null;
      context.signupPhoneNumber = "";
      context.accountIdentifier = "";
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
    result,
  };
}

export async function fetchSignupPhoneCodeStep(context, { logger } = {}) {
  if (!context.page) throw new Error("fetch-signup-phone-code requires a browser page");
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(context.config);
  const { code } = await pollOpenAiPhoneCode(activation, context.config);
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
      signupProfile: {
        firstName: context.checkoutProfile.guest.firstName,
        lastName: context.checkoutProfile.guest.lastName,
        age: Number(context.config.runner?.signupAge || 25),
      },
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  context.signupPhoneCompletedActivation = { ...activation, completedAt: new Date().toISOString() };
  logger?.info?.("signup phone verification submitted", {
    phoneNumber: activation.phoneNumber,
    resultState: result?.state || "",
  });
  return { status: "done", reason: "signup_phone_code_submitted", result };
}

function isOpenAiLoginPageUrl(page) {
  return OPENAI_LOGIN_URL_RE.test(String(page?.url?.() || ""));
}

async function loginWithSignupPhoneOnCurrentPage(context, { logger } = {}) {
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(context.config);
  const phoneNumber = context.signupPhoneNumber || context.accountIdentifier || activation.phoneNumber;
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const login = await dispatchChromeRuntimeMessage(context.page, {
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
      password: context.config.runner?.gptPassword || "myPASSword!2026",
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (login?.error) throw new Error(login.error);
  logger?.info?.("signup flow redirected to login; submitted same phone login", {
    phoneNumber,
    resultState: login?.state || "",
  });
  return login;
}

async function submitSignupPhoneLoginCodeIfNeeded(context, { logger } = {}) {
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(context.config);
  if (!context.loginPhoneAdditionalSmsRequested) {
    await requestOpenAiPhoneAdditionalSms(activation, context.config);
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
      signupProfile: {
        firstName: context.checkoutProfile.guest.firstName,
        lastName: context.checkoutProfile.guest.lastName,
        age: Number(context.config.runner?.signupAge || 25),
      },
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  logger?.info?.("signup redirected login phone verification submitted", {
    phoneNumber: activation.phoneNumber,
    resultState: result?.state || "",
  });
  return result;
}

export async function recoverSignupRedirectedLoginStep(context, { logger } = {}) {
  if (!context.page || !isOpenAiLoginPageUrl(context.page)) {
    return { recovered: false, reason: "not_openai_login_page" };
  }
  const login = await loginWithSignupPhoneOnCurrentPage(context, { logger });
  if (login?.skipLoginVerificationStep || login?.addEmailPage || login?.oauthConsentPage) {
    return { recovered: true, reason: "phone_login_completed_without_sms", login };
  }
  const code = await submitSignupPhoneLoginCodeIfNeeded(context, { logger });
  return { recovered: true, reason: "phone_login_code_submitted", login, code };
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
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const resolvedActivation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(context.config);
  const phoneNumber = context.signupPhoneNumber || context.accountIdentifier || resolvedActivation.phoneNumber;
  const result = await dispatchChromeRuntimeMessage(context.page, {
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
      password: context.config.runner?.gptPassword || "myPASSword!",
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "oauth_phone_login_submitted", result };
}

export async function fetchLoginPhoneCodeStep(context) {
  if (!context.page) throw new Error("fetch-login-phone-code requires a browser page");
  const activation = context.signupPhoneActivation || await resolveOpenAiPhoneActivation(context.config);
  const ignoredCodes = context.signupPhoneCodes || [];
  if (!context.loginPhoneAdditionalSmsRequested) {
    await requestOpenAiPhoneAdditionalSms(activation, context.config);
    context.loginPhoneAdditionalSmsRequested = true;
  }
  const { code } = await pollOpenAiPhoneCode(activation, context.config, { ignoreCodes: ignoredCodes });
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
  return { status: "done", reason: "login_phone_code_submitted", result };
}

export async function bindEmailStep(context) {
  if (!context.page) throw new Error("bind-email requires a browser page");
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

export async function fetchBindEmailCodeStep(context) {
  if (!context.account?.email) throw new Error("fetch-bind-email-code requires a leased Outlook email");
  const { pollOpenAiEmailCode } = await import("../providers/ms-oauth2api-next-mail.js");
  const { code, mailbox, mail } = await pollOpenAiEmailCode(context.account, context.config, {
    minReceivedAt: Number(context.bindEmailSubmittedAt || 0),
  });
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
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
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "bind_email_code_submitted", mailbox, mail, result };
}

export async function confirmOauthCallbackStep(context) {
  if (!context.page) throw new Error("confirm-oauth-callback requires a browser page");
  await injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "STEP8_FIND_AND_CLICK",
    source: "runner",
    step: 14,
    payload: {
      visibleStep: 14,
    },
  }, {
    timeoutMs: Number(context.config.runner?.oauthCallbackTimeoutMs || 600000),
    onRetry: async () => injectSignupFlow(context.page, { pluginRoot: context.config.plugin?.root }),
  });
  if (result?.error) throw new Error(result.error);
  const localhostUrl = result.localhostUrl || result.url || result.callbackUrl || "";
  if (!localhostUrl) {
    throw new Error("confirm-oauth-callback did not return localhostUrl");
  }
  context.localhostUrl = localhostUrl;
  return { status: "done", reason: "oauth_callback_captured", localhostUrl };
}
