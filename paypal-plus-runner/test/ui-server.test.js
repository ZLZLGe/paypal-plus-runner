import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { createRun, finishRun, updateRun } from "../src/db/run-history-store.js";
import { saveReadyCheckoutLink } from "../src/db/checkout-link-store.js";
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

db.prepare(`
  INSERT INTO gpt_phone_accounts(signup_phone_number, gpt_password, lifecycle_status, lease_status, bound_email, cpa_upload_status)
  VALUES
    ('+447700900123', 'pw', 'registered', 'available', '', ''),
    ('+447700900124', 'pw', 'plus_done', 'available', '', '')
`).run();
const registeredAccount = db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = '+447700900123'").get();
const checkoutLink = saveReadyCheckoutLink(db, {
  gptPhoneAccountId: registeredAccount.id,
  runId: "run_register_link",
  checkoutLongUrl: "https://checkout.stripe.com/c/pay/cs_live_ui_server_testAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA#fidsecret",
});
db.prepare(`
  INSERT INTO paypal_phone_pool(phone, sms_url, status, leased_by, current_run_id, lease_expires_at)
  VALUES (
    '+818012345678',
    'https://sms.test/api/sms/leasedSecretToken123',
    'leased',
    'worker_guard',
    'run_guard',
    datetime('now', '+30 minutes')
  )
`).run();
const leasedPaypalPhone = db.prepare("SELECT id FROM paypal_phone_pool WHERE phone = '+818012345678'").get();
db.prepare(`
  INSERT INTO paypal_phone_pool(phone, sms_url, status, cooldown_until)
  VALUES (
    '+819099998888',
    'https://sms.test/api/sms/cooldownSecretToken123',
    'cooldown',
    datetime('now', '+5 minutes')
  )
`).run();

db.close();

const fakeTasks = new Map();
const fakeJobManager = {
  start(options) {
    const task = {
      taskId: "task_test",
      mode: options.mode,
      ids: options.ids,
      limit: options.limit,
      windows: options.windows,
      forceNewPhone: options.forceNewPhone,
      headless: options.headless,
      paypalPhoneCooldownMinutes: options.paypalPhoneCooldownMinutes,
      status: "running",
      runIds: [],
    };
    fakeTasks.set(task.taskId, task);
    return task;
  },
  list() {
    return [...fakeTasks.values()];
  },
  get(taskId) {
    return fakeTasks.get(taskId) || null;
  },
  stop(taskId) {
    const task = fakeTasks.get(taskId);
    if (!task) return null;
    task.status = "stopped";
    return task;
  },
};

