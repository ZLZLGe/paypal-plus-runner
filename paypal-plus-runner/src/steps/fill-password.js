import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { safeGoto } from "../browser/page-utils.js";
import { directSubmitSignupEmail, isThirdPartyOAuthDetourUrl, openSignupEmailEntry } from "./submit-signup-email.js";
import { shouldSkipSignupPhoneRegistrationSteps } from "./phone-flow.js";

const AUTH_RETRY_BUTTON_SELECTOR = "button[data-dd-action-name='Try again']";
const SIGNUP_PASSWORD_INPUT_SELECTOR = "form[action='/create-account/password'] input[name='new-password']";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseRetryDelayMs(value, fallback = [5000, 10000, 15000, 20000]) {
  if (Array.isArray(value)) {
    const parsed = value.map((item) => positiveInt(item, 0)).filter((item) => item > 0);
    return parsed.length ? parsed : fallback;
  }
  const text = String(value ?? "").trim();
  if (!text) return fallback;
  const parsed = text.split(/[,\s]+/).map((item) => positiveInt(item, 0)).filter((item) => item > 0);
  return parsed.length ? parsed : fallback;
}

function resolvePasswordSubmitDelaysMs(config = {}) {
  return parseRetryDelayMs(
    config.runner?.signupPasswordSubmitDelaysMs
      ?? config.runner?.authTryAgainRetryDelaysMs,
  );
}

async function detectAuthRetryPage(page) {
  return page.evaluate((retrySelector) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const retryButtons = Array.from(document.querySelectorAll(retrySelector)).filter(visible);
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const title = String(document.title || "").trim();
    const hasTimeoutText = /operation\s+timed\s+out|timed\s+out|不明なエラー|something\s+went\s+wrong|oops/i.test(`${title} ${text}`);
    return {
      isAuthRetryPage: retryButtons.length === 1 && hasTimeoutText,
      retryButtonCount: retryButtons.length,
      retryEnabled: retryButtons.length === 1
        && !retryButtons[0].disabled
        && retryButtons[0].getAttribute("aria-disabled") !== "true",
      url: location.href,
      title,
      text: text.slice(0, 300),
    };
  }, AUTH_RETRY_BUTTON_SELECTOR);
}

async function detectSignupVerificationPage(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const html = String(document.documentElement?.innerHTML || "");
    const hasCodeInput = Boolean(document.querySelector(
      "input[name*='code' i], input[autocomplete='one-time-code'], input[inputmode='numeric'], input[type='tel']",
    ));
    const looksLikeVerification = /check\s+your\s+inbox|enter\s+the\s+verification\s+code|enter\s+the\s+code|we\s+just\s+sent|resend\s+email/i.test(text);
    const path = String(location.pathname || "");
    const routeLooksLikeVerification = /email-verification|contact-verification/i.test(`${location.href} ${path} ${html.slice(0, 100000)}`);
    return {
      isVerificationPage: routeLooksLikeVerification || (hasCodeInput && looksLikeVerification),
      url: location.href,
      text: text.slice(0, 300),
    };
  });
}

