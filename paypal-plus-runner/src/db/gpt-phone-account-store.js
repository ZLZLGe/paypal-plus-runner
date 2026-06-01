import { utcNow } from "./connection.js";

export const GPT_PHONE_LIFECYCLE = Object.freeze({
  SIGNUP_PENDING: "signup_pending",
  REGISTERED: "registered",
  PLUS_DONE: "plus_done",
  EMAIL_BOUND: "email_bound",
  CPA_DONE: "cpa_done",
  HOLD_NO_SMS_ACCESS: "hold_no_sms_access",
  DISABLED: "disabled",
});

const REUSABLE_STATUSES = [
  GPT_PHONE_LIFECYCLE.EMAIL_BOUND,
  GPT_PHONE_LIFECYCLE.PLUS_DONE,
  GPT_PHONE_LIFECYCLE.REGISTERED,
];

const ACTIVE_ACTIVATION_STATUSES = [
  "requested",
  "submitted",
  "code_received",
  "registered",
  "preserved_for_oauth",
];

function normalizeString(value = "") {
  return String(value || "").trim();
}

function normalizePhone(value = "") {
  const text = normalizeString(value);
  if (!text) return "";
  const digits = text.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  return `+${digits}`;
}

function leaseExpiresExpr(leaseMinutes = 120) {
  const minutes = Math.max(1, Number.parseInt(String(leaseMinutes), 10) || 120);
  return `datetime('now', '+${minutes} minutes')`;
}