const server = createUiServer({
  database: { path: dbPath },
  paypalPhone: { maxUse: 5, successCooldownMinutes: 7 },
}, { jobManager: fakeJobManager });
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

  const accountsResponse = await fetch(`${baseUrl}/api/plus/accounts?stage=pay-link&limit=50`);
  assert.equal(accountsResponse.ok, true);
  const accountsJson = await accountsResponse.json();
  assert.equal(accountsJson.ok, true);
  assert.equal(accountsJson.accounts.length, 1);
  assert.equal(accountsJson.accounts[0].latestCheckoutLinkStatus, "ready");
  assert.equal(accountsJson.accounts[0].signupPhoneNumber.includes("7700900123"), false);

  const linksResponse = await fetch(`${baseUrl}/api/plus/checkout-links?status=ready&limit=50`);
  assert.equal(linksResponse.ok, true);
  const linksJson = await linksResponse.json();
  assert.equal(linksJson.ok, true);
  assert.equal(linksJson.links.length, 1);
  assert.equal(linksJson.links[0].id, checkoutLink.id);
  assert.equal(JSON.stringify(linksJson).includes("cs_live_ui_server_test"), false);

  const taskResponse = await fetch(`${baseUrl}/api/plus/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "pay-link",
      ids: [checkoutLink.id],
      limit: 1,
      windows: 1,
      headless: false,
      paypalPhoneCooldownMinutes: 7,
    }),
  });
  assert.equal(taskResponse.status, 201);
  const taskJson = await taskResponse.json();
  assert.equal(taskJson.ok, true);
  assert.equal(taskJson.task.mode, "pay-link");
  assert.deepEqual(taskJson.task.ids, [checkoutLink.id]);
  assert.equal(taskJson.task.forceNewPhone, false);
  assert.equal(taskJson.task.headless, false);
  assert.equal(taskJson.task.paypalPhoneCooldownMinutes, 7);

  const initialSettingsResponse = await fetch(`${baseUrl}/api/plus/settings`);
  assert.equal(initialSettingsResponse.ok, true);
  const initialSettingsJson = await initialSettingsResponse.json();
  assert.equal(initialSettingsJson.settings.headless, true);

  const saveSettingsResponse = await fetch(`${baseUrl}/api/plus/settings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ headless: false }),
  });
  assert.equal(saveSettingsResponse.ok, true);
  const saveSettingsJson = await saveSettingsResponse.json();
  assert.equal(saveSettingsJson.settings.headless, false);

  const savedSettingsResponse = await fetch(`${baseUrl}/api/plus/settings`);
  assert.equal(savedSettingsResponse.ok, true);
  const savedSettingsJson = await savedSettingsResponse.json();
  assert.equal(savedSettingsJson.settings.headless, false);

  const importResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: [
        "7094656315----https://s.eduaieasy.indevs.in/api/sms/fakeToken123456",
        "+15722337281|https://sms.test/us",
      ].join("\n"),
      maxUse: 6,
    }),
  });
  assert.equal(importResponse.status, 201);
  const importJson = await importResponse.json();
  assert.equal(importJson.ok, true);
  assert.equal(importJson.imported, 1);
  assert.equal(importJson.skipped, 1);
  assert.equal(importJson.errors[0].line, 2);
  assert.match(importJson.errors[0].error, /country US is not allowed/);

  const emptyImportResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });
  assert.equal(emptyImportResponse.ok, false);

  const phonesResponse = await fetch(`${baseUrl}/api/plus/paypal-phones?country=JP&limit=20`);
  assert.equal(phonesResponse.ok, true);
  const phonesJson = await phonesResponse.json();
  assert.equal(phonesJson.ok, true);
  assert.equal(phonesJson.country, "JP");
  assert.equal(phonesJson.maxUse, 5);
  assert.equal(phonesJson.paypalPhoneCooldownMinutes, 7);
  assert.equal(JSON.stringify(phonesJson).includes("7094656315"), false);
  assert.equal(JSON.stringify(phonesJson).includes("fakeToken123456"), false);
  assert.equal(JSON.stringify(phonesJson).includes("leasedSecretToken123"), false);
  assert.equal(JSON.stringify(phonesJson).includes("cooldownSecretToken123"), false);
  const cooldownPaypalPhone = phonesJson.phones.find((phone) => phone.status === "cooldown");
  assert.ok(cooldownPaypalPhone);
  assert.ok(cooldownPaypalPhone.cooldownUntil);
  const importedPaypalPhone = phonesJson.phones.find((phone) => phone.phone.endsWith("6315"));
  assert.ok(importedPaypalPhone);
  assert.equal(importedPaypalPhone.maxUse, 6);
  assert.equal(importedPaypalPhone.smsUrlPreview, "https://s.eduaieasy.indevs.in/api/sms/[REDACTED]");

  const disableResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/${importedPaypalPhone.id}/disable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "manual test disable" }),
  });
  assert.equal(disableResponse.ok, true);
  const disableJson = await disableResponse.json();
  assert.equal(disableJson.phone.status, "disabled");
  assert.equal(disableJson.phone.lastError, "manual test disable");

  const restoreResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/${importedPaypalPhone.id}/restore`, { method: "POST" });
  assert.equal(restoreResponse.ok, true);
  const restoreJson = await restoreResponse.json();
  assert.equal(restoreJson.phone.status, "active");

  const lockedDisableResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/${leasedPaypalPhone.id}/disable`, { method: "POST" });
  assert.equal(lockedDisableResponse.ok, false);
  const lockedDisableJson = await lockedDisableResponse.json();
  assert.match(lockedDisableJson.error, /cannot be disabled while lease is active/);

  const deleteResponse = await fetch(`${baseUrl}/api/plus/paypal-phones/${importedPaypalPhone.id}/delete`, { method: "POST" });
  assert.equal(deleteResponse.ok, true);
  const deleteJson = await deleteResponse.json();
  assert.equal(deleteJson.action, "delete");

  const newPhoneTaskResponse = await fetch(`${baseUrl}/api/plus/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "register-link", ids: [registeredAccount.id], forceNewPhone: true, limit: 1, windows: 1 }),
  });
  assert.equal(newPhoneTaskResponse.status, 201);
  const newPhoneTaskJson = await newPhoneTaskResponse.json();
  assert.equal(newPhoneTaskJson.ok, true);
  assert.equal(newPhoneTaskJson.task.mode, "register-link");
  assert.deepEqual(newPhoneTaskJson.task.ids, []);
  assert.equal(newPhoneTaskJson.task.forceNewPhone, true);
  assert.equal(newPhoneTaskJson.task.headless, false);

  const taskDetailResponse = await fetch(`${baseUrl}/api/plus/tasks/task_test`);
  assert.equal(taskDetailResponse.ok, true);
  const taskDetailJson = await taskDetailResponse.json();
  assert.equal(taskDetailJson.task.status, "running");

  const stopResponse = await fetch(`${baseUrl}/api/plus/tasks/task_test/stop`, { method: "POST" });
  assert.equal(stopResponse.ok, true);
  const stopJson = await stopResponse.json();
  assert.equal(stopJson.task.status, "stopped");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(tmpDir, { recursive: true, force: true });
}

console.log("ui-server tests passed");
