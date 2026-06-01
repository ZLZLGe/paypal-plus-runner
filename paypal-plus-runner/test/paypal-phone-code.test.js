import assert from "node:assert/strict";
import {
  extractPaypalSmsCodeFromResponse,
  extractSmsCode,
  extractSmsCodes,
  fetchPaypalSmsCode,
  parseSmsBody,
} from "../src/providers/paypal-phone-code.js";

const paypalPipe = "yes|PayPal: 600685 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00\n";
const parsed = parseSmsBody(paypalPipe);
assert.equal(parsed.state, "yes");
assert.match(parsed.payload, /PayPal/);
assert.equal(extractSmsCode(parsed.payload), "600685");

assert.equal(extractSmsCode("PayPal: 1234 is your security code."), "1234");
assert.equal(extractSmsCode("No code here"), "");
assert.deepEqual(extractSmsCodes("old 111111 new 222222 ref 333333", { allowVariableLength: false }), ["111111", "222222", "333333"]);
assert.equal(extractPaypalSmsCodeFromResponse("PayPal: 1234 is your security code."), "");
assert.equal(extractPaypalSmsCodeFromResponse("PayPal: 1234 is your security code.", { allowVariableLength: true }), "1234");

const dangsJson = JSON.stringify([{
  ReciveTime: "2026/5/31 1:35:56",
  Phone: "COM43",
  SmsCode: "364734",
  SmsContent: "PayPal: お客さまのセキュリティコードは364734です。コードを他の方と共有することはお控えください。",
}]);
const dangsParsed = parseSmsBody(dangsJson);
assert.equal(dangsParsed.state, "yes");
assert.equal(extractSmsCode(dangsParsed.payload), "364734");

assert.equal(
  extractPaypalSmsCodeFromResponse("PayPal: お客さまのセキュリティコードは691165です。"),
  "691165",
);
assert.equal(
  extractPaypalSmsCodeFromResponse(JSON.stringify({ status: "ok", data: { text: "PayPal code 782604" } })),
  "782604",
);
assert.equal(
  extractPaypalSmsCodeFromResponse("yes|old 111111 new 222222", { ignoreCodes: ["111111"] }),
  "222222",
);

const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ status: "delivered", raw: "PayPal verification 987654" }),
  });
  const code = await fetchPaypalSmsCode(
    { phone: "+817012345678", sms_url: "https://sms.example.invalid/get" },
    { initialDelayMs: 0, pollIntervalMs: 1, timeoutMs: 1000, requestTimeoutMs: 1000 },
  );
  assert.equal(code, "987654");
} finally {
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
}

try {
  let requestCount = 0;
  const ignored = [];
  let accepted = "";
  globalThis.fetch = async () => ({
    ok: true,
    text: async () => {
      requestCount += 1;
      return requestCount === 1 ? "PayPal old 111111" : "PayPal old 111111 new 222222";
    },
  });
  const code = await fetchPaypalSmsCode(
    { phone: "+817012345678", sms_url: "https://sms.example.invalid/get" },
    {
      initialDelayMs: 0,
      pollIntervalMs: 1,
      timeoutMs: 1000,
      requestTimeoutMs: 1000,
      getIgnoreCodes: () => ["111111"],
      onCodesIgnored: (codes) => ignored.push(...codes),
      onCodeAccepted: (nextCode) => {
        accepted = nextCode;
      },
    },
  );
  assert.equal(code, "222222");
  assert.equal(accepted, "222222");
  assert.ok(ignored.includes("111111"));
} finally {
  if (originalFetch) globalThis.fetch = originalFetch;
  else delete globalThis.fetch;
}

console.log("paypal-phone-code tests passed");
