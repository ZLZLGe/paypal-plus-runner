import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCpaAuthFileName,
  buildCpaJsonArtifact,
  convertSessionJsonToCpaAuthJson,
  importToCpa,
  parseJwtPayload,
  shouldSaveLocalCpaJson,
} from "../src/providers/cpa.js";

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fakeJwt(payload = {}) {
  return [
    base64UrlJson({ alg: "none", typ: "JWT" }),
    base64UrlJson(payload),
    "test-signature",
  ].join(".");
}

const now = new Date("2026-05-27T12:00:00.000Z");
const accessToken = fakeJwt({
  exp: 1800000000,
  email: "user@example.com",
  "https://api.openai.com/auth": {
    chatgpt_account_id: "account-123",
    chatgpt_user_id: "user-123",
    chatgpt_plan_type: "plus",
  },
  "https://api.openai.com/profile": {
    email: "profile@example.com",
  },
});

const sessionJson = JSON.stringify({
  email: "runner@example.com",
  access_token: accessToken,
  session_token: "session-token-test",
  raw_session: {
    user: {
      id: "raw-user",
      email: "raw@example.com",
    },
  },
});

const converted = convertSessionJsonToCpaAuthJson(sessionJson, { now });
assert.equal(converted.authJson.type, "codex");
assert.equal(converted.authJson.account_id, "account-123");
assert.equal(converted.authJson.chatgpt_account_id, "account-123");
assert.equal(converted.authJson.email, "runner@example.com");
assert.equal(converted.authJson.plan_type, "plus");
assert.equal(converted.authJson.chatgpt_plan_type, "plus");
assert.equal(converted.authJson.access_token, accessToken);
assert.equal(converted.authJson.refresh_token, "");
assert.equal(converted.authJson.session_token, "session-token-test");
assert.equal(converted.authJson.id_token_synthetic, true);
assert.equal(converted.authJson.last_refresh, now.toISOString());
assert.equal(converted.authJson.expired, "2027-01-15T08:00:00.000Z");
assert.match(converted.warnings.join("\n"), /无 RT/);
assert.equal(parseJwtPayload(converted.authJson.id_token).email, "runner@example.com");
assert.equal(
  parseJwtPayload(converted.authJson.id_token)["https://api.openai.com/auth"].chatgpt_account_id,
  "account-123",
);

assert.equal(
  buildCpaAuthFileName({ email: "runner@example.com", planType: "plus", accountId: "account-123" }),
  "codex-runner@example.com-plus.json",
);
assert.match(
  buildCpaAuthFileName({ email: "runner@example.com", planType: "team", accountId: "account-123" }),
  /^codex-[a-f0-9]{8}-runner@example\.com-team\.json$/,
);
assert.equal(
  buildCpaAuthFileName({ accountId: "account/with:bad|chars", planType: "Plus Team" }),
  "codex-account-with-bad-chars-plus-team.json",
);

assert.equal(shouldSaveLocalCpaJson({ cpa: { localJsonEnabled: true }, flow: { sessionJsonTarget: "session_json" } }), true);
assert.equal(shouldSaveLocalCpaJson({ cpa: { localJsonEnabled: false }, flow: { sessionJsonTarget: "local_cpa_json" } }), false);
assert.equal(shouldSaveLocalCpaJson({ cpa: {}, flow: { sessionJsonTarget: "local-cpa-json" } }), true);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-plus-cpa-json-"));
try {
  const config = { cpa: { localJsonDir: tmpDir }, output: { dir: "output" } };
  const artifact = buildCpaJsonArtifact({
    sessionJson,
    account: { email: "account@example.com" },
    config,
    now,
  });
  assert.equal(artifact.fileName, "codex-runner@example.com-plus.json");
  assert.equal(artifact.directoryPath, tmpDir);
  assert.equal(artifact.filePath, path.join(tmpDir, "codex-runner@example.com-plus.json"));

  const result = await importToCpa({
    sessionJson,
    account: { email: "account@example.com" },
    config,
    now,
  });
  assert.equal(result.status, "done");
  assert.equal(result.target, "local_cpa_json");
  assert.equal(result.filePath, artifact.filePath);
  const saved = JSON.parse(fs.readFileSync(result.filePath, "utf8"));
  assert.equal(saved.type, "codex");
  assert.equal(saved.email, "runner@example.com");
  assert.equal(saved.refresh_token, "");
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

console.log("cpa-json tests passed");
