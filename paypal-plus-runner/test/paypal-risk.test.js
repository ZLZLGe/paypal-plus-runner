import assert from "node:assert/strict";
import {
  buildPaypalRiskBlockedError,
  buildPaypalRiskObservedError,
  inspectPaypalRiskBlockHtml,
  inspectPaypalRiskBlockSnapshot,
  isPaypalRiskBlockedState,
  PAYPAL_RISK_BLOCKED_STAGE,
} from "../src/steps/paypal-risk.js";

const datadomeApprovalHtml = `
  <html>
    <head><title>paypal.com</title></head>
    <body>
      <script data-cfasync="false">
        var dd={'rt':'i','host':'geo.ddc.paypal.com'};
      </script>
      <script src="https://ct.ddc.paypal.com/i.js"></script>
      <form id="ads-dd-captcha">
        <input type="hidden" name="adsddtoken" value="redacted">
      </form>
    </body>
  </html>
`;

const approval = inspectPaypalRiskBlockHtml(
  datadomeApprovalHtml,
  "https://www.paypal.com/agreements/approve?ba_token=BA-redacted",
);
assert.equal(approval.riskBlocked, true);
assert.equal(approval.hostedStage, PAYPAL_RISK_BLOCKED_STAGE);
assert.ok(approval.signals.includes("var_dd"));
assert.ok(approval.signals.includes("geo_ddc_paypal"));
assert.ok(approval.signals.includes("ct_ddc_paypal"));
assert.ok(approval.signals.includes("adsdd_form"));

const blockedSnapshot = inspectPaypalRiskBlockSnapshot({
  url: "https://www.paypal.com/agreements/approve?ba_token=BA-redacted",
  html: datadomeApprovalHtml,
  visibleControlCount: 0,
  hasApproveAction: false,
});
assert.equal(blockedSnapshot.riskBlocked, true);
assert.match(blockedSnapshot.reason, /visible_controls_0/);

const realApproval = inspectPaypalRiskBlockSnapshot({
  url: "https://www.paypal.com/agreements/approve?ba_token=BA-redacted",
  html: "<html><body><button id=\"consentButton\">Agree and Continue</button></body></html>",
  visibleControlCount: 1,
  hasApproveAction: true,
});
assert.equal(realApproval.riskBlocked, false);

assert.equal(isPaypalRiskBlockedState({ hostedStage: "risk_blocked" }), true);
assert.equal(isPaypalRiskBlockedState({ hostedRiskBlocked: true }), true);
assert.equal(isPaypalRiskBlockedState({ hostedStage: "approval", bodyTextPreview: "normal approval page" }), false);

const error = buildPaypalRiskBlockedError(blockedSnapshot, blockedSnapshot);
assert.equal(error.code, "PAYPAL_RISK_BLOCKED");
assert.equal(error.retryable, true);
assert.match(error.message, /PAYPAL_RISK_BLOCKED/);

const observedError = buildPaypalRiskObservedError(blockedSnapshot, blockedSnapshot);
assert.equal(observedError.code, "PAYPAL_RISK_OBSERVED");
assert.equal(observedError.retryable, false);
assert.equal(observedError.preserveBrowserWindow, true);
assert.match(observedError.message, /PAYPAL_RISK_OBSERVED/);

console.log("paypal risk tests passed");
