import assert from "node:assert/strict";
import {
  completePhoneLoginProfileIfNeeded,
  confirmOauthCallbackStep,
  detectPhoneLoginProfilePage,
  fetchBindEmailCodeStep,
  fetchLoginPhoneCodeStep,
  isLocalhostOAuthCallbackUrl,
  parsePhoneFlowRetryDelayMs,
  resolveSignupPhoneActivationForOauth,
  shouldRecoverExistingSignupPhoneLogin,
  shouldSkipSignupPhoneRegistrationSteps,
  waitForPostSignupPhoneSubmitState,
} from "../src/steps/phone-flow.js";
import { fillPasswordStep } from "../src/steps/fill-password.js";
import { fetchSignupPhoneCodeStep } from "../src/steps/phone-flow.js";
import { WorkflowStepRetryError } from "../src/utils/errors.js";

assert.deepEqual(parsePhoneFlowRetryDelayMs("5000, 10000 15000 20000"), [5000, 10000, 15000, 20000]);
assert.deepEqual(parsePhoneFlowRetryDelayMs([], [1, 2]), [1, 2]);

assert.equal(shouldRecoverExistingSignupPhoneLogin({
  provider: "hero-sms",
  reused: true,
  activationId: "123",
  phoneNumber: "+573150253471",
}), true);

assert.equal(shouldRecoverExistingSignupPhoneLogin({
  provider: "hero-sms",
  reused: false,
  activationId: "123",
  phoneNumber: "+573150253471",
}), false);

assert.equal(shouldRecoverExistingSignupPhoneLogin({
  provider: "hero-sms",
  reused: true,
  activationId: "123",
  phoneNumber: "+573150253471",
}, {
  runner: { recoverReusedSignupPhoneLogin: false },
}), false);

assert.equal(shouldSkipSignupPhoneRegistrationSteps({
  signupPhoneRecoveredExistingLogin: true,
}), true);

assert.equal(shouldSkipSignupPhoneRegistrationSteps({
  signupPhoneRegistrationSkipped: true,
}), true);

assert.equal(isLocalhostOAuthCallbackUrl("https://auth.openai.com/sign-in-with-chatgpt/codex/consent"), false);
assert.equal(isLocalhostOAuthCallbackUrl("http://127.0.0.1:1455/auth/callback?code=abc&state=state"), true);
assert.equal(isLocalhostOAuthCallbackUrl("http://localhost:1455/auth/callback?error=access_denied&state=state"), true);

assert.equal(resolveSignupPhoneActivationForOauth({
  signupPhoneActivation: {
    provider: "hero-sms",
    phoneNumber: "+44 7787 834951",
  },
  signupPhoneNumber: "+447787834951",
  accountIdentifierType: "phone",
  accountIdentifier: "+447787834951",
}).phoneNumber, "+447787834951");

assert.throws(
  () => resolveSignupPhoneActivationForOauth({}),
  /缺少注册阶段手机号激活/,
);

assert.throws(
  () => resolveSignupPhoneActivationForOauth({
    signupPhoneActivation: { phoneNumber: "+447787834951" },
    signupPhoneNumber: "+817012345678",
  }),
  /与注册阶段不一致/,
);

{
  let evaluateCalls = 0;
  let waitCalls = 0;
  const page = {
    url: () => "https://auth.openai.com/create-account/password",
    waitForTimeout: async () => {
      waitCalls += 1;
    },
    evaluate: async () => {
      evaluateCalls += 1;
      if (evaluateCalls < 2) {
        return {
          state: "unknown",
          url: "https://chatgpt.com/auth/login",
          path: "/auth/login",
        };
      }
      return {
        state: "signup_password_page",
        url: "https://auth.openai.com/create-account/password",
        path: "/create-account/password",
        signupPasswordFormCount: 1,
        signupPasswordInputCount: 1,
      };
    },
  };
  const state = await waitForPostSignupPhoneSubmitState(page, {
    timeoutMs: 0,
    pollMs: 100,
    finalGraceMs: 100,
  });
  assert.equal(state.state, "signup_password_page");
  assert.equal(state.recoveredAfterTimeout, true);
  assert.equal(state.previousState, "unknown");
  assert.equal(state.previousUrl, "https://chatgpt.com/auth/login");
  assert.equal(waitCalls, 1);
}

{
  const page = {
    url: () => "https://auth.openai.com/about-you",
    evaluate: async () => ({
      profilePage: true,
      url: "https://auth.openai.com/about-you",
      title: "何才ですか？ - OpenAI",
      hasNameInput: true,
      hasAgeOrBirthdayInput: true,
    }),
  };
  const profile = await detectPhoneLoginProfilePage(page);
  assert.equal(profile.profilePage, true);
}

