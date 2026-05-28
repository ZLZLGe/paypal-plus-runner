import { utcNow } from "./connection.js";

function getImportTarget(result = {}, config = {}) {
  const configured = config.flow?.sessionJsonTarget || "session_json";
  if (!result.cpaJsonPath) return configured;
  return configured === "session_json" ? "local_cpa_json" : `${configured}+local_cpa_json`;
}

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
    getImportTarget(result, config),
    result.roxyDirId || "",
    result.roxyExitIp || "",
    utcNow(),
  );
}
