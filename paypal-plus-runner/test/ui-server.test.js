import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { createRun, finishRun, updateRun } from "../src/db/run-history-store.js";
import { createUiServer } from "../src/ui/server.js";

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ui-server-test-"));
const dbPath = path.join(tmpDir, "ui.db");
const db = openDatabase(dbPath);
initSchema(db);

createRun(db, { runId: "run_running", email: "", workerId: "worker_1" });
updateRun(db, "run_running", {
  status: "running",
  current_step: "plus-checkout-billing",
  roxy_dir_id: "dir-live",
  roxy_exit_ip: "203.0.113.10",
  account_identifier_type: "phone",
  account_identifier: "+447700900111",
  gpt_phone_account_id: 23,
  openai_phone_activation_id: 101,
  paypal_phone_id: 7,
  account_lifecycle_status: "registered",
});

createRun(db, { runId: "run_stale_running", email: "", workerId: "worker_1" });
updateRun(db, "run_stale_running", {
  status: "running",
  current_step: "old-workflow",
});
db.prepare("UPDATE run_history SET updated_at = ? WHERE run_id = ?")
  .run("2020-01-01T00:00:00.000Z", "run_stale_running");

createRun(db, { runId: "run_failed", email: "failed@example.com", workerId: "worker_1" });
finishRun(db, "run_failed", { status: "failed", error: "boom" });

createRun(db, { runId: "run_done", email: "done@example.com", workerId: "worker_1" });
finishRun(db, "run_done", { status: "done" });

db.close();

const server = createUiServer({ database: { path: dbPath } });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  const runningResponse = await fetch(`${baseUrl}/api/runs?status=running&activeOnly=1&limit=100`);
  assert.equal(runningResponse.ok, true);
  const runningJson = await runningResponse.json();
  assert.equal(runningJson.ok, true);
  assert.equal(runningJson.runs.length, 1);
  assert.equal(runningJson.runs[0].runId, "run_running");
  assert.equal(runningJson.runs[0].status, "running");
  assert.equal(runningJson.runs[0].gptPhoneAccountId, 23);
  assert.equal(runningJson.runs[0].openAiPhoneActivationId, 101);
  assert.equal(runningJson.runs[0].paypalPhoneId, 7);
  assert.equal(runningJson.runs[0].accountLifecycleStatus, "registered");

  const allResponse = await fetch(`${baseUrl}/api/runs?limit=100`);
  assert.equal(allResponse.ok, true);
  const allJson = await allResponse.json();
  assert.deepEqual(
    new Set(allJson.runs.map((run) => run.runId)),
    new Set(["run_running", "run_stale_running", "run_failed", "run_done"]),
  );

  const runningHistoryResponse = await fetch(`${baseUrl}/api/runs?status=running&limit=100`);
  assert.equal(runningHistoryResponse.ok, true);
  const runningHistoryJson = await runningHistoryResponse.json();
  assert.deepEqual(
    new Set(runningHistoryJson.runs.map((run) => run.runId)),
    new Set(["run_running", "run_stale_running"]),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log("ui-server tests passed");
