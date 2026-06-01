export const PAYPAL_PLUS_PROCESS = Object.freeze({
  REGISTER_LINK: "register-link",
  PAY_LINK: "pay-link",
  CPA_UPLOAD: "cpa-upload",
  FULL: "full",
});

const PROCESS_ALIASES = new Map([
  ["register", PAYPAL_PLUS_PROCESS.REGISTER_LINK],
  ["register_link", PAYPAL_PLUS_PROCESS.REGISTER_LINK],
  ["register-link", PAYPAL_PLUS_PROCESS.REGISTER_LINK],
  ["link", PAYPAL_PLUS_PROCESS.REGISTER_LINK],
  ["pay", PAYPAL_PLUS_PROCESS.PAY_LINK],
  ["pay_link", PAYPAL_PLUS_PROCESS.PAY_LINK],
  ["pay-link", PAYPAL_PLUS_PROCESS.PAY_LINK],
  ["payment", PAYPAL_PLUS_PROCESS.PAY_LINK],
  ["cpa", PAYPAL_PLUS_PROCESS.CPA_UPLOAD],
  ["cpa_upload", PAYPAL_PLUS_PROCESS.CPA_UPLOAD],
  ["cpa-upload", PAYPAL_PLUS_PROCESS.CPA_UPLOAD],
  ["full", PAYPAL_PLUS_PROCESS.FULL],
  ["all", PAYPAL_PLUS_PROCESS.FULL],
]);

export function normalizePaypalPlusProcess(value = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return PAYPAL_PLUS_PROCESS.FULL;
  return PROCESS_ALIASES.get(raw) || PAYPAL_PLUS_PROCESS.FULL;
}

export function paypalPlusProcessFromConfig(config = {}) {
  return normalizePaypalPlusProcess(config.flow?.paypalPlusProcess || config.flow?.paypal_plus_process || "");
}

export function isPaypalPlusProcess(value, expected) {
  return normalizePaypalPlusProcess(value) === normalizePaypalPlusProcess(expected);
}
