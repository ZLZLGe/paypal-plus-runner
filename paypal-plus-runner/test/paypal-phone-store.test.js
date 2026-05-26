import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { importPaypalPhonesFile, leasePaypalPhone, releasePaypalPhone } from "../src/db/paypal-phone-store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-plus-runner-"));
const dbPath = path.join(tmpDir, "phones.db");
const phonePath = path.join(tmpDir, "phone.txt");

fs.writeFileSync(phonePath, [
  "+15722337281|http://a.62-us.com/api/get_sms?key=pipe",
  "+14644009780----http://a.62-us.com/api/get_sms?key=dash",
].join("\n"));

const db = openDatabase(dbPath);
initSchema(db);

const imported = importPaypalPhonesFile(db, phonePath, { maxUse: 1 });
assert.equal(imported.imported, 2);
assert.equal(imported.skipped, 0);

const first = leasePaypalPhone(db, { workerId: "w1", runId: "r1" });
const second = leasePaypalPhone(db, { workerId: "w2", runId: "r2" });
assert.ok(first);
assert.ok(second);
assert.notEqual(first.phone, second.phone);
assert.match(first.paypal_local_phone, /^\d{10}$/);
assert.match(second.paypal_local_phone, /^\d{10}$/);

const third = leasePaypalPhone(db, { workerId: "w3", runId: "r3" });
assert.equal(third, null);

releasePaypalPhone(db, first.id, { runId: "r1", success: false, error: "retry" });
const leasedAgain = leasePaypalPhone(db, { workerId: "w4", runId: "r4" });
assert.equal(leasedAgain.id, first.id);

releasePaypalPhone(db, leasedAgain.id, { runId: "r4", success: true });
const row = db.prepare("SELECT status, used_count FROM paypal_phone_pool WHERE id = ?").get(leasedAgain.id);
assert.equal(row.status, "exhausted");
assert.equal(row.used_count, 1);

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("paypal-phone-store tests passed");
