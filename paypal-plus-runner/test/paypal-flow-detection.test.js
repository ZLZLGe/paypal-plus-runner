import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function makeVisibleElement({ id = "", text = "", attrs = {}, disabled = false } = {}) {
  return {
    nodeType: 1,
    id,
    textContent: text,
    innerText: text,
    value: "",
    disabled,
    hidden: false,
    className: "",
    parentElement: null,
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getBoundingClientRect() {
      return { width: 42, height: 54, x: 0, y: 0 };
    },
    querySelectorAll() {
      return [];
    },
    scrollIntoView() {},
    click() {
      this.clicked = true;
    },
    dispatchEvent() {},
  };
}

function loadPaypalFlowHooks() {
  const hooks = {};
  const documentElement = {
    nodeType: 1,
    attrs: {},
    getAttribute(name) {
      return this.attrs[name] ?? null;
    },
    setAttribute(name, value) {
      this.attrs[name] = String(value);
    },
    querySelectorAll() {
      return [];
    },
    getBoundingClientRect() {
      return { width: 1, height: 1, x: 0, y: 0 };
    },
  };
  const document = {
    readyState: "complete",
    title: "",
    body: { innerText: "", textContent: "" },
    documentElement,
    scripts: [],
    activeElement: null,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };

  const context = {
    console,
    URL,
    document,
    location: new URL("https://www.paypal.com/checkoutweb/signup"),
    history: { length: 1, back() {} },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    setTimeout() {
      return 0;
    },
    clearTimeout() {},
    setInterval() {
      return 0;
    },
    clearInterval() {},
    log() {},
    throwIfStopped() {},
    sleep: async () => {},
    __PAYPAL_FLOW_TEST_HOOKS__: hooks,
  };
  context.window = context;
  context.globalThis = context;
  context.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1" });

  const source = fs.readFileSync(
    path.join(process.cwd(), "vendor/plugin/content/paypal-flow.js"),
    "utf8",
  );
  vm.runInNewContext(source, context, { filename: "paypal-flow.js" });
  return { hooks, context };
}

const { hooks, context } = loadPaypalFlowHooks();

const reviewConsentButton = makeVisibleElement({
  id: "consentButton",
  text: "同意して続行",
});
context.location = new URL("https://www.paypal.com/webapps/hermes?token=EC-test#/billingweb/review");
context.document.title = "PayPal Checkout - お支払いをご確認ください";
context.document.body.innerText = "対象となるカードが登録されていません。新しい支払方法を追加してください。 同意して続行";
context.document.body.textContent = context.document.body.innerText;
context.document.getElementById = (id) => (id === "consentButton" ? reviewConsentButton : null);
context.document.querySelector = (selector) => (
  selector === "button[data-testid=\"consentButton\"]" ? reviewConsentButton : null
);
context.document.querySelectorAll = () => [reviewConsentButton];

assert.equal(hooks.hasHostedReviewSignals(), true);
assert.equal(hooks.findHostedReviewConsentButton(), reviewConsentButton);

const ciInputs = Array.from({ length: 6 }, (_, index) => makeVisibleElement({
  id: `ci-ciBasic-${index}`,
  attrs: { "aria-label": `${index + 1}-6` },
}));
const idMap = {
  email: makeVisibleElement({ id: "email" }),
  phone: makeVisibleElement({ id: "phone" }),
  cardNumber: makeVisibleElement({ id: "cardNumber" }),
  cardExpiry: makeVisibleElement({ id: "cardExpiry" }),
  cardCvv: makeVisibleElement({ id: "cardCvv" }),
  ...Object.fromEntries(ciInputs.map((input) => [input.id, input])),
};
const submitButton = makeVisibleElement({
  id: "submit-button",
  text: "同意して続行",
});
const resendButton = makeVisibleElement({
  id: "resend-code",
  text: "再送",
});
const directResendButton = makeVisibleElement({
  id: "direct-resend-code",
  text: "Send again",
  attrs: { "data-testid": "resend-link" },
});
const closeButton = makeVisibleElement({
  id: "close-verification",
  text: "閉じる",
  attrs: { "aria-label": "閉じる" },
});
const returnMerchantButton = makeVisibleElement({
  id: "return-to-merchant",
  text: "キャンセルしてマーチャントのページに戻る",
});
context.location = new URL("https://www.paypal.com/checkoutweb/signup?country.x=JP&locale.x=ja_JP");
context.document.title = "PayPal";
context.document.body.innerText = "コードを入力する 6桁のコードを709-3915-798に送信しました 再送";
context.document.body.textContent = context.document.body.innerText;
context.document.activeElement = ciInputs[0];
context.document.getElementById = (id) => idMap[id] || null;
context.document.querySelector = (selector) => {
  if (selector === "button[data-testid=\"submit-button\"]") return submitButton;
  if (selector === "button[data-testid=\"resend-link\"]") return directResendButton;
  return null;
};
context.document.querySelectorAll = () => [submitButton];

