import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openDatabase } from "../src/db/connection.js";
import { initSchema } from "../src/db/schema.js";
import {
  CHECKOUT_LINK_STATUS,
  accountHasActiveCheckoutLink,
  getReadyCheckoutLinkForAccount,
  leaseReadyCheckoutLink,
  listCheckoutLinks,
  markCheckoutLinkFailed,
  markCheckoutLinkPaid,
  saveReadyCheckoutLink,
} from "../src/db/checkout-link-store.js";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-links-"));
  const db = openDatabase(path.join(dir, "test.db"));
  initSchema(db);
  return { dir, db };
}

function insertAccount(db, phone, status = "registered") {
  db.prepare(`
    INSERT INTO gpt_phone_accounts(signup_phone_number, gpt_password, lifecycle_status, lease_status)
    VALUES (?, 'pw', ?, 'available')
  `).run(phone, status);
  return db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = ?").get(phone);
}

function checkoutUrl(id) {
  return `https://checkout.stripe.com/c/pay/cs_live_${id}${"A".repeat(32)}#fidsecret`;
}

test("checkout links are saved, leased, and protected after paid", () => {
  const { dir, db } = makeDb();
  try {
    const account = insertAccount(db, "+447700900501");
    const link = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register",
      checkoutLongUrl: checkoutUrl("one"),
    });

    assert.equal(link.status, CHECKOUT_LINK_STATUS.READY);
    assert.equal(accountHasActiveCheckoutLink(db, account.id), true);
    assert.equal(getReadyCheckoutLinkForAccount(db, account.id).id, link.id);

    const same = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register_2",
      checkoutLongUrl: checkoutUrl("one"),
    });
    assert.equal(same.id, link.id);
    assert.equal(same.status, CHECKOUT_LINK_STATUS.READY);

    const leased = leaseReadyCheckoutLink(db, {
      workerId: "worker_1",
      runId: "run_pay",
      ids: [link.id],
    });
    assert.equal(leased.link.status, CHECKOUT_LINK_STATUS.PAYING);
    assert.equal(leased.account.id, account.id);

    const paid = markCheckoutLinkPaid(db, link.id, { runId: "run_pay" });
    assert.equal(paid.status, CHECKOUT_LINK_STATUS.PAID);
    assert.ok(paid.paid_at);

    const failedAfterPaid = markCheckoutLinkFailed(db, link.id, {
      runId: "run_late_cpa",
      error: "CPA upload failed after Plus was confirmed",
    });
    assert.equal(failedAfterPaid.status, CHECKOUT_LINK_STATUS.PAID);

    const savedAfterPaid = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register_3",
      checkoutLongUrl: checkoutUrl("one"),
    });
    assert.equal(savedAfterPaid.status, CHECKOUT_LINK_STATUS.PAID);

    const paidRows = listCheckoutLinks(db, { status: "paid" });
    assert.equal(paidRows.length, 1);
    assert.equal(paidRows[0].gptPhoneAccountId, account.id);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkout links can move to failed or expired without recreating payment data", () => {
  const { dir, db } = makeDb();
  try {
    const account = insertAccount(db, "+447700900502");
    const failed = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register",
      checkoutLongUrl: checkoutUrl("two"),
    });
    const expired = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register",
      checkoutLongUrl: checkoutUrl("three"),
    });
    const retryable = saveReadyCheckoutLink(db, {
      gptPhoneAccountId: account.id,
      runId: "run_register",
      checkoutLongUrl: checkoutUrl("four"),
    });

    assert.equal(markCheckoutLinkFailed(db, failed.id, { error: "paypal error" }).status, CHECKOUT_LINK_STATUS.FAILED);
    assert.equal(markCheckoutLinkFailed(db, expired.id, { error: "checkout expired", expired: true }).status, CHECKOUT_LINK_STATUS.EXPIRED);
    const retryableAfterFailure = markCheckoutLinkFailed(db, retryable.id, {
      runId: "run_pay_retryable",
      error: "paypal phone otp timeout for +817012345678",
      retryable: true,
    });
    assert.equal(retryableAfterFailure.status, CHECKOUT_LINK_STATUS.READY);
    assert.match(retryableAfterFailure.last_error, /paypal phone otp timeout/);
    assert.equal(listCheckoutLinks(db, { status: "ready" }).length, 1);
    assert.equal(listCheckoutLinks(db, { status: "failed" }).length, 1);
    assert.equal(listCheckoutLinks(db, { status: "expired" }).length, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("schema migration creates checkout_links on older databases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-links-migration-"));
  const dbPath = path.join(dir, "test.db");
  const db = openDatabase(dbPath);
  try {
    db.exec("CREATE TABLE legacy_marker(id INTEGER PRIMARY KEY);");
    initSchema(db);
    const columns = db.prepare("PRAGMA table_info(checkout_links)").all().map((row) => row.name);
    assert.deepEqual(
      ["id", "gpt_phone_account_id", "run_id", "checkout_long_url", "status", "last_error", "created_at", "updated_at", "paid_at"].every((column) => columns.includes(column)),
      true,
    );
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
