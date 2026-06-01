import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../db/connection.js";
import { initSchema } from "../db/schema.js";
import { getDatabaseStats } from "../db/stats.js";
import { listRunEvents } from "../db/run-event-store.js";
import { listCheckoutLinks } from "../db/checkout-link-store.js";
import { redactForCliOutput, redactStringForOutput } from "../utils/safe-output.js";
import { UiJobManager } from "./job-manager.js";

const UI_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

function sendJson(res, value, status = 200) {
  const body = `${JSON.stringify(redactForCliOutput(value), null, 2)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function notFound(res) {
  sendJson(res, { ok: false, error: "not_found" }, 404);
}

function openUiDb(config) {
  const db = openDatabase(config.database.path);
  initSchema(db);
  return db;
}

function parseBoolean(value = "") {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").trim().toLowerCase());
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function queryRuns(db, { status = "", limit = 100, activeOnly = false, activeWithinMinutes = 30 } = {}) {
  const params = [];
  const clauses = [];
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (activeOnly) {
    const minutes = Math.max(1, Number.parseInt(String(activeWithinMinutes || 30), 10) || 30);
    clauses.push("updated_at >= ?");
    params.push(new Date(Date.now() - minutes * 60 * 1000).toISOString());
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.max(1, Math.min(500, Number.parseInt(String(limit || 100), 10) || 100)));
  return db.prepare(`
    SELECT run_id AS runId, email, worker_id AS workerId, status, current_step AS currentStep,
           roxy_dir_id AS roxyDirId, roxy_exit_ip AS roxyExitIp,
           account_identifier_type AS accountIdentifierType,
           account_identifier AS accountIdentifier,
           gpt_phone_account_id AS gptPhoneAccountId,
           openai_phone_activation_id AS openAiPhoneActivationId,
           paypal_phone_id AS paypalPhoneId,
           account_lifecycle_status AS accountLifecycleStatus,
           cpa_upload_status AS cpaUploadStatus,
           callback_json_path AS callbackJsonPath,
           artifact_dir AS artifactDir, error, started_at AS startedAt,
           finished_at AS finishedAt, updated_at AS updatedAt
    FROM run_history
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(...params);
}

function queryRun(db, runId) {
  return db.prepare(`
    SELECT run_id AS runId, email, worker_id AS workerId, status, current_step AS currentStep,
           roxy_dir_id AS roxyDirId, roxy_exit_ip AS roxyExitIp,
           account_identifier_type AS accountIdentifierType,
           account_identifier AS accountIdentifier,
           gpt_phone_account_id AS gptPhoneAccountId,
           openai_phone_activation_id AS openAiPhoneActivationId,
           paypal_phone_id AS paypalPhoneId,
           account_lifecycle_status AS accountLifecycleStatus,
           cpa_upload_status AS cpaUploadStatus,
           callback_json_path AS callbackJsonPath,
           artifact_dir AS artifactDir, error, started_at AS startedAt,
           finished_at AS finishedAt, updated_at AS updatedAt
    FROM run_history
    WHERE run_id = ?
  `).get(runId);
}

function queryResource(db, table) {
  const allowed = {
    outlook: "SELECT status, COUNT(1) AS count FROM outlook_emails GROUP BY status ORDER BY status",
    "gpt-phone-accounts": "SELECT lifecycle_status AS status, COUNT(1) AS count FROM gpt_phone_accounts GROUP BY lifecycle_status ORDER BY lifecycle_status",
    "paypal-phones": "SELECT status, COUNT(1) AS count FROM paypal_phone_pool GROUP BY status ORDER BY status",
    "openai-phones": "SELECT status, COUNT(1) AS count FROM openai_phone_activations GROUP BY status ORDER BY status",
  };
  if (!allowed[table]) return null;
  return db.prepare(allowed[table]).all();
}

function maskPhoneNumber(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const digits = text.replace(/\D+/g, "");
  if (digits.length <= 6) return text ? "[REDACTED_PHONE]" : "";
  const prefix = text.startsWith("+") ? "+" : "";
  return `${prefix}${digits.slice(0, 2)}***${digits.slice(-4)}`;
}

function maskPlusAccount(row = {}) {
  return {
    ...row,
    signupPhoneNumber: maskPhoneNumber(row.signupPhoneNumber),
  };
}

