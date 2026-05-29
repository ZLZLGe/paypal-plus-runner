import { utcNow } from "./connection.js";
import { redactForCliOutput, redactStringForOutput } from "../utils/safe-output.js";

function safeJson(value) {
  try {
    return JSON.stringify(redactForCliOutput(value ?? {}));
  } catch {
    return "{}";
  }
}

export function appendRunEvent(db, event = {}) {
  const now = utcNow();
  const payload = redactForCliOutput(event.payload || {});
  const pageUrl = event.pageUrl || event.page_url || payload.url || payload.pageUrl || "";
  const info = {
    runId: String(event.runId || event.run_id || ""),
    workerId: String(event.workerId || event.worker_id || ""),
    roxyDirId: String(event.roxyDirId || event.roxy_dir_id || ""),
    accountEmail: String(event.accountEmail || event.account_email || ""),
    accountIdentifierType: String(event.accountIdentifierType || event.account_identifier_type || ""),
    accountIdentifier: String(event.accountIdentifier || event.account_identifier || ""),
    step: String(event.step || ""),
    level: String(event.level || "info").toLowerCase(),
    eventType: String(event.eventType || event.event_type || "event"),
    message: String(event.message || ""),
    pageStage: String(event.pageStage || event.page_stage || payload.stage || ""),
    pageUrlRedacted: redactStringForOutput(pageUrl).slice(0, 1000),
    payloadJson: safeJson(payload),
    createdAt: String(event.createdAt || now),
  };

  const result = db.prepare(`
    INSERT INTO run_events(
      run_id, worker_id, roxy_dir_id, account_email, account_identifier_type,
      account_identifier, step, level, event_type, message, page_stage,
      page_url_redacted, payload_json, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    info.runId,
    info.workerId,
    info.roxyDirId,
    info.accountEmail,
    info.accountIdentifierType,
    info.accountIdentifier,
    info.step,
    info.level,
    info.eventType,
    info.message,
    info.pageStage,
    info.pageUrlRedacted,
    info.payloadJson,
    info.createdAt,
  );

  return { id: Number(result.lastInsertRowid || 0), ...info, payload };
}

export function appendContextEvent(db, context = {}, event = {}) {
  return appendRunEvent(db, {
    runId: context.runId || "",
    workerId: context.workerId || "",
    roxyDirId: context.windowInfo?.dirId || "",
    accountEmail: context.account?.email || "",
    accountIdentifierType: context.accountIdentifierType || "",
    accountIdentifier: context.accountIdentifier || "",
    step: context.currentStep || event.step || "",
    ...event,
  });
}

export function listRunEvents(db, { runId = "", workerId = "", limit = 200, afterId = 0 } = {}) {
  const clauses = ["id > ?"];
  const params = [Math.max(0, Number.parseInt(String(afterId || 0), 10) || 0)];
  if (runId) {
    clauses.push("run_id = ?");
    params.push(String(runId));
  }
  if (workerId) {
    clauses.push("worker_id = ?");
    params.push(String(workerId));
  }
  params.push(Math.max(1, Math.min(1000, Number.parseInt(String(limit || 200), 10) || 200)));
  return db.prepare(`
    SELECT id, run_id AS runId, worker_id AS workerId, roxy_dir_id AS roxyDirId,
           account_email AS accountEmail, account_identifier_type AS accountIdentifierType,
           account_identifier AS accountIdentifier, step, level, event_type AS eventType,
           message, page_stage AS pageStage, page_url_redacted AS pageUrlRedacted,
           payload_json AS payloadJson, created_at AS createdAt
    FROM run_events
    WHERE ${clauses.join(" AND ")}
    ORDER BY id ASC
    LIMIT ?
  `).all(...params).map((row) => ({
    ...row,
    payload: (() => {
      try {
        return JSON.parse(row.payloadJson || "{}");
      } catch {
        return {};
      }
    })(),
  }));
}
