import { utcNow } from "./connection.js";

function normalizeString(value = "") {
  return String(value || "").trim();
}

function getImportTarget(result = {}, config = {}) {
  if (result.cpaUploadStatus === "done") return "cpa_upload";
  if (result.plusAccountOnly || (result.accountIdentifierType === "phone" && !result.sessionJson && !result.cpaJsonPath)) {
    return "phone_plus";
  }
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

function hasEmailShape(value = "") {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalizeString(value));
}

function resolvePlusAccountRow(account = {}, result = {}, config = {}) {
  const accountIdentifierType = normalizeString(result.accountIdentifierType);
  const accountIdentifier = normalizeString(result.accountIdentifier);
  const signupPhoneNumber = normalizeString(result.signupPhoneNumber);
  const boundEmail = normalizeString(result.boundEmail);
  const accountEmail = normalizeString(account.email);
  const gptPhoneAccountId = Number(result.gptPhoneAccountId || account.gptPhoneAccountId || 0) || null;
  const gptPassword = normalizeString(account.gptPassword) || normalizeString(config.runner?.gptPassword) || "myPASSword!";
  const email = boundEmail
    || (hasEmailShape(accountEmail) ? accountEmail : "")
    || accountIdentifier
    || signupPhoneNumber
    || accountEmail;

  return {
    email,
    password: normalizeString(account.password) || gptPassword,
    clientId: normalizeString(account.client_id),
    refreshToken: normalizeString(account.refresh_token),
    gptPassword,
    sessionJson: result.sessionJson || "",
    importTarget: getImportTarget(result, config),
    roxyDirId: normalizeString(result.roxyDirId),
    roxyExitIp: normalizeString(result.roxyExitIp),
    accountIdentifierType,
    accountIdentifier,
    signupPhoneNumber,
    boundEmail,
    cpaUploadStatus: normalizeString(result.cpaUploadStatus),
    cpaUploadJson: stringifyJson(result.cpaUploadResult || result.results?.["cpa-platform-verify"]?.cpaUploadResult),
    callbackJson: stringifyJson(result.callbackJson || result.results?.["callback-json-save"]?.callbackJson),
    callbackJsonPath: normalizeString(result.callbackJsonPath || result.results?.["callback-json-save"]?.callbackJsonPath),
    gptPhoneAccountId,
  };
}