assert.equal(hooks.getHostedVerificationPromptText(), "コードを入力する");
assert.equal(hooks.hasActiveHostedVerificationDialog(), true);
assert.equal(hooks.hasHostedVerificationInputs(), true);
assert.equal(hooks.isHostedVerificationResendControl(resendButton), true);
assert.equal(hooks.isHostedVerificationResendControl(submitButton), false);
assert.equal(hooks.isHostedVerificationResendControl(closeButton), false);
assert.equal(hooks.isHostedVerificationResendControl(returnMerchantButton), false);

context.document.querySelectorAll = (selector) => {
  const text = String(selector || "");
  if (text.includes('button') || text.includes('[role="button"]') || text.includes('[aria-label]')) {
    return [submitButton, closeButton, returnMerchantButton, resendButton];
  }
  return [];
};
assert.equal(hooks.findHostedVerificationResendButton(), directResendButton);
const resendResult = await hooks.resendHostedVerificationCode();
assert.equal(resendResult.verificationResendRequested, true);
assert.match(resendResult.buttonText, /Send again/);
assert.equal(directResendButton.clicked, true);
assert.equal(resendButton.clicked, undefined);
assert.equal(submitButton.clicked, undefined);
assert.equal(closeButton.clicked, undefined);
assert.equal(returnMerchantButton.clicked, undefined);

const emptyVerificationAlert = makeVisibleElement({
  id: "verification-error-banner",
  text: "",
  attrs: { role: "alert" },
});
context.document.querySelectorAll = (selector) => {
  const text = String(selector || "");
  if (text.includes('[role="alert"]')) return [emptyVerificationAlert];
  if (text.includes('button')) return [submitButton];
  return [];
};

assert.equal(hooks.getHostedVerificationErrorText(), "paypal_verification_error_banner_visible");
assert.equal(hooks.hasHostedVerificationError(), true);

context.document.body.innerText = "銀行口座またはカードで支払う 同意して続行";
context.document.body.textContent = context.document.body.innerText;
context.document.activeElement = null;
context.document.querySelectorAll = () => [submitButton];

assert.equal(hooks.getHostedVerificationPromptText(), "");
assert.equal(hooks.hasActiveHostedVerificationDialog(), false);
assert.equal(hooks.hasHostedVerificationInputs(), false);

const cookieSubmitButton = makeVisibleElement({
  id: "submitCookiesBtn",
  text: "Cookieの設定を保存",
});
context.location = new URL("https://www.paypal.com/myaccount/privacy/cookiePrefs?locale=ja_JP");
context.document.title = "PayPal";
context.document.body.innerText = "Cookieの設定を管理する Cookieの設定を保存";
context.document.body.textContent = context.document.body.innerText;
context.document.getElementById = (id) => (id === "submitCookiesBtn" ? cookieSubmitButton : null);
context.document.querySelector = () => null;
context.document.querySelectorAll = () => [cookieSubmitButton];

assert.equal(hooks.isHostedPrivacySettingsPage(), true);
assert.equal(hooks.detectPayPalHostedCheckoutStage(), "privacy_settings");
const privacyState = hooks.inspectPayPalState();
assert.equal(privacyState.hostedPrivacySettingsVisible, true);
assert.equal(privacyState.hostedBlockingPromptVisible, true);

console.log("paypal flow detection tests passed");
