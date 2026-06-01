import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { insertPlusAccount } from "../src/db/plus-store.js";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plus-store-"));
  const db = openDatabase(path.join(dir, "test.db"));
  initSchema(db);
  return { dir, db };
}

const config = {
  runner: { gptPassword: "gpt-secret" },
  flow: { sessionJsonTarget: "session_json" },
};

{
  const { dir, db } = makeTempDb();
  try {
    const phoneRow = insertPlusAccount(db, {}, {
      plusAccountOnly: true,
      accountIdentifierType: "phone",
      accountIdentifier: "+447787834951",
      signupPhoneNumber: "+447787834951",
      roxyDirId: "dir_1",
      roxyExitIp: "1.2.3.4",
    }, config);

    assert.equal(phoneRow.email, "+447787834951");
    assert.equal(phoneRow.password, "gpt-secret");
    assert.equal(phoneRow.gpt_password, "gpt-secret");
    assert.equal(phoneRow.account_identifier_type, "phone");
    assert.equal(phoneRow.account_identifier, "+447787834951");
    assert.equal(phoneRow.signup_phone_number, "+447787834951");
    assert.equal(phoneRow.bound_email, "");
    assert.equal(phoneRow.import_target, "phone_plus");

    const updatedRow = insertPlusAccount(db, {
      email: "bound@example.com",
      password: "mail-password",
      client_id: "client",
      refresh_token: "refresh",
    }, {
      accountIdentifierType: "phone",
      accountIdentifier: "+447787834951",
      signupPhoneNumber: "+447787834951",
      boundEmail: "bound@example.com",
      cpaUploadStatus: "done",
      cpaUploadResult: { cpaUploadStatus: "done", verifiedStatus: "ok" },
      callbackJsonPath: "/tmp/callback.json",
    }, config);

    assert.equal(updatedRow.id, phoneRow.id);
    assert.equal(updatedRow.email, "bound@example.com");
    assert.equal(updatedRow.password, "mail-password");
    assert.equal(updatedRow.client_id, "client");
    assert.equal(updatedRow.refresh_token, "refresh");
    assert.equal(updatedRow.bound_email, "bound@example.com");
    assert.equal(updatedRow.cpa_upload_status, "done");
    assert.equal(updatedRow.callback_json_path, "/tmp/callback.json");
    assert.equal(db.prepare("SELECT COUNT(1) AS count FROM plus_accounts").get().count, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("plus-store tests passed");
