function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = columnNames(db, table);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

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
      artifact_dir TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS openai_phone_activations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL DEFAULT '',
      provider_order_id TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      country_code TEXT NOT NULL DEFAULT '',
      dial_code TEXT NOT NULL DEFAULT '',
      local_number TEXT NOT NULL DEFAULT '',
      purpose TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      run_id TEXT NOT NULL DEFAULT '',
      worker_id TEXT NOT NULL DEFAULT '',
      activation_json TEXT NOT NULL DEFAULT '',
      completed_json TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL DEFAULT '',
      worker_id TEXT NOT NULL DEFAULT '',
      roxy_dir_id TEXT NOT NULL DEFAULT '',
      account_email TEXT NOT NULL DEFAULT '',
      account_identifier_type TEXT NOT NULL DEFAULT '',
      account_identifier TEXT NOT NULL DEFAULT '',
      step TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      event_type TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      page_stage TEXT NOT NULL DEFAULT '',
      page_url_redacted TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_outlook_status ON outlook_emails(status, id);
    CREATE INDEX IF NOT EXISTS idx_phone_status ON paypal_phone_pool(status, used_count, updated_at);
    CREATE INDEX IF NOT EXISTS idx_run_history_status ON run_history(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_openai_phone_status ON openai_phone_activations(status, run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_run_events_worker ON run_events(worker_id, id);
  `);

  addColumnIfMissing(db, "run_history", "artifact_dir", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "account_identifier_type", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "account_identifier", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "cpa_upload_status", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "callback_json_path", "TEXT NOT NULL DEFAULT ''");

  addColumnIfMissing(db, "plus_accounts", "account_identifier_type", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "account_identifier", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "signup_phone_number", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "bound_email", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "cpa_upload_status", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "cpa_upload_json", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "callback_json", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "callback_json_path", "TEXT NOT NULL DEFAULT ''");
}
