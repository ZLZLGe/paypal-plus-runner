import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { pollOpenAiEmailCode } from "../providers/ms-oauth2api-next-mail.js";
import { detectLoggedInChatgpt } from "./signup-state.js";
import { buildSignupProfilePayload } from "./signup-profile.js";
import { RunnerError } from "../utils/errors.js";
import { directSubmitSignupEmail, openSignupEmailEntry } from "./submit-signup-email.js";

async function ensureSignupRuntime(context) {
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root,
  });
}

function isReadyStateGateError(error) {
  return /注册验证码页面长时间未完成加载|readyState=interactive|readyState=loading/i.test(String(error?.message || error || ""));
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function detectSignupCodePage(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const codeInputs = Array.from(document.querySelectorAll([
      "input[name*='code' i]",
      "input[autocomplete='one-time-code']",
      "input[inputmode='numeric']",
      "input[maxlength='6']",
      "input[aria-label*='code' i]",
      "input[placeholder*='code' i]",
    ].join(","))).filter(visible);
    const strictEmailInputs = Array.from(document.querySelectorAll(
      "[data-testid='login-form'] form input#email[name='email'][type='email'][aria-label='Email address']",
    )).filter(visible);
    const strictLoginForms = Array.from(document.querySelectorAll("[data-testid='login-form']")).filter(visible);
    const passwordInputs = Array.from(document.querySelectorAll("input[type='password']")).filter(visible);
    return {
      url: location.href,
      isCodePage: codeInputs.length > 0,
      hasStrictEmailEntry: strictLoginForms.length === 1 && strictEmailInputs.length === 1,
      hasPasswordInput: passwordInputs.length > 0,
      codeInputCount: codeInputs.length,
      strictEmailInputCount: strictEmailInputs.length,
      text: text.slice(0, 500),
    };
  }).catch((error) => ({
    url: page.url(),
    isCodePage: false,
    hasStrictEmailEntry: false,
    hasPasswordInput: false,
    codeInputCount: 0,
    strictEmailInputCount: 0,
    text: "",
    error: error.message,
  }));
}

async function waitForSignupCodePage(context, { logger = null } = {}) {
  const page = context.page;
  const timeoutMs = positiveInt(context.config.runner?.signupCodePageWaitMs, 45000);
  const pollMs = positiveInt(context.config.runner?.signupCodePagePollMs, 500);
  const startedAt = Date.now();
  let lastState = await detectSignupCodePage(page);
  let resubmitted = false;

  while (Date.now() - startedAt < timeoutMs) {
    const loggedInState = await detectLoggedInChatgpt(page).catch(() => ({ loggedIn: false }));
    if (loggedInState.loggedIn) {
      return { ...lastState, loggedIn: true, loggedInState };
    }
    lastState = await detectSignupCodePage(page);
    if (lastState.isCodePage) return lastState;
    if (lastState.hasStrictEmailEntry && !resubmitted) {
      logger?.warn?.("signup code step found strict email entry instead of verification page; resubmitting email", {
        url: lastState.url,
        strictEmailInputCount: lastState.strictEmailInputCount,
      });
      const entry = await openSignupEmailEntry(context, { logger });
      if (entry.ok) {
        const direct = await directSubmitSignupEmail(page, context.account.email, {
          timeoutMs: positiveInt(context.config.runner?.signupEmailDirectSubmitTimeoutMs, 30000),
          pollMs: 250,
        });
        if (direct.ok) {
          context.signupEmailSubmittedAt = Date.now();
          resubmitted = true;
        } else {
          logger?.warn?.("signup code email resubmit failed", {
            reason: direct.reason || "unknown",
            url: page.url(),
          });
        }
      }
    }
    await page.waitForTimeout(pollMs);
  }

  return lastState;
}

async function directFillSignupCode(page, code, { timeoutMs = 45000 } = {}) {
  const submitResult = await page.evaluate((verificationCode) => {
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const actionText = (el) => [
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const input = Array.from(document.querySelectorAll([
      "input[name*='code' i]",
      "input[autocomplete='one-time-code']",
      "input[inputmode='numeric']",
      "input[maxlength='6']",
      "input[aria-label*='code' i]",
      "input[placeholder*='code' i]",
    ].join(","))).find(visible);
    if (!input) return { submitted: false, error: `direct fallback did not find code input. URL: ${location.href}` };

    input.focus?.();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(input, verificationCode);
    else input.value = verificationCode;
    input.dispatchEvent(new InputEvent("input", { bubbles: true, data: verificationCode, inputType: "insertText" }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: verificationCode.slice(-1) || "0" }));

    const form = input.form || input.closest("form");
    const buttons = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"));
    const submitButton = buttons.find((el) => {
      if (!visible(el) || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      const text = actionText(el);
      const value = String(el.getAttribute?.("value") || "").trim();
      return value === "validate" || /continue|submit|verify|验证|继续/i.test(text);
    });
    if (submitButton) {
      submitButton.click();
    } else if (form?.requestSubmit) {
      form.requestSubmit();
    } else if (form) {
      form.submit();
    } else {
      return { submitted: false, error: `direct fallback did not find submit target. URL: ${location.href}` };
    }
    return { submitted: true, url: location.href };
  }, code);

  if (!submitResult?.submitted) {
    throw new Error(submitResult?.error || "direct signup code fallback failed");
  }

  const startedAt = Date.now();
  let lastState = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastState = await page.evaluate(() => {
      const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
      const codeInput = document.querySelector("input[name*='code' i], input[autocomplete='one-time-code'], input[inputmode='numeric']");
      return {
        url: location.href,
        hasCodeInput: Boolean(codeInput),
        invalidCode: /incorrect|invalid|try again|not valid|代码不正确|验证码不正确/i.test(text),
        text: text.slice(0, 500),
      };
    }).catch(() => lastState);
    if (lastState?.invalidCode) return { invalidCode: true, errorText: lastState.text, directFallback: true };
    if (!/email-verification/i.test(lastState?.url || "") || !lastState?.hasCodeInput) {
      return { success: true, assumed: true, directFallback: true, url: lastState?.url || page.url() };
    }
    await page.waitForTimeout(750);
  }
  return { success: true, assumed: true, directFallback: true, url: page.url(), timeoutMs };
}

