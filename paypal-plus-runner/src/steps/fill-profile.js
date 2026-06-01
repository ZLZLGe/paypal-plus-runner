import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { safeGoto } from "../browser/page-utils.js";
import { detectLoggedInChatgpt } from "./signup-state.js";
import { recoverSignupRedirectedLoginStep } from "./phone-flow.js";
import { buildSignupProfilePayload } from "./signup-profile.js";

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function detectProfileReadiness(page) {
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
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ").trim();
    const url = location.href;
    const nameInput = Array.from(document.querySelectorAll("input")).find((el) => {
      if (!visible(el)) return false;
      const meta = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
      ].filter(Boolean).join(" ");
      return /name|first|last|given|family|姓名|名字|姓氏/i.test(meta);
    });
    const birthdayInput = Array.from(document.querySelectorAll("input, select, [role='combobox'], [role='spinbutton']")).find((el) => {
      if (!visible(el)) return false;
      const meta = [
        el.name,
        el.id,
        el.placeholder,
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        el.textContent,
      ].filter(Boolean).join(" ");
      return /birth|birthday|month|day|year|出生|生日/i.test(meta);
    });
    const isCallback = /\/api\/auth\/callback\/openai/i.test(url);
    const isGatewayTimeout = /gateway\s*time-?out|error reference number:\s*504|cf-error-details|cloudflare location/i.test(text);
    const hasCloudflareChallenge = /__CF\$cv|challenge-platform|cdn-cgi\/challenge|cf_chl/i.test(String(document.documentElement?.innerHTML || ""));
    const hasOnboardingPrompt = /what brings you to chatgpt|we.?ll use this information to suggest ideas|school work personal tasks|fun and entertainment|ChatGPT\s*を選んだ理由|この情報は、あなたに役に立つと思われるアイデアを提案するために使用されます|学校|職場|個人的なタスク|娯楽/i.test(text);
    const hasLoggedInShell = /new chat|search chats|新しいチャット|チャットを検索/i.test(text)
      && /chat history|projects|library|apps|codex|チャット履歴|プロジェクト|ライブラリ|アプリ/i.test(text);
    const hasCompletionInterstitial = /you.?re all set|by continuing, you agree to our terms|continue/i.test(text)
      && hasLoggedInShell;
    const isProfileRoute = /\/(?:create-account\/profile|u\/signup\/profile|signup\/profile|about-you)(?:[/?#]|$)/i
      .test(String(location.pathname || ""));
    const isOpenAiLoginPage = /\/\/auth\.openai\.com\/log-in(?:[/?#]|$)/i.test(url);
    const hasProfileCopy = /tell us about yourself|what should we call you|how old are you|date of birth|姓名|生日/i.test(text);
    const hasProfileForm = Boolean((nameInput || birthdayInput) || (isProfileRoute && hasProfileCopy));
    return {
      url,
      text: text.slice(0, 300),
      isCallback,
      isGatewayTimeout,
      hasCloudflareChallenge,
      hasOnboardingPrompt,
      hasLoggedInShell,
      hasCompletionInterstitial,
      hasProfileForm,
      isOpenAiLoginPage,
      hasNameInput: Boolean(nameInput),
      hasBirthdayInput: Boolean(birthdayInput),
      isProfileRoute,
      hasProfileCopy,
    };
  }).catch(() => ({
    url: page.url(),
    isCallback: /\/api\/auth\/callback\/openai/i.test(page.url()),
    isGatewayTimeout: false,
    isOpenAiLoginPage: /\/\/auth\.openai\.com\/log-in(?:[/?#]|$)/i.test(page.url()),
    hasProfileForm: false,
  }));
}

export async function dismissOnboardingPrompt(page) {
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
      && !el.hasAttribute?.("data-visually-disabled");
    const actionText = (el) => [
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const hasOnboardingPrompt = /what brings you to chatgpt|we.?ll use this information to suggest ideas|school work personal tasks|fun and entertainment|ChatGPT\s*を選んだ理由|この情報は、あなたに役に立つと思われるアイデアを提案するために使用されます|学校|職場|個人的なタスク|娯楽/i.test(text);
    if (!hasOnboardingPrompt) {
      return { clicked: false, reason: "no_onboarding_prompt", url: location.href };
    }
    const actions = Array.from(document.querySelectorAll(
      "button, a, [role='button'], input[type='button'], input[type='submit']",
    )).filter((el) => visible(el) && enabled(el));
    const skip = actions.find((el) => /^(skip|スキップする)$/i.test(actionText(el)));
    const personal = actions.find((el) => /personal tasks|個人的なタスク/i.test(actionText(el)));
    const next = actions.find((el) => /^(next|次へ)$/i.test(actionText(el)));
    const continueButton = actions.find((el) => /^(continue|続行)$/i.test(actionText(el)));
    const target = skip || continueButton || personal || next;
    if (!target) {
      return {
        clicked: false,
        reason: "missing_onboarding_action",
        url: location.href,
        actions: actions.map((el) => actionText(el)).filter(Boolean).slice(0, 12),
      };
    }
    target.scrollIntoView?.({ block: "center", inline: "center" });
    target.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.click();
    return { clicked: true, reason: "clicked_onboarding_action", action: actionText(target), url: location.href };
  });
}

function isTransientNavigationError(error) {
  return /Execution context was destroyed|most likely because of a navigation|Cannot find context with specified id|Target closed/i
    .test(String(error?.message || error || ""));
}

async function waitForProfileReadyOrLoggedIn(context, { logger } = {}) {
  const page = context.page;
  const timeoutMs = positiveInt(context.config.runner?.signupProfileReadyWaitMs, 90000);
  const callbackReloadAttempts = positiveInt(context.config.runner?.signupCallbackReloadAttempts, 2);
  const startedAt = Date.now();
  let reloads = 0;
  let lastState = await detectProfileReadiness(page);
  let loggedCallbackWait = false;

  while (Date.now() - startedAt < timeoutMs) {
    const loggedInState = await detectLoggedInChatgpt(page);
    if (loggedInState.loggedIn) {
      return { state: "logged_in", loggedInState };
    }

    lastState = await detectProfileReadiness(page);
    if (lastState.hasLoggedInShell || lastState.hasCompletionInterstitial) {
      return { state: "logged_in", profileState: lastState };
    }
    if (lastState.hasOnboardingPrompt) {
      const dismiss = await dismissOnboardingPrompt(page);
      logger?.info?.("handled ChatGPT onboarding prompt", dismiss);
      await page.waitForTimeout(2500);
      continue;
    }
    if (lastState.hasProfileForm) {
      return { state: "profile", profileState: lastState };
    }
    if (lastState.isOpenAiLoginPage) {
      return { state: "openai_login", profileState: lastState };
    }

    if (lastState.isGatewayTimeout && reloads < callbackReloadAttempts) {
      reloads += 1;
      logger?.warn?.("auth callback gateway timeout; reloading callback", {
        reloads,
        callbackReloadAttempts,
        url: lastState.url,
      });
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000),
      }).catch((error) => {
        logger?.warn?.("auth callback reload failed", { error: error.message });
      });
      await page.waitForTimeout(2500);
      continue;
    }

    if (lastState.isCallback && !loggedCallbackWait) {
      loggedCallbackWait = true;
      logger?.warn?.("waiting for auth callback to leave callback URL", {
        url: lastState.url,
        isGatewayTimeout: lastState.isGatewayTimeout,
        hasCloudflareChallenge: lastState.hasCloudflareChallenge,
      });
    }

    if (lastState.isGatewayTimeout && reloads >= callbackReloadAttempts) {
      logger?.warn?.("auth callback still timed out; navigating to ChatGPT home for state recovery", {
        url: lastState.url,
      });
      await safeGoto(page, String(context.config.runner?.signupEntryUrl || "https://chatgpt.com/"), {
        waitUntil: "domcontentloaded",
        timeoutMs: positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000),
      }).catch(() => undefined);
      await page.waitForTimeout(3000);
    } else {
      await page.waitForTimeout(1000);
    }
  }

  return { state: "timeout", profileState: lastState };
}

