import { makeRunId } from "./utils/ids.js";
import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { leaseNextOutlookEmail, markOutlookFailure, markOutlookPlusDone, markOutlookRunning } from "./db/outlook-store.js";
import { leasePaypalPhone, releasePaypalPhone } from "./db/paypal-phone-store.js";
import { createRun, finishRun, updateRun } from "./db/run-history-store.js";
import { insertPlusAccount } from "./db/plus-store.js";
import { prepareRunContext, runWorkflow } from "./workflow.js";
import { connectOverCdp } from "./browser/connect-cdp.js";
import { cleanupBrowserData } from "./browser/cleanup.js";
import { WorkflowNotImplementedError } from "./utils/errors.js";
import { writeFailureArtifacts } from "./utils/artifacts.js";

function isRiskError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.name,
  ].filter(Boolean).join(" ");
  return /PAYPAL_RISK_BLOCKED|DataDome|risk\/DataDome|risk block|paypal_datadome/i.test(text);
}

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

  async maybeRotateWindowProxy({ force = false, reason = "" } = {}) {
    const roxy = this.config.roxy || {};
    const info = this.windowInfo;
    if (!info?.client || !info?.dirId) return null;
    const every = Math.max(0, Number.parseInt(String(roxy.rotateProxyEveryAccounts || 0), 10));
    const rotatePerAccount = roxy.rotateProxyPerAccount === true;
    const shouldRotate = force || rotatePerAccount || (every > 0 && info.accountRuns > 0 && info.accountRuns % every === 0);
    if (!shouldRotate) return null;
    this.logger.info("rotating roxy proxy for window", {
      dirId: info.dirId,
      accountRuns: info.accountRuns,
      rotatePerAccount,
      every,
      force,
      reason,
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
    try {
      const { RoxyClient } = await import("./roxy/client.js");
      info.localProxyUrl = await RoxyClient.buildLocalWindowProxyUrlWithRetry(info.dirId, {
        attempts: Number(roxy.localProxyResolveAttempts || 10),
        delayMs: Number(roxy.localProxyResolveDelayMs || 750),
      });
    } catch (error) {
      this.logger.warn("local roxy proxy resolve after rotation failed", {
        dirId: info.dirId,
        error: error.message,
      });
    }
    return result;
  }

  async maybeRotateWindowProxyAfterFailure(error) {
    const roxy = this.config.roxy || {};
    const risk = isRiskError(error);
    const shouldRotate = (risk && roxy.rotateProxyOnRiskErrors !== false)
      || (!risk && roxy.rotateProxyOnFailure === true);
    if (!shouldRotate) return null;
    try {
      return await this.maybeRotateWindowProxy({
        force: true,
        reason: risk ? "risk_error" : "account_failure",
      });
    } catch (rotateError) {
      this.logger.warn("roxy proxy rotation after failure failed", {
        dirId: this.windowInfo?.dirId || "",
        risk,
        error: rotateError.message,
      });
      return null;
    }
  }

  async runOnce() {
    await this.maybeRotateWindowProxy();
    if (this.config.runner?.cleanupBrowserDataBeforeEachAccount !== false && this.windowInfo?.context && this.windowInfo?.page) {
      await cleanupBrowserData(this.windowInfo.context, {
        page: this.windowInfo.page,
        logger: this.logger,
      });
    }
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
      const retryable = error instanceof WorkflowNotImplementedError ? true : error.retryable !== false;
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
      if (this.windowInfo) this.windowInfo.accountRuns += 1;
      await this.maybeRotateWindowProxyAfterFailure(error);
      error.runId = error.runId || runId;
      error.email = error.email || account.email;
      error.retryable = retryable;
      throw error;
    }
  }

  async runLoop({ limit = 0 } = {}) {
    const results = [];
    try {
      while (!this.stopped) {
        if (limit > 0 && results.length >= limit) break;
        let result;
        try {
          result = await this.runOnce();
        } catch (error) {
          if (!error.runId) throw error;
          result = {
            status: "failed",
            runId: error.runId || "",
            email: error.email || "",
            retryable: error.retryable !== false,
            error: error.message,
          };
          if (this.config.runner?.continueOnAccountFailure === false) {
            results.push(result);
            throw error;
          }
        }
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
