const HOSTED_CHECKOUT_URL_PATTERN = /^https:\/\/(?:pay\.openai\.com|checkout\.stripe\.com)\/c\/pay\//i;
const STRIPE_HOSTED_CHECKOUT_URL_PATTERN = /^https:\/\/checkout\.stripe\.com\/c\/pay\//i;
const CHATGPT_CHECKOUT_URL_PATTERN = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/checkout(?:\/|$)/i;

export function isHostedCheckoutUrl(value = "") {
  return HOSTED_CHECKOUT_URL_PATTERN.test(String(value || "").trim());
}

export function isStripeHostedCheckoutUrl(value = "") {
  return STRIPE_HOSTED_CHECKOUT_URL_PATTERN.test(String(value || "").trim());
}

export function isChatgptCheckoutUrl(value = "") {
  return CHATGPT_CHECKOUT_URL_PATTERN.test(String(value || "").trim());
}

function requireStripeHosted(config = {}) {
  return config.checkoutConversion?.requireStripeHostedUrl !== false;
}

export function requireHostedCheckoutUrl(checkout = {}) {
  const candidates = [
    checkout.preferredCheckoutUrl,
    checkout.hostedCheckoutUrl,
    checkout.stripe_payurl,
  ].map((value) => String(value || "").trim()).filter(Boolean);

  const hostedUrl = candidates.find(isHostedCheckoutUrl) || "";
  if (!hostedUrl) {
    throw new Error("checkout conversion did not return a hosted long checkout URL");
  }
  return hostedUrl;
}

export function requireStripeHostedCheckoutUrl(checkout = {}) {
  const candidates = [
    checkout.stripeHostedCheckoutUrl,
    checkout.stripe_payurl,
    checkout.hostedCheckoutUrl,
    checkout.preferredCheckoutUrl,
  ].map((value) => String(value || "").trim()).filter(Boolean);

  const hostedUrl = candidates.find(isStripeHostedCheckoutUrl) || "";
  if (!hostedUrl) {
    throw new Error("checkout conversion did not return a Stripe hosted long checkout URL");
  }
  return hostedUrl;
}

function normalizeOpenUrlPreference(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (["hosted", "hosted_checkout", "long", "pay_openai"].includes(raw)) return "hosted";
  if (["preferred", "provider", "auto"].includes(raw)) return "preferred";
  if (["chatgpt", "short"].includes(raw)) return "chatgpt";
  return "hosted";
}

function compactUrls(values = []) {
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

function pickFirstMatching(values = [], predicate) {
  return compactUrls(values).find(predicate) || "";
}

function describeCheckoutUrlType(url = "") {
  if (isHostedCheckoutUrl(url)) return "hosted";
  if (isChatgptCheckoutUrl(url)) return "chatgpt";
  return "unknown";
}

export function resolveCheckoutOpenTarget(checkout = {}, config = {}) {
  const preference = normalizeOpenUrlPreference(config.checkoutConversion?.openUrlPreference);
  const chatgptUrl = pickFirstMatching([
    checkout.chatgptCheckoutUrl,
    checkout.convertedCheckoutUrl,
    checkout.checkoutUrl,
  ], isChatgptCheckoutUrl);
  const hostedUrl = pickFirstMatching([
    checkout.stripeHostedCheckoutUrl,
    checkout.hostedCheckoutUrl,
    checkout.stripe_payurl,
    checkout.preferredCheckoutUrl,
    checkout.openaiHostedCheckoutUrl,
  ], isHostedCheckoutUrl);
  const stripeHostedUrl = pickFirstMatching([
    checkout.stripeHostedCheckoutUrl,
    checkout.stripe_payurl,
    checkout.hostedCheckoutUrl,
    checkout.preferredCheckoutUrl,
    checkout.openaiHostedCheckoutUrl,
  ], isStripeHostedCheckoutUrl);
  const preferredUrl = String(checkout.preferredCheckoutUrl || "").trim();
  const preferredUrlType = describeCheckoutUrlType(preferredUrl);

  const selectedHostedUrl = requireStripeHosted(config) ? stripeHostedUrl : (stripeHostedUrl || hostedUrl);
  if (!selectedHostedUrl) {
    if (requireStripeHosted(config)) {
      throw new Error("checkout conversion did not return a Stripe hosted long checkout URL");
    }
    throw new Error("checkout conversion did not return a hosted long checkout URL");
  }

  return {
    url: selectedHostedUrl,
    type: "hosted",
    preference,
    chatgptUrl,
    hostedUrl: selectedHostedUrl,
    stripeHostedUrl,
    preferredUrlType,
  };
}
