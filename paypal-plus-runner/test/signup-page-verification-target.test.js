import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

function makeInput({ attrs = {}, form = null } = {}) {
  return {
    nodeType: 1,
    textContent: "",
    value: attrs.value || "",
    disabled: false,
    maxLength: Number(attrs.maxlength || 0),
    form,
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    closest() {
      return form;
    },
    getBoundingClientRect() {
      return { width: 240, height: 40, x: 0, y: 0 };
    },
  };
}

const profileForm = {
  getAttribute(name) {
    return name === "action" ? "/about-you" : null;
  },
};
const ageInput = makeInput({
  form: profileForm,
  attrs: {
    name: "age",
    id: "_r_3_-age",
    inputmode: "numeric",
    type: "number",
  },
});
const codeInput = makeInput({
  attrs: {
    name: "code",
    id: "verification-code",
    inputmode: "numeric",
    maxlength: "6",
    autocomplete: "one-time-code",
  },
});

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
  body: { innerText: "何才ですか？ 年齢", textContent: "何才ですか？ 年齢" },
  documentElement,
  querySelector() {
    return null;
  },
  querySelectorAll(selector) {
    if (selector === 'input[maxlength="1"]') return [];
    if (selector.includes('input[inputmode="numeric"]')) {
      return this.body.innerText.includes("SMS") ? [codeInput] : [ageInput];
    }
    return [];
  },
};
const hooks = {};
const context = {
  console,
  document,
  location: new URL("https://auth.openai.com/about-you"),
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

assert.equal(hooks.isVerificationCodeCandidateInput(ageInput), false);
assert.equal(hooks.getVerificationCodeTarget(), null);

context.location = new URL("https://auth.openai.com/phone-verification");
context.window.location = context.location;
context.document.body.innerText = "SMS verification code";
context.document.body.textContent = "SMS verification code";

assert.equal(hooks.isVerificationCodeCandidateInput(codeInput), true);
const target = hooks.getVerificationCodeTarget();
assert.equal(target.type, "single");
assert.equal(target.element, codeInput);

console.log("signup-page verification target tests passed");