{
  let injected = false;
  let payload = null;
  const context = {
    config: { runner: {}, plugin: {} },
    page: {
      url: () => "https://auth.openai.com/about-you",
      evaluate: async () => ({
        profilePage: true,
        url: "https://auth.openai.com/about-you",
        title: "何才ですか？ - OpenAI",
      }),
    },
    checkoutProfile: {
      guest: {
        firstName: "Mai",
        lastName: "Wakita",
        dateOfBirth: "04/15/1986",
      },
    },
  };
  const result = await completePhoneLoginProfileIfNeeded(context, {
    injectRuntime: async () => {
      injected = true;
    },
    dispatchMessage: async (_page, message) => {
      payload = message.payload;
      return { status: "done" };
    },
  });
  assert.equal(injected, true);
  assert.equal(result.completed, true);
  assert.equal(context.signupProfileCompletedAfterLogin, true);
  assert.equal(payload.nodeId, "fill-profile");
  assert.equal(payload.firstName, "Mai");
  assert.equal(payload.year, 1986);
  assert.equal(payload.month, 4);
  assert.equal(payload.day, 15);
}

{
  let evaluateCalls = 0;
  const context = {
    config: { runner: {}, plugin: {} },
    page: {
      url: () => "https://chatgpt.com/",
      evaluate: async () => {
        evaluateCalls += 1;
        if (evaluateCalls === 1) {
          return {
            profilePage: true,
            url: "https://auth.openai.com/about-you",
            title: "何才ですか？ - OpenAI",
          };
        }
        if (evaluateCalls === 2) {
          return {
            profilePage: false,
            url: "https://chatgpt.com/",
          };
        }
        return {
          loggedIn: true,
          url: "https://chatgpt.com/",
          hasLoggedInShell: true,
        };
      },
    },
  };
  const result = await completePhoneLoginProfileIfNeeded(context, {
    injectRuntime: async () => {},
    dispatchMessage: async () => ({
      error: "未找到姓名输入框。URL: https://chatgpt.com/",
    }),
  });
  assert.equal(result.completed, true);
  assert.equal(result.result.reason, "profile_already_advanced_to_chatgpt");
  assert.equal(context.signupProfileCompletedAfterLogin, true);
}

{
  const result = await fillPasswordStep({
    config: { runner: {} },
    signupPhoneRecoveredExistingLogin: true,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "signup_phone_registration_already_recovered");
}

{
  const result = await fetchSignupPhoneCodeStep({
    config: { runner: {} },
    signupPhoneRegistrationSkipped: true,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "signup_phone_registration_already_recovered");
}

{
  const result = await fetchLoginPhoneCodeStep({
    page: {},
    oauthLoginCompletedWithoutSms: true,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "oauth_login_completed_without_sms");
}

{
  const result = await fetchBindEmailCodeStep({
    oauthLoginDirectConsentPage: true,
  });
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "oauth_login_already_on_consent_page");
}

{
  const calls = [];
  let currentUrl = "https://auth.openai.com/sign-in-with-chatgpt/codex/consent";
  const context = {
    config: { runner: { oauthCallbackTimeoutMs: 1000 }, plugin: {} },
    page: {
      url: () => currentUrl,
      waitForTimeout: async () => {},
    },
  };
  const result = await confirmOauthCallbackStep(context, {
    injectFlow: async () => {},
    dispatchMessage: async (_page, message) => {
      calls.push(message.type);
      if (message.type === "STEP8_FIND_AND_CLICK") {
        return { url: "https://auth.openai.com/sign-in-with-chatgpt/codex/consent" };
      }
      currentUrl = "http://127.0.0.1:1455/auth/callback?code=code123&state=state123";
      return { url: "https://auth.openai.com/sign-in-with-chatgpt/codex/consent" };
    },
  });
  assert.deepEqual(calls, ["STEP8_FIND_AND_CLICK", "STEP8_TRIGGER_CONTINUE"]);
  assert.equal(result.localhostUrl, "http://127.0.0.1:1455/auth/callback?code=code123&state=state123");
  assert.equal(context.localhostUrl, result.localhostUrl);
}

{
  const context = {
    config: {
      runner: {
        signupPhoneActivationMaxAttempts: 2,
      },
      openaiPhone: {
        provider: "manual",
        signupPollTimeoutMs: 1000,
        pollIntervalMs: 250,
        initialSmsDelayMs: 0,
        requestTimeoutMs: 1000,
      },
    },
    page: {},
    signupPhoneActivation: {
      provider: "manual",
      phoneNumber: "+447700900111",
      smsUrl: "https://sms.example/no-code",
    },
    signupPhoneNumber: "+447700900111",
    accountIdentifierType: "phone",
    accountIdentifier: "+447700900111",
    gptPhoneAccountId: 123,
    gptPhoneAccount: { id: 123 },
    gptPhoneLifecycleStatus: "signup_pending",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("STATUS_WAIT_CODE");
  try {
    await assert.rejects(
      () => fetchSignupPhoneCodeStep(context),
      (error) => {
        assert.equal(error instanceof WorkflowStepRetryError, true);
        assert.equal(error.code, "OPENAI_SIGNUP_PHONE_CODE_TIMEOUT");
        assert.equal(error.retryFromStep, "submit-signup-phone");
        assert.equal(error.retryMax, 2);
        return true;
      },
    );
    assert.equal(context.signupPhoneActivation, null);
    assert.equal(context.signupPhoneNumber, "");
    assert.equal(context.accountIdentifier, "");
    assert.equal(context.gptPhoneAccountId, null);
    assert.equal(context.gptPhoneAccount, null);
    assert.equal(context.gptPhoneLifecycleStatus, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log("phone-flow tests passed");
