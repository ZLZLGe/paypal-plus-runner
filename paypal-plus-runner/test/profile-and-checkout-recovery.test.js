import assert from "node:assert/strict";
import { detectLoggedInChatgpt } from "../src/steps/signup-state.js";
import { detectProfileReadiness, dismissOnboardingPrompt } from "../src/steps/fill-profile.js";
import {
  buildHostedGuestPayload,
  fetchPaypalSmsCodeWithSingleResend,
  fillPlusCheckoutStep,
  findStagePage,
  requestPaypalVerificationResend,
  waitForStageAcrossContext,
} from "../src/steps/fill-plus-checkout.js";
import { plusReturnConfirmStep } from "../src/steps/plus-return-confirm.js";
import { detectPageStage, isStripePaypalRedirectSucceededUrl, safeGotoWithRetry } from "../src/browser/page-utils.js";
import { assertPlusSessionJson, extractSessionPlanType, isPlusSessionPlanType } from "../src/providers/session-json.js";

function makeEvalPage({ url = "https://chatgpt.com/", html = "", session = null } = {}) {
  return {
    url: () => url,
    async evaluate(fn, arg) {
      const previous = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
        fetch: globalThis.fetch,
        localStorage: globalThis.localStorage,
        sessionStorage: globalThis.sessionStorage,
        getComputedStyle: globalThis.getComputedStyle,
        MouseEvent: globalThis.MouseEvent,
      };
      const body = {
        innerText: html,
        textContent: html,
      };
      const document = {
        body,
        documentElement: { innerHTML: html },
        title: "ChatGPT",
        querySelector(selector) {
          if (/textarea|\[contenteditable='true'\]|form textarea|main form/.test(selector)) return null;
          return null;
        },
        querySelectorAll(selector) {
          if (/button/.test(selector) && /What brings you to ChatGPT/i.test(html)) {
            return [
              {
                textContent: "Skip",
                value: "",
                disabled: false,
                hasAttribute: () => false,
                getAttribute: () => "",
                getBoundingClientRect: () => ({ width: 80, height: 32 }),
                scrollIntoView() {},
                dispatchEvent() {},
                click() {
                  this.clicked = true;
                },
              },
            ];
          }
          return [];
        },
      };
      try {
        globalThis.window = { getComputedStyle: () => ({ display: "block", visibility: "visible" }) };
        globalThis.document = document;
        globalThis.location = new URL(url);
        globalThis.fetch = async () => session
          ? ({ ok: true, status: 200, json: async () => session })
          : ({ ok: false, status: 401, json: async () => ({}) });
        globalThis.localStorage = { length: 0, key: () => null, getItem: () => null };
        globalThis.sessionStorage = { length: 0, key: () => null, getItem: () => null };
        globalThis.getComputedStyle = () => ({ display: "block", visibility: "visible" });
        globalThis.MouseEvent = class MouseEvent {};
        return await fn(arg);
      } finally {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete globalThis[key];
          else globalThis[key] = value;
        }
      }
    },
    async waitForTimeout() {},
  };
}

const loggedInShellHtml = [
  "Skip to content",
  "You're all set",
  "Continue",
  "New chat",
  "Search chats",
  "Chat history",
  "Projects",
  "Library",
  "Apps",
  "Codex",
  "James Smith",
  "Free",
  "Where should we begin?",
].join(" ");

const serverUserContextHtml = [
  "ChatGPT",
  "{\"userID\":\"user-example\",\"customIDs\":{\"workspace_id\":\"workspace-example\",\"account_id\":\"account-example\"},\"plan_type\":\"free\",\"has_logged_in_before\":true}",
].join(" ");

const loggedInState = await detectLoggedInChatgpt(makeEvalPage({ html: loggedInShellHtml }));
assert.equal(loggedInState.loggedIn, true);
assert.equal(loggedInState.hasLoggedInShell, true);

const serverContextState = await detectLoggedInChatgpt(makeEvalPage({ html: serverUserContextHtml }));
assert.equal(serverContextState.loggedIn, true);
assert.equal(serverContextState.hasServerUserContext, true);

const profileState = await detectProfileReadiness(makeEvalPage({ html: loggedInShellHtml }));
assert.equal(profileState.hasLoggedInShell, true);
assert.equal(profileState.hasCompletionInterstitial, true);

