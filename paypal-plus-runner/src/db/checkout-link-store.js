import { utcNow } from "./connection.js";

export const CHECKOUT_LINK_STATUS = Object.freeze({
  READY: "ready",
  PAYING: "paying",
  PAID: "paid",
  EXPIRED: "expired",
  FAILED: "failed",
});

const ACTIVE_STATUSES = [
  CHECKOUT_LINK_STATUS.READY,
  CHECKOUT_LINK_STATUS.PAYING,
  CHECKOUT_LINK_STATUS.PAID,
];

function now() {
  return utcNow();
}

export function normalizeCheckoutLinkStatus(value = "") {
  const status = String(value || "").trim().toLowerCase().replaceAll("_", "-");
  return Object.values(CHECKOUT_LINK_STATUS).includes(status) ? status : CHECKOUT_LINK_STATUS.READY;
}

export function normalizeCheckoutLongUrl(value = "") {
  const url = String(value || "").trim();
  if (!/^https:\/\/(?:checkout\.stripe\.com|pay\.openai\.com)\/c\/pay\//i.test(url)) {
    throw new Error("checkout long URL must be a Stripe/OpenAI hosted long checkout URL");
  }
  return url;
}

export function saveReadyCheckoutLink(db, {
  gptPhoneAccountId,
  runId = "",
  checkoutLongUrl,
} = {}) {
  const accountId = Number(gptPhoneAccountId || 0);
  if (!accountId) throw new Error("checkout link requires gpt_phone_account_id");
  const longUrl = normalizeCheckoutLongUrl(checkoutLongUrl);
  const timestamp = now();
  db.prepare(`
    INSERT INTO checkout_links(
      gpt_phone_account_id, run_id, checkout_long_url, status,
      last_error, created_at, updated_at, paid_at
    )
    VALUES (?, ?, ?, 'ready', '', ?, ?, '')
    ON CONFLICT(checkout_long_url) DO UPDATE SET
      gpt_phone_account_id = excluded.gpt_phone_account_id,
      run_id = excluded.run_id,
      status = CASE WHEN checkout_links.status = 'paid' THEN checkout_links.status ELSE 'ready' END,
      last_error = CASE WHEN checkout_links.status = 'paid' THEN checkout_links.last_error ELSE '' END,
      updated_at = excluded.updated_at
  `).run(accountId, String(runId || ""), longUrl, timestamp, timestamp);
  return db.prepare("SELECT * FROM checkout_links WHERE checkout_long_url = ?").get(longUrl);
}

export function getCheckoutLink(db, id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM checkout_links WHERE id = ?").get(id) || null;
}

export function getReadyCheckoutLinkForAccount(db, gptPhoneAccountId) {
  const accountId = Number(gptPhoneAccountId || 0);
  if (!accountId) return null;
  return db.prepare(`
    SELECT *
    FROM checkout_links
    WHERE gpt_phone_account_id = ?
      AND status = 'ready'
    ORDER BY id DESC
    LIMIT 1
  `).get(accountId) || null;
}

export function accountHasActiveCheckoutLink(db, gptPhoneAccountId) {
  const accountId = Number(gptPhoneAccountId || 0);
  if (!accountId) return false;
  const row = db.prepare(`
    SELECT COUNT(1) AS c
    FROM checkout_links
    WHERE gpt_phone_account_id = ?
      AND status IN (${ACTIVE_STATUSES.map(() => "?").join(",")})
  `).get(accountId, ...ACTIVE_STATUSES);
  return Number(row?.c || 0) > 0;
}