async function detectSignupPasswordValidationState(page) {
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
    const passwordInput = Array.from(document.querySelectorAll("input[type='password']")).find(visible) || null;
    const form = passwordInput?.closest("form") || document.querySelector("form[action='/create-account/password']");
    const disabledFieldset = passwordInput?.closest("fieldset[disabled]") || form?.closest?.("fieldset[disabled]") || null;
    const submitButton = Array.from((form || document).querySelectorAll("button[type='submit'], input[type='submit']"))
      .find(visible) || null;
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    const retryButtons = Array.from(document.querySelectorAll("button[data-dd-action-name='Try again']")).filter(visible);
    const isAuthRetryPage = retryButtons.length === 1
      && /operation\s+timed\s+out|timed\s+out|不明なエラー|something\s+went\s+wrong|oops/i.test(`${document.title || ""} ${text}`);
    const isPasswordPage = Boolean(passwordInput) || (!isAuthRetryPage && /\/(?:create-account|log-in)\/password(?:[/?#]|$)/i.test(location.pathname || ""));
    const normalize = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
    const errorSelectors = [
      ".react-aria-FieldError",
      "[slot='errorMessage']",
      "[role='alert']",
      "[aria-live='assertive']",
      "[id$='-error']",
      "[id$='-errors']",
    ];
    const visibleErrorText = errorSelectors
      .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
      .filter(visible)
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .join(" ");
    const invalidPassword = Boolean(passwordInput && (
      passwordInput.getAttribute("aria-invalid") === "true"
      || passwordInput.getAttribute("data-invalid") === "true"
      || passwordInput.closest("[aria-invalid='true'], [data-invalid='true']")
    ));
    const ruleTextOnly = /(?:満たしました|met|satisfied|complete)/i.test(text)
      && /12\s*(?:文字|characters?)/i.test(text)
      && !visibleErrorText
      && !invalidPassword;
    const hasLengthError = !ruleTextOnly && (
      /12\s*(?:文字|characters?)\s*(?:以上|required|minimum)|at\s+least\s+12|12文字以上/i.test(visibleErrorText)
      || (invalidPassword && /12\s*(?:文字|characters?)|at\s+least\s+12|12文字以上/i.test(text))
    );
    const hasPasswordError = Boolean(
      visibleErrorText
      && /password.{0,80}(?:required|invalid|too short)|パスワード.{0,80}(?:必要|以上|無効)|incorrect\s+phone\s+number\s+or\s+password|account\s+associated\s+with\s+this\s+phone\s+number/i.test(visibleErrorText)
    ) || hasLengthError || invalidPassword;
    const disabledByFieldset = Boolean(disabledFieldset);
    const inputDisabled = Boolean(passwordInput && (
      passwordInput.disabled
      || passwordInput.matches?.(":disabled")
      || disabledByFieldset
    ));
    const submitDisabled = Boolean(submitButton && (
      submitButton.disabled
      || submitButton.matches?.(":disabled")
      || submitButton.getAttribute("aria-disabled") === "true"
      || disabledByFieldset
    ));
    const submitHasSpinner = Boolean(submitButton?.querySelector?.(
      "[class*='animate-spin'], [class*='spinner'], [class*='loading'], [role='progressbar'], [aria-busy='true']",
    ));
    const isSubmitting = Boolean(isPasswordPage && !hasPasswordError && (
      disabledByFieldset || inputDisabled || submitDisabled || submitHasSpinner
    ));
    return {
      isPasswordPage,
      isAuthRetryPage,
      hasPasswordError,
      hasLengthError,
      isSubmitting,
      disabledByFieldset,
      inputDisabled,
      submitDisabled,
      submitHasSpinner,
      submitText: String(submitButton?.textContent || submitButton?.value || "").replace(/\s+/g, " ").trim().slice(0, 120),
      passwordLength: String(passwordInput?.value || "").length,
      url,
      visibleErrorText: visibleErrorText.slice(0, 300),
      invalidPassword,
      text: text.slice(0, 500),
    };
  });
}

async function waitForPasswordSubmitSettled(page, { timeoutMs = 12000, pollMs = 300 } = {}) {
  const startedAt = Date.now();
  let lastState = await detectSignupPasswordValidationState(page).catch(() => ({
    isPasswordPage: false,
    hasPasswordError: false,
    url: page.url(),
    text: "",
  }));
  while (Date.now() - startedAt < timeoutMs) {
    const verification = await detectSignupVerificationPage(page).catch(() => ({ isVerificationPage: false }));
    if (verification.isVerificationPage) {
      return { state: "verification_page", verification };
    }
    const retry = await detectAuthRetryPage(page).catch(() => ({ isAuthRetryPage: false }));
    if (retry.isAuthRetryPage) {
      return { state: "auth_retry_page", retry };
    }
    lastState = await detectSignupPasswordValidationState(page).catch(() => lastState);
    if (lastState.isPasswordPage && lastState.hasPasswordError) {
      return { state: "password_error", password: lastState };
    }
    if (!lastState.isPasswordPage) {
      return { state: "left_password_page", password: lastState };
    }
    await page.waitForTimeout(pollMs);
  }
  return { state: "timeout", password: lastState };
}

async function waitForSignupPasswordInputReady(page, { timeoutMs = 12000, pollMs = 300 } = {}) {
  const startedAt = Date.now();
  let lastPasswordState = null;
  while (Date.now() - startedAt < timeoutMs) {
    const input = page.locator(SIGNUP_PASSWORD_INPUT_SELECTOR);
    const count = await input.count().catch(() => 0);
    if (count === 1) {
      const visible = await input.isVisible().catch(() => false);
      if (visible) {
        lastPasswordState = await detectSignupPasswordValidationState(page).catch(() => null);
        if (!lastPasswordState?.isSubmitting) return { ready: true, count, url: page.url() };
      }
    }
    const retry = await detectAuthRetryPage(page).catch(() => ({ isAuthRetryPage: false }));
    if (retry.isAuthRetryPage) {
      await page.waitForTimeout(pollMs);
      continue;
    }
    const verification = await detectSignupVerificationPage(page).catch(() => ({ isVerificationPage: false }));
    if (verification.isVerificationPage) return { ready: false, verification, url: verification.url };
    await page.waitForTimeout(pollMs);
  }
  return { ready: false, url: page.url(), password: lastPasswordState };
}

export function shouldRetrySignupPasswordSubmit(settled = {}) {
  return settled?.state === "timeout"
    && Boolean(settled?.password?.isPasswordPage)
    && !settled?.password?.hasPasswordError;
}

async function clickAuthRetryWithDelay(page, delayMs, { logger, attempt, total } = {}) {
  const retry = await detectAuthRetryPage(page);
  if (!retry.isAuthRetryPage) return { clicked: false, reason: "auth_retry_page_absent", retry };
  if (!retry.retryEnabled) {
    throw new Error(`步骤 3：OpenAI Try again 按钮不可用。URL: ${retry.url}`);
  }
  logger?.warn?.("auth retry page detected after password submit; waiting before Try again", {
    attempt,
    total,
    delayMs,
    url: retry.url,
    title: retry.title,
  });
  await page.waitForTimeout(delayMs);
  const button = page.locator(AUTH_RETRY_BUTTON_SELECTOR);
  const count = await button.count().catch(() => 0);
  if (count !== 1) {
    throw new Error(`步骤 3：Try again 精确按钮数量异常：${count}。URL: ${page.url()}`);
  }
  await button.click({ timeout: 10000, noWaitAfter: true });
  return { clicked: true, delayMs, retry };
}

async function detectSignupPostEmailState(page, { email = "" } = {}) {
  return page.evaluate((targetEmail) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && rect.width > 0
        && rect.height > 0;
    };
    const actionText = (el) => [
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const enabled = (el) => Boolean(el)
      && !el.disabled
      && el.getAttribute?.("aria-disabled") !== "true"
      && !el.hasAttribute?.("data-visually-disabled")
      && !/\bcursor-not-allowed\b|\bopacity-50\b/i.test(String(el.className || ""));
    const firstVisible = (selector) => Array.from(document.querySelectorAll(selector)).find(visible) || null;

    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const html = String(document.documentElement?.innerHTML || "");
    const url = location.href;
    const passwordInput = firstVisible(
      "input[type='password'], input[name*='password' i], input[id*='password' i], input[autocomplete='new-password'], input[autocomplete='current-password']",
    );
    const codeInput = firstVisible(
      "input[name*='code' i], input[autocomplete='one-time-code'], input[inputmode='numeric'], input[type='tel']",
    );
    const emailInput = firstVisible(
      "input[type='email'], input[name*='email' i], input[id*='email' i], input[autocomplete*='email' i]",
    );
    const actions = Array.from(document.querySelectorAll(
      "button, input[type='submit'], input[type='button'], [role='button']",
    )).filter(visible);
    const submitButton = actions.find((el) => {
      const textValue = actionText(el);
      return el.type === "submit" || /continue|next|submit|sign\s*up|log\s*in|继续|下一步|提交|注册|登录/i.test(textValue);
    }) || null;
    const submitText = actionText(submitButton);
    const submitEnabled = enabled(submitButton);
    const submitDisabled = Boolean(submitButton) && !submitEnabled;
    const submitHasSpinner = Boolean(submitButton?.querySelector?.(
      "[class*='animate-spin'], [class*='spinner'], [class*='loading'], [role='progressbar'], [aria-busy='true']",
    ));
    const normalizedTargetEmail = String(targetEmail || "").trim().toLowerCase();
    const emailValue = String(emailInput?.value || "").trim();
    const normalizedEmailValue = emailValue.toLowerCase();
    const emailMatches = !normalizedTargetEmail || normalizedEmailValue === normalizedTargetEmail;
    const hasAuthModal = Boolean(document.querySelector(
      "#modal-no-auth-login, [data-testid='modal-no-auth-login'], [data-testid='login-form']",
    )) || /log\s+in\s+or\s+sign\s+up/i.test(text);
    const routeLooksLikeVerification = /email-verification|contact-verification/i.test(`${url} ${location.pathname || ""} ${html.slice(0, 100000)}`);
    const textLooksLikeVerification = /check\s+your\s+inbox|enter\s+the\s+verification\s+code|enter\s+the\s+code|we\s+just\s+sent|resend\s+email/i.test(text);
    const hasCloudflareChallenge = /__CF\$cv|challenge-platform|cdn-cgi\/challenge|cf_chl/i.test(html);
    const isEmailSubmitting = Boolean(hasAuthModal && emailInput && emailMatches && !passwordInput && !codeInput && (
      emailInput.disabled || submitDisabled || submitHasSpinner
    ) && (submitDisabled || submitHasSpinner));

    return {
      isVerificationPage: routeLooksLikeVerification || (Boolean(codeInput) && textLooksLikeVerification),
      isPasswordPage: Boolean(passwordInput),
      isEmailSubmitting,
      isEmailEntryReady: Boolean(hasAuthModal && emailInput && emailMatches && !emailInput.disabled && (!submitButton || submitEnabled)),
      isThirdPartyOAuthDetour: /(^|\.)accounts\.google\.com$|(^|\.)appleid\.apple\.com$|(^|\.)login\.live\.com$|(^|\.)login\.microsoftonline\.com$/i.test(location.hostname || ""),
      hasAuthModal,
      hasCloudflareChallenge,
      emailValue,
      emailInputDisabled: Boolean(emailInput?.disabled),
      submitText,
      submitDisabled,
      submitHasSpinner,
      url,
      text: text.slice(0, 300),
    };
  }, email);
}

