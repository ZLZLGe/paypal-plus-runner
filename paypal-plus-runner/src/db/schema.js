export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS outlook_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'new',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      leased_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS plus_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL DEFAULT '',
      client_id TEXT NOT NULL DEFAULT '',
      refresh_token TEXT NOT NULL DEFAULT '',
      gpt_password TEXT NOT NULL DEFAULT 'myPASSword!',
      session_json TEXT NOT NULL DEFAULT '',
      import_target TEXT NOT NULL DEFAULT 'session_json',
      roxy_dir_id TEXT NOT NULL DEFAULT '',
      roxy_exit_ip TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS paypal_phone_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      sms_url TEXT NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      max_use INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'active',
      leased_by TEXT NOT NULL DEFAULT '',
      current_run_id TEXT NOT NULL DEFAULT '',
      leased_at TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS run_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL DEFAULT '',
      outlook_email_id INTEGER,
      worker_id TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'created',
      current_step TEXT NOT NULL DEFAULT '',
      roxy_dir_id TEXT NOT NULL DEFAULT '',
      roxy_exit_ip TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_outlook_status ON outlook_emails(status, id);
    CREATE INDEX IF NOT EXISTS idx_phone_status ON paypal_phone_pool(status, used_count, updated_at);
    CREATE INDEX IF NOT EXISTS idx_run_history_status ON run_history(status, updated_at);
  `);
}
