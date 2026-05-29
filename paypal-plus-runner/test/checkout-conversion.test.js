import assert from "node:assert/strict";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";
import { buildCheckoutPayload } from "../src/checkout-conversion/checkout-api.js";
import {
  requireHostedCheckoutUrl,
  requireStripeHostedCheckoutUrl,
  resolveCheckoutOpenTarget,
} from "../src/checkout-conversion/hosted-url.js";
import { isRetryableLocalJpError } from "../src/checkout-conversion/local-jp-provider.js";

const config = loadConfig();
assert.equal(DEFAULT_CONFIG.checkoutConversion.country, "US");
assert.equal(DEFAULT_CONFIG.checkoutConversion.currency, "USD");
assert.equal(DEFAULT_CONFIG.checkoutConversion.checkoutUiMode, "hosted");
assert.equal(DEFAULT_CONFIG.checkoutConversion.isCouponFromQueryParam, false);
assert.equal(DEFAULT_CONFIG.checkoutConversion.openUrlPreference, "hosted");
assert.equal(DEFAULT_CONFIG.checkoutConversion.requireStripeHostedUrl, true);
assert.equal(config.checkoutConversion.country, "US");
assert.equal(config.checkoutConversion.currency, "USD");
assert.equal(DEFAULT_CONFIG.roxy.requireExitCountry, "JP");
assert.equal(DEFAULT_CONFIG.checkoutProfile.fallbackAddress.countryCode, "JP");

const payload = buildCheckoutPayload();
assert.equal(payload.checkout_ui_mode, "hosted");
assert.deepEqual(payload.billing_details, { country: "US", currency: "USD" });
assert.equal(payload.promo_campaign.promo_campaign_id, "plus-1-month-free");
assert.equal(payload.promo_campaign.is_coupon_from_query_param, false);

const defaultConfigPayload = buildCheckoutPayload(DEFAULT_CONFIG.checkoutConversion);
assert.deepEqual(defaultConfigPayload.billing_details, { country: "US", currency: "USD" });

const overridePayload = buildCheckoutPayload({
  country: "us",
  currency: "usd",
  checkoutUiMode: "hosted",
  isCouponFromQueryParam: false,
});
assert.deepEqual(overridePayload.billing_details, { country: "US", currency: "USD" });

const hosted = "https://pay.openai.com/c/pay/cs_test_example#fidkdWxOYHwnPyd1blpxYHZx";
const stripeHosted = "https://checkout.stripe.com/c/pay/cs_test_example#fidkdWxOYHwnPyd1blpxYHZx";
const chatgpt = "https://chatgpt.com/checkout/openai_llc/cs_test_example";
assert.equal(requireHostedCheckoutUrl({
  checkoutUrl: "https://chatgpt.com/checkout/openai_ie/cs_test_example",
  hostedCheckoutUrl: hosted,
}), hosted);
assert.equal(requireStripeHostedCheckoutUrl({
  hostedCheckoutUrl: hosted,
  stripeHostedCheckoutUrl: stripeHosted,
}), stripeHosted);
assert.throws(() => requireStripeHostedCheckoutUrl({
  hostedCheckoutUrl: hosted,
}), /Stripe hosted long checkout URL/);

assert.throws(() => requireHostedCheckoutUrl({
  checkoutUrl: "https://chatgpt.com/checkout/openai_ie/cs_test_example",
}), /hosted long checkout URL/);

assert.deepEqual(resolveCheckoutOpenTarget({
  checkoutUrl: "https://chatgpt.com/checkout/openai_ie/cs_test_example",
  chatgptCheckoutUrl: chatgpt,
  hostedCheckoutUrl: hosted,
  stripeHostedCheckoutUrl: stripeHosted,
  preferredCheckoutUrl: hosted,
}, DEFAULT_CONFIG).url, stripeHosted);

assert.deepEqual(resolveCheckoutOpenTarget({
  chatgptCheckoutUrl: chatgpt,
  hostedCheckoutUrl: hosted,
  stripeHostedCheckoutUrl: stripeHosted,
}, {
  checkoutConversion: { openUrlPreference: "hosted" },
}).url, stripeHosted);

assert.deepEqual(resolveCheckoutOpenTarget({
  chatgptCheckoutUrl: chatgpt,
  hostedCheckoutUrl: hosted,
  preferredCheckoutUrl: hosted,
}, {
  checkoutConversion: { openUrlPreference: "preferred", requireStripeHostedUrl: false },
}).url, hosted);

assert.deepEqual(resolveCheckoutOpenTarget({
  chatgptCheckoutUrl: chatgpt,
  hostedCheckoutUrl: hosted,
}, {
  checkoutConversion: { openUrlPreference: "chatgpt", requireStripeHostedUrl: false },
}).url, hosted);

assert.throws(() => resolveCheckoutOpenTarget({
  chatgptCheckoutUrl: chatgpt,
  hostedCheckoutUrl: hosted,
}, {
  checkoutConversion: { openUrlPreference: "hosted", requireStripeHostedUrl: true },
}), /Stripe hosted long checkout URL/);

assert.throws(() => resolveCheckoutOpenTarget({
  checkoutUrl: "https://chatgpt.com/checkout/openai_ie/cs_test_example",
  chatgptCheckoutUrl: chatgpt,
}, {
  checkoutConversion: { openUrlPreference: "chatgpt" },
}), /hosted long checkout URL/);

assert.equal(
  isRetryableLocalJpError(new Error("curl failed code=35 signal=: curl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to iplark.com:443")),
  true,
);
assert.equal(isRetryableLocalJpError(new Error("local JP checkout did not generate a Stripe hosted long checkout URL")), true);
assert.equal(isRetryableLocalJpError(new Error("local jp checkout failed HTTP 400: User is not eligible")), false);

console.log("checkout-conversion tests passed");