const onboarding = await dismissOnboardingPrompt(makeEvalPage({
  html: "What brings you to ChatGPT? We’ll use this information to suggest ideas. School Work Personal tasks Fun and entertainment Other Next Skip",
}));
assert.equal(onboarding.clicked, true);
assert.equal(onboarding.action, "Skip");

const alreadyPaidContext = {
  page: makeEvalPage(),
  checkout: { alreadyPaid: true, alreadyPaidReason: "User is already paid" },
  plusAlreadyPaid: true,
};
assert.deepEqual(
  await fillPlusCheckoutStep(alreadyPaidContext),
  { status: "skipped", reason: "already_paid", checkout: alreadyPaidContext.checkout },
);
assert.deepEqual(
  await plusReturnConfirmStep(alreadyPaidContext),
  { status: "skipped", reason: "already_paid", checkout: alreadyPaidContext.checkout },
);

assert.equal(isStripePaypalRedirectSucceededUrl("https://checkout.stripe.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=succeeded"), true);
assert.equal(isStripePaypalRedirectSucceededUrl("https://checkout.stripe.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=failed"), false);
assert.equal(isStripePaypalRedirectSucceededUrl("https://pay.openai.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=succeeded"), false);
assert.equal((await detectPageStage(makeEvalPage({ url: "https://chatgpt.com/auth/login" }))).stage, "chatgpt_login");

const stripeReturnContext = {
  page: makeEvalPage({ url: "https://checkout.stripe.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=succeeded" }),
  checkout: {},
  config: { runner: {} },
};
const stripeReturn = await fillPlusCheckoutStep(stripeReturnContext);
assert.equal(stripeReturn.status, "done");
assert.equal(stripeReturn.reason, "stripe_paypal_redirect_succeeded");
assert.equal(stripeReturnContext.stripePaypalRedirectSucceeded, true);

const chatgptLoginReturnContext = {
  page: makeEvalPage({ url: "https://chatgpt.com/auth/login" }),
  checkout: {},
  config: { runner: { checkoutTransitionTimeoutMs: 1 } },
};
const chatgptLoginReturn = await fillPlusCheckoutStep(chatgptLoginReturnContext);
assert.equal(chatgptLoginReturn.status, "done");
assert.equal(chatgptLoginReturn.reason, "chatgpt_login_after_paypal");

await assert.rejects(
  () => plusReturnConfirmStep({
    page: makeEvalPage({ url: "https://checkout.stripe.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=failed" }),
    checkout: {},
    config: { runner: { plusReturnTimeoutMs: 1 } },
  }),
  (error) => {
    assert.equal(error.code, "PLUS_RETURN_NOT_CONFIRMED");
    assert.equal(error.retryable, true);
    return /success URL\/session was not observed/.test(error.message);
  },
);

const hostedPage = makeEvalPage({ url: "https://checkout.stripe.com/c/pay/cs_live_123" });
const paypalPage = makeEvalPage({ url: "https://www.paypal.com/checkoutweb/signup?country.x=JP&locale.x=ja_JP" });
const multiPageContext = {
  page: hostedPage,
  browserContext: {
    pages: () => [hostedPage, paypalPage],
  },
};
const paypalMatch = await findStagePage(multiPageContext, hostedPage, (item) => item.stage === "paypal", {
  preferStages: ["paypal"],
});
assert.equal(paypalMatch.page, paypalPage);
assert.equal(paypalMatch.stage.stage, "paypal");

const successPage = makeEvalPage({ url: "https://chatgpt.com/payments/success?x=1" });
const preferredMatch = await waitForStageAcrossContext({
  page: hostedPage,
  browserContext: {
    pages: () => [hostedPage, paypalPage, successPage],
  },
}, hostedPage, (item) => item.stage === "paypal" || item.stage === "payments_success", {
  timeoutMs: 1,
  pollMs: 0,
  preferStages: ["payments_success", "paypal"],
});
assert.equal(preferredMatch.page, successPage);
assert.equal(preferredMatch.stage.stage, "payments_success");

const plusSession = {
  accessToken: "not-a-jwt",
  account: { plan_type: "plus" },
  user: { email: "plus-user@example.com" },
};
const paypalWaitingPage = makeEvalPage({ url: "https://www.paypal.com/checkoutweb/signup?country.x=JP&locale.x=ja_JP" });
const chatgptPlusPage = makeEvalPage({ url: "https://chatgpt.com/", session: plusSession });
const chatgptPlusContext = {
  page: paypalWaitingPage,
  checkout: {},
  config: { runner: { chatgptPlusSessionProbeIntervalMs: 1 } },
  browserContext: {
    pages: () => [paypalWaitingPage, chatgptPlusPage],
  },
};
const plusSessionResult = await fillPlusCheckoutStep(chatgptPlusContext);
assert.equal(plusSessionResult.status, "done");
assert.equal(plusSessionResult.reason, "chatgpt_plus_session_confirmed");
assert.equal(chatgptPlusContext.page, chatgptPlusPage);
assert.match(chatgptPlusContext.sessionJson, /"plan_type": "plus"/);

