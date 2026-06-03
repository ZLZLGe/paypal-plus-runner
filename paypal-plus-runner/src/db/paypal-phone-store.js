import fs from "node:fs";
import { utcNow } from "./connection.js";

export function normalizePaypalPhone(rawPhone) {
  const digits = String(rawPhone || "").replace(/\D+/g, "");
  if (digits.length === 12 && digits.startsWith("81")) {
    return `+${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("0")) {
    return `+81${digits.slice(1)}`;
  }
  if (digits.length === 10 && /^(70|80|90)/.test(digits)) {
    return `+81${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1${digits.slice(1)}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  throw new Error(`invalid PayPal phone: ${rawPhone}`);
}

export function paypalLocalPhone(phone) {
  const normalized = normalizePaypalPhone(phone);
  if (normalized.startsWith("+81")) return normalized.replace(/^\+81/, "");
  if (normalized.startsWith("+1")) return normalized.replace(/^\+1/, "");
  return normalized.replace(/^\+/, "");
}

export function paypalPhoneCountryCode(phone) {
  const normalized = normalizePaypalPhone(phone);
  if (normalized.startsWith("+81")) return "JP";
  if (normalized.startsWith("+1")) return "US";
  return "";
}

export function paypalPhoneDialCode(phone) {
  const normalized = normalizePaypalPhone(phone);
  if (normalized.startsWith("+81")) return "81";
  if (normalized.startsWith("+1")) return "1";
  return "";
}

export function normalizePaypalPhoneCountryCodes(countryCodes = []) {
  const values = Array.isArray(countryCodes) ? countryCodes : [countryCodes];
  const normalized = values
    .flatMap((value) => String(value || "").split(","))
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  return [...new Set(normalized)];
}

function phoneCountrySql(countryCodes = []) {
  const normalized = normalizePaypalPhoneCountryCodes(countryCodes);
  if (!normalized.length) return { clause: "", params: [] };
  const parts = [];
  const params = [];
  if (normalized.includes("JP")) {
    parts.push("phone LIKE '+81%'");
  }
  if (normalized.includes("US")) {
    parts.push("phone LIKE '+1%'");
  }
  if (!parts.length) {
    return { clause: "AND 0", params };
  }
  return { clause: `AND (${parts.join(" OR ")})`, params };
}

export function parsePaypalPhoneLine(line) {
  const text = String(line || "").trim();
  if (!text) return null;
  const separator = text.includes("|") ? "|" : (text.includes("----") ? "----" : "");
  if (!separator) {
    throw new Error("expected +phone|sms_url or +phone----sms_url");
  }
  const [phonePart, ...urlParts] = text.split(separator);
  const phone = normalizePaypalPhone(phonePart);
  const smsUrl = urlParts.join(separator).trim();
  if (!smsUrl) {
    throw new Error("sms_url is required");
  }
  return { phone, sms_url: smsUrl };
}

function normalizeAllowedCountries(countryCodes = []) {
  return normalizePaypalPhoneCountryCodes(countryCodes).filter((country) => ["JP", "US"].includes(country));
}

function hasActiveLease(db, phoneId) {
  return Boolean(db.prepare(`
    SELECT 1 AS active
    FROM paypal_phone_pool
    WHERE id = ?
      AND status = 'leased'
      AND lease_expires_at <> ''
      AND lease_expires_at >= CURRENT_TIMESTAMP
  `).get(phoneId));
}

function assertAllowedPaypalPhoneCountry(row = {}, countryCodes = []) {
  const allowedCountries = normalizeAllowedCountries(countryCodes);
  if (!allowedCountries.length) return;
  const country = paypalPhoneCountryCode(row.phone || "");
  if (!allowedCountries.includes(country)) {
    throw new Error(`paypal phone ${row.id || ""} country ${country || "unknown"} is not allowed`);
  }
}

function importPaypalPhoneLines(db, lines = [], { maxUse = 5, countryCodes = [] } = {}) {
  const allowedCountries = normalizeAllowedCountries(countryCodes);
  const stmt = db.prepare(`
    INSERT INTO paypal_phone_pool(phone, sms_url, max_use, status, imported_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(phone) DO UPDATE SET
      sms_url = excluded.sms_url,
      max_use = excluded.max_use,
      status = CASE
        WHEN paypal_phone_pool.status IN ('disabled', 'leased') THEN paypal_phone_pool.status
        WHEN paypal_phone_pool.used_count >= excluded.max_use THEN 'exhausted'
        WHEN paypal_phone_pool.status = 'cooldown' THEN paypal_phone_pool.status
        ELSE 'active'
      END,
      cooldown_until = CASE
        WHEN paypal_phone_pool.status = 'cooldown' AND paypal_phone_pool.used_count < excluded.max_use
          THEN paypal_phone_pool.cooldown_until
        ELSE ''
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
        const country = paypalPhoneCountryCode(row.phone);
        if (allowedCountries.length && !allowedCountries.includes(country)) {
          throw new Error(`paypal phone country ${country || "unknown"} is not allowed`);
        }
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

export function importPaypalPhonesText(db, text, { maxUse = 5, countryCodes = [] } = {}) {
  return importPaypalPhoneLines(db, String(text || "").split(/\r?\n/), { maxUse, countryCodes });
}

export function importPaypalPhonesFile(db, filePath, { maxUse = 5, countryCodes = [] } = {}) {
  return importPaypalPhonesText(db, fs.readFileSync(filePath, "utf8"), { maxUse, countryCodes });
}

export function leasePaypalPhone(db, { workerId, runId, leaseMinutes = 30, countryCodes = ["JP"] } = {}) {
  const now = utcNow();
  const expiresExpr = `datetime('now', '+${Math.max(1, Number.parseInt(String(leaseMinutes), 10) || 30)} minutes')`;
  const countryFilter = phoneCountrySql(countryCodes);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT * FROM paypal_phone_pool
      WHERE (
          status = 'active'
          OR (status = 'leased' AND lease_expires_at < CURRENT_TIMESTAMP)
          OR (status = 'cooldown' AND cooldown_until <> '' AND cooldown_until <= CURRENT_TIMESTAMP)
        )
        AND used_count < max_use
        ${countryFilter.clause}
      ORDER BY used_count ASC, updated_at ASC, id ASC
      LIMIT 1
    `).get(...countryFilter.params);
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
          cooldown_until = '',
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

export function releasePaypalPhone(db, phoneId, {
  runId = "",
  success = false,
  disable = false,
  error = "",
  cooldownMinutes = 0,
} = {}) {
  const normalizedCooldownMinutes = Math.max(0, Number.parseInt(String(cooldownMinutes || 0), 10) || 0);
  const cooldownExpr = `datetime('now', '+${normalizedCooldownMinutes} minutes')`;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (success) {
      db.prepare(`
        UPDATE paypal_phone_pool
        SET used_count = used_count + 1,
            status = CASE
              WHEN used_count + 1 >= max_use THEN 'exhausted'
              WHEN ? > 0 THEN 'cooldown'
              ELSE 'active'
            END,
            leased_by = '',
            current_run_id = '',
            leased_at = '',
            lease_expires_at = '',
            cooldown_until = CASE
              WHEN used_count + 1 >= max_use THEN ''
              WHEN ? > 0 THEN ${cooldownExpr}
              ELSE ''
            END,
            last_error = '',
            updated_at = ?
        WHERE id = ? AND (? = '' OR current_run_id = ?)
      `).run(normalizedCooldownMinutes, normalizedCooldownMinutes, utcNow(), phoneId, runId, runId);
    } else if (disable) {
      db.prepare(`
        UPDATE paypal_phone_pool
        SET status = 'disabled',
            leased_by = '',
            current_run_id = '',
            leased_at = '',
            lease_expires_at = '',
            cooldown_until = '',
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
            cooldown_until = '',
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

export function countAvailablePaypalPhones(db, { countryCodes = ["JP"] } = {}) {
  const countryFilter = phoneCountrySql(countryCodes);
  return Number(db.prepare(`
    SELECT COUNT(1) AS c FROM paypal_phone_pool
    WHERE (
        status = 'active'
        OR (status = 'leased' AND lease_expires_at < CURRENT_TIMESTAMP)
        OR (status = 'cooldown' AND cooldown_until <> '' AND cooldown_until <= CURRENT_TIMESTAMP)
      )
      AND used_count < max_use
      ${countryFilter.clause}
  `).get(...countryFilter.params).c || 0);
}

export function getNextPaypalPhoneCooldown(db, { countryCodes = ["JP"] } = {}) {
  const countryFilter = phoneCountrySql(countryCodes);
  const row = db.prepare(`
    SELECT id, phone, cooldown_until
    FROM paypal_phone_pool
    WHERE status = 'cooldown'
      AND cooldown_until <> ''
      AND cooldown_until > CURRENT_TIMESTAMP
      AND used_count < max_use
      ${countryFilter.clause}
    ORDER BY cooldown_until ASC, used_count ASC, id ASC
    LIMIT 1
  `).get(...countryFilter.params);
  return row || null;
}

export function listPaypalPhones(db, { limit = 200, countryCodes = ["JP"] } = {}) {
  const countryFilter = phoneCountrySql(countryCodes);
  return db.prepare(`
    SELECT id, phone, sms_url, used_count, max_use, status, leased_by, current_run_id,
           leased_at, lease_expires_at, cooldown_until, last_error, imported_at, updated_at
    FROM paypal_phone_pool
    WHERE 1 = 1
      ${countryFilter.clause}
    ORDER BY
      CASE status
        WHEN 'active' THEN 1
        WHEN 'leased' THEN 2
        WHEN 'cooldown' THEN 3
        WHEN 'exhausted' THEN 4
        WHEN 'disabled' THEN 5
        ELSE 5
      END,
      used_count ASC,
      id DESC
    LIMIT ?
  `).all(...countryFilter.params, Math.max(1, Math.min(500, Number.parseInt(String(limit || 200), 10) || 200)));
}

export function summarizePaypalPhones(db, { countryCodes = ["JP"] } = {}) {
  const countryFilter = phoneCountrySql(countryCodes);
  return db.prepare(`
    SELECT status, COUNT(1) AS count, SUM(used_count) AS usedCount
    FROM paypal_phone_pool
    WHERE 1 = 1
      ${countryFilter.clause}
    GROUP BY status
    ORDER BY status
  `).all(...countryFilter.params);
}

export function disablePaypalPhone(db, phoneId, { error = "disabled from ui", countryCodes = [] } = {}) {
  const id = Number.parseInt(String(phoneId || ""), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("paypal phone id is required");
  const existing = db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(id);
  if (!existing) throw new Error(`paypal phone ${id} not found`);
  assertAllowedPaypalPhoneCountry(existing, countryCodes);
  if (hasActiveLease(db, id)) {
    throw new Error("leased paypal phone cannot be disabled while lease is active");
  }
  db.prepare(`
    UPDATE paypal_phone_pool
    SET status = 'disabled',
        leased_by = '',
        current_run_id = '',
        leased_at = '',
        lease_expires_at = '',
        cooldown_until = '',
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(String(error || "disabled from ui").slice(0, 1000), utcNow(), id);
  return db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(id);
}

export function restorePaypalPhone(db, phoneId, { countryCodes = [] } = {}) {
  const id = Number.parseInt(String(phoneId || ""), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("paypal phone id is required");
  const existing = db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(id);
  if (!existing) throw new Error(`paypal phone ${id} not found`);
  assertAllowedPaypalPhoneCountry(existing, countryCodes);
  if (hasActiveLease(db, id)) {
    throw new Error("leased paypal phone cannot be restored while lease is active");
  }
  const status = Number(existing.used_count || 0) >= Number(existing.max_use || 0) ? "exhausted" : "active";
  db.prepare(`
    UPDATE paypal_phone_pool
    SET status = ?,
        leased_by = '',
        current_run_id = '',
        leased_at = '',
        lease_expires_at = '',
        cooldown_until = '',
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(status, utcNow(), id);
  return db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(id);
}

export function deletePaypalPhone(db, phoneId, { countryCodes = [] } = {}) {
  const id = Number.parseInt(String(phoneId || ""), 10);
  if (!Number.isFinite(id) || id <= 0) throw new Error("paypal phone id is required");
  const existing = db.prepare("SELECT * FROM paypal_phone_pool WHERE id = ?").get(id);
  if (!existing) throw new Error(`paypal phone ${id} not found`);
  assertAllowedPaypalPhoneCountry(existing, countryCodes);
  if (hasActiveLease(db, id)) {
    throw new Error("leased paypal phone cannot be deleted while lease is active");
  }
  db.prepare("DELETE FROM paypal_phone_pool WHERE id = ?").run(id);
  return existing;
}