function findExistingPlusAccount(db, row = {}) {
  if (row.gptPhoneAccountId) {
    const match = db.prepare(`
      SELECT * FROM plus_accounts
      WHERE gpt_phone_account_id = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(row.gptPhoneAccountId);
    if (match) return match;
  }
  if (row.accountIdentifierType && row.accountIdentifier) {
    const match = db.prepare(`
      SELECT * FROM plus_accounts
      WHERE account_identifier_type = ? AND account_identifier = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(row.accountIdentifierType, row.accountIdentifier);
    if (match) return match;
  }
  if (row.signupPhoneNumber) {
    const match = db.prepare(`
      SELECT * FROM plus_accounts
      WHERE signup_phone_number = ?
      ORDER BY id ASC
      LIMIT 1
    `).get(row.signupPhoneNumber);
    if (match) return match;
  }
  if (row.email) {
    const match = db.prepare("SELECT * FROM plus_accounts WHERE email = ? LIMIT 1").get(row.email);
    if (match) return match;
  }
  return null;
}

function updatePlusAccountById(db, id, row = {}) {
  db.prepare(`
    UPDATE plus_accounts
    SET email = CASE WHEN ? <> '' THEN ? ELSE email END,
        password = CASE WHEN ? <> '' THEN ? ELSE password END,
        client_id = CASE WHEN ? <> '' THEN ? ELSE client_id END,
        refresh_token = CASE WHEN ? <> '' THEN ? ELSE refresh_token END,
        gpt_password = CASE WHEN ? <> '' THEN ? ELSE gpt_password END,
        session_json = CASE WHEN ? <> '' THEN ? ELSE session_json END,
        import_target = CASE WHEN ? <> '' THEN ? ELSE import_target END,
        roxy_dir_id = CASE WHEN ? <> '' THEN ? ELSE roxy_dir_id END,
        roxy_exit_ip = CASE WHEN ? <> '' THEN ? ELSE roxy_exit_ip END,
        account_identifier_type = CASE WHEN ? <> '' THEN ? ELSE account_identifier_type END,
        account_identifier = CASE WHEN ? <> '' THEN ? ELSE account_identifier END,
        signup_phone_number = CASE WHEN ? <> '' THEN ? ELSE signup_phone_number END,
        bound_email = CASE WHEN ? <> '' THEN ? ELSE bound_email END,
        cpa_upload_status = CASE WHEN ? <> '' THEN ? ELSE cpa_upload_status END,
        cpa_upload_json = CASE WHEN ? <> '' THEN ? ELSE cpa_upload_json END,
        callback_json = CASE WHEN ? <> '' THEN ? ELSE callback_json END,
        callback_json_path = CASE WHEN ? <> '' THEN ? ELSE callback_json_path END,
        gpt_phone_account_id = COALESCE(?, gpt_phone_account_id),
        updated_at = ?
    WHERE id = ?
  `).run(
    row.email, row.email,
    row.password, row.password,
    row.clientId, row.clientId,
    row.refreshToken, row.refreshToken,
    row.gptPassword, row.gptPassword,
    row.sessionJson, row.sessionJson,
    row.importTarget, row.importTarget,
    row.roxyDirId, row.roxyDirId,
    row.roxyExitIp, row.roxyExitIp,
    row.accountIdentifierType, row.accountIdentifierType,
    row.accountIdentifier, row.accountIdentifier,
    row.signupPhoneNumber, row.signupPhoneNumber,
    row.boundEmail, row.boundEmail,
    row.cpaUploadStatus, row.cpaUploadStatus,
    row.cpaUploadJson, row.cpaUploadJson,
    row.callbackJson, row.callbackJson,
    row.callbackJsonPath, row.callbackJsonPath,
    row.gptPhoneAccountId,
    utcNow(),
    id,
  );
}

export function insertPlusAccount(db, account, result = {}, config = {}) {
  const row = resolvePlusAccountRow(account, result, config);
  if (!row.email) {
    throw new Error("plus account requires email or phone identity");
  }
  const existing = findExistingPlusAccount(db, row);
  if (existing?.id) {
    updatePlusAccountById(db, existing.id, row);
    return db.prepare("SELECT * FROM plus_accounts WHERE id = ?").get(existing.id);
  }
  db.prepare(`
    INSERT INTO plus_accounts(
      email, password, client_id, refresh_token, gpt_password,
      session_json, import_target, roxy_dir_id, roxy_exit_ip,
      account_identifier_type, account_identifier, signup_phone_number, bound_email,
      cpa_upload_status, cpa_upload_json, callback_json, callback_json_path,
      gpt_phone_account_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      callback_json_path = excluded.callback_json_path,
      gpt_phone_account_id = COALESCE(excluded.gpt_phone_account_id, plus_accounts.gpt_phone_account_id),
      updated_at = excluded.updated_at
  `).run(
    row.email,
    row.password,
    row.clientId,
    row.refreshToken,
    row.gptPassword,
    row.sessionJson,
    row.importTarget,
    row.roxyDirId,
    row.roxyExitIp,
    row.accountIdentifierType,
    row.accountIdentifier,
    row.signupPhoneNumber,
    row.boundEmail,
    row.cpaUploadStatus,
    row.cpaUploadJson,
    row.callbackJson,
    row.callbackJsonPath,
    row.gptPhoneAccountId,
    utcNow(),
    utcNow(),
  );
  return db.prepare("SELECT * FROM plus_accounts WHERE email = ?").get(row.email);
}
