import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { safeGoto } from "../browser/page-utils.js";
import { directSubmitSignupEmail, isThirdPartyOAuthDetourUrl, openSignupEmailEntry } from "./submit-signup-email.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
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
  if (!context.page) throw new Error("fill-password requires a browser page");
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
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root,
  });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "EXECUTE_NODE",
    source: "runner",
    nodeId: "fill-password",
    payload: {
      nodeId: "fill-password",
      visibleStep: 3,
      email: context.account.email,
      password: context.config.runner?.gptPassword || "myPASSword!",
      accountIdentifierType: "email",
      accountIdentifier: context.account.email,
    },
  }, {
    onRetry: async () => injectSignupFlow(context.page, {
      pluginRoot: context.config.plugin?.root,
    }),
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "signup_password_submitted", result };
}
