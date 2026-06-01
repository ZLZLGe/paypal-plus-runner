function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function addColumnIfMissing(db, table, column, definition) {
  const columns = columnNames(db, table);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function createIndexIfPossible(db, sql) {
  try {
    db.exec(sql);
  } catch {
    // Existing user data can contain duplicates. Keep startup working; tests cover
    // clean installs where the unique indexes are created.
  }
}

function lifecycleStatusForPlusRow(row = {}) {
  if (String(row.cpa_upload_status || "").trim().toLowerCase() === "done") return "cpa_done";
  if (String(row.bound_email || "").trim()) return "email_bound";
  return "plus_done";
}

function backfillGptPhoneAccounts(db) {
  const rows = db.prepare(`
    SELECT *
    FROM plus_accounts
    WHERE signup_phone_number <> ''
       OR (account_identifier_type = 'phone' AND account_identifier <> '')
       OR (email LIKE '+%' AND account_identifier_type = 'phone')
  `).all();
  if (!rows.length) return;

  const stmt = db.prepare(`
    INSERT INTO gpt_phone_accounts(
      account_identifier_type, signup_phone_number, gpt_password, lifecycle_status,
      lease_status, bound_email, cpa_upload_status, cpa_upload_json,
      callback_json, callback_json_path, session_json, roxy_dir_id, roxy_exit_ip,
      registered_at, plus_done_at, email_bound_at, cpa_done_at, created_at, updated_at
    )
    VALUES ('phone', ?, ?, ?, 'available', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(signup_phone_number) DO UPDATE SET
      gpt_password = CASE WHEN excluded.gpt_password <> '' THEN excluded.gpt_password ELSE gpt_phone_accounts.gpt_password END,
      lifecycle_status = CASE
        WHEN gpt_phone_accounts.lifecycle_status = 'cpa_done' THEN gpt_phone_accounts.lifecycle_status
        WHEN excluded.lifecycle_status = 'cpa_done' THEN excluded.lifecycle_status
        WHEN gpt_phone_accounts.lifecycle_status = 'email_bound' THEN gpt_phone_accounts.lifecycle_status
        WHEN excluded.lifecycle_status = 'email_bound' THEN excluded.lifecycle_status
        ELSE excluded.lifecycle_status
      END,
      bound_email = CASE WHEN excluded.bound_email <> '' THEN excluded.bound_email ELSE gpt_phone_accounts.bound_email END,
      cpa_upload_status = CASE WHEN excluded.cpa_upload_status <> '' THEN excluded.cpa_upload_status ELSE gpt_phone_accounts.cpa_upload_status END,
      cpa_upload_json = CASE WHEN excluded.cpa_upload_json <> '' THEN excluded.cpa_upload_json ELSE gpt_phone_accounts.cpa_upload_json END,
      callback_json = CASE WHEN excluded.callback_json <> '' THEN excluded.callback_json ELSE gpt_phone_accounts.callback_json END,
      callback_json_path = CASE WHEN excluded.callback_json_path <> '' THEN excluded.callback_json_path ELSE gpt_phone_accounts.callback_json_path END,
      session_json = CASE WHEN excluded.session_json <> '' THEN excluded.session_json ELSE gpt_phone_accounts.session_json END,
      roxy_dir_id = CASE WHEN excluded.roxy_dir_id <> '' THEN excluded.roxy_dir_id ELSE gpt_phone_accounts.roxy_dir_id END,
      roxy_exit_ip = CASE WHEN excluded.roxy_exit_ip <> '' THEN excluded.roxy_exit_ip ELSE gpt_phone_accounts.roxy_exit_ip END,
      plus_done_at = CASE WHEN gpt_phone_accounts.plus_done_at <> '' THEN gpt_phone_accounts.plus_done_at ELSE excluded.plus_done_at END,
      email_bound_at = CASE WHEN excluded.email_bound_at <> '' THEN excluded.email_bound_at ELSE gpt_phone_accounts.email_bound_at END,
      cpa_done_at = CASE WHEN excluded.cpa_done_at <> '' THEN excluded.cpa_done_at ELSE gpt_phone_accounts.cpa_done_at END,
      updated_at = CURRENT_TIMESTAMP
  `);

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const phone = String(row.signup_phone_number || (row.account_identifier_type === "phone" ? row.account_identifier : "") || row.email || "").trim();
      if (!phone) continue;
      const status = lifecycleStatusForPlusRow(row);
      const now = new Date().toISOString();
      stmt.run(
        phone,
        String(row.gpt_password || row.password || "").trim(),
        status,
        String(row.bound_email || "").trim(),
        String(row.cpa_upload_status || "").trim(),
        String(row.cpa_upload_json || "").trim(),
        String(row.callback_json || "").trim(),
        String(row.callback_json_path || "").trim(),
        String(row.session_json || "").trim(),
        String(row.roxy_dir_id || "").trim(),
        String(row.roxy_exit_ip || "").trim(),
        String(row.created_at || now).trim(),
        String(row.created_at || now).trim(),
        status === "email_bound" || status === "cpa_done" ? now : "",
        status === "cpa_done" ? now : "",
        String(row.created_at || now).trim(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gpt_phone_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_identifier_type TEXT NOT NULL DEFAULT 'phone',
      signup_phone_number TEXT NOT NULL UNIQUE,
      signup_country_code TEXT NOT NULL DEFAULT '',
      signup_dial_code TEXT NOT NULL DEFAULT '',
      signup_local_number TEXT NOT NULL DEFAULT '',
      gpt_password TEXT NOT NULL DEFAULT '',
      lifecycle_status TEXT NOT NULL DEFAULT 'signup_pending',
      lease_status TEXT NOT NULL DEFAULT 'available',
      leased_by TEXT NOT NULL DEFAULT '',
      current_run_id TEXT NOT NULL DEFAULT '',
      leased_at TEXT NOT NULL DEFAULT '',
      lease_expires_at TEXT NOT NULL DEFAULT '',
      active_activation_id INTEGER,
      bound_outlook_email_id INTEGER,
      bound_email TEXT NOT NULL DEFAULT '',
      cpa_upload_status TEXT NOT NULL DEFAULT '',
      cpa_upload_json TEXT NOT NULL DEFAULT '',
      callback_json TEXT NOT NULL DEFAULT '',
      callback_json_path TEXT NOT NULL DEFAULT '',
      session_json TEXT NOT NULL DEFAULT '',
      roxy_dir_id TEXT NOT NULL DEFAULT '',
      roxy_exit_ip TEXT NOT NULL DEFAULT '',
      registered_at TEXT NOT NULL DEFAULT '',
      plus_done_at TEXT NOT NULL DEFAULT '',
      email_bound_at TEXT NOT NULL DEFAULT '',
      cpa_done_at TEXT NOT NULL DEFAULT '',
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_failed_step TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

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

    CREATE TABLE IF NOT EXISTS paypal_phone_sms_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_id INTEGER,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(phone, code)
    );

    CREATE TABLE IF NOT EXISTS checkout_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gpt_phone_account_id INTEGER NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      checkout_long_url TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'ready',
      last_error TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      paid_at TEXT NOT NULL DEFAULT ''
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

    CREATE TABLE IF NOT EXISTS ui_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_outlook_status ON outlook_emails(status, id);
    CREATE INDEX IF NOT EXISTS idx_phone_status ON paypal_phone_pool(status, used_count, updated_at);
    CREATE INDEX IF NOT EXISTS idx_paypal_phone_sms_codes_phone_seen ON paypal_phone_sms_codes(phone, last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_checkout_links_account_status ON checkout_links(gpt_phone_account_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_checkout_links_status ON checkout_links(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_run_history_status ON run_history(status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_openai_phone_status ON openai_phone_activations(status, run_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);
    CREATE INDEX IF NOT EXISTS idx_run_events_worker ON run_events(worker_id, id);
    CREATE INDEX IF NOT EXISTS idx_gpt_phone_accounts_lease ON gpt_phone_accounts(lifecycle_status, lease_status, lease_expires_at, updated_at);
    CREATE INDEX IF NOT EXISTS idx_gpt_phone_accounts_run ON gpt_phone_accounts(current_run_id, leased_by);
  `);

  addColumnIfMissing(db, "run_history", "artifact_dir", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "account_identifier_type", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "account_identifier", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "cpa_upload_status", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "callback_json_path", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "run_history", "gpt_phone_account_id", "INTEGER");
  addColumnIfMissing(db, "run_history", "openai_phone_activation_id", "INTEGER");
  addColumnIfMissing(db, "run_history", "paypal_phone_id", "INTEGER");
  addColumnIfMissing(db, "run_history", "account_lifecycle_status", "TEXT NOT NULL DEFAULT ''");

  addColumnIfMissing(db, "plus_accounts", "account_identifier_type", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "account_identifier", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "signup_phone_number", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "bound_email", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "cpa_upload_status", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "cpa_upload_json", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "callback_json", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "callback_json_path", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "plus_accounts", "gpt_phone_account_id", "INTEGER");
  addColumnIfMissing(db, "plus_accounts", "updated_at", "TEXT NOT NULL DEFAULT ''");

  addColumnIfMissing(db, "openai_phone_activations", "gpt_phone_account_id", "INTEGER");
  addColumnIfMissing(db, "openai_phone_activations", "leased_by", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "openai_phone_activations", "current_run_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "openai_phone_activations", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "openai_phone_activations", "expires_at", "TEXT NOT NULL DEFAULT ''");

  addColumnIfMissing(db, "outlook_emails", "leased_by", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "outlook_emails", "current_run_id", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "outlook_emails", "lease_expires_at", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "outlook_emails", "bound_gpt_phone_account_id", "INTEGER");
  addColumnIfMissing(db, "outlook_emails", "bound_signup_phone_number", "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, "outlook_emails", "bound_at", "TEXT NOT NULL DEFAULT ''");

  createIndexIfPossible(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_plus_accounts_gpt_phone_account ON plus_accounts(gpt_phone_account_id) WHERE gpt_phone_account_id IS NOT NULL;");
  createIndexIfPossible(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_plus_accounts_signup_phone ON plus_accounts(signup_phone_number) WHERE signup_phone_number <> '';");
  createIndexIfPossible(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_plus_accounts_bound_email ON plus_accounts(bound_email) WHERE bound_email <> '';");
  createIndexIfPossible(db, "CREATE UNIQUE INDEX IF NOT EXISTS idx_plus_accounts_identifier ON plus_accounts(account_identifier_type, account_identifier) WHERE account_identifier_type <> '' AND account_identifier <> '';");
  createIndexIfPossible(db, "CREATE INDEX IF NOT EXISTS idx_outlook_lease ON outlook_emails(status, lease_expires_at, id);");
  createIndexIfPossible(db, "CREATE INDEX IF NOT EXISTS idx_openai_phone_account ON openai_phone_activations(gpt_phone_account_id, status, updated_at);");

  backfillGptPhoneAccounts(db);
}
