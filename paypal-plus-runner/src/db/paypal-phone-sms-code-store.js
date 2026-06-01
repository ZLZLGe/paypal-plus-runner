function normalizeCodeList(codes = []) {
  const items = Array.isArray(codes) ? codes : [codes];
  const seen = new Set();
  const normalized = [];
  for (const item of items) {
    const code = String(item || "").trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    normalized.push(code);
  }
  return normalized;
}

function sqliteNow() {
  return new Date().toISOString().slice(0, 19).replace("T", " ");
}

export function recordPaypalPhoneSmsCodes(db, {
  phoneId = null,
  phone = "",
  codes = [],
  source = "",
  runId = "",
} = {}) {
  if (!db) return { recorded: 0, codes: [] };
  const normalizedPhone = String(phone || "").trim();
  if (!normalizedPhone) return { recorded: 0, codes: [] };
  const normalizedCodes = normalizeCodeList(codes);
  if (!normalizedCodes.length) return { recorded: 0, codes: [] };
  const now = sqliteNow();
  const stmt = db.prepare(`
    INSERT INTO paypal_phone_sms_codes(
      phone_id, phone, code, source, run_id, first_seen_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(phone, code) DO UPDATE SET
      phone_id = CASE
        WHEN excluded.phone_id IS NOT NULL THEN excluded.phone_id
        ELSE paypal_phone_sms_codes.phone_id
      END,
      source = excluded.source,
      run_id = CASE
        WHEN excluded.run_id <> '' THEN excluded.run_id
        ELSE paypal_phone_sms_codes.run_id
      END,
      last_seen_at = excluded.last_seen_at
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const code of normalizedCodes) {
      stmt.run(
        phoneId ?? null,
        normalizedPhone,
        code,
        String(source || "").trim(),
        String(runId || "").trim(),
        now,
        now,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { recorded: normalizedCodes.length, codes: normalizedCodes };
}

export function getRecentPaypalPhoneSmsCodes(db, {
  phone = "",
  ttlHours = 24,
} = {}) {
  if (!db) return [];
  const normalizedPhone = String(phone || "").trim();
  if (!normalizedPhone) return [];
  const hours = Math.max(1, Number.parseInt(String(ttlHours || 24), 10) || 24);
  return db.prepare(`
    SELECT code
    FROM paypal_phone_sms_codes
    WHERE phone = ?
      AND last_seen_at >= datetime('now', ?)
    ORDER BY last_seen_at DESC, id DESC
  `).all(normalizedPhone, `-${hours} hours`)
    .map((row) => String(row.code || "").trim())
    .filter(Boolean);
}