const plusReturnResult = await plusReturnConfirmStep({
  page: makeEvalPage({ url: "https://chatgpt.com/", session: plusSession }),
  checkout: {},
  config: { runner: { plusReturnTimeoutMs: 1 } },
});
assert.equal(plusReturnResult.status, "done");
assert.equal(plusReturnResult.reason, "chatgpt_plus_session_confirmed");

const plusSessionJson = JSON.stringify({
  access_token: "not-a-jwt",
  plan_type: "plus",
  raw_session: { account: { plan_type: "plus" } },
});
assert.equal(extractSessionPlanType(plusSessionJson), "plus");
assert.equal(isPlusSessionPlanType("plus"), true);
assert.equal(isPlusSessionPlanType("free"), false);
assert.equal(assertPlusSessionJson(plusSessionJson).planType, "plus");
assert.throws(() => assertPlusSessionJson(JSON.stringify({ access_token: "not-a-jwt", plan_type: "free" })), /Plus plan not confirmed/);

const hostedPayload = buildHostedGuestPayload({
  pluginGuestProfile: {
    email: "guest@example.com",
    firstName: "舞桜",
    lastName: "脇田",
    cardNumber: "3566430218129004",
  },
  checkoutProfile: {
    address: {
      street: "2-5, Nihonbashi Odenma-cho, Chuo-ku, Tokyo",
      city: "Tokyo",
      state: "Tokyo",
      zip: "103-0011",
      countryCode: "JP",
    },
  },
  config: {
    checkoutProfile: {
      hostedAddressCountryCode: "JP",
      fallbackAddress: { countryCode: "JP" },
    },
  },
}, {
  email: "guest@example.com",
});
assert.equal(hostedPayload.email, "guest@example.com");
assert.equal(hostedPayload.firstName, "舞桜");
assert.equal(hostedPayload.lastName, "脇田");
assert.equal(hostedPayload.cardNumber, "3566430218129004");
assert.equal(hostedPayload.address.countryCode, "JP");
assert.equal(hostedPayload.addressSeed.countryCode, "JP");

const hostedVerificationPayload = buildHostedGuestPayload({
  pluginGuestProfile: hostedPayload,
  checkoutProfile: {
    address: hostedPayload.address,
  },
  config: {
    checkoutProfile: {
      hostedAddressCountryCode: "JP",
      fallbackAddress: { countryCode: "JP" },
    },
  },
}, {
  verificationCode: "123456",
  forceFillAfterError: true,
});
assert.equal(hostedVerificationPayload.verificationCode, "123456");
assert.equal(hostedVerificationPayload.forceFillAfterError, true);
assert.equal(hostedVerificationPayload.firstName, "舞桜");
assert.equal(hostedVerificationPayload.cardNumber, "3566430218129004");

const makePaypalOtpTimeout = () => new Error("paypal phone otp timeout for +817094975372, last_response=");
const buildResendPayload = (_context, overrides = {}) => ({ ...overrides });

{
  const context = {
    phoneLease: { phone: "+817094975372", sms_url: "https://sms.test/paypal" },
    config: {},
  };
  const fetchCalls = [];
  const resendCalls = [];
  const code = await fetchPaypalSmsCodeWithSingleResend(context, {}, {
    fetchSmsCode: async (_lease, options) => {
      fetchCalls.push(options);
      if (fetchCalls.length === 1) throw makePaypalOtpTimeout();
      return "654321";
    },
    runHosted: async (_page, _context, payload) => {
      resendCalls.push(payload);
      return { buttonText: "再送", verificationRequired: true };
    },
    buildPayload: buildResendPayload,
    logger: { warn() {} },
  });
  assert.equal(code, "654321");
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].timeoutMs, 30000);
  assert.equal(fetchCalls[1].timeoutMs, 30000);
  assert.equal(resendCalls.length, 1);
  assert.equal(resendCalls[0].requestVerificationResend, true);
  assert.equal(context.paypalVerificationResendAttempted, true);
  assert.equal(context.paypalVerificationResendResult.buttonText, "再送");
  assert.equal(context.currentStep, "plus-checkout-billing/paypal-verification-resend-code");
}