export async function fetchSignupCodeStep(context) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("fetch-signup-code requires a browser page");
  const beforeState = await detectLoggedInChatgpt(context.page);
  if (beforeState.loggedIn) {
    context.signupProfileSkipped = true;
    return { status: "skipped", reason: "already_logged_in_after_email_code", loggedInState: beforeState };
  }
  const codePageState = await waitForSignupCodePage(context);
  if (codePageState.loggedIn) {
    context.signupProfileSkipped = true;
    return { status: "skipped", reason: "already_logged_in_before_email_code_poll", loggedInState: codePageState.loggedInState };
  }
  if (!codePageState.isCodePage) {
    throw new RunnerError(`步骤 4：未进入 OpenAI 邮箱验证码页，停止轮询邮箱。URL: ${codePageState.url || context.page.url()}`, {
      code: "OPENAI_SIGNUP_CODE_PAGE_NOT_READY",
      retryable: true,
    });
  }
  const attemptedCodes = new Set();
  let code = "";
  let mailbox = "";
  let mail = null;
  let result;
  const maxCodeAttempts = Number(context.config.verification?.openaiCodeSubmitMaxAttempts || 3);

  for (let attempt = 1; attempt <= maxCodeAttempts; attempt += 1) {
    ({ code, mailbox, mail } = await pollOpenAiEmailCode(context.account, context.config, {
      excludeCodes: [...attemptedCodes],
      minReceivedAt: Number(context.signupEmailSubmittedAt || 0),
    }));
    attemptedCodes.add(code);

    const preSubmitState = await detectLoggedInChatgpt(context.page);
    if (preSubmitState.loggedIn) {
      context.signupProfileSkipped = true;
      return {
        status: "done",
        reason: "already_logged_in_before_code_submit",
        mailbox,
        mail,
        result: { assumed: true, code, loggedInState: preSubmitState },
      };
    }

    await ensureSignupRuntime(context);
    try {
      result = await dispatchChromeRuntimeMessage(context.page, {
        type: "FILL_CODE",
        source: "runner",
        step: 4,
        payload: {
          visibleStep: 4,
          code,
          signupProfile: buildSignupProfilePayload(context),
        },
      }, {
        onRetry: async () => ensureSignupRuntime(context),
      });
    } catch (error) {
      const afterErrorState = await detectLoggedInChatgpt(context.page);
      if (/Execution context was destroyed|navigation|chrome runtime shim is not installed/i.test(String(error.message || "")) && afterErrorState.loggedIn) {
        context.signupProfileSkipped = true;
        return {
          status: "done",
          reason: "signup_code_submitted_navigation_to_logged_in",
          mailbox,
          result: { assumed: true, code, loggedInState: afterErrorState },
        };
      }
      if (isReadyStateGateError(error)) {
        result = await directFillSignupCode(context.page, code, {
          timeoutMs: Number(context.config.runner?.signupCodeDirectFallbackTimeoutMs || 45000),
        });
      } else {
        throw error;
      }
    }

    if (result?.error) {
      if (isReadyStateGateError(result.error)) {
        result = await directFillSignupCode(context.page, code, {
          timeoutMs: Number(context.config.runner?.signupCodeDirectFallbackTimeoutMs || 45000),
        });
      }
    }

    if (result?.error) {
      const retryable = !/未找到验证码输入框|verification code input|code input/i.test(String(result.error || ""));
      throw new RunnerError(result.error, { code: "OPENAI_SIGNUP_CODE_SUBMIT_FAILED", retryable });
    }
    const errorText = String(result?.errorText || result?.message || "");
    if (!result?.invalidCode && !/incorrect|invalid|代码不正确/i.test(errorText)) break;
    if (attempt >= maxCodeAttempts) {
      throw new RunnerError(`openai signup code rejected too many times, last_code=${code}, error=${errorText || "invalid code"}`, {
        code: "OPENAI_SIGNUP_CODE_REJECTED",
        retryable: false,
      });
    }
  }
  const afterState = await detectLoggedInChatgpt(context.page);
  if (afterState.loggedIn || result?.skipProfileStep) context.signupProfileSkipped = true;
  return { status: "done", reason: "signup_code_submitted", mailbox, mail, result };
}
