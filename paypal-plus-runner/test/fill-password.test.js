import assert from "node:assert/strict";
import {
  parseRetryDelayMs,
  shouldRetrySignupPasswordSubmit,
} from "../src/steps/fill-password.js";

assert.deepEqual(parseRetryDelayMs("5000 10000,15000 20000"), [5000, 10000, 15000, 20000]);
assert.deepEqual(parseRetryDelayMs([], [1, 2]), [1, 2]);

assert.equal(shouldRetrySignupPasswordSubmit({
  state: "timeout",
  password: {
    isPasswordPage: true,
    isSubmitting: true,
    hasPasswordError: false,
  },
}), true);

assert.equal(shouldRetrySignupPasswordSubmit({
  state: "timeout",
  password: {
    isPasswordPage: true,
    isSubmitting: false,
    hasPasswordError: false,
  },
}), true);

assert.equal(shouldRetrySignupPasswordSubmit({
  state: "timeout",
  password: {
    isPasswordPage: true,
    isSubmitting: false,
    hasPasswordError: true,
  },
}), false);

assert.equal(shouldRetrySignupPasswordSubmit({
  state: "verification_page",
  verification: {},
}), false);

console.log("fill-password tests passed");
