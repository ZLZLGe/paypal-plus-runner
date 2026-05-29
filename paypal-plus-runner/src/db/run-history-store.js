import { utcNow } from "./connection.js";

export function createRun(db, { runId, email = "", outlookEmailId = null, workerId = "" }) {
  const now = utcNow();
  db.prepare(`
    INSERT INTO run_history(run_id, email, outlook_email_id, worker_id, status, started_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'created', ?, ?, ?)
  `).run(runId, email, outlookEmailId, workerId, now, now, now);
}

export function updateRun(db, runId, patch = {}) {
  const allowed = [
    "email",
    "status",
    "current_step",
    "roxy_dir_id",
    "roxy_exit_ip",
    "outlook_email_id",
    "artifact_dir",
    "error",
    "finished_at",
    "account_identifier_type",
    "account_identifier",
    "cpa_upload_status",
    "callback_json_path",
  ];
  const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `${key} = ?`);
  const values = entries.map(([, value]) => value ?? "");
  sets.push("updated_at = ?");
  values.push(utcNow(), runId);
  db.prepare(`UPDATE run_history SET ${sets.join(", ")} WHERE run_id = ?`).run(...values);
}

export function finishRun(db, runId, { status = "done", error = "" } = {}) {
  updateRun(db, runId, {
    status,
    error: String(error || "").slice(0, 1000),
    finished_at: utcNow(),
  });
}
