import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import {
  deletePaypalPhone,
  disablePaypalPhone,
  countAvailablePaypalPhones,
  getNextPaypalPhoneCooldown,
  importPaypalPhonesFile,
  importPaypalPhonesText,
  leasePaypalPhone,
  listPaypalPhones,
  paypalLocalPhone,
  paypalPhoneCountryCode,
  paypalPhoneDialCode,
  releasePaypalPhone,
  restorePaypalPhone,
  summarizePaypalPhones,
} from "../src/db/paypal-phone-store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-plus-runner-"));
const dbPath = path.join(tmpDir, "phones.db");
const phonePath = path.join(tmpDir, "phone.txt");

fs.writeFileSync(phonePath, [
  "+15722337281|http://a.62-us.com/api/get_sms?key=pipe",
  "+14644009780----http://a.62-us.com/api/get_sms?key=dash",
  "07094717091----https://sms.test/jp",
].join("\n"));

const db = openDatabase(dbPath);
initSchema(db);

const imported = importPaypalPhonesFile(db, phonePath, { maxUse: 1 });
assert.equal(imported.imported, 3);
assert.equal(imported.skipped, 0);

const first = leasePaypalPhone(db, { workerId: "w1", runId: "r1" });
assert.ok(first);
assert.equal(first.phone, "+817094717091");
assert.equal(first.paypal_local_phone, "7094717091");

const noMoreJp = leasePaypalPhone(db, { workerId: "w2", runId: "r2" });
assert.equal(noMoreJp, null);

releasePaypalPhone(db, first.id, { runId: "r1", success: false, error: "retry" });
const leasedAgain = leasePaypalPhone(db, { workerId: "w4", runId: "r4" });
assert.equal(leasedAgain.id, first.id);

const usPhone = leasePaypalPhone(db, { workerId: "w_us", runId: "r_us", countryCodes: ["US"] });
assert.ok(usPhone);
assert.equal(paypalPhoneCountryCode(usPhone.phone), "US");
assert.match(usPhone.paypal_local_phone, /^\d{10}$/);

const second = leasePaypalPhone(db, { workerId: "w2", runId: "r2", countryCodes: ["US"] });
assert.ok(second);
assert.notEqual(usPhone.phone, second.phone);
assert.match(second.paypal_local_phone, /^\d{10}$/);

const third = leasePaypalPhone(db, { workerId: "w3", runId: "r3" });
assert.equal(third, null);

const fourth = leasePaypalPhone(db, { workerId: "w5", runId: "r5" });
assert.equal(fourth, null);

assert.equal(paypalLocalPhone("+817094717091"), "7094717091");
assert.equal(paypalLocalPhone("7094717091"), "7094717091");
assert.equal(paypalPhoneCountryCode("7094717091"), "JP");
assert.equal(paypalPhoneCountryCode("+817094717091"), "JP");
assert.equal(paypalPhoneDialCode("+817094717091"), "81");

releasePaypalPhone(db, leasedAgain.id, { runId: "r4", success: true });
const row = db.prepare("SELECT status, used_count FROM paypal_phone_pool WHERE id = ?").get(leasedAgain.id);
assert.equal(row.status, "exhausted");
assert.equal(row.used_count, 1);

db.close();

const manageDbPath = path.join(tmpDir, "manage-phones.db");
const manageDb = openDatabase(manageDbPath);
initSchema(manageDb);

const textImported = importPaypalPhonesText(manageDb, [
  "7094656315----https://s.eduaieasy.indevs.in/api/sms/fakeToken123456",
  "09012345678|https://sms.test/jp?key=fake-secret",
  "+15722337281|https://sms.test/us",
  "",
].join("\n"), { maxUse: 3, countryCodes: ["JP"] });
assert.equal(textImported.imported, 2);
assert.equal(textImported.skipped, 1);
assert.equal(textImported.errors[0].line, 3);
assert.match(textImported.errors[0].error, /country US is not allowed/);