async function waitForSignupPostEmailState(page, {
  timeoutMs = 90000,
  pollMs = 500,
  email = "",
  stuckAfterMs = 20000,
  logger = null,
} = {}) {
  const startedAt = Date.now();
  let submittingStartedAt = 0;
  let lastState = {
    isVerificationPage: false,
    isPasswordPage: false,
    isEmailSubmitting: false,
    isEmailEntryReady: false,
    url: "",
  };
  let loggedSlowSpinner = false;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await detectSignupPostEmailState(page, { email }).catch(() => lastState);
    if (lastState.isVerificationPage || lastState.isPasswordPage || lastState.isThirdPartyOAuthDetour) return lastState;
    if (lastState.isEmailSubmitting) {
      submittingStartedAt = submittingStartedAt || Date.now();
      const submittingForMs = Date.now() - submittingStartedAt;
      if (submittingForMs >= stuckAfterMs) {
        return { ...lastState, stuck: true, submittingForMs };
      }
    } else {
      submittingStartedAt = 0;
    }
    if (
      lastState.isEmailSubmitting
      && !loggedSlowSpinner
      && Date.now() - startedAt >= Math.min(15000, stuckAfterMs)
    ) {
      loggedSlowSpinner = true;
      logger?.warn?.("signup email submit still loading", {
        url: lastState.url,
        emailValue: lastState.emailValue,
        submitDisabled: lastState.submitDisabled,
        submitHasSpinner: lastState.submitHasSpinner,
        hasCloudflareChallenge: lastState.hasCloudflareChallenge,
      });
    }
    await page.waitForTimeout(pollMs);
  }
  return lastState;
}

