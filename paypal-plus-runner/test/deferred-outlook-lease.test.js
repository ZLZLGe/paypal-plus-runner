import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import { leaseNextOutlookEmail, markOutlookFailure, markOutlookRunning, releaseOutlookEmail } from "../src/db/outlook-store.js";
import { importPaypalPhonesFile } from "../src/db/paypal-phone-store.js";
import { createRun } from "../src/db/run-history-store.js";
import {
  ensureOutlookAccountForStep,
  prepareRunContext,
  releaseDeferredOutlookOnFailure,
  requiresOutlookAccountForStep,
} from "../src/workflow.js";
import { Worker } from "../src/worker.js";

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deferred-outlook-"));
  const db = openDatabase(path.join(dir, "test.db"));
  initSchema(db);
  return { dir, db };
}

function insertOutlook(db, email = "deferred@example.com") {
  db.prepare(`
    INSERT INTO outlook_emails(email, password, client_id, refresh_token, status, updated_at)
    VALUES (?, 'pw', 'client', 'refresh', 'new', CURRENT_TIMESTAMP)
  `).run(email);
  return db.prepare("SELECT * FROM outlook_emails WHERE email = ?").get(email);
}

function insertPhone(db, dir) {
  const file = path.join(dir, "phones.txt");
  fs.writeFileSync(file, "+817094717091|http://example.test/sms");
  importPaypalPhonesFile(db, file, { maxUse: 1 });
}