let jpRows = listPaypalPhones(manageDb, { countryCodes: ["JP"] });
assert.equal(jpRows.length, 2);
const localJpRow = jpRows.find((item) => item.phone === "+817094656315");
assert.ok(localJpRow);
assert.equal(localJpRow.max_use, 3);
assert.equal(listPaypalPhones(manageDb, { countryCodes: ["US"] }).length, 0);

const disabled = disablePaypalPhone(manageDb, localJpRow.id, { error: "manual disable", countryCodes: ["JP"] });
assert.equal(disabled.status, "disabled");
assert.equal(disabled.last_error, "manual disable");

const duplicate = importPaypalPhonesText(
  manageDb,
  "7094656315----https://sms.test/api/sms/replacementToken999",
  { maxUse: 9, countryCodes: ["JP"] },
);
assert.equal(duplicate.imported, 1);
const disabledAfterImport = manageDb.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(localJpRow.id);
assert.equal(disabledAfterImport.status, "disabled");
assert.equal(disabledAfterImport.max_use, 9);
assert.match(disabledAfterImport.sms_url, /replacementToken999/);

const restored = restorePaypalPhone(manageDb, localJpRow.id, { countryCodes: ["JP"] });
assert.equal(restored.status, "active");
assert.equal(restored.last_error, "");

importPaypalPhonesText(manageDb, "+15722337282|https://sms.test/us2", { maxUse: 1 });
const usOnlyRow = manageDb.prepare("SELECT * FROM paypal_phone_pool WHERE phone = '+15722337282'").get();
assert.ok(usOnlyRow);
assert.throws(
  () => disablePaypalPhone(manageDb, usOnlyRow.id, { countryCodes: ["JP"] }),
  /country US is not allowed/,
);

const deleteTarget = manageDb.prepare("SELECT * FROM paypal_phone_pool WHERE phone = '+819012345678'").get();
assert.ok(deleteTarget);
const deleted = deletePaypalPhone(manageDb, deleteTarget.id, { countryCodes: ["JP"] });
assert.equal(deleted.id, deleteTarget.id);
assert.equal(manageDb.prepare("SELECT COUNT(1) AS c FROM paypal_phone_pool WHERE id = ?").get(deleteTarget.id).c, 0);

importPaypalPhonesText(manageDb, "08012345678|https://sms.test/guard", { maxUse: 2, countryCodes: ["JP"] });
const guardRow = manageDb.prepare("SELECT * FROM paypal_phone_pool WHERE phone = '+818012345678'").get();
manageDb.prepare(`
  UPDATE paypal_phone_pool
  SET status = 'leased',
      current_run_id = 'run_guard',
      lease_expires_at = datetime('now', '+30 minutes')
  WHERE id = ?
`).run(guardRow.id);
assert.throws(
  () => disablePaypalPhone(manageDb, guardRow.id, { countryCodes: ["JP"] }),
  /cannot be disabled while lease is active/,
);
assert.throws(
  () => restorePaypalPhone(manageDb, guardRow.id, { countryCodes: ["JP"] }),
  /cannot be restored while lease is active/,
);
assert.throws(
  () => deletePaypalPhone(manageDb, guardRow.id, { countryCodes: ["JP"] }),
  /cannot be deleted while lease is active/,
);

const summary = summarizePaypalPhones(manageDb, { countryCodes: ["JP"] });
assert.ok(summary.some((item) => item.status === "active" && Number(item.count) >= 1));
assert.ok(summary.some((item) => item.status === "leased" && Number(item.count) === 1));

manageDb.close();

const cooldownDbPath = path.join(tmpDir, "cooldown-phones.db");
const cooldownDb = openDatabase(cooldownDbPath);
initSchema(cooldownDb);

const cooldownImported = importPaypalPhonesText(
  cooldownDb,
  "09011112222|https://sms.test/cooldown-original",
  { maxUse: 3, countryCodes: ["JP"] },
);
assert.equal(cooldownImported.imported, 1);
assert.equal(countAvailablePaypalPhones(cooldownDb, { countryCodes: ["JP"] }), 1);