function normalizePositiveIds(ids = []) {
  return (Array.isArray(ids) ? ids : [ids])
    .map((value) => Number.parseInt(String(value || ""), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function parseJson(value = "") {
  if (!value) return null;
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
}

function stringifyJson(value) {
  if (!value) return "";
  try {
    return typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    return "";
  }
}

function activationFromRow(row) {
  if (!row) return null;
  const payload = parseJson(row.activation_json) || parseJson(row.completed_json) || {};
  return {
    ...payload,
    provider: payload.provider || row.provider || "",
    activationId: payload.activationId || row.provider_order_id || "",
    providerOrderId: row.provider_order_id || payload.providerOrderId || payload.activationId || "",
    phoneNumber: payload.phoneNumber || row.phone || "",
    countryCode: payload.countryCode || row.country_code || "",
    dialCode: payload.dialCode || row.dial_code || "",
    localNumber: payload.localNumber || row.local_number || "",
    dbActivationId: row.id,
    gptPhoneAccountId: row.gpt_phone_account_id || null,
    dbStatus: row.status || "",
  };
}

export function gptPhoneAccountToWorkflowAccount(row = {}) {
  return {
    id: null,
    email: row.bound_email || "",
    password: "",
    client_id: "",
    refresh_token: "",
    gptPhoneAccountId: row.id || null,
    signupPhoneNumber: row.signup_phone_number || "",
    accountIdentifierType: row.account_identifier_type || "phone",
    accountIdentifier: row.signup_phone_number || "",
    gptPassword: row.gpt_password || "",
    lifecycleStatus: row.lifecycle_status || "",
    boundOutlookEmailId: row.bound_outlook_email_id || null,
    boundEmail: row.bound_email || "",
    activeActivationId: row.active_activation_id || null,
  };
}

export function leaseReusableGptPhoneAccount(db, { workerId = "", runId = "", leaseMinutes = 120, ids = [] } = {}) {
  const expiresExpr = leaseExpiresExpr(leaseMinutes);
  const now = utcNow();
  const normalizedIds = normalizePositiveIds(ids);
  const idClause = normalizedIds.length ? `AND id IN (${normalizedIds.map(() => "?").join(",")})` : "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT *
      FROM gpt_phone_accounts
      WHERE lifecycle_status IN (${REUSABLE_STATUSES.map(() => "?").join(",")})
        AND (
          lease_status = 'available'
          OR lease_expires_at = ''
          OR lease_expires_at < CURRENT_TIMESTAMP
        )
        ${idClause}
      ORDER BY CASE lifecycle_status
          WHEN 'email_bound' THEN 1
          WHEN 'plus_done' THEN 2
          WHEN 'registered' THEN 3
          ELSE 9
        END,
        updated_at ASC,
        id ASC
      LIMIT 1
    `).get(...REUSABLE_STATUSES, ...normalizedIds);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE gpt_phone_accounts
      SET lease_status = 'leased',
          leased_by = ?,
          current_run_id = ?,
          leased_at = ?,
          lease_expires_at = ${expiresExpr},
          last_error = '',
          updated_at = ?
      WHERE id = ?
    `).run(workerId, runId, now, now, row.id);
    const updated = db.prepare("SELECT * FROM gpt_phone_accounts WHERE id = ?").get(row.id);
    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function leaseGptPhoneAccountForRegisterLink(db, { workerId = "", runId = "", leaseMinutes = 120, ids = [] } = {}) {
  const expiresExpr = leaseExpiresExpr(leaseMinutes);
  const now = utcNow();
  const normalizedIds = normalizePositiveIds(ids);
  const idClause = normalizedIds.length ? `AND g.id IN (${normalizedIds.map(() => "?").join(",")})` : "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT *
      FROM gpt_phone_accounts g
      WHERE g.lifecycle_status = 'registered'
        AND (
          g.lease_status = 'available'
          OR g.lease_expires_at = ''
          OR g.lease_expires_at < CURRENT_TIMESTAMP
        )
        ${idClause}
        AND NOT EXISTS (
          SELECT 1
          FROM checkout_links cl
          WHERE cl.gpt_phone_account_id = g.id
            AND cl.status IN ('ready', 'paying', 'paid')
        )
      ORDER BY g.updated_at ASC, g.id ASC
      LIMIT 1
    `).get(...normalizedIds);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE gpt_phone_accounts
      SET lease_status = 'leased',
          leased_by = ?,
          current_run_id = ?,
          leased_at = ?,
          lease_expires_at = ${expiresExpr},
          last_error = '',
          updated_at = ?
      WHERE id = ?
    `).run(workerId, runId, now, now, row.id);
    const updated = db.prepare("SELECT * FROM gpt_phone_accounts WHERE id = ?").get(row.id);
    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function leaseGptPhoneAccountForCpaUpload(db, { workerId = "", runId = "", leaseMinutes = 120, ids = [] } = {}) {
  const expiresExpr = leaseExpiresExpr(leaseMinutes);
  const now = utcNow();
  const normalizedIds = normalizePositiveIds(ids);
  const idClause = normalizedIds.length ? `AND id IN (${normalizedIds.map(() => "?").join(",")})` : "";
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(`
      SELECT *
      FROM gpt_phone_accounts
      WHERE lifecycle_status IN ('plus_done', 'email_bound')
        AND (
          lease_status = 'available'
          OR lease_expires_at = ''
          OR lease_expires_at < CURRENT_TIMESTAMP
        )
        ${idClause}
      ORDER BY CASE lifecycle_status
          WHEN 'email_bound' THEN 1
          WHEN 'plus_done' THEN 2
          ELSE 9
        END,
        updated_at ASC,
        id ASC
      LIMIT 1
    `).get(...normalizedIds);
    if (!row) {
      db.exec("COMMIT");
      return null;
    }
    db.prepare(`
      UPDATE gpt_phone_accounts
      SET lease_status = 'leased',
          leased_by = ?,
          current_run_id = ?,
          leased_at = ?,
          lease_expires_at = ${expiresExpr},
          last_error = '',
          updated_at = ?
      WHERE id = ?
    `).run(workerId, runId, now, now, row.id);
    const updated = db.prepare("SELECT * FROM gpt_phone_accounts WHERE id = ?").get(row.id);
    db.exec("COMMIT");
    return updated;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function countReusableGptPhoneAccounts(db) {
  return Number(db.prepare(`
    SELECT COUNT(1) AS c
    FROM gpt_phone_accounts
    WHERE lifecycle_status IN (${REUSABLE_STATUSES.map(() => "?").join(",")})
      AND (
        lease_status = 'available'
        OR lease_expires_at = ''
        OR lease_expires_at < CURRENT_TIMESTAMP
      )
  `).get(...REUSABLE_STATUSES).c || 0);
}

export function getGptPhoneAccount(db, id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM gpt_phone_accounts WHERE id = ?").get(id) || null;
}

export function getGptPhoneAccountByPhone(db, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;
  return db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = ?").get(normalized) || null;
}

export function recordOpenAiPhoneActivation(db, activation = {}, {
  gptPhoneAccountId = null,
  runId = "",
  workerId = "",
  status = "requested",
  leaseMinutes = 120,
} = {}) {
  const now = utcNow();
  const phone = normalizePhone(activation.phoneNumber || activation.phone || "");
  const providerOrderId = normalizeString(activation.activationId || activation.providerOrderId || activation.provider_order_id);
  const expiresExpr = leaseExpiresExpr(leaseMinutes);
  db.prepare(`
    INSERT INTO openai_phone_activations(
      provider, provider_order_id, phone, country_code, dial_code, local_number,
      purpose, status, run_id, worker_id, activation_json, completed_json,
      last_error, gpt_phone_account_id, leased_by, current_run_id, lease_expires_at,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, 'signup', ?, ?, ?, ?, '', '', ?, ?, ?, ${expiresExpr}, ?, ?)
  `).run(
    normalizeString(activation.provider),
    providerOrderId,
    phone,
    normalizeString(activation.countryCode || activation.countryId),
    normalizeString(activation.dialCode),
    normalizeString(activation.localNumber),
    status,
    runId,
    workerId,
    stringifyJson(activation),
    gptPhoneAccountId,
    workerId,
    runId,
    now,
    now,
  );
  return db.prepare("SELECT * FROM openai_phone_activations WHERE id = last_insert_rowid()").get();
}

export function createPendingGptPhoneAccountFromActivation(db, activation = {}, {
  activationId = null,
  workerId = "",
  runId = "",
  leaseMinutes = 120,
  gptPassword = "",
} = {}) {
  const phone = normalizePhone(activation.phoneNumber || activation.phone || "");
  if (!phone) throw new Error("GPT phone account requires signup phone number");
  const now = utcNow();
  const expiresExpr = leaseExpiresExpr(leaseMinutes);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`
      INSERT INTO gpt_phone_accounts(
        account_identifier_type, signup_phone_number, signup_country_code,
        signup_dial_code, signup_local_number, gpt_password, lifecycle_status,
        lease_status, leased_by, current_run_id, leased_at, lease_expires_at,
        active_activation_id, created_at, updated_at
      )
      VALUES ('phone', ?, ?, ?, ?, ?, 'signup_pending', 'leased', ?, ?, ?, ${expiresExpr}, ?, ?, ?)
      ON CONFLICT(signup_phone_number) DO UPDATE SET
        gpt_password = CASE WHEN excluded.gpt_password <> '' THEN excluded.gpt_password ELSE gpt_phone_accounts.gpt_password END,
        lifecycle_status = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.lifecycle_status
          ELSE gpt_phone_accounts.lifecycle_status
        END,
        lease_status = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.lease_status
          ELSE 'leased'
        END,
        leased_by = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.leased_by
          ELSE excluded.leased_by
        END,
        current_run_id = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.current_run_id
          ELSE excluded.current_run_id
        END,
        leased_at = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.leased_at
          ELSE excluded.leased_at
        END,
        lease_expires_at = CASE
          WHEN gpt_phone_accounts.lifecycle_status IN ('cpa_done', 'disabled') THEN gpt_phone_accounts.lease_expires_at
          ELSE excluded.lease_expires_at
        END,
        active_activation_id = CASE WHEN excluded.active_activation_id IS NOT NULL THEN excluded.active_activation_id ELSE gpt_phone_accounts.active_activation_id END,
        updated_at = excluded.updated_at
    `).run(
      phone,
      normalizeString(activation.countryCode || activation.countryId),
      normalizeString(activation.dialCode),
      normalizeString(activation.localNumber),
      normalizeString(gptPassword),
      workerId,
      runId,
      now,
      activationId,
      now,
      now,
    );
    const row = db.prepare("SELECT * FROM gpt_phone_accounts WHERE signup_phone_number = ?").get(phone);
    if (row?.lifecycle_status === GPT_PHONE_LIFECYCLE.CPA_DONE || row?.lifecycle_status === GPT_PHONE_LIFECYCLE.DISABLED) {
      throw new Error(`signup phone ${phone} already belongs to a non-reusable GPT account (${row.lifecycle_status})`);
    }
    if (activationId) {
      db.prepare(`
        UPDATE openai_phone_activations
        SET gpt_phone_account_id = ?, updated_at = ?
        WHERE id = ?
      `).run(row.id, now, activationId);
    }
    db.exec("COMMIT");
    return row;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getActiveOpenAiPhoneActivationForAccount(db, gptPhoneAccountId) {
  if (!gptPhoneAccountId) return null;
  const row = db.prepare(`
    SELECT *
    FROM openai_phone_activations
    WHERE gpt_phone_account_id = ?
      AND status IN (${ACTIVE_ACTIVATION_STATUSES.map(() => "?").join(",")})
      AND (expires_at = '' OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY id DESC
    LIMIT 1
  `).get(gptPhoneAccountId, ...ACTIVE_ACTIVATION_STATUSES);
  return activationFromRow(row);
}

export function markOpenAiPhoneActivationStatus(db, activation = {}, status, { error = "", completed = null } = {}) {
  const id = activation?.dbActivationId || activation?.id;
  if (!id) return null;
  const completedJson = completed ? stringifyJson(completed) : "";
  db.prepare(`
    UPDATE openai_phone_activations
    SET status = ?,
        completed_json = CASE WHEN ? <> '' THEN ? ELSE completed_json END,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(status, completedJson, completedJson, normalizeString(error).slice(0, 1000), utcNow(), id);
  return db.prepare("SELECT * FROM openai_phone_activations WHERE id = ?").get(id);
}

export function markGptAccountRegistered(db, id, {
  activation = null,
  gptPassword = "",
  runId = "",
  workerId = "",
} = {}) {
  if (!id) return null;
  const now = utcNow();
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lifecycle_status = CASE
          WHEN lifecycle_status IN ('plus_done', 'email_bound', 'cpa_done') THEN lifecycle_status
          ELSE 'registered'
        END,
        account_identifier_type = 'phone',
        signup_phone_number = CASE WHEN ? <> '' THEN ? ELSE signup_phone_number END,
        signup_country_code = CASE WHEN ? <> '' THEN ? ELSE signup_country_code END,
        signup_dial_code = CASE WHEN ? <> '' THEN ? ELSE signup_dial_code END,
        signup_local_number = CASE WHEN ? <> '' THEN ? ELSE signup_local_number END,
        gpt_password = CASE WHEN ? <> '' THEN ? ELSE gpt_password END,
        active_activation_id = CASE WHEN ? IS NOT NULL THEN ? ELSE active_activation_id END,
        registered_at = CASE WHEN registered_at = '' THEN ? ELSE registered_at END,
        leased_by = CASE WHEN ? <> '' THEN ? ELSE leased_by END,
        current_run_id = CASE WHEN ? <> '' THEN ? ELSE current_run_id END,
        last_failed_step = '',
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(
    normalizePhone(activation?.phoneNumber || ""),
    normalizePhone(activation?.phoneNumber || ""),
    normalizeString(activation?.countryCode || activation?.countryId),
    normalizeString(activation?.countryCode || activation?.countryId),
    normalizeString(activation?.dialCode),
    normalizeString(activation?.dialCode),
    normalizeString(activation?.localNumber),
    normalizeString(activation?.localNumber),
    normalizeString(gptPassword),
    normalizeString(gptPassword),
    activation?.dbActivationId || null,
    activation?.dbActivationId || null,
    now,
    workerId,
    workerId,
    runId,
    runId,
    now,
    id,
  );
  if (activation?.dbActivationId) {
    markOpenAiPhoneActivationStatus(db, activation, "registered");
  }
  return getGptPhoneAccount(db, id);
}

export function markGptAccountPlusDone(db, id, patch = {}) {
  if (!id) return null;
  const now = utcNow();
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lifecycle_status = CASE
          WHEN lifecycle_status IN ('email_bound', 'cpa_done') THEN lifecycle_status
          ELSE 'plus_done'
        END,
        gpt_password = CASE WHEN ? <> '' THEN ? ELSE gpt_password END,
        session_json = CASE WHEN ? <> '' THEN ? ELSE session_json END,
        roxy_dir_id = CASE WHEN ? <> '' THEN ? ELSE roxy_dir_id END,
        roxy_exit_ip = CASE WHEN ? <> '' THEN ? ELSE roxy_exit_ip END,
        plus_done_at = CASE WHEN plus_done_at = '' THEN ? ELSE plus_done_at END,
        last_failed_step = '',
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(
    normalizeString(patch.gptPassword),
    normalizeString(patch.gptPassword),
    normalizeString(patch.sessionJson),
    normalizeString(patch.sessionJson),
    normalizeString(patch.roxyDirId),
    normalizeString(patch.roxyDirId),
    normalizeString(patch.roxyExitIp),
    normalizeString(patch.roxyExitIp),
    now,
    now,
    id,
  );
  return getGptPhoneAccount(db, id);
}

export function markGptAccountEmailBound(db, id, { outlookEmailId = null, email = "" } = {}) {
  if (!id) return null;
  const now = utcNow();
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lifecycle_status = CASE WHEN lifecycle_status = 'cpa_done' THEN lifecycle_status ELSE 'email_bound' END,
        bound_outlook_email_id = COALESCE(?, bound_outlook_email_id),
        bound_email = CASE WHEN ? <> '' THEN ? ELSE bound_email END,
        email_bound_at = CASE WHEN email_bound_at = '' THEN ? ELSE email_bound_at END,
        last_failed_step = '',
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(outlookEmailId, normalizeString(email), normalizeString(email), now, now, id);
  return getGptPhoneAccount(db, id);
}

export function markGptAccountCpaDone(db, id, patch = {}) {
  if (!id) return null;
  const now = utcNow();
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lifecycle_status = 'cpa_done',
        bound_email = CASE WHEN ? <> '' THEN ? ELSE bound_email END,
        cpa_upload_status = CASE WHEN ? <> '' THEN ? ELSE cpa_upload_status END,
        cpa_upload_json = CASE WHEN ? <> '' THEN ? ELSE cpa_upload_json END,
        callback_json = CASE WHEN ? <> '' THEN ? ELSE callback_json END,
        callback_json_path = CASE WHEN ? <> '' THEN ? ELSE callback_json_path END,
        cpa_done_at = CASE WHEN cpa_done_at = '' THEN ? ELSE cpa_done_at END,
        last_failed_step = '',
        last_error = '',
        updated_at = ?
    WHERE id = ?
  `).run(
    normalizeString(patch.boundEmail),
    normalizeString(patch.boundEmail),
    normalizeString(patch.cpaUploadStatus),
    normalizeString(patch.cpaUploadStatus),
    stringifyJson(patch.cpaUploadResult || patch.cpaUploadJson),
    stringifyJson(patch.cpaUploadResult || patch.cpaUploadJson),
    stringifyJson(patch.callbackJson),
    stringifyJson(patch.callbackJson),
    normalizeString(patch.callbackJsonPath),
    normalizeString(patch.callbackJsonPath),
    now,
    now,
    id,
  );
  return getGptPhoneAccount(db, id);
}

export function markGptAccountHoldNoSmsAccess(db, id, { error = "", step = "" } = {}) {
  if (!id) return null;
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lifecycle_status = 'hold_no_sms_access',
        lease_status = 'available',
        leased_by = '',
        current_run_id = '',
        leased_at = '',
        lease_expires_at = '',
        failure_count = failure_count + 1,
        last_failed_step = ?,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(normalizeString(step), normalizeString(error).slice(0, 1000), utcNow(), id);
  return getGptPhoneAccount(db, id);
}

export function markGptAccountFailure(db, id, { error = "", step = "", status = "" } = {}) {
  if (!id) return null;
  const normalizedStatus = normalizeString(status);
  const statusExpr = normalizedStatus ? "lifecycle_status = ?," : "";
  const params = normalizedStatus ? [normalizedStatus] : [];
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET ${statusExpr}
        lease_status = CASE WHEN ? = 'disabled' THEN 'available' ELSE lease_status END,
        leased_by = CASE WHEN ? = 'disabled' THEN '' ELSE leased_by END,
        current_run_id = CASE WHEN ? = 'disabled' THEN '' ELSE current_run_id END,
        leased_at = CASE WHEN ? = 'disabled' THEN '' ELSE leased_at END,
        lease_expires_at = CASE WHEN ? = 'disabled' THEN '' ELSE lease_expires_at END,
        failure_count = failure_count + 1,
        last_failed_step = ?,
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    ...params,
    normalizedStatus,
    normalizedStatus,
    normalizedStatus,
    normalizedStatus,
    normalizedStatus,
    normalizeString(step),
    normalizeString(error).slice(0, 1000),
    utcNow(),
    id,
  );
  return getGptPhoneAccount(db, id);
}

export function releaseGptPhoneAccount(db, id, { runId = "", error = "" } = {}) {
  if (!id) return null;
  db.prepare(`
    UPDATE gpt_phone_accounts
    SET lease_status = 'available',
        leased_by = '',
        current_run_id = '',
        leased_at = '',
        lease_expires_at = '',
        last_error = CASE WHEN ? <> '' THEN ? ELSE last_error END,
        updated_at = ?
    WHERE id = ?
      AND lifecycle_status NOT IN ('disabled')
      AND (? = '' OR current_run_id = ?)
  `).run(
    normalizeString(error).slice(0, 1000),
    normalizeString(error).slice(0, 1000),
    utcNow(),
    id,
    runId,
    runId,
  );
  return getGptPhoneAccount(db, id);
}