function maskCheckoutLink(row = {}) {
  return {
    ...row,
    signupPhoneNumber: maskPhoneNumber(row.signupPhoneNumber),
    linkPreview: redactStringForOutput(row.checkoutLongUrl || ""),
  };
}

function queryPlusAccounts(db, { stage = "", limit = 200 } = {}) {
  const normalizedStage = String(stage || "").trim().toLowerCase();
  const clauses = [];
  const params = [];
  if (normalizedStage === "pay-link") {
    clauses.push("g.lifecycle_status = 'registered'");
    clauses.push("EXISTS (SELECT 1 FROM checkout_links cl WHERE cl.gpt_phone_account_id = g.id AND cl.status = 'ready')");
  } else if (normalizedStage === "cpa-upload") {
    clauses.push("g.lifecycle_status IN ('plus_done', 'email_bound')");
  } else if (normalizedStage === "register-link") {
    clauses.push("g.lifecycle_status = 'registered'");
    clauses.push("NOT EXISTS (SELECT 1 FROM checkout_links cl WHERE cl.gpt_phone_account_id = g.id AND cl.status IN ('ready', 'paying', 'paid'))");
  }
  params.push(Math.max(1, Math.min(500, Number.parseInt(String(limit || 200), 10) || 200)));
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`
    SELECT g.id,
           g.signup_phone_number AS signupPhoneNumber,
           g.lifecycle_status AS lifecycleStatus,
           g.lease_status AS leaseStatus,
           g.bound_email AS boundEmail,
           g.cpa_upload_status AS cpaUploadStatus,
           g.current_run_id AS currentRunId,
           g.last_failed_step AS lastFailedStep,
           g.last_error AS lastError,
           g.updated_at AS updatedAt,
           (
             SELECT COUNT(1)
             FROM checkout_links cl
             WHERE cl.gpt_phone_account_id = g.id
           ) AS checkoutLinkCount,
           (
             SELECT cl.status
             FROM checkout_links cl
             WHERE cl.gpt_phone_account_id = g.id
             ORDER BY cl.id DESC
             LIMIT 1
           ) AS latestCheckoutLinkStatus
    FROM gpt_phone_accounts g
    ${where}
    ORDER BY g.id DESC
    LIMIT ?
  `).all(...params).map(maskPlusAccount);
}

async function sendStatic(req, res) {
  const parsed = new URL(req.url, "http://127.0.0.1");
  const pathname = parsed.pathname === "/" ? "/index.html" : parsed.pathname;
  const filePath = path.join(UI_ROOT, pathname.replace(/^\/+/, ""));
  if (!filePath.startsWith(UI_ROOT)) return notFound(res);
  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    notFound(res);
  }
}

