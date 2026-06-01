import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAYPAL_PLUS_PROCESS, normalizePaypalPlusProcess } from "../plus/process.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_PATH = path.join(PROJECT_ROOT, "src", "cli.js");

function makeTaskId() {
  return `task_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
}

function keepRecent(lines = [], chunk = "") {
  const next = [...lines, ...String(chunk || "").split(/\r?\n/).filter(Boolean)];
  return next.slice(-200);
}

function extractRunIds(lines = []) {
  const ids = new Set();
  const text = lines.join("\n");
  for (const match of text.matchAll(/"runId"\s*:\s*"([^"]+)"/g)) {
    if (match[1]) ids.add(match[1]);
  }
  return [...ids];
}

export class UiJobManager {
  constructor({ config = {}, cwd = PROJECT_ROOT, spawnFn = spawn } = {}) {
    this.config = config;
    this.cwd = cwd;
    this.spawnFn = spawnFn;
    this.tasks = new Map();
  }

  start({ mode = "full", limit = 1, windows = 1, ids = [], forceNewPhone = false, headless = true } = {}) {
    const resolvedMode = normalizePaypalPlusProcess(mode);
    const taskId = makeTaskId();
    const args = [CLI_PATH, "plus", "--mode", resolvedMode];
    const configPath = String(this.config.__configPath || "").trim();
    if (configPath) args.push("--config", configPath);
    if (this.config.database?.path) args.push("--db", String(this.config.database.path));
    const resolvedHeadless = headless !== false;
    args.push(resolvedHeadless ? "--headless" : "--headed");
    if (Number(limit) > 0) args.push("--limit", String(Math.max(1, Number.parseInt(String(limit), 10) || 1)));
    if (Number(windows) > 0) args.push("--windows", String(Math.max(1, Number.parseInt(String(windows), 10) || 1)));
    const shouldForceNewPhone = resolvedMode === PAYPAL_PLUS_PROCESS.REGISTER_LINK && forceNewPhone === true;
    if (shouldForceNewPhone) args.push("--new-phone");
    const rawIds = shouldForceNewPhone ? [] : (Array.isArray(ids) ? ids : [ids]);
    const normalizedIds = rawIds
      .map((value) => Number.parseInt(String(value || ""), 10))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (normalizedIds.length) {
      if (resolvedMode === PAYPAL_PLUS_PROCESS.PAY_LINK) {
        args.push("--checkout-link-ids", normalizedIds.join(","));
      } else {
        args.push("--gpt-phone-account-ids", normalizedIds.join(","));
      }
    }

    const task = {
      taskId,
      mode: resolvedMode,
      forceNewPhone: shouldForceNewPhone,
      headless: resolvedHeadless,
      status: "running",
      pid: 0,
      command: [process.execPath, ...args].join(" "),
      startedAt: new Date().toISOString(),
      finishedAt: "",
      exitCode: null,
      signal: "",
      error: "",
      runIds: [],
      output: [],
    };
    const child = this.spawnFn(process.execPath, args, {
      cwd: this.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    task.pid = child.pid || 0;
    task.child = child;
    this.tasks.set(taskId, task);

    child.stdout.on("data", (chunk) => {
      task.output = keepRecent(task.output, chunk.toString("utf8"));
      task.runIds = extractRunIds(task.output);
    });
    child.stderr.on("data", (chunk) => {
      task.output = keepRecent(task.output, chunk.toString("utf8"));
      task.runIds = extractRunIds(task.output);
    });
    child.on("error", (error) => {
      task.status = "failed";
      task.error = error.message;
      task.finishedAt = new Date().toISOString();
    });
    child.on("exit", (code, signal) => {
      task.exitCode = code;
      task.signal = signal || "";
      task.finishedAt = new Date().toISOString();
      task.runIds = extractRunIds(task.output);
      if (task.status === "stopping") {
        task.status = "stopped";
      } else {
        task.status = code === 0 ? "done" : "failed";
      }
      delete task.child;
    });
    return this.view(task);
  }

  stop(taskId) {
    const task = this.tasks.get(String(taskId || ""));
    if (!task) return null;
    if (task.child && task.status === "running") {
      task.status = "stopping";
      task.child.kill("SIGTERM");
    }
    return this.view(task);
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .map((task) => this.view(task));
  }

  get(taskId) {
    const task = this.tasks.get(String(taskId || ""));
    return task ? this.view(task) : null;
  }

  view(task) {
    const { child, ...safe } = task;
    return safe;
  }
}