export function markCheckoutLinkPaying(db, id, { runId = "" } = {}) {
  const timestamp = now();
  db.prepare(`
    UPDATE checkout_links
    SET status = 'paying',
        run_id = CASE WHEN ? <> '' THEN ? ELSE run_id END,
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(String(runId || ""), String(runId || ""), timestamp, id);
  return getCheckoutLink(db, id);
}

export function leaseReadyCheckoutLink(db, {
  workerId = "",
  runId = "",
  ids = [],
  leaseMinutes = 120,
} = {}) {
  const normalizedIds = (Array.isArray(ids) ? ids : [ids])
    .map((value) => Number.parseInt(String(value || ""), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  const idClause = normalizedIds.length ? `AND cl.id IN (${normalizedIds.map(() => "?").join(",")})` : "";
  const expiresExpr = `datetime('now', '+${Math.max(1, Number.parseInt(String(leaseMinutes), 10) || 120)} minutes')`;
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT cl.*,
             g.id AS account_id
      FROM checkout_links cl
      JOIN gpt_phone_accounts g ON g.id = cl.gpt_phone_account_id
      WHERE cl.status = 'ready'
        AND g.lifecycle_status = 'registered'
        AND (
          g.lease_status = 'available'
          OR g.lease_expires_at = ''
          OR g.lease_expires_at < CURRENT_TIMESTAMP
        )
        ${idClause}
      ORDER BY cl.updated_at ASC, cl.id ASC
      LIMIT 1
    `).get(...normalizedIds);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE checkout_links
      SET status = 'paying',
          run_id = ?,
          last_error = '',
          updated_at = ?
      WHERE id = ?
    `).run(String(runId || ""), timestamp, row.id);
    db.prepare(`
      UPDATE gpt_phone_accounts
      SET lease_status = 'leased',
          leased_by = ?,
          current_run_id = ?,
          leased_at = ?,
          lease_expires_at = ${expiresExpr},
          last_error = '',
          updated_at = ?
      WHERE id = ?
    `).run(String(workerId || ""), String(runId || ""), timestamp, timestamp, row.account_id);
    const link = db.prepare("SELECT * FROM checkout_links WHERE id = ?").get(row.id);
    const account = db.prepare("SELECT * FROM gpt_phone_accounts WHERE id = ?").get(row.account_id);
    db.exec("COMMIT");
    return { link, account };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markCheckoutLinkPaid(db, id, { runId = "" } = {}) {
  const timestamp = now();
  db.prepare(`
    UPDATE checkout_links
    SET status = 'paid',
        run_id = CASE WHEN ? <> '' THEN ? ELSE run_id END,
        last_error = '',
        paid_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(String(runId || ""), String(runId || ""), timestamp, timestamp, id);
  return getCheckoutLink(db, id);
}

export function markCheckoutLinkFailed(db, id, {
  runId = "",
  error = "",
  expired = false,
} = {}) {
  const timestamp = now();
  db.prepare(`
    UPDATE checkout_links
    SET status = ?,
        run_id = CASE WHEN ? <> '' THEN ? ELSE run_id END,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
      AND status <> 'paid'
  `).run(
    expired ? CHECKOUT_LINK_STATUS.EXPIRED : CHECKOUT_LINK_STATUS.FAILED,
    String(runId || ""),
    String(runId || ""),
    String(error || "").slice(0, 1000),
    timestamp,
    id,
  );
  return getCheckoutLink(db, id);
}

export function listCheckoutLinks(db, {
  status = "",
  limit = 100,
} = {}) {
  const params = [];
  const clauses = [];
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized) {
    clauses.push("cl.status = ?");
    params.push(normalizeCheckoutLinkStatus(normalized));
  }
  params.push(Math.max(1, Math.min(500, Number.parseInt(String(limit || 100), 10) || 100)));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT cl.id,
           cl.gpt_phone_account_id AS gptPhoneAccountId,
           cl.run_id AS runId,
           cl.checkout_long_url AS checkoutLongUrl,
           cl.status,
           cl.last_error AS lastError,
           cl.created_at AS createdAt,
           cl.updated_at AS updatedAt,
           cl.paid_at AS paidAt,
           g.signup_phone_number AS signupPhoneNumber,
           g.lifecycle_status AS lifecycleStatus,
           g.bound_email AS boundEmail,
           g.cpa_upload_status AS cpaUploadStatus
    FROM checkout_links cl
    LEFT JOIN gpt_phone_accounts g ON g.id = cl.gpt_phone_account_id
    ${where}
    ORDER BY cl.id DESC
    LIMIT ?
  `).all(...params);
}
