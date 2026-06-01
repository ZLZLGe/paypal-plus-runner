import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function makeButton({ text = "", attrs = {} } = {}) {
  return {
    nodeType: 1,
    textContent: text,
    value: attrs.value || "",
    disabled: false,
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    getBoundingClientRect() {
      return { width: 240, height: 56, x: 0, y: 0 };
    },
  };
}

const targetSession = makeButton({
  text: "Account +44 7787 834951",
  attrs: {
    "aria-disabled": "false",
    "data-dd-action-name": "Select existing session",
    name: "session_id",
    value: "target-session",
  },
});
const otherSession = makeButton({
  text: "Account +81 70 1234 5678",
  attrs: {
    "aria-disabled": "false",
    "data-dd-action-name": "Select existing session",
    name: "session_id",
    value: "other-session",
  },
});
const deleteButton = makeButton({
  text: "",
  attrs: {
    "aria-disabled": "false",
    "aria-label": "アカウント +44 7787 834951 を削除する",
    type: "button",
  },
});
const continueWithPhoneButton = makeButton({
  text: "電話番号で続行",
  attrs: {
    "aria-disabled": "false",
    "data-dd-action-name": "Continue with phone",
    type: "button",
  },
});
const chooseAccountSelector = 'form[action="/choose-an-account"] button[name="session_id"], button[name="session_id"][data-dd-action-name="Select existing session"]';
const documentElement = {
  attrs: {},
  getAttribute(name) {
    return this.attrs[name] ?? null;
  },
  setAttribute(name, value) {
    this.attrs[name] = String(value);
  },
};
const document = {
  body: { innerText: "", textContent: "" },
  documentElement,
  querySelector(selector) {
    return selector === 'form[action="/choose-an-account"]' ? {} : null;
  },
  querySelectorAll(selector) {
    if (selector === chooseAccountSelector) {
      return [targetSession, otherSession];
    }
    if (selector === 'button[data-dd-action-name="Continue with phone"], button[type="button"]') {
      return [continueWithPhoneButton];
    }
    if (selector === "button, a, [role=\"button\"], [role=\"link\"], input[type=\"button\"], input[type=\"submit\"]") {
      return [targetSession, otherSession, deleteButton, continueWithPhoneButton];
    }
    return [];
  },
};
const hooks = {};
const context = {
  console,
  document,
  location: new URL("https://auth.openai.com/choose-an-account"),
  chrome: { runtime: { onMessage: { addListener() {} } } },
  __SIGNUP_PAGE_TEST_HOOKS__: hooks,
};
context.window = context;
context.self = context;
context.globalThis = context;
context.getComputedStyle = () => ({ display: "block", visibility: "visible" });

const source = fs.readFileSync(
  path.join(process.cwd(), "vendor/plugin/content/signup-page.js"),
  "utf8",
);
vm.runInNewContext(source, context, { filename: "signup-page.js" });

assert.equal(hooks.isChooseAccountPageReady(), true);
assert.equal(hooks.getChooseAccountSessionButtons().length, 2);
assert.equal(hooks.findChooseAccountSessionButton("+447787834951"), targetSession);
assert.equal(hooks.findChooseAccountSessionButton("+817012345678"), otherSession);
assert.equal(hooks.findChooseAccountSessionButton("+15550001111"), null);
assert.equal(hooks.inspectLoginAuthState().state, "choose_account_page");
assert.equal(hooks.findLoginPhoneEntryTrigger(), continueWithPhoneButton);
assert.deepEqual(
  JSON.parse(JSON.stringify(hooks.serializeLoginAuthState(hooks.inspectLoginAuthState()))),
  {
    state: "choose_account_page",
    url: "https://auth.openai.com/choose-an-account",
    path: "/choose-an-account",
    displayedEmail: "",
    verificationErrorText: "",
    retryEnabled: false,
    titleMatched: false,
    detailMatched: false,
    maxCheckAttemptsBlocked: false,
    emailInUseBlocked: false,
    hasVerificationTarget: false,
    hasPasswordInput: false,
    hasEmailInput: false,
    hasPhoneInput: false,
    hasSubmitButton: false,
    hasSwitchTrigger: false,
    hasLoginEntryTrigger: false,
    hasPhoneEntryTrigger: true,
    hasMoreOptionsTrigger: false,
    verificationVisible: false,
    addPhonePage: false,
    addEmailPage: false,
    phoneVerificationPage: false,
    oauthConsentPage: false,
    consentReady: false,
    chooseAccountPage: true,
    chooseAccountSessionCount: 2,
  },
);

console.log("signup-page choose-account tests passed");