const cooldownLease = leasePaypalPhone(cooldownDb, { workerId: "cool_worker", runId: "cool_run" });
assert.ok(cooldownLease);
releasePaypalPhone(cooldownDb, cooldownLease.id, {
  runId: "cool_run",
  success: true,
  cooldownMinutes: 5,
});
let cooldownRow = cooldownDb.prepare(`
  SELECT status, used_count, cooldown_until
  FROM paypal_phone_pool
  WHERE id = ?
`).get(cooldownLease.id);
assert.equal(cooldownRow.status, "cooldown");
assert.equal(cooldownRow.used_count, 1);
assert.ok(cooldownRow.cooldown_until);
assert.equal(countAvailablePaypalPhones(cooldownDb, { countryCodes: ["JP"] }), 0);
assert.equal(leasePaypalPhone(cooldownDb, { workerId: "blocked_worker", runId: "blocked_run" }), null);
assert.equal(getNextPaypalPhoneCooldown(cooldownDb, { countryCodes: ["JP"] }).id, cooldownLease.id);

const duplicateDuringCooldown = importPaypalPhonesText(
  cooldownDb,
  "09011112222|https://sms.test/cooldown-replacement",
  { maxUse: 9, countryCodes: ["JP"] },
);
assert.equal(duplicateDuringCooldown.imported, 1);
cooldownRow = cooldownDb.prepare("SELECT status, max_use, sms_url FROM paypal_phone_pool WHERE id = ?").get(cooldownLease.id);
assert.equal(cooldownRow.status, "cooldown");
assert.equal(cooldownRow.max_use, 9);
assert.match(cooldownRow.sms_url, /cooldown-replacement/);

cooldownDb.prepare(`
  UPDATE paypal_phone_pool
  SET cooldown_until = datetime('now', '-1 seconds')
  WHERE id = ?
`).run(cooldownLease.id);
const expiredCooldownLease = leasePaypalPhone(cooldownDb, { workerId: "cool_worker_2", runId: "cool_run_2" });
assert.equal(expiredCooldownLease.id, cooldownLease.id);
assert.equal(expiredCooldownLease.status, "leased");
assert.equal(expiredCooldownLease.cooldown_until, "");
releasePaypalPhone(cooldownDb, expiredCooldownLease.id, { runId: "cool_run_2", success: false, error: "retry" });
cooldownRow = cooldownDb.prepare("SELECT status, cooldown_until FROM paypal_phone_pool WHERE id = ?").get(cooldownLease.id);
assert.equal(cooldownRow.status, "active");
assert.equal(cooldownRow.cooldown_until, "");

const noCooldownLease = leasePaypalPhone(cooldownDb, { workerId: "cool_worker_3", runId: "cool_run_3" });
releasePaypalPhone(cooldownDb, noCooldownLease.id, { runId: "cool_run_3", success: true, cooldownMinutes: 0 });
cooldownRow = cooldownDb.prepare("SELECT status, cooldown_until, used_count FROM paypal_phone_pool WHERE id = ?").get(cooldownLease.id);
assert.equal(cooldownRow.status, "active");
assert.equal(cooldownRow.cooldown_until, "");
assert.equal(cooldownRow.used_count, 2);

const maxLease = leasePaypalPhone(cooldownDb, { workerId: "max_worker", runId: "max_run" });
cooldownDb.prepare("UPDATE paypal_phone_pool SET used_count = max_use - 1 WHERE id = ?").run(maxLease.id);
releasePaypalPhone(cooldownDb, maxLease.id, { runId: "max_run", success: true, cooldownMinutes: 5 });
cooldownRow = cooldownDb.prepare("SELECT status, cooldown_until, used_count, max_use FROM paypal_phone_pool WHERE id = ?").get(maxLease.id);
assert.equal(cooldownRow.status, "exhausted");
assert.equal(cooldownRow.cooldown_until, "");
assert.equal(cooldownRow.used_count, cooldownRow.max_use);

cooldownDb.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("paypal-phone-store tests passed");
