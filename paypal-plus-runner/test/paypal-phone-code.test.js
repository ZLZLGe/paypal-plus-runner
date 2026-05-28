import assert from "node:assert/strict";
import { extractSmsCode, parseSmsBody } from "../src/providers/paypal-phone-code.js";

const paypalPipe = "yes|PayPal: 600685 is your security code. Don't share it.|(PayPal)|到期时间：2026-06-29 00:00:00\n";
const parsed = parseSmsBody(paypalPipe);
assert.equal(parsed.state, "yes");
assert.match(parsed.payload, /PayPal/);
assert.equal(extractSmsCode(parsed.payload), "600685");

assert.equal(extractSmsCode("PayPal: 1234 is your security code."), "1234");
assert.equal(extractSmsCode("No code here"), "");

console.log("paypal-phone-code tests passed");