export async function fillProfileStep(context, { logger } = {}) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("fill-profile requires a browser page");
  if (context.signupProfileSkipped) {
    return { status: "skipped", reason: "signup_profile_already_skipped" };
  }
  const loggedInState = await detectLoggedInChatgpt(context.page);
  if (loggedInState.loggedIn) {
    return { status: "skipped", reason: "already_logged_in_no_profile_page", loggedInState };
  }
  const readyState = await waitForProfileReadyOrLoggedIn(context, { logger });
  if (readyState.state === "openai_login" && context.accountIdentifierType === "phone") {
    const recovery = await recoverSignupRedirectedLoginStep(context, { logger });
    if (recovery.recovered) {
      const recoveredState = await waitForProfileReadyOrLoggedIn(context, { logger });
      if (recoveredState.state === "logged_in") {
        return { status: "skipped", reason: "already_logged_in_after_signup_redirected_login", loggedInState: recoveredState.loggedInState, recovery };
      }
      if (recoveredState.state === "profile") {
        readyState.state = "profile";
        readyState.profileState = recoveredState.profileState;
      } else if (recoveredState.state === "timeout") {
        throw new Error(`注册后手机号登录恢复超时。URL: ${recoveredState.profileState?.url || context.page.url()}`);
      }
    }
  }
  if (readyState.state === "logged_in") {
    return { status: "skipped", reason: "already_logged_in_no_profile_page", loggedInState: readyState.loggedInState };
  }
  if (readyState.state === "timeout") {
    throw new Error(`等待资料页或登录态超时。URL: ${readyState.profileState?.url || context.page.url()}`);
  }
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root,
  });
  let result;
  try {
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "fill-profile",
      payload: {
        nodeId: "fill-profile",
        visibleStep: 5,
        ...buildSignupProfilePayload(context),
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, {
        pluginRoot: context.config.plugin?.root,
      }),
    });
  } catch (error) {
    if (!isTransientNavigationError(error)) throw error;
    logger?.warn?.("fill-profile hit transient navigation; rechecking page state", {
      error: error.message,
      url: context.page.url(),
    });
    await context.page.waitForLoadState("domcontentloaded", {
      timeout: positiveInt(context.config.runner?.pageLoadTimeoutMs, 120000),
    }).catch(() => undefined);
    await context.page.waitForTimeout(2500);
    const recoveredState = await waitForProfileReadyOrLoggedIn(context, { logger });
    if (recoveredState.state === "logged_in") {
      return { status: "skipped", reason: "already_logged_in_after_profile_navigation", loggedInState: recoveredState.loggedInState };
    }
    if (recoveredState.state === "timeout") {
      throw new Error(`资料页跳转后重新检测超时。URL: ${recoveredState.profileState?.url || context.page.url()}`);
    }
    await injectSignupFlow(context.page, {
      pluginRoot: context.config.plugin?.root,
    });
    result = await dispatchChromeRuntimeMessage(context.page, {
      type: "EXECUTE_NODE",
      source: "runner",
      nodeId: "fill-profile",
      payload: {
        nodeId: "fill-profile",
        visibleStep: 5,
        ...buildSignupProfilePayload(context),
      },
    }, {
      onRetry: async () => injectSignupFlow(context.page, {
        pluginRoot: context.config.plugin?.root,
      }),
    });
  }
  if (result?.error) {
    if (/未找到姓名输入框|name input|profile/i.test(String(result.error || ""))) {
      logger?.warn?.("fill-profile plugin could not find fields; rechecking page state", {
        error: result.error,
        url: context.page.url(),
      });
      const recoveredState = await waitForProfileReadyOrLoggedIn(context, { logger });
      if (recoveredState.state === "logged_in") {
        return { status: "skipped", reason: "already_logged_in_after_profile_recheck", loggedInState: recoveredState.loggedInState };
      }
      if (recoveredState.state === "timeout") {
        throw new Error(`资料页字段缺失且重新检测超时。URL: ${recoveredState.profileState?.url || context.page.url()}`);
      }
    }
    throw new Error(result.error);
  }
  return { status: "done", reason: "profile_submitted", result };
}
