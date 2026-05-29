import fs from "node:fs";
import { utcNow } from "./connection.js";

export function parseOutlookLine(line) {
  const parts = String(line || "").trim().split("----");
  if (parts.length < 4) {
    throw new Error("expected email----password----client_id----refresh_token");
  }
  const [email, password, clientId, ...refreshParts] = parts;
  const refreshToken = refreshParts.join("----");
  if (!String(email || "").trim() || !String(refreshToken || "").trim()) {
    throw new Error("email and refresh_token are required");
  }
  return {
    email: String(email).trim(),
    password: String(password || "").trim(),
    client_id: String(clientId || "").trim(),
    refresh_token: String(refreshToken || "").trim(),
  };
}

export function importOutlookFile(db, filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const stmt = db.prepare(`
    INSERT INTO outlook_emails(email, password, client_id, refresh_token, status, updated_at)
    VALUES (?, ?, ?, ?, 'new', ?)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      client_id = excluded.client_id,
      refresh_token = excluded.refresh_token,
      status = CASE WHEN outlook_emails.status = 'plus_done' THEN outlook_emails.status ELSE 'new' END,
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
        const row = parseOutlookLine(line);
        stmt.run(row.email, row.password, row.client_id, row.refresh_token, utcNow());
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

export function countAvailableOutlook(db) {
  return Number(db.prepare("SELECT COUNT(1) AS c FROM outlook_emails WHERE status = 'new'").get().c || 0);
}

export function leaseNextOutlookEmail(db, { maxAttempts = 5 } = {}) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT * FROM outlook_emails
      WHERE status = 'new' AND attempt_count < ?
      ORDER BY id ASC
      LIMIT 1
    `).get(maxAttempts);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE outlook_emails
      SET status = 'leased',
          leased_at = ?,
          attempt_count = attempt_count + 1,
          updated_at = ?
      WHERE id = ?
    `).run(utcNow(), utcNow(), row.id);
    const updated = db.prepare("SELECT * FROM outlook_emails WHERE id = ?").get(row.id);
    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function markOutlookRunning(db, id) {
  db.prepare("UPDATE outlook_emails SET status = 'running', updated_at = ? WHERE id = ?").run(utcNow(), id);
}

export function releaseOutlookEmail(db, id, { error = "", decrementAttempt = true } = {}) {
  const row = db.prepare("SELECT attempt_count FROM outlook_emails WHERE id = ?").get(id);
  const attempts = Math.max(0, Number(row?.attempt_count || 0) - (decrementAttempt ? 1 : 0));
  db.prepare(`
    UPDATE outlook_emails
    SET status = 'new',
        attempt_count = ?,
        leased_at = '',
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(attempts, String(error || "").slice(0, 1000), utcNow(), id);
}

export function markOutlookPlusDone(db, id) {
  db.prepare("UPDATE outlook_emails SET status = 'plus_done', last_error = '', updated_at = ? WHERE id = ?").run(utcNow(), id);
}

export function markOutlookFailure(db, id, { retryable = true, error = "", maxAttempts = 5 } = {}) {
  const row = db.prepare("SELECT attempt_count FROM outlook_emails WHERE id = ?").get(id);
  const attempts = Number(row?.attempt_count || 0);
  const status = retryable && attempts < maxAttempts ? "new" : "failed";
  db.prepare("UPDATE outlook_emails SET status = ?, last_error = ?, updated_at = ? WHERE id = ?")
    .run(status, String(error || "").slice(0, 1000), utcNow(), id);
  return status;
}
