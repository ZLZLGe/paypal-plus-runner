import { utcNow } from "./connection.js";

export function insertPlusAccount(db, account, result = {}, config = {}) {
  db.prepare(`
    INSERT INTO plus_accounts(
      email, password, client_id, refresh_token, gpt_password,
      session_json, import_target, roxy_dir_id, roxy_exit_ip, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      client_id = excluded.client_id,
      refresh_token = excluded.refresh_token,
      gpt_password = excluded.gpt_password,
      session_json = excluded.session_json,
      import_target = excluded.import_target,
      roxy_dir_id = excluded.roxy_dir_id,
      roxy_exit_ip = excluded.roxy_exit_ip
  `).run(
    account.email,
    account.password || "",
    account.client_id || "",
    account.refresh_token || "",
    config.runner?.gptPassword || "myPASSword!",
    result.sessionJson || "",
    config.flow?.sessionJsonTarget || "session_json",
    result.roxyDirId || "",
    result.roxyExitIp || "",
    utcNow(),
  );
}
