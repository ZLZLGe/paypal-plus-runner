import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import {
  getRecentPaypalPhoneSmsCodes,
  recordPaypalPhoneSmsCodes,
} from "../src/db/paypal-phone-sms-code-store.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "paypal-plus-runner-sms-codes-"));
const dbPath = path.join(tmpDir, "sms-codes.db");
const db = openDatabase(dbPath);
initSchema(db);

recordPaypalPhoneSmsCodes(db, {
  phoneId: 7,
  phone: "+817012345678",
  codes: ["111111", "222222", "111111"],
  source: "baseline",
  runId: "run_a",
});

assert.deepEqual(
  new Set(getRecentPaypalPhoneSmsCodes(db, { phone: "+817012345678" })),
  new Set(["111111", "222222"]),
);

recordPaypalPhoneSmsCodes(db, {
  phoneId: 7,
  phone: "+817012345678",
  codes: ["111111"],
  source: "submitted",
  runId: "run_b",
});
const updated = db.prepare("SELECT source, run_id FROM paypal_phone_sms_codes WHERE phone = ? AND code = ?")
  .get("+817012345678", "111111");
assert.equal(updated.source, "submitted");
assert.equal(updated.run_id, "run_b");

db.prepare(`
  INSERT INTO paypal_phone_sms_codes(phone, code, source, run_id, first_seen_at, last_seen_at)
  VALUES (?, ?, 'baseline', 'old_run', datetime('now', '-25 hours'), datetime('now', '-25 hours'))
`).run("+817012345678", "333333");
assert.equal(
  getRecentPaypalPhoneSmsCodes(db, { phone: "+817012345678", ttlHours: 24 }).includes("333333"),
  false,
);

recordPaypalPhoneSmsCodes(db, {
  phone: "+817000000000",
  codes: ["444444"],
  source: "received",
  runId: "other_phone",
});
assert.deepEqual(getRecentPaypalPhoneSmsCodes(db, { phone: "+817000000000" }), ["444444"]);

db.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log("paypal-phone-sms-code-store tests passed");
