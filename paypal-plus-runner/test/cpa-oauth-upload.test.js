import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  buildCallbackJsonSummary,
  fetchCpaOAuthUrl,
  parseLocalhostOAuthCallback,
  uploadCpaOAuthCallback,
} from "../src/providers/cpa-oauth.js";

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("fetchCpaOAuthUrl reads auth URL and state with bearer headers", async () => {
  await withServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-secret");
    assert.equal(req.headers["x-management-key"], "test-secret");
    assert.equal(req.url, "/v0/management/codex-auth-url");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ auth_url: "https://auth.openai.com/oauth?state=abc", state: "abc" }));
  }, async (baseUrl) => {
    const result = await fetchCpaOAuthUrl({
      cpa: { baseUrl, authorizationBearer: "test-secret", timeoutMs: 5000 },
    });
    assert.equal(result.oauthUrl, "https://auth.openai.com/oauth?state=abc");
    assert.equal(result.cpaOAuthState, "abc");
    assert.equal(result.cpaManagementOrigin, baseUrl);
  });
});

test("uploadCpaOAuthCallback validates state and uploads redirect_url", async () => {
  await withServer(async (req, res) => {
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/v0/management/oauth-callback");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(body.provider, "codex");
    assert.match(body.redirect_url, /^http:\/\/127\.0\.0\.1:1455\/auth\/callback\?/);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ message: "uploaded" }));
  }, async (baseUrl) => {
    const result = await uploadCpaOAuthCallback({
      config: { cpa: { baseUrl, authorizationBearer: "test-secret", timeoutMs: 5000 } },
      localhostUrl: "http://127.0.0.1:1455/auth/callback?code=code123&state=abc",
      expectedState: "abc",
    });
    assert.equal(result.cpaUploadStatus, "done");
    assert.equal(result.verifiedStatus, "uploaded");
    assert.equal(result.callbackSummary.hasCode, true);
    assert.equal(result.callbackSummary.stateMatched, true);
  });
});

test("parseLocalhostOAuthCallback rejects mismatched state", () => {
  assert.throws(() => parseLocalhostOAuthCallback(
    "http://localhost:1455/auth/callback?code=code123&state=wrong",
    "expected",
  ), /state does not match/);
});

test("buildCallbackJsonSummary omits code and state values", () => {
  const summary = buildCallbackJsonSummary({
    account: { email: "user@example.com" },
    accountIdentifierType: "phone",
    accountIdentifier: "+12015550123",
    localhostUrl: "http://localhost:1455/auth/callback?code=secret-code&state=secret-state",
    expectedState: "secret-state",
    cpaUploadResult: { cpaUploadStatus: "done", verifiedStatus: "ok", cpaManagementOrigin: "http://127.0.0.1:8317" },
    now: new Date("2026-05-29T00:00:00.000Z"),
  });
  const text = JSON.stringify(summary);
  assert.equal(summary.callback.hasCode, true);
  assert.equal(summary.callback.hasState, true);
  assert.equal(text.includes("secret-code"), false);
  assert.equal(text.includes("secret-state"), false);
});