async function recoverStuckSignupEmailSubmission(context, { logger } = {}) {
  const page = context.page;
  const attempts = positiveInt(context.config.runner?.signupEmailRecoveryAttempts, 2);
  const waitMs = positiveInt(context.config.runner?.signupEmailRecoveryWaitMs, 30000);
  const settleMs = positiveInt(context.config.runner?.signupEmailRecoveryReloadSettleMs, 2500);

  let lastState = await detectSignupPostEmailState(page, { email: context.account.email }).catch(() => ({
    url: page.url(),
  }));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger?.warn?.("recovering stuck signup email submission", {
      attempt,
      attempts,
      url: lastState.url,
      emailValue: lastState.emailValue,
      submitDisabled: lastState.submitDisabled,
      submitHasSpinner: lastState.submitHasSpinner,
      hasCloudflareChallenge: lastState.hasCloudflareChallenge,
    });

    await safeGoto(page, String(context.config.runner?.signupEntryUrl || "https://chatgpt.com/"), {
      waitUntil: "domcontentloaded",
      timeoutMs: positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000),
    }).catch(async (error) => {
      logger?.warn?.("signup recovery navigation failed; trying page reload", { error: error.message });
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000),
      }).catch(() => undefined);
    });
    await page.waitForTimeout(settleMs);
    const entry = await openSignupEmailEntry(context, { logger });
    if (!entry.ok) {
      lastState = {
        url: page.url(),
        isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
        recoveryReason: entry.reason || "missing_strict_email_entry",
      };
      continue;
    }
    const direct = await directSubmitSignupEmail(page, context.account.email, {
      timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
      pollMs: 250,
    });
    if (!direct.ok) {
      lastState = {
        url: page.url(),
        isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
        recoveryReason: direct.reason || "strict_direct_submit_failed",
      };
      continue;
    }
    context.signupEmailSubmittedAt = Date.now();
    lastState = await waitForSignupPostEmailState(page, {
      timeoutMs: waitMs,
      pollMs: 500,
      email: context.account.email,
      stuckAfterMs: positiveInt(context.config.runner?.signupEmailSubmittingStuckMs, 20000),
      logger,
    });
    if (lastState.isVerificationPage || lastState.isPasswordPage) return lastState;
    if (!lastState.isEmailSubmitting && !lastState.isEmailEntryReady) return lastState;
  }
  return lastState;
}