export function createUiServer(config, { jobManager = null } = {}) {
  const tasks = jobManager || new UiJobManager({ config });
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, "http://127.0.0.1");
    if (parsed.pathname.startsWith("/api/")) {
      const db = openUiDb(config);
      try {
        if (parsed.pathname === "/api/plus/accounts") {
          return sendJson(res, {
            ok: true,
            accounts: queryPlusAccounts(db, {
              stage: parsed.searchParams.get("stage") || "",
              limit: parsed.searchParams.get("limit") || 200,
            }),
          });
        }
        if (parsed.pathname === "/api/plus/checkout-links") {
          return sendJson(res, {
            ok: true,
            links: listCheckoutLinks(db, {
              status: parsed.searchParams.get("status") || "",
              limit: parsed.searchParams.get("limit") || 100,
            }).map(maskCheckoutLink),
          });
        }
        if (parsed.pathname === "/api/plus/tasks") {
          if (req.method === "POST") {
            const body = await readJsonBody(req);
            const forceNewPhone = parseBoolean(body.forceNewPhone);
            const task = tasks.start({
              mode: body.mode || body.process || "full",
              ids: forceNewPhone ? [] : body.ids || [],
              limit: body.limit || 1,
              windows: body.windows || 1,
              forceNewPhone,
              headless: body.headless === undefined ? config.roxy?.headless !== false : parseBoolean(body.headless),
            });
            return sendJson(res, { ok: true, task }, 201);
          }
          return sendJson(res, { ok: true, tasks: tasks.list() });
        }
        const plusTaskMatch = parsed.pathname.match(/^\/api\/plus\/tasks\/([^/]+)(?:\/(stop))?$/);
        if (plusTaskMatch) {
          const taskId = decodeURIComponent(plusTaskMatch[1]);
          const action = plusTaskMatch[2] || "";
          if (action === "stop") {
            const task = tasks.stop(taskId);
            if (!task) return notFound(res);
            return sendJson(res, { ok: true, task });
          }
          const task = tasks.get(taskId);
          if (!task) return notFound(res);
          return sendJson(res, { ok: true, task });
        }
        if (parsed.pathname === "/api/summary") {
          return sendJson(res, { ok: true, ...getDatabaseStats(db) });
        }
        if (parsed.pathname === "/api/windows") {
          const rows = db.prepare(`
            SELECT worker_id AS workerId, roxy_dir_id AS roxyDirId, roxy_exit_ip AS roxyExitIp,
                   status, current_step AS currentStep, email, updated_at AS updatedAt
            FROM run_history
            WHERE roxy_dir_id <> ''
            ORDER BY id DESC
            LIMIT 100
          `).all();
          return sendJson(res, { ok: true, windows: rows });
        }
        if (parsed.pathname === "/api/runs") {
          return sendJson(res, {
            ok: true,
            runs: queryRuns(db, {
              status: parsed.searchParams.get("status") || "",
              limit: parsed.searchParams.get("limit") || 100,
              activeOnly: parseBoolean(parsed.searchParams.get("activeOnly") || ""),
              activeWithinMinutes: parsed.searchParams.get("activeWithinMinutes")
                || config.ui?.activeRunMinutes
                || 30,
            }),
          });
        }
        const runMatch = parsed.pathname.match(/^\/api\/runs\/([^/]+)(?:\/(events|artifacts))?$/);
        if (runMatch) {
          const runId = decodeURIComponent(runMatch[1]);
          const suffix = runMatch[2] || "";
          if (suffix === "events") {
            return sendJson(res, {
              ok: true,
              events: listRunEvents(db, {
                runId,
                afterId: parsed.searchParams.get("afterId") || 0,
                limit: parsed.searchParams.get("limit") || 300,
              }),
            });
          }
          const run = queryRun(db, runId);
          if (!run) return notFound(res);
          if (suffix === "artifacts") {
            return sendJson(res, { ok: true, runId, artifactDir: run.artifactDir || "" });
          }
          return sendJson(res, { ok: true, run });
        }
        const resourceMatch = parsed.pathname.match(/^\/api\/resources\/([^/]+)$/);
        if (resourceMatch) {
          const rows = queryResource(db, resourceMatch[1]);
          if (!rows) return notFound(res);
          return sendJson(res, { ok: true, resource: resourceMatch[1], rows });
        }
        if (parsed.pathname === "/api/events/stream") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-store",
            Connection: "keep-alive",
          });
          let lastId = Number(parsed.searchParams.get("afterId") || 0);
          const timer = setInterval(() => {
            try {
              const rows = listRunEvents(db, { afterId: lastId, limit: 100 });
              for (const row of rows) {
                lastId = Math.max(lastId, row.id);
                res.write(`id: ${row.id}\n`);
                res.write(`event: run_event\n`);
                res.write(`data: ${JSON.stringify(redactForCliOutput(row))}\n\n`);
              }
            } catch (error) {
              res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
            }
          }, 1500);
          req.on("close", () => {
            clearInterval(timer);
            db.close();
          });
          return undefined;
        }
        return notFound(res);
      } catch (error) {
        return sendJson(res, { ok: false, error: error.message }, 500);
      } finally {
        if (parsed.pathname !== "/api/events/stream") db.close();
      }
    }
    return sendStatic(req, res);
  });
}

export async function startUiServer(config, { logger = console } = {}) {
  const server = createUiServer(config);
  const host = String(config.ui?.host || "127.0.0.1");
  const port = Number(config.ui?.port || 8787);
  await new Promise((resolve) => server.listen(port, host, resolve));
  logger.info?.("ui server started", { url: `http://${host}:${port}` });
  return server;
}
