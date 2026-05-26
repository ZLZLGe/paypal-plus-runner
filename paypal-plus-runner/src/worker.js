import { makeRunId } from "./utils/ids.js";
import { leaseNextOutlookEmail, markOutlookFailure, markOutlookPlusDone, markOutlookRunning } from "./db/outlook-store.js";
import { leasePaypalPhone, releasePaypalPhone } from "./db/paypal-phone-store.js";
import { createRun, finishRun, updateRun } from "./db/run-history-store.js";
import { insertPlusAccount } from "./db/plus-store.js";
import { prepareRunContext, runWorkflow, WorkflowNotImplementedError } from "./workflow.js";

export class Worker {
  constructor({ id, db, config, logger, dryRun = false }) {
    this.id = id;
    this.db = db;
    this.config = config;
    this.logger = logger;
    this.dryRun = dryRun;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async runOnce() {
    const account = leaseNextOutlookEmail(this.db, {
      maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
    });
    if (!account) return { status: "empty" };

    const runId = makeRunId(this.id);
    let phoneLease = null;
    createRun(this.db, { runId, email: account.email, outlookEmailId: account.id, workerId: this.id });
    updateRun(this.db, runId, { status: "running", current_step: "lease-paypal-phone" });

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

      const context = await prepareRunContext({ account, phoneLease, config: this.config });
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
      return { status: "done", runId, result };
    } catch (error) {
      const retryable = error instanceof WorkflowNotImplementedError ? true : true;
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
    while (!this.stopped) {
      if (limit > 0 && results.length >= limit) break;
      const result = await this.runOnce();
      if (result.status === "empty") break;
      results.push(result);
      if (this.dryRun) break;
    }
    return results;
  }
}
