import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { appendRunEvent, listRunEvents } from "../src/db/run-event-store.js";

test("run events are stored with redacted payload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-events-"));
  const db = openDatabase(path.join(dir, "test.db"));
  try {
    initSchema(db);
    appendRunEvent(db, {
      runId: "run_1",
      workerId: "worker_1",
      step: "confirm-oauth-callback",
      eventType: "callback_captured",
      message: "captured",
      pageUrl: "http://localhost:1455/auth/callback?code=secret-code&state=secret-state",
      payload: {
        localhostUrl: "http://localhost:1455/auth/callback?code=secret-code&state=secret-state",
        code: "secret-code",
        state: "secret-state",
        nested: { accessToken: "secret-token" },
      },
    });
    const rows = listRunEvents(db, { runId: "run_1" });
    assert.equal(rows.length, 1);
    const text = JSON.stringify(rows[0]);
    assert.equal(text.includes("secret-code"), false);
    assert.equal(text.includes("secret-state"), false);
    assert.equal(text.includes("secret-token"), false);
    assert.match(rows[0].pageUrlRedacted, /code=\[REDACTED\]/);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
