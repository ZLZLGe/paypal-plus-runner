import assert from "node:assert/strict";
import { redactForCliOutput, stringifySafeJson } from "../src/utils/safe-output.js";

const jwt = [
  "eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1LWJiYzktNDRkMS1hOWQwLWY5NTdiMDc5YmQwZSIsInR5cCI6IkpXVCJ9",
  "eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdLCJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ",
  "Vngq2Me5_MtJJ1lFSk_j-osIT3QxJolZBhu4EaVOCDPUQ2AUTZLJq2cvYM7xKBmAj0qb1ETYKx9rye4mpv3XHN6FefNkNPSz1tcale16nfDTWGXEJxWZChYTlv",
].join(".");

const raw = {
  status: "ok",
  email: "user@example.com",
  result: {
    sessionJson: JSON.stringify({ access_token: jwt }),
    accessToken: jwt,
    checkoutSessionId: "cs_live_a1SN3XHibu7kJI1P5hdyQ82kD9tXUdBeL32hDtPYI5QCOEsoUM6x3y1DPs",
    hostedCheckoutUrl: "https://pay.openai.com/c/pay/cs_live_a1SN3XHibu7kJI1P5hdyQ82kD9tXUdBeL32hDtPYI5QCOEsoUM6x3y1DPs#fidsecret",
    callbackUrl: "https://chatgpt.com/api/auth/callback/openai?code=abc123&state=state123",
    nested: {
      raw_session: { sessionToken: "secret" },
      safe: "plain text",
    },
  },
};

const redacted = redactForCliOutput(raw);
assert.equal(redacted.email, "user@example.com");
assert.equal(redacted.result.sessionJson, "[REDACTED]");
assert.equal(redacted.result.accessToken, "[REDACTED]");
assert.equal(redacted.result.checkoutSessionId, "[REDACTED]");
assert.equal(redacted.result.hostedCheckoutUrl, "https://pay.openai.com/c/pay/cs_[REDACTED]#fid[REDACTED]");
assert.equal(redacted.result.nested.raw_session, "[REDACTED]");
assert.equal(redacted.result.nested.safe, "plain text");
assert.equal(redacted.result.callbackUrl, "https://chatgpt.com/api/auth/callback/openai?code=[REDACTED]&state=[REDACTED]");

const safeJson = stringifySafeJson(raw);
assert.doesNotMatch(safeJson, /eyJ/);
assert.doesNotMatch(safeJson, /cs_live_/);
assert.doesNotMatch(safeJson, /abc123|state123|secret/);
assert.match(safeJson, /\[REDACTED\]/);

console.log("safe-output tests passed");
