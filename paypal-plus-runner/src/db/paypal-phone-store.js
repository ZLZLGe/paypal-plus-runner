import fs from "node:fs";
import { utcNow } from "./connection.js";

export function normalizePaypalPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  throw new Error(`invalid US phone: ${rawPhone}`);
}

export function paypalLocalPhone(phone) {
  const normalized = normalizePaypalPhone(phone);
  return normalized.replace(/^\+1/, "");
}

export function parsePaypalPhoneLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const separator = text.includes("|") ? "|" : (text.includes("----") ? "----" : "");
  if (!separator) {
    throw new Error("expected +phone|sms_url");
  }
  const [phonePart, ...urlParts] = text.split(separator);
  const phone = normalizePaypalPhone(phonePart);
  const smsUrl = urlParts.join(separator).trim();
  if (!smsUrl) {
    throw new Error("sms_url is required");
  }
  return { phone, sms_url: smsUrl };
}

export function importPaypalPhonesFile(db, filePath, { maxUse = 5 } = {}) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const stmt = db.prepare(`
    INSERT INTO paypal_phone_pool(phone, sms_url, max_use, status, imported_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      sms_url = excluded.sms_url,
      max_use = excluded.max_use,
      status = CASE
        WHEN paypal_phone_pool.status IN ('disabled', 'leased') THEN paypal_phone_pool.status
        WHEN paypal_phone_pool.used_count >= excluded.max_use THEN 'exhausted'
        ELSE 'active'
      END,
      updated_at = excluded.updated_at
  `);
  let imported = 0;
  let skipped = 0;
  const errors = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [index, raw] of lines.entries()) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const row = parsePaypalPhoneLine(line);
        stmt.run(row.phone, row.sms_url, Number(maxUse) || 5, utcNow(), utcNow());
        imported += 1;
      } catch (error) {
        skipped += 1;
        errors.push({ line: index + 1, error: error.message });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { imported, skipped, errors };
}

export function leasePaypalPhone(db, { workerId, runId, leaseMinutes = 30 } = {}) {
  const now = utcNow();
  const expiresExpr = `datetime('now', '+${Math.max(1, Number.parseInt(String(leaseMinutes), 10) || 30)} minutes')`;
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT * FROM paypal_phone_pool
      WHERE (
          status = 'active'
          OR (status = 'leased' AND lease_expires_at < CURRENT_TIMESTAMP)
        )
        AND used_count < max_use
      ORDER BY used_count ASC, updated_at ASC, id ASC
      LIMIT 1
    `).get();
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE paypal_phone_pool
      SET status = 'leased',
          leased_by = ?,
          current_run_id = ?,
          leased_at = ?,
          lease_expires_at = ${expiresExpr},
          updated_at = ?,
          last_error = ''
      WHERE id = ?
    `).run(workerId || "", runId || "", now, now, row.id);
    const updated = db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(row.id);
    db.exec("COMMIT");
    return updated ? { ...updated, paypal_local_phone: paypalLocalPhone(updated.phone) } : null;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function releasePaypalPhone(db, phoneId, { runId = "", success = false, disable = false, error = "" } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (success) {
      db.prepare(`
        UPDATE paypal_phone_pool
        SET used_count = used_count + 1,
            status = CASE WHEN used_count + 1 >= max_use THEN 'exhausted' ELSE 'active' END,
            leased_by = '',
            current_run_id = '',
            leased_at = '',
            lease_expires_at = '',
            last_error = '',
            updated_at = ?
        WHERE id = ? AND (? = '' OR current_run_id = ?)
      `).run(utcNow(), phoneId, runId, runId);
    } else if (disable) {
      db.prepare(`
        UPDATE paypal_phone_pool
        SET status = 'disabled',
            leased_by = '',
            current_run_id = '',
            leased_at = '',
            lease_expires_at = '',
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND (? = '' OR current_run_id = ?)
      `).run(String(error || "").slice(0, 1000), utcNow(), phoneId, runId, runId);
    } else {
      db.prepare(`
        UPDATE paypal_phone_pool
        SET status = CASE WHEN used_count >= max_use THEN 'exhausted' ELSE 'active' END,
            leased_by = '',
            current_run_id = '',
            leased_at = '',
            lease_expires_at = '',
            last_error = ?,
            updated_at = ?
        WHERE id = ? AND (? = '' OR current_run_id = ?)
      `).run(String(error || "").slice(0, 1000), utcNow(), phoneId, runId, runId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function countAvailablePaypalPhones(db) {
  return Number(db.prepare(`
    SELECT COUNT(1) AS c FROM paypal_phone_pool
    WHERE (status = 'active' OR (status = 'leased' AND lease_expires_at < CURRENT_TIMESTAMP))
      AND used_count < max_use
  `).get().c || 0);
}