async function resubmitReadySignupEmailEntry(context, { logger } = {}) {
  const page = context.page;
  const attempts = positiveInt(context.config.runner?.signupEmailReadyResubmitAttempts, 2);
  const waitMs = positiveInt(context.config.runner?.signupEmailRecoveryWaitMs, 30000);
  let lastState = await detectSignupPostEmailState(page, { email: context.account.email }).catch(() => ({
    url: page.url(),
  }));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger?.warn?.("signup email entry still ready after submit; resubmitting exact email form", {
      attempt,
      attempts,
      url: lastState.url || page.url(),
      emailValue: lastState.emailValue,
      submitDisabled: lastState.submitDisabled,
      submitHasSpinner: lastState.submitHasSpinner,
    });
    const direct = await directSubmitSignupEmail(page, context.account.email, {
      timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
      pollMs: 250,
    });
    if (!direct.ok) {
      lastState = {
        url: page.url(),
        isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
        recoveryReason: direct.reason || "strict_direct_submit_failed",
      };
      continue;
    }
    context.signupEmailSubmittedAt = Date.now();
    lastState = await waitForSignupPostEmailState(page, {
      timeoutMs: waitMs,
      pollMs: 500,
      email: context.account.email,
      stuckAfterMs: positiveInt(context.config.runner?.signupEmailSubmittingStuckMs, 20000),
      logger,
    });
    if (lastState.isVerificationPage || lastState.isPasswordPage) return lastState;
    if (lastState.isThirdPartyOAuthDetour) return lastState;
    if (!lastState.isEmailSubmitting && !lastState.isEmailEntryReady) return lastState;
  }

  return lastState;
}