function smsOauthConfig(dbPath) {
  return {
    database: { path: dbPath },
    runner: {
      maxAttemptsPerEmail: 5,
      gptPassword: "myPASSword!2026",
    },
    flow: { plusAccountAccessStrategy: "sms_oauth" },
    paypalPhone: { leaseMinutes: 30 },
    checkoutProfile: {
      addressProvider: "fallback",
      firstName: "舞桜",
      lastName: "脇田",
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
    const outlook = insertOutlook(db);
    createRun(db, { runId: "run_lease", email: "", outlookEmailId: null, workerId: "worker_1" });
    const phoneLease = {
      id: 1,
      phone: "+15722337281",
      sms_url: "http://example.test/sms",
      paypal_local_phone: "5722337281",
    };
    const context = await prepareRunContext({
      account: { id: null, email: "", password: "", client_id: "", refresh_token: "" },
      phoneLease,
      config: smsOauthConfig(path.join(dir, "test.db")),
      runId: "run_lease",
      workerId: "worker_1",
      db,
    });

    assert.equal(requiresOutlookAccountForStep("submit-signup-phone", context.config), false);
    assert.equal(requiresOutlookAccountForStep("bind-email", context.config), true);
    assert.equal(context.account.id, null);

    await ensureOutlookAccountForStep(context, "submit-signup-phone");
    assert.equal(context.account.id, null);

    await ensureOutlookAccountForStep(context, "bind-email");
    assert.equal(context.account.id, outlook.id);
    assert.equal(context.account.email, outlook.email);
    assert.equal(context.outlookLeaseDeferred, true);

    const row = db.prepare("SELECT status, attempt_count FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "running");
    assert.equal(row.attempt_count, 1);

    const run = db.prepare("SELECT email, outlook_email_id FROM run_history WHERE run_id = 'run_lease'").get();
    assert.equal(run.email, outlook.email);
    assert.equal(run.outlook_email_id, outlook.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const outlook = insertOutlook(db, "release@example.com");
    const account = leaseNextOutlookEmail(db);
    markOutlookRunning(db, account.id);
    assert.equal(account.id, outlook.id);

    const context = {
      config: smsOauthConfig(path.join(dir, "test.db")),
      outlookLeaseDeferred: true,
      account,
      boundEmailSubmitted: false,
    };
    const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
      releaseOutlookEmail(db, id, {
        error: options.error,
        decrementAttempt: true,
      });
    }, { error: "failed before submit" });

    assert.equal(released, true);
    const row = db.prepare("SELECT status, attempt_count, leased_at, last_error FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "new");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.leased_at, "");
    assert.equal(row.last_error, "failed before submit");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const outlook = insertOutlook(db, "used@example.com");
    const account = leaseNextOutlookEmail(db);
    markOutlookRunning(db, account.id);

    const context = {
      config: smsOauthConfig(path.join(dir, "test.db")),
      outlookLeaseDeferred: true,
      account,
      boundEmailSubmitted: true,
    };
    const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
      releaseOutlookEmail(db, id, {
        error: options.error,
        decrementAttempt: true,
      });
    }, { error: "failed after submit" });

    assert.equal(released, true);
    const row = db.prepare("SELECT status, attempt_count, last_error FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "new");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, "failed after submit");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const outlook = insertOutlook(db, "verified@example.com");
    const account = leaseNextOutlookEmail(db);
    markOutlookRunning(db, account.id);

    const context = {
      config: smsOauthConfig(path.join(dir, "test.db")),
      outlookLeaseDeferred: true,
      account,
      boundEmailSubmitted: true,
      boundEmailVerified: true,
    };
    const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
      releaseOutlookEmail(db, id, {
        error: options.error,
        decrementAttempt: true,
      });
    }, { error: "failed after verified" });

    assert.equal(released, true);
    const row = db.prepare("SELECT status, attempt_count, last_error FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "new");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, "failed after verified");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const outlook = insertOutlook(db, "completed@example.com");
    const account = leaseNextOutlookEmail(db);
    markOutlookRunning(db, account.id);

    const context = {
      config: smsOauthConfig(path.join(dir, "test.db")),
      outlookLeaseDeferred: true,
      account,
      boundEmailSubmitted: true,
      boundEmailVerified: true,
      boundEmailCompleted: true,
    };
    const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
      releaseOutlookEmail(db, id, {
        error: options.error,
        decrementAttempt: true,
      });
    }, { error: "failed after completed" });

    assert.equal(released, false);
    markOutlookFailure(db, outlook.id, {
      retryable: false,
      error: "failed after completed",
      maxAttempts: 5,
    });
    const row = db.prepare("SELECT status, attempt_count, last_error FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "failed");
    assert.equal(row.attempt_count, 1);
    assert.equal(row.last_error, "failed after completed");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    const outlook = insertOutlook(db, "needs-rebind@example.com");
    const account = leaseNextOutlookEmail(db);
    markOutlookRunning(db, account.id);

    const context = {
      config: smsOauthConfig(path.join(dir, "test.db")),
      outlookLeaseDeferred: true,
      account,
      boundEmailSubmitted: true,
      boundEmailVerified: true,
      boundEmailNeedsRebind: true,
    };
    const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
      releaseOutlookEmail(db, id, {
        error: options.error,
        decrementAttempt: true,
      });
    }, { error: "oauth still required add-email" });

    assert.equal(released, true);
    const row = db.prepare("SELECT status, attempt_count, last_error FROM outlook_emails WHERE id = ?").get(outlook.id);
    assert.equal(row.status, "new");
    assert.equal(row.attempt_count, 0);
    assert.equal(row.last_error, "oauth still required add-email");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const { dir, db } = makeTempDb();
  try {
    insertOutlook(db, "dryrun@example.com");
    insertPhone(db, dir);
    const config = smsOauthConfig(path.join(dir, "test.db"));
    const worker = new Worker({
      id: "worker_1",
      db,
      config,
      logger: { info() {}, warn() {}, error() {} },
      dryRun: true,
    });
    const result = await worker.runOnce();

    assert.equal(result.status, "skipped");
    const row = db.prepare("SELECT status, attempt_count FROM outlook_emails WHERE email = 'dryrun@example.com'").get();
    assert.equal(row.status, "new");
    assert.equal(row.attempt_count, 0);
    const run = db.prepare("SELECT email, outlook_email_id, status FROM run_history ORDER BY id DESC LIMIT 1").get();
    assert.equal(run.email, "");
    assert.equal(run.outlook_email_id, null);
    assert.equal(run.status, "skipped");
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

{
  const worker = new Worker({
    id: "worker_1",
    config: {
      ...smsOauthConfig(":memory:"),
      paypalRiskRetry: { newWindow: true },
    },
    logger: { info() {}, warn() {}, error() {} },
    windowInfo: { dirId: "old-dir", page: "old-page" },
  });
  let replaced = false;
  worker.replaceWindowForRiskRetry = async ({ reason }) => {
    replaced = reason === "paypal_risk_retry";
    worker.windowInfo = {
      dirId: "new-dir",
      page: "new-page",
      browser: "new-browser",
      context: "new-context",
    };
    return { dirId: "new-dir", asn: "AS2516", region: "JP" };
  };
  worker.maybeRotateWindowProxy = async () => {
    throw new Error("should not rotate old window");
  };
  const context = {};
  context.rotateWindowProxy = async (options = {}) => {
    const useNewWindow = options.newWindow === true || (
      options.reason === "paypal_risk_retry"
      && worker.config.paypalRiskRetry?.newWindow === true
    );
    const result = useNewWindow
      ? await worker.replaceWindowForRiskRetry({ reason: options.reason || "workflow_proxy_rotation" })
      : await worker.maybeRotateWindowProxy({ force: true, reason: options.reason || "workflow_proxy_rotation" });
    context.windowInfo = worker.windowInfo;
    context.browser = worker.windowInfo?.browser || context.browser;
    context.browserContext = worker.windowInfo?.context || context.browserContext;
    context.page = worker.windowInfo?.page || context.page;
    return result;
  };
  const rotation = await context.rotateWindowProxy({ reason: "paypal_risk_retry", newWindow: true });
  assert.equal(replaced, true);
  assert.equal(rotation.dirId, "new-dir");
  assert.equal(context.page, "new-page");
  worker.close();
}

console.log("deferred-outlook-lease tests passed");
