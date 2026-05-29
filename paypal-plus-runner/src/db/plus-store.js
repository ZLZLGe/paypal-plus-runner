import { utcNow } from "./connection.js";

function getImportTarget(result = {}, config = {}) {
  if (result.cpaUploadStatus === "done") return "cpa_upload";
  const configured = config.flow?.sessionJsonTarget || "session_json";
  if (!result.cpaJsonPath) return configured;
  return configured === "session_json" ? "local_cpa_json" : `${configured}+local_cpa_json`;
}

function stringifyJson(value) {
  if (!value) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

export function insertPlusAccount(db, account, result = {}, config = {}) {
  db.prepare(`
    INSERT INTO plus_accounts(
      email, password, client_id, refresh_token, gpt_password,
      session_json, import_target, roxy_dir_id, roxy_exit_ip,
      account_identifier_type, account_identifier, signup_phone_number, bound_email,
      cpa_upload_status, cpa_upload_json, callback_json, callback_json_path, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      password = excluded.password,
      client_id = excluded.client_id,
      refresh_token = excluded.refresh_token,
      gpt_password = excluded.gpt_password,
      session_json = excluded.session_json,
      import_target = excluded.import_target,
      roxy_dir_id = excluded.roxy_dir_id,
      roxy_exit_ip = excluded.roxy_exit_ip,
      account_identifier_type = excluded.account_identifier_type,
      account_identifier = excluded.account_identifier,
      signup_phone_number = excluded.signup_phone_number,
      bound_email = excluded.bound_email,
      cpa_upload_status = excluded.cpa_upload_status,
      cpa_upload_json = excluded.cpa_upload_json,
      callback_json = excluded.callback_json,
      callback_json_path = excluded.callback_json_path
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
    result.accountIdentifierType || "",
    result.accountIdentifier || "",
    result.signupPhoneNumber || "",
    result.boundEmail || account.email || "",
    result.cpaUploadStatus || "",
    stringifyJson(result.cpaUploadResult || result.results?.["cpa-platform-verify"]?.cpaUploadResult),
    stringifyJson(result.callbackJson || result.results?.["callback-json-save"]?.callbackJson),
    result.callbackJsonPath || result.results?.["callback-json-save"]?.callbackJsonPath || "",
    utcNow(),
  );
}
