export function getDatabaseStats(db) {
  const one = (sql, params = []) => db.prepare(sql).get(...params);
  const all = (sql, params = []) => db.prepare(sql).all(...params);
  return {
    outlookEmails: all("SELECT status, COUNT(1) AS count FROM outlook_emails GROUP BY status ORDER BY status"),
    gptPhoneAccounts: all("SELECT lifecycle_status, lease_status, COUNT(1) AS count FROM gpt_phone_accounts GROUP BY lifecycle_status, lease_status ORDER BY lifecycle_status, lease_status"),
    paypalPhones: all("SELECT status, COUNT(1) AS count, SUM(used_count) AS usedCount FROM paypal_phone_pool GROUP BY status ORDER BY status"),
    plusAccounts: one("SELECT COUNT(1) AS count FROM plus_accounts").count,
    openaiPhoneActivations: all("SELECT status, COUNT(1) AS count FROM openai_phone_activations GROUP BY status ORDER BY status"),
    runHistory: all("SELECT status, COUNT(1) AS count FROM run_history GROUP BY status ORDER BY status"),
    runEvents: one("SELECT COUNT(1) AS count FROM run_events").count,
    recentRuns: all(`
      SELECT run_id, email, worker_id, status, current_step, roxy_dir_id, roxy_exit_ip,
             account_identifier_type, account_identifier, cpa_upload_status, callback_json_path,
             artifact_dir, error, updated_at
      FROM run_history
      ORDER BY id DESC
      LIMIT 10
    `),
  };
}

export function listPaypalPhones(db, { limit = 50 } = {}) {
  return db.prepare(`
    SELECT id, phone, used_count, max_use, status, leased_by, current_run_id, lease_expires_at, last_error, updated_at
    FROM paypal_phone_pool
    ORDER BY status ASC, used_count ASC, id ASC
    LIMIT ?
  `).all(Math.max(1, Number.parseInt(String(limit || 50), 10)));
}