{
  const context = {
    phoneLease: { phone: "+817094975372", sms_url: "https://sms.test/paypal" },
    config: {},
  };
  const fetchCalls = [];
  const resendCalls = [];
  await assert.rejects(
    fetchPaypalSmsCodeWithSingleResend(context, {}, {
      fetchSmsCode: async (_lease, options) => {
        fetchCalls.push(options);
        throw makePaypalOtpTimeout();
      },
      runHosted: async (_page, _context, payload) => {
        resendCalls.push(payload);
        return { buttonText: "Send again", verificationRequired: true };
      },
      buildPayload: buildResendPayload,
      logger: { warn() {} },
    }),
    /paypal phone otp timeout/i,
  );
  assert.equal(fetchCalls.length, 2);
  assert.equal(fetchCalls[0].timeoutMs, 30000);
  assert.equal(fetchCalls[1].timeoutMs, 30000);
  assert.equal(resendCalls.length, 1);
  assert.equal(context.paypalVerificationResendAttempted, true);
}

{
  const context = {
    phoneLease: { phone: "+817094975372", sms_url: "https://sms.test/paypal" },
    config: {},
  };
  const fetchCalls = [];
  const resendCalls = [];
  const code = await fetchPaypalSmsCodeWithSingleResend(context, {}, {
    fetchSmsCode: async (_lease, options) => {
      fetchCalls.push(options);
      return "111222";
    },
    runHosted: async (_page, _context, payload) => {
      resendCalls.push(payload);
      return { buttonText: "再送", verificationRequired: true };
    },
    buildPayload: buildResendPayload,
    logger: { warn() {} },
  });
  assert.equal(code, "111222");
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].timeoutMs, 30000);
  assert.equal(resendCalls.length, 0);
  assert.equal(context.paypalVerificationResendAttempted, undefined);
}

{
  const context = {
    phoneLease: { id: 9, phone: "+817094975372", sms_url: "https://sms.test/paypal" },
    config: {},
  };
  const payloads = [];
  const result = await requestPaypalVerificationResend(context, {}, {
    reason: "verification_error",
    runHosted: async (_page, _context, payload) => {
      payloads.push(payload);
      return { buttonText: "再送", verificationRequired: true, verificationResendRequested: true };
    },
    buildPayload: buildResendPayload,
    logger: { warn() {}, info() {} },
  });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].requestVerificationResend, true);
  assert.equal(result.buttonText, "再送");
  assert.equal(context.paypalVerificationResendAttempted, true);
  assert.equal(context.paypalVerificationResendReason, "verification_error");
}

{
  const context = {
    phoneLease: { id: 10, phone: "+817094975372", sms_url: "https://sms.test/paypal" },
    config: {},
  };
  const payloads = [];
  const result = await requestPaypalVerificationResend(context, {}, {
    reason: "sms_timeout",
    runHosted: async (_page, _context, payload) => {
      payloads.push(payload);
      if (payload.requestVerificationResend) {
        throw new Error("PayPal hosted checkout 未找到验证码再送按钮。");
      }
      return { verificationRetryRequested: true, verificationRequired: true };
    },
    buildPayload: buildResendPayload,
    logger: { warn() {}, info() {} },
  });
  assert.equal(payloads.length, 2);
  assert.equal(payloads[0].requestVerificationResend, true);
  assert.equal(payloads[1].requestVerificationRetry, true);
  assert.equal(result.fallbackRetry, true);
  assert.equal(context.paypalVerificationResendAttempted, true);
}

let gotoAttempts = 0;
const retryPage = {
  async goto() {
    gotoAttempts += 1;
    if (gotoAttempts < 2) throw new Error("page.goto: net::ERR_SSL_PROTOCOL_ERROR");
  },
  url: () => "https://pay.openai.com/c/pay/cs_test_example",
  async waitForTimeout() {},
};
const stage = await safeGotoWithRetry(retryPage, "https://pay.openai.com/c/pay/cs_test_example", {
  attempts: 2,
  retryDelayMs: 0,
  blankBetweenAttempts: false,
});
assert.equal(gotoAttempts, 2);
assert.equal(stage.stage, "hosted_checkout");

console.log("profile and checkout recovery tests passed");
