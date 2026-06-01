import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { insertPlusAccount } from "../src/db/plus-store.js";
import {
  GPT_PHONE_LIFECYCLE,
  countReusableGptPhoneAccounts,
  createPendingGptPhoneAccountFromActivation,
  gptPhoneAccountToWorkflowAccount,
  leaseReusableGptPhoneAccount,
  markGptAccountCpaDone,
  markGptAccountEmailBound,
  markGptAccountFailure,
  markGptAccountPlusDone,
  recordOpenAiPhoneActivation,
  releaseGptPhoneAccount,
} from "../src/db/gpt-phone-account-store.js";
import { prepareRunContext, runWorkflow } from "../src/workflow.js";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-phone-store-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase(dbPath);
  initSchema(db);
  return { dir, db, dbPath };
}

function smsOauthConfig(dbPath) {
  return {
    database: { path: dbPath },
    runner: {
      gptPassword: "runner-password-2026",
      pageObservationTimeoutMs: 1,
    },
    flow: { plusAccountAccessStrategy: "sms_oauth" },
    paypalPhone: { leaseMinutes: 30 },
    checkoutProfile: {
      addressProvider: "fallback",
      firstName: "Mai",
      lastName: "Wakita",
      fallbackAddress: {
        street: "1-1-2 Otemachi",
        city: "Chiyoda-ku",
        state: "Tokyo",
        zip: "1000004",
        countryCode: "JP",
      },
    },
  };
}

{
  const { dir, db } = makeTempDb();
  try {
    insertPlusAccount(db, {}, {
      plusAccountOnly: true,
      accountIdentifierType: "phone",
      accountIdentifier: "+447700900111",
      signupPhoneNumber: "+447700900111",
    }, smsOauthConfig(path.join(dir, "test.db")));
    initSchema(db);

    const row = db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = '+447700900111'").get();
    assert.equal(row.lifecycle_status, GPT_PHONE_LIFECYCLE.PLUS_DONE);
    assert.equal(row.lease_status, "available");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db, dbPath } = makeTempDb();
  const db2 = openDatabase(dbPath);
  initSchema(db2);
  try {
    db.prepare(`
      INSERT INTO gpt_phone_accounts(signup_phone_number, gpt_password, lifecycle_status, lease_status, bound_email, updated_at)
      VALUES
        ('+447700900201', 'pw', 'registered', 'available', '', '2026-01-03T00:00:00.000Z'),
        ('+447700900202', 'pw', 'plus_done', 'available', '', '2026-01-02T00:00:00.000Z'),
        ('+447700900203', 'pw', 'email_bound', 'available', 'bound@example.com', '2026-01-01T00:00:00.000Z')
    `).run();

    const first = leaseReusableGptPhoneAccount(db, { workerId: "w1", runId: "r1" });
    const second = leaseReusableGptPhoneAccount(db2, { workerId: "w2", runId: "r2" });

    assert.equal(first.signup_phone_number, "+447700900203");
    assert.equal(first.lifecycle_status, GPT_PHONE_LIFECYCLE.EMAIL_BOUND);
    assert.equal(second.signup_phone_number, "+447700900202");
    assert.equal(second.lifecycle_status, GPT_PHONE_LIFECYCLE.PLUS_DONE);
    assert.notEqual(first.id, second.id);

    releaseGptPhoneAccount(db, first.id, { runId: "r1" });
    assert.equal(countReusableGptPhoneAccounts(db), 2);
  } finally {
    db2.close();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const activation = {
      provider: "hero-sms",
      activationId: "act_1",
      phoneNumber: "+447700900301",
      countryId: 16,
      countryLabel: "United Kingdom",
    };
    const activationRow = recordOpenAiPhoneActivation(db, activation, {
      runId: "r1",
      workerId: "w1",
    });
    const account = createPendingGptPhoneAccountFromActivation(db, activation, {
      activationId: activationRow.id,
      workerId: "w1",
      runId: "r1",
      gptPassword: "phone-password",
    });
    assert.equal(account.lifecycle_status, GPT_PHONE_LIFECYCLE.SIGNUP_PENDING);
    assert.equal(account.lease_status, "leased");

    const disabled = markGptAccountFailure(db, account.id, {
      status: GPT_PHONE_LIFECYCLE.DISABLED,
      step: "submit-signup-phone",
      error: "already registered",
    });
    assert.equal(disabled.lifecycle_status, GPT_PHONE_LIFECYCLE.DISABLED);
    assert.equal(disabled.lease_status, "available");
    assert.equal(disabled.current_run_id, "");

    const replacementActivation = {
      ...activation,
      activationId: "act_1b",
      phoneNumber: "+447700900302",
    };
    const replacementActivationRow = recordOpenAiPhoneActivation(db, replacementActivation, {
      runId: "r1",
      workerId: "w1",
    });
    const replacement = createPendingGptPhoneAccountFromActivation(db, replacementActivation, {
      activationId: replacementActivationRow.id,
      workerId: "w1",
      runId: "r1",
      gptPassword: "phone-password",
    });

    const plus = markGptAccountPlusDone(db, replacement.id, { gptPassword: "phone-password" });
    assert.equal(plus.lifecycle_status, GPT_PHONE_LIFECYCLE.PLUS_DONE);
    const bound = markGptAccountEmailBound(db, replacement.id, { email: "bound@example.com" });
    assert.equal(bound.lifecycle_status, GPT_PHONE_LIFECYCLE.EMAIL_BOUND);
    const done = markGptAccountCpaDone(db, replacement.id, {
      boundEmail: "bound@example.com",
      cpaUploadStatus: "done",
      callbackJsonPath: "/tmp/callback.json",
    });
    assert.equal(done.lifecycle_status, GPT_PHONE_LIFECYCLE.CPA_DONE);
    assert.equal(done.callback_json_path, "/tmp/callback.json");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db, dbPath } = makeTempDb();
  try {
    db.prepare(`
      INSERT INTO gpt_phone_accounts(signup_phone_number, gpt_password, lifecycle_status, lease_status)
      VALUES ('+447700900401', 'phone-password', 'plus_done', 'available')
    `).run();
    const row = db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = '+447700900401'").get();
    const account = gptPhoneAccountToWorkflowAccount(row);
    account.signupPhoneActivation = { provider: "stored", phoneNumber: row.signup_phone_number };
    const context = await prepareRunContext({
      account,
      phoneLease: null,
      config: smsOauthConfig(dbPath),
      runId: "r_plus_done",
      workerId: "w1",
      db,
    });
    const result = await runWorkflow(context, {
      dryRun: true,
      logger: { info() {}, warn() {}, error() {} },
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.skippedSteps[0], "fetch-cpa-oauth-url");
    assert.equal(result.skippedSteps.includes("plus-checkout-billing"), false);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log("gpt-phone-account-store tests passed");
