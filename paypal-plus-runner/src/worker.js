import { makeRunId } from "./utils/ids.js";
import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { leaseNextOutlookEmail, markOutlookFailure, markOutlookPlusDone, markOutlookRunning } from "./db/outlook-store.js";
import { leasePaypalPhone, releasePaypalPhone } from "./db/paypal-phone-store.js";
import { createRun, finishRun, updateRun } from "./db/run-history-store.js";
import { insertPlusAccount } from "./db/plus-store.js";
import { prepareRunContext, runWorkflow } from "./workflow.js";
import { connectOverCdp } from "./browser/connect-cdp.js";
import { WorkflowNotImplementedError } from "./utils/errors.js";
import { writeFailureArtifacts } from "./utils/artifacts.js";

export class Worker {
  constructor({ id, db = null, config, logger, dryRun = false, windowInfo = null }) {
    this.id = id;
    this.db = db || openDatabase(config.database.path);
    initSchema(this.db);
    this.ownsDb = !db;
    this.config = config;
    this.logger = logger;
    this.dryRun = dryRun;
    this.windowInfo = windowInfo;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  close() {
    if (this.ownsDb) this.db.close();
  }

  async maybeRotateWindowProxy() {
    const roxy = this.config.roxy || {};
    const info = this.windowInfo;
    if (!info?.client || !info?.dirId) return null;
    const every = Math.max(0, Number.parseInt(String(roxy.rotateProxyEveryAccounts || 0), 10));
    const rotatePerAccount = roxy.rotateProxyPerAccount === true;
    const shouldRotate = rotatePerAccount || (every > 0 && info.accountRuns > 0 && info.accountRuns % every === 0);
    if (!shouldRotate) return null;
    this.logger.info("rotating roxy proxy for window", {
      dirId: info.dirId,
      accountRuns: info.accountRuns,
      rotatePerAccount,
      every,
    });
    const result = await info.client.modifyWindowProxy(info.dirId, {
      reopen: roxy.reopenWindowOnProxyRotate !== false,
    });
    info.sid = result.sid || info.sid;
    info.asn = result.asn || info.asn;
    info.region = result.region || info.region;
    info.proxyUserName = result.proxyUserName || info.proxyUserName;
    if (result.rawOpen?.ws) {
      info.ws = result.rawOpen.ws;
      try {
        await info.browser?.close?.();
      } catch {
        // The old CDP connection is expected to disconnect when Roxy reopens.
      }
      const connected = await connectOverCdp(info.ws, {
        timeoutMs: Number(roxy.cdpConnectTimeoutMs || 45000),
      });
      info.browser = connected.browser;
      info.context = connected.context;
      info.page = connected.page;
    }
    return result;
  }

  async runOnce() {
    await this.maybeRotateWindowProxy();
    const account = leaseNextOutlookEmail(this.db, {
      maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
    });
    if (!account) return { status: "empty" };

    const runId = makeRunId(this.id);
    let phoneLease = null;
    let context = null;
    createRun(this.db, { runId, email: account.email, outlookEmailId: account.id, workerId: this.id });
    updateRun(this.db, runId, {
      status: "running",
      current_step: "lease-paypal-phone",
      roxy_dir_id: this.windowInfo?.dirId || "",
      roxy_exit_ip: this.windowInfo?.exitIp || "",
    });

    try {
      markOutlookRunning(this.db, account.id);
      phoneLease = leasePaypalPhone(this.db, {
        workerId: this.id,
        runId,
        leaseMinutes: Number(this.config.paypalPhone?.leaseMinutes || 30),
      });
      if (!phoneLease) {
        throw new Error("paypal_phone_pool has no available phone");
      }
      this.logger.info("leased run resources", {
        runId,
        email: account.email,
        phone: phoneLease.phone,
        paypalLocalPhone: phoneLease.paypal_local_phone,
      });

      context = await prepareRunContext({
        account,
        phoneLease,
        config: this.config,
        windowInfo: this.windowInfo,
        runId,
        workerId: this.id,
      });
      updateRun(this.db, runId, { current_step: "workflow" });
      const result = await runWorkflow(context, { dryRun: this.dryRun, logger: this.logger });

      if (this.dryRun) {
        releasePaypalPhone(this.db, phoneLease.id, { runId, success: false, error: "dry_run_release" });
        markOutlookFailure(this.db, account.id, {
          retryable: true,
          error: "dry_run_release",
          maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
        });
        finishRun(this.db, runId, { status: "skipped", error: "dry_run" });
        return { status: "skipped", runId, result };
      }

      insertPlusAccount(this.db, account, result, this.config);
      markOutlookPlusDone(this.db, account.id);
      releasePaypalPhone(this.db, phoneLease.id, { runId, success: true });
      finishRun(this.db, runId, { status: "done" });
      if (this.windowInfo) this.windowInfo.accountRuns += 1;
      return { status: "done", runId, result };
    } catch (error) {
      const retryable = error instanceof WorkflowNotImplementedError ? true : true;
      try {
        const artifactContext = context || {
          runId,
          workerId: this.id,
          account,
          phoneLease,
          windowInfo: this.windowInfo,
          page: this.windowInfo?.page || null,
          config: this.config,
          currentStep: error.step || "unknown",
        };
        const artifact = await writeFailureArtifacts(artifactContext, error, { logger: this.logger });
        if (artifact?.dir) {
          updateRun(this.db, runId, { artifact_dir: artifact.dir });
        }
      } catch (artifactError) {
        this.logger.warn("failure artifact capture failed", { runId, error: artifactError.message });
      }
      if (phoneLease) {
        releasePaypalPhone(this.db, phoneLease.id, { runId, success: false, error: error.message });
      }
      markOutlookFailure(this.db, account.id, {
        retryable,
        error: error.message,
        maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
      });
      finishRun(this.db, runId, { status: "failed", error: error.message });
      throw error;
    }
  }

  async runLoop({ limit = 0 } = {}) {
    const results = [];
    try {
      while (!this.stopped) {
        if (limit > 0 && results.length >= limit) break;
        const result = await this.runOnce();
        if (result.status === "empty") break;
        results.push(result);
        if (this.dryRun) break;
      }
      return results;
    } finally {
      this.close();
    }
  }
}