async function recoverThirdPartyOAuthDetour(context, { logger } = {}) {
  const page = context.page;
  const attempts = positiveInt(context.config.runner?.signupThirdPartyDetourRecoveryAttempts, 2);
  let lastState = await detectSignupPostEmailState(page, { email: context.account.email }).catch(() => ({
    url: page.url(),
    isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
  }));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    logger?.warn?.("recovering third-party oauth detour during signup", {
      attempt,
      attempts,
      url: lastState.url || page.url(),
    });
    const recovery = await openSignupEmailEntry(context, { logger });
    if (!recovery.ok) {
      lastState = {
        url: page.url(),
        isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
        recoveryReason: recovery.reason || "unknown",
      };
      continue;
    }
    const direct = await directSubmitSignupEmail(page, context.account.email, {
      timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
      pollMs: 250,
    });
    if (!direct.ok) {
      lastState = {
        url: page.url(),
        isThirdPartyOAuthDetour: isThirdPartyOAuthDetourUrl(page.url()),
        recoveryReason: direct.reason || "direct_submit_failed",
      };
      continue;
    }
    context.signupEmailSubmittedAt = Date.now();
    lastState = await waitForSignupPostEmailState(page, {
      timeoutMs: positiveInt(context.config.runner?.signupEmailRecoveryWaitMs, 30000),
      pollMs: 500,
      email: context.account.email,
      stuckAfterMs: positiveInt(context.config.runner?.signupEmailSubmittingStuckMs, 20000),
      logger,
    });
    if (lastState.isVerificationPage || lastState.isPasswordPage) return lastState;
    if (!lastState.isThirdPartyOAuthDetour) return lastState;
  }

  return lastState;
}

