import assert from "node:assert/strict";
import { detectLoggedInChatgpt } from "../src/steps/signup-state.js";
import { detectProfileReadiness, dismissOnboardingPrompt } from "../src/steps/fill-profile.js";
import { fillPlusCheckoutStep } from "../src/steps/fill-plus-checkout.js";
import { plusReturnConfirmStep } from "../src/steps/plus-return-confirm.js";
import { isStripePaypalRedirectSucceededUrl, safeGotoWithRetry } from "../src/browser/page-utils.js";
import { assertPlusSessionJson, extractSessionPlanType, isPlusSessionPlanType } from "../src/providers/session-json.js";

function makeEvalPage({ url = "https://chatgpt.com/", html = "" } = {}) {
  return {
    url: () => url,
    async evaluate(fn, arg) {
      const previous = {
        window: globalThis.window,
        document: globalThis.document,
        location: globalThis.location,
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

const loggedInState = await detectLoggedInChatgpt(makeEvalPage({ html: loggedInShellHtml }));
assert.equal(loggedInState.loggedIn, true);
assert.equal(loggedInState.hasLoggedInShell, true);

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

const stripeReturnContext = {
  page: makeEvalPage({ url: "https://checkout.stripe.com/c/pay/cs_live_123?redirect_pm_type=paypal&redirect_status=succeeded" }),
  checkout: {},
  config: { runner: {} },
};
const stripeReturn = await fillPlusCheckoutStep(stripeReturnContext);
assert.equal(stripeReturn.status, "done");
assert.equal(stripeReturn.reason, "stripe_paypal_redirect_succeeded");
assert.equal(stripeReturnContext.stripePaypalRedirectSucceeded, true);

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