export async function fillPasswordStep(context, { logger } = {}) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (shouldSkipSignupPhoneRegistrationSteps(context)) {
    return { status: "skipped", reason: "signup_phone_registration_already_recovered" };
  }
  if (!context.page) throw new Error("fill-password requires a browser page");
  const signupPassword = String(context.gptPassword || context.config.runner?.gptPassword || "myPASSword!2026");
  if (signupPassword.length < 12) {
    throw new Error(`步骤 3：配置的 gptPassword 长度为 ${signupPassword.length}，OpenAI 当前要求至少 12 字符。`);
  }
  let postEmailState = await waitForSignupPostEmailState(context.page, {
    timeoutMs: positiveInt(context.config.runner?.signupPostEmailWaitMs, 90000),
    pollMs: 500,
    email: context.account.email,
    stuckAfterMs: positiveInt(context.config.runner?.signupEmailSubmittingStuckMs, 20000),
    logger,
  });
  if (postEmailState.isThirdPartyOAuthDetour || isThirdPartyOAuthDetourUrl(postEmailState.url || context.page.url())) {
    postEmailState = await recoverThirdPartyOAuthDetour(context, { logger });
  }
  if (postEmailState.isEmailEntryReady) {
    postEmailState = await resubmitReadySignupEmailEntry(context, { logger });
  }
  if (postEmailState.isEmailSubmitting || postEmailState.isEmailEntryReady) {
    postEmailState = await recoverStuckSignupEmailSubmission(context, { logger });
  }
  if (postEmailState.isVerificationPage) {
    return {
      status: "skipped",
      reason: "password_page_skipped_verification_page",
      verificationState: postEmailState,
    };
  }
  if (postEmailState.isEmailSubmitting) {
    throw new Error(`步骤 3：邮箱提交后登录弹窗持续 loading，恢复后仍未进入密码页或验证码页。URL: ${postEmailState.url || context.page.url()}`);
  }
  if (postEmailState.isThirdPartyOAuthDetour || isThirdPartyOAuthDetourUrl(postEmailState.url || context.page.url())) {
    throw new Error(`步骤 3：邮箱提交后误入第三方登录，恢复后仍未进入 OpenAI 密码页或验证码页。URL: ${postEmailState.url || context.page.url()}`);
  }
  const verificationState = await detectSignupVerificationPage(context.page).catch(() => ({ isVerificationPage: false }));
  if (verificationState.isVerificationPage) {
    return { status: "skipped", reason: "password_page_skipped_verification_page", verificationState };
  }
  const retryDelaysMs = parseRetryDelayMs(context.config.runner?.authTryAgainRetryDelaysMs);
  const submitDelaysMs = resolvePasswordSubmitDelaysMs(context.config);
  let result = null;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (attempt > 0) {
      const ready = await waitForSignupPasswordInputReady(context.page, {
        timeoutMs: positiveInt(context.config.runner?.signupPasswordRetryReadyTimeoutMs, 15000),
      });
      if (ready.verification?.isVerificationPage) {
        return { status: "skipped", reason: "password_page_skipped_verification_page", verificationState: ready.verification };
      }
      if (!ready.ready) {
        if (ready.password?.isSubmitting) {
          const delayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || 0;
          if (!delayMs) {
            throw new Error(`步骤 3：密码提交后页面持续提交中。URL: ${ready.url || context.page.url()}`);
          }
          logger?.warn?.("signup password page still submitting before retry; waiting stepped delay", {
            attempt: attempt + 1,
            total: retryDelaysMs.length,
            delayMs,
            url: ready.url || context.page.url(),
            disabledByFieldset: Boolean(ready.password.disabledByFieldset),
            submitDisabled: Boolean(ready.password.submitDisabled),
          });
          await context.page.waitForTimeout(delayMs);
          continue;
        }
        throw new Error(`步骤 3：Try again 后未回到精确注册密码页。URL: ${ready.url || context.page.url()}`);
      }
    }

    const submitDelayMs = submitDelaysMs[Math.min(attempt, submitDelaysMs.length - 1)] || 0;
    if (submitDelayMs > 0) {
      logger?.info?.("waiting before signup password submit", {
        attempt: attempt + 1,
        delayMs: submitDelayMs,
        url: context.page.url(),
      });
      await context.page.waitForTimeout(submitDelayMs);
    }

    await injectSignupFlow(context.page, {
      pluginRoot: context.config.plugin?.root,
    });
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "fill-password",
      payload: {
        nodeId: "fill-password",
        visibleStep: 3,
        email: context.account.email,
        password: signupPassword,
        phoneNumber: context.signupPhoneNumber || "",
        accountIdentifierType: context.accountIdentifierType || "email",
        accountIdentifier: context.accountIdentifier || context.account.email,
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, {
        pluginRoot: context.config.plugin?.root,
      }),
    });
    if (result?.error) throw new Error(result.error);

    const settled = await waitForPasswordSubmitSettled(context.page, {
      timeoutMs: positiveInt(context.config.runner?.signupPasswordSubmitVerifyTimeoutMs, 15000),
    });
    if (settled.state === "password_error") {
      throw new Error(`步骤 3：密码提交后仍停留在密码页并出现校验错误。URL: ${settled.password.url} text=${settled.password.text.slice(0, 200)}`);
    }
    if (settled.state === "auth_retry_page") {
      const delayMs = retryDelaysMs[attempt];
      if (!delayMs) {
        throw new Error(`步骤 3：OpenAI Try again 重试页在 ${retryDelaysMs.length} 次阶梯重试后仍未恢复。URL: ${settled.retry.url}`);
      }
      await clickAuthRetryWithDelay(context.page, delayMs, {
        logger,
        attempt: attempt + 1,
        total: retryDelaysMs.length,
      });
      continue;
    }
    if (shouldRetrySignupPasswordSubmit(settled)) {
      const delayMs = retryDelaysMs[attempt];
      if (!delayMs) {
        throw new Error(`步骤 3：密码提交后仍停留在密码页。URL: ${settled.password.url}`);
      }
      logger?.warn?.("signup password submit still on password page; retrying with stepped delay", {
        attempt: attempt + 1,
        total: retryDelaysMs.length,
        delayMs,
        url: settled.password.url,
        isSubmitting: Boolean(settled.password.isSubmitting),
        disabledByFieldset: Boolean(settled.password.disabledByFieldset),
        submitDisabled: Boolean(settled.password.submitDisabled),
      });
      await context.page.waitForTimeout(delayMs);
      continue;
    }
    return { status: "done", reason: "signup_password_submitted", result };
  }

  throw new Error(`步骤 3：密码提交重试流程异常结束。URL: ${context.page.url()}`);
}
