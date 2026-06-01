import { makeRunId } from "./utils/ids.js";
import { openDatabase } from "./db/connection.js";
import { initSchema } from "./db/schema.js";
import { leaseNextOutlookEmail, markOutlookBound, markOutlookFailure, markOutlookRunning, releaseOutlookEmail } from "./db/outlook-store.js";
import { leasePaypalPhone, releasePaypalPhone } from "./db/paypal-phone-store.js";
import { createRun, finishRun, updateRun } from "./db/run-history-store.js";
import { appendRunEvent } from "./db/run-event-store.js";
import { insertPlusAccount } from "./db/plus-store.js";
import {
  GPT_PHONE_LIFECYCLE,
  getActiveOpenAiPhoneActivationForAccount,
  gptPhoneAccountToWorkflowAccount,
  leaseGptPhoneAccountForCpaUpload,
  leaseGptPhoneAccountForRegisterLink,
  leaseReusableGptPhoneAccount,
  markGptAccountCpaDone,
  markGptAccountEmailBound,
  markGptAccountFailure,
  markGptAccountHoldNoSmsAccess,
  releaseGptPhoneAccount,
} from "./db/gpt-phone-account-store.js";
import { prepareRunContext, releaseDeferredOutlookOnFailure, runWorkflow } from "./workflow.js";
import { connectOverCdp } from "./browser/connect-cdp.js";
import { cleanupBrowserData } from "./browser/cleanup.js";
import { WorkflowNotImplementedError } from "./utils/errors.js";
import { writeFailureArtifacts } from "./utils/artifacts.js";
import { cancelOpenAiPhoneActivation, finishOpenAiPhoneActivation } from "./providers/openai-phone.js";
import { openManagedRoxyWindow } from "./roxy/window-pool.js";
import { RoxyClient, extractRoxyWebSocketUrl } from "./roxy/client.js";
import { leaseReadyCheckoutLink, markCheckoutLinkFailed } from "./db/checkout-link-store.js";
import { PAYPAL_PLUS_PROCESS, paypalPlusProcessFromConfig } from "./plus/process.js";

function isRiskError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.name,
  ].filter(Boolean).join(" ");
  return /PAYPAL_RISK_BLOCKED|DataDome|risk\/DataDome|risk block|paypal_datadome/i.test(text);
}

function isPaypalPhoneRejectedError(error) {
  const text = [
    error?.code,
    error?.message,
    error?.name,
  ].filter(Boolean).join(" ");
  return /PAYPAL_PHONE_REJECTED|try a different phone number|try another mobile number|別の電話番号をお試しください|其他电话号码|另一个电话号码/i.test(text);
}

function shouldPreserveBrowserWindow(error) {
  return error?.preserveBrowserWindow === true;
}

function isMissingReusablePhoneOtpError(error) {
  return /no active OpenAI phone activation|OpenAI phone activation smsUrl is empty|OAuth 手机登录缺少注册阶段手机号激活|手机号 OTP|phone code timeout/i
    .test(String(error?.message || error || ""));
}

function isSmsOauthFlow(config = {}) {
  return String(config.flow?.plusAccountAccessStrategy || "").trim().toLowerCase() === "sms_oauth";
}

function checkoutLinkFromRow(row = {}) {
  if (!row) return null;
  return {
    id: row.id,
    gptPhoneAccountId: row.gpt_phone_account_id,
    runId: row.run_id,
    checkoutLongUrl: row.checkout_long_url,
    status: row.status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
  };
}

function startRunHeartbeat(db, runId, {
  config = {},
  logger = null,
  getContext = () => null,
} = {}) {
  const configured = config.runner?.runHeartbeatMs;
  const intervalMs = configured === undefined
    ? 15000
    : Math.max(0, Number.parseInt(String(configured), 10) || 0);
  if (!db || !runId || intervalMs <= 0) return null;
  const timer = setInterval(() => {
    try {
      const context = getContext() || {};
      updateRun(db, runId, {
        status: "running",
        current_step: context.currentStep || "workflow",
        account_lifecycle_status: context.gptPhoneLifecycleStatus || "",
      });
    } catch (error) {
      logger?.warn?.("run heartbeat update failed", {
        runId,
        error: error.message,
      });
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function emptyAccount() {
  return {
    id: null,
    email: "",
    password: "",
    client_id: "",
    refresh_token: "",
  };
}

async function refreshLocalProxyUrl(windowInfo, config, logger) {
  const roxy = config.roxy || {};
  if (!windowInfo?.dirId) return "";
  try {
    windowInfo.localProxyUrl = await RoxyClient.buildLocalWindowProxyUrlWithRetry(windowInfo.dirId, {
      attempts: Number(roxy.localProxyResolveAttempts || 10),
      delayMs: Number(roxy.localProxyResolveDelayMs || 750),
    });
  } catch (error) {
    logger?.warn?.("local roxy proxy resolve after reconnect failed", {
      dirId: windowInfo.dirId,
      error: error.message,
    });
  }
  return windowInfo.localProxyUrl || "";
}

export async function reconnectRoxyWindowCdp(windowInfo, config, ws, {
  logger = null,
  reason = "",
  connect = connectOverCdp,
} = {}) {
  const roxy = config.roxy || {};
  const resolvedWs = String(ws || "").trim();
  if (!windowInfo?.dirId) throw new Error("cannot reconnect roxy window without dirId");
  if (!resolvedWs) throw new Error(`Roxy reopen missing ws for dirId=${windowInfo.dirId}`);
  try {
    await windowInfo.browser?.close?.();
  } catch {
    // The stale CDP connection is often already closed after a Roxy reopen.
  }
  const connected = await connect(resolvedWs, {
    timeoutMs: Number(roxy.cdpConnectTimeoutMs || 45000),
  });
  windowInfo.ws = resolvedWs;
  windowInfo.browser = connected.browser;
  windowInfo.context = connected.context;
  windowInfo.page = connected.page;
  await refreshLocalProxyUrl(windowInfo, config, logger);
  logger?.warn?.("roxy window CDP reconnected", {
    dirId: windowInfo.dirId,
    reason,
  });
  return windowInfo;
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

  buildReplacementWindowName(reason = "") {
    const prefix = String(this.config.roxy?.windowNamePrefix || "paypal-plus").trim() || "paypal-plus";
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
    const suffix = String(reason || "replace").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 32) || "replace";
    return `${prefix}-${this.id}-${suffix}-${stamp}`;
  }

  async replaceWindowForRiskRetry({ reason = "paypal_risk_retry" } = {}) {
    const current = this.windowInfo;
    const client = current?.client;
    if (!client) {
      throw new Error("cannot replace roxy window without roxy client");
    }
    const name = this.buildReplacementWindowName(reason);
    this.logger.warn("creating fresh roxy window for paypal risk retry", {
      oldDirId: current?.dirId || "",
      name,
      reason,
    });
    const next = await openManagedRoxyWindow(this.config, {
      client,
      name,
      logger: this.logger,
    });
    next.client = client;
    try {
      await current?.browser?.close?.();
    } catch {
      // Old CDP connection may already be closed.
    }
    try {
      await client.closeWindow(current.dirId);
    } catch (error) {
      this.logger.warn("old roxy window close after replacement failed", {
        oldDirId: current?.dirId || "",
        error: error.message,
      });
    }
    Object.keys(current || {}).forEach((key) => delete current[key]);
    Object.assign(current, next);
    this.logger.warn("fresh roxy window ready for paypal risk retry", {
      dirId: current.dirId,
      asn: current.asn || "",
      region: current.region || "",
      exitIp: current.exitIp || "",
      exitCountry: current.exitProbe?.countryCode || "",
    });
    return current;
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
    if (roxy.reopenWindowOnProxyRotate !== false) {
      let ws = extractRoxyWebSocketUrl(result) || extractRoxyWebSocketUrl(result.rawOpen);
      if (!ws) {
        const reopened = await info.client.openWindow(info.dirId);
        result.rawOpen = reopened;
        result.ws = extractRoxyWebSocketUrl(reopened);
        ws = result.ws;
      }
      await reconnectRoxyWindowCdp(info, this.config, ws, {
        logger: this.logger,
        reason: reason || "proxy_rotation",
      });
    } else {
      await refreshLocalProxyUrl(info, this.config, this.logger);
    }
    return result;
  }

  async recoverClosedRoxyWindow({ reason = "closed_page_retry" } = {}) {
    const info = this.windowInfo;
    if (!info?.client || !info?.dirId) {
      throw new Error("cannot recover closed roxy window without roxy client and dirId");
    }
    this.logger.warn("recovering closed roxy window", {
      dirId: info.dirId,
      reason,
    });
    const reopened = await info.client.reopenWindow(info.dirId);
    const ws = extractRoxyWebSocketUrl(reopened);
    await reconnectRoxyWindowCdp(info, this.config, ws, {
      logger: this.logger,
      reason,
    });
    this.logger.warn("closed roxy window recovered", {
      dirId: info.dirId,
      reason,
    });
    return info;
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
    const runId = makeRunId(this.id);
    const deferOutlookLease = isSmsOauthFlow(this.config);
    const paypalPlusProcess = paypalPlusProcessFromConfig(this.config);
    const selectedGptAccountIds = this.config.flow?.gptPhoneAccountIds || [];
    const forceNewGptPhoneAccount = this.config.flow?.forceNewGptPhoneAccount === true;
    let gptPhoneAccount = null;
    let checkoutLink = null;
    let account = null;
    if (deferOutlookLease) {
      if (paypalPlusProcess === PAYPAL_PLUS_PROCESS.REGISTER_LINK) {
        if (forceNewGptPhoneAccount && selectedGptAccountIds.length) {
          this.logger.warn("ignoring selected gpt phone accounts because --new-phone was requested", {
            selectedGptAccountIds,
          });
        }
        if (!forceNewGptPhoneAccount) {
          gptPhoneAccount = leaseGptPhoneAccountForRegisterLink(this.db, {
            workerId: this.id,
            runId,
            leaseMinutes: Number(this.config.runner?.gptAccountLeaseMinutes || 120),
            ids: selectedGptAccountIds,
          });
          if (!gptPhoneAccount && selectedGptAccountIds.length) return { status: "empty" };
        }
      } else if (paypalPlusProcess === PAYPAL_PLUS_PROCESS.PAY_LINK) {
        const leased = leaseReadyCheckoutLink(this.db, {
          workerId: this.id,
          runId,
          ids: this.config.flow?.checkoutLinkIds || [],
          leaseMinutes: Number(this.config.runner?.gptAccountLeaseMinutes || 120),
        });
        if (!leased) return { status: "empty" };
        gptPhoneAccount = leased.account;
        checkoutLink = checkoutLinkFromRow(leased.link);
      } else if (paypalPlusProcess === PAYPAL_PLUS_PROCESS.CPA_UPLOAD) {
        gptPhoneAccount = leaseGptPhoneAccountForCpaUpload(this.db, {
          workerId: this.id,
          runId,
          leaseMinutes: Number(this.config.runner?.gptAccountLeaseMinutes || 120),
          ids: selectedGptAccountIds,
        });
        if (!gptPhoneAccount) return { status: "empty" };
      } else {
        gptPhoneAccount = leaseReusableGptPhoneAccount(this.db, {
          workerId: this.id,
          runId,
          leaseMinutes: Number(this.config.runner?.gptAccountLeaseMinutes || 120),
          ids: selectedGptAccountIds,
        });
        if (!gptPhoneAccount && selectedGptAccountIds.length) return { status: "empty" };
      }
      account = gptPhoneAccount ? gptPhoneAccountToWorkflowAccount(gptPhoneAccount) : emptyAccount();
      if (gptPhoneAccount) {
        const activation = getActiveOpenAiPhoneActivationForAccount(this.db, gptPhoneAccount.id);
        account.signupPhoneActivation = activation || {
          provider: "stored",
          phoneNumber: gptPhoneAccount.signup_phone_number,
          gptPhoneAccountId: gptPhoneAccount.id,
        };
      }
    } else {
      account = leaseNextOutlookEmail(this.db, {
        maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
        workerId: this.id,
        runId,
        leaseMinutes: Number(this.config.runner?.outlookLeaseMinutes || 30),
      });
      if (!account) return { status: "empty" };
    }

    let phoneLease = null;
    let context = null;
    let heartbeatTimer = null;
    createRun(this.db, { runId, email: account.email, outlookEmailId: account.id || null, workerId: this.id });
    updateRun(this.db, runId, {
      status: "running",
      current_step: "lease-paypal-phone",
      roxy_dir_id: this.windowInfo?.dirId || "",
      roxy_exit_ip: this.windowInfo?.exitIp || "",
      gpt_phone_account_id: gptPhoneAccount?.id || null,
      openai_phone_activation_id: account.signupPhoneActivation?.dbActivationId || null,
      account_lifecycle_status: gptPhoneAccount?.lifecycle_status || "",
    });

    try {
      if (account.id) markOutlookRunning(this.db, account.id);
      if (!deferOutlookLease) {
        phoneLease = leasePaypalPhone(this.db, {
          workerId: this.id,
          runId,
          leaseMinutes: Number(this.config.paypalPhone?.leaseMinutes || 30),
          countryCodes: this.config.paypalPhone?.countryCodes || ["JP"],
        });
        if (!phoneLease) {
          throw new Error(`paypal_phone_pool has no available phone for countries: ${(this.config.paypalPhone?.countryCodes || ["JP"]).join(",")}`);
        }
        updateRun(this.db, runId, { paypal_phone_id: phoneLease.id });
      }
      this.logger.info("leased run resources", {
        runId,
        email: account.email || "",
        outlookLeaseDeferred: deferOutlookLease,
        gptPhoneAccountId: gptPhoneAccount?.id || null,
        gptPhoneLifecycleStatus: gptPhoneAccount?.lifecycle_status || "",
        phone: phoneLease?.phone || "",
        paypalLocalPhone: phoneLease?.paypal_local_phone || "",
      });

      context = await prepareRunContext({
        account,
        phoneLease,
        config: this.config,
        windowInfo: this.windowInfo,
        runId,
        workerId: this.id,
        db: this.db,
      });
      context.gptPhoneAccount = gptPhoneAccount;
      context.checkoutLink = checkoutLink;
      context.checkoutLongUrl = checkoutLink?.checkoutLongUrl || "";
      context.leasePaypalPhone = () => {
        if (phoneLease) return phoneLease;
        phoneLease = leasePaypalPhone(this.db, {
          workerId: this.id,
          runId,
          leaseMinutes: Number(this.config.paypalPhone?.leaseMinutes || 30),
          countryCodes: this.config.paypalPhone?.countryCodes || ["JP"],
        });
        return phoneLease;
      };
      context.rotateWindowProxy = async (options = {}) => {
        const useNewWindow = options.newWindow === true || (
          options.reason === "paypal_risk_retry"
          && this.config.paypalRiskRetry?.newWindow === true
        );
        const result = useNewWindow
          ? await this.replaceWindowForRiskRetry({ reason: options.reason || "workflow_proxy_rotation" })
          : await this.maybeRotateWindowProxy({
              force: true,
              reason: options.reason || "workflow_proxy_rotation",
            });
        context.windowInfo = this.windowInfo;
        context.browser = this.windowInfo?.browser || context.browser;
        context.browserContext = this.windowInfo?.context || context.browserContext;
        context.page = this.windowInfo?.page || context.page;
        updateRun(this.db, runId, {
          roxy_dir_id: this.windowInfo?.dirId || "",
          roxy_exit_ip: this.windowInfo?.exitIp || "",
        });
        return result;
      };
      context.recoverClosedPage = async (options = {}) => {
        const result = await this.recoverClosedRoxyWindow({
          reason: options.reason || "closed_page_retry",
        });
        context.windowInfo = this.windowInfo;
        context.browser = this.windowInfo?.browser || context.browser;
        context.browserContext = this.windowInfo?.context || context.browserContext;
        context.page = this.windowInfo?.page || context.page;
        updateRun(this.db, runId, {
          roxy_dir_id: this.windowInfo?.dirId || "",
          roxy_exit_ip: this.windowInfo?.exitIp || "",
        });
        return result;
      };
      updateRun(this.db, runId, { current_step: "workflow" });
      heartbeatTimer = startRunHeartbeat(this.db, runId, {
        config: this.config,
        logger: this.logger,
        getContext: () => context,
      });
      let result;
      try {
        result = await runWorkflow(context, { dryRun: this.dryRun, logger: this.logger });
      } finally {
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
      }

      if (this.dryRun) {
        if (phoneLease) releasePaypalPhone(this.db, phoneLease.id, { runId, success: false, error: "dry_run_release" });
        if (context.gptPhoneAccountId) {
          releaseGptPhoneAccount(this.db, context.gptPhoneAccountId, { runId, error: "dry_run_release" });
        }
        if (account.id) {
          markOutlookFailure(this.db, account.id, {
            retryable: true,
            error: "dry_run_release",
            maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
          });
        }
        finishRun(this.db, runId, { status: "skipped", error: "dry_run" });
        return { status: "skipped", runId, result };
      }

      const finalAccount = context.account || account;
      if (!deferOutlookLease || paypalPlusProcess !== PAYPAL_PLUS_PROCESS.REGISTER_LINK) {
        insertPlusAccount(this.db, finalAccount, result, this.config);
      }
      if (context.gptPhoneAccountId && result.cpaUploadStatus === "done") {
        const updatedGpt = markGptAccountCpaDone(this.db, context.gptPhoneAccountId, {
          boundEmail: result.boundEmail || context.boundEmail || finalAccount.email || "",
          cpaUploadStatus: result.cpaUploadStatus || "",
          cpaUploadResult: result.cpaUploadResult || null,
          callbackJson: result.callbackJson || null,
          callbackJsonPath: result.callbackJsonPath || "",
        });
        context.gptPhoneLifecycleStatus = updatedGpt?.lifecycle_status || GPT_PHONE_LIFECYCLE.CPA_DONE;
        if (context.signupPhoneActivation?.provider === "hero-sms") {
          try {
            await finishOpenAiPhoneActivation(context.signupPhoneActivation, this.config, { db: this.db });
          } catch (finishError) {
            this.logger.warn("openai phone activation finish after CPA done failed", {
              runId,
              error: finishError.message,
            });
          }
        }
      } else if (context.gptPhoneAccountId && context.boundEmailCompleted) {
        const updatedGpt = markGptAccountEmailBound(this.db, context.gptPhoneAccountId, {
          outlookEmailId: finalAccount.id || context.boundOutlookEmailId || null,
          email: result.boundEmail || context.boundEmail || finalAccount.email || "",
        });
        context.gptPhoneLifecycleStatus = updatedGpt?.lifecycle_status || GPT_PHONE_LIFECYCLE.EMAIL_BOUND;
      }
      updateRun(this.db, runId, {
        account_identifier_type: result.accountIdentifierType || "",
        account_identifier: result.accountIdentifier || "",
        cpa_upload_status: result.cpaUploadStatus || "",
        callback_json_path: result.callbackJsonPath || "",
        gpt_phone_account_id: context.gptPhoneAccountId || null,
        openai_phone_activation_id: context.signupPhoneActivation?.dbActivationId || null,
        paypal_phone_id: phoneLease?.id || null,
        account_lifecycle_status: context.gptPhoneLifecycleStatus || "",
      });
      if (finalAccount.id && (context.boundEmailCompleted || !deferOutlookLease)) {
        markOutlookBound(this.db, finalAccount.id, {
          gptPhoneAccountId: context.gptPhoneAccountId || null,
          signupPhoneNumber: result.signupPhoneNumber || context.signupPhoneNumber || "",
        });
      }
      if (phoneLease) releasePaypalPhone(this.db, phoneLease.id, { runId, success: true });
      if (context.gptPhoneAccountId) {
        releaseGptPhoneAccount(this.db, context.gptPhoneAccountId, { runId });
      }
      finishRun(this.db, runId, { status: "done" });
      appendRunEvent(this.db, {
        runId,
        workerId: this.id,
        roxyDirId: this.windowInfo?.dirId || "",
        accountEmail: finalAccount.email || "",
        eventType: "run_done",
        message: "run completed",
        payload: {
          cpaUploadStatus: result.cpaUploadStatus || "",
          callbackJsonPath: result.callbackJsonPath || "",
        },
      });
      if (this.windowInfo) this.windowInfo.accountRuns += 1;
      return { status: "done", runId, result };
    } catch (error) {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const retryable = error instanceof WorkflowNotImplementedError ? true : error.retryable !== false;
      if (
        context?.signupPhoneActivation?.provider === "hero-sms"
        && context.preserveOpenAiPhoneActivationOnFailure !== true
      ) {
        try {
          await cancelOpenAiPhoneActivation(context.signupPhoneActivation, this.config, { db: this.db });
          this.logger.info("cancelled openai phone activation after failure", {
            runId,
            provider: context.signupPhoneActivation.provider,
          });
        } catch (cancelError) {
          this.logger.warn("openai phone activation cancel failed", {
            runId,
            provider: context.signupPhoneActivation.provider,
            error: cancelError.message,
          });
        }
      } else if (context?.signupPhoneActivation?.provider === "hero-sms") {
        this.logger.warn("preserved openai phone activation after failure", {
          runId,
          provider: context.signupPhoneActivation.provider,
          phoneNumber: context.signupPhoneActivation.phoneNumber || "",
          reason: "signup_phone_recovered_existing_login",
        });
      }
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
        releasePaypalPhone(this.db, phoneLease.id, {
          runId,
          success: false,
          disable: isPaypalPhoneRejectedError(error),
          error: error.message,
        });
      }
      if (context?.checkoutLink?.id) {
        const expired = /expired|not found|invalid.*checkout|checkout.*invalid|checkout.*expired/i
          .test(String(error.message || ""));
        markCheckoutLinkFailed(this.db, context.checkoutLink.id, {
          runId,
          error: error.message,
          expired,
        });
      }
      const finalAccount = context?.account || account;
      if (context?.gptPhoneAccountId) {
        if (isMissingReusablePhoneOtpError(error)) {
          markGptAccountHoldNoSmsAccess(this.db, context.gptPhoneAccountId, {
            error: error.message,
            step: error.step || context?.currentStep || "unknown",
          });
        } else {
          const status = context.gptPhoneLifecycleStatus === GPT_PHONE_LIFECYCLE.SIGNUP_PENDING
            ? GPT_PHONE_LIFECYCLE.DISABLED
            : "";
          markGptAccountFailure(this.db, context.gptPhoneAccountId, {
            error: error.message,
            step: error.step || context?.currentStep || "unknown",
            status,
          });
          releaseGptPhoneAccount(this.db, context.gptPhoneAccountId, { runId, error: error.message });
        }
      }
      if (finalAccount?.id && context?.reusedBoundOutlookEmail !== true) {
        const released = releaseDeferredOutlookOnFailure(context, (id, options) => {
          releaseOutlookEmail(this.db, id, {
            error: options.error || "",
            decrementAttempt: true,
            runId,
          });
        }, { error: error.message });
        if (!released) {
          const retryOutlook = retryable && !(deferOutlookLease && context?.boundEmailSubmitted === true);
          markOutlookFailure(this.db, finalAccount.id, {
            retryable: retryOutlook,
            error: error.message,
            maxAttempts: Number(this.config.runner?.maxAttemptsPerEmail || 5),
          });
        }
      }
      finishRun(this.db, runId, { status: "failed", error: error.message });
      appendRunEvent(this.db, {
        runId,
        workerId: this.id,
        roxyDirId: this.windowInfo?.dirId || "",
        accountEmail: finalAccount?.email || "",
        level: "error",
        eventType: "run_failed",
        message: error.message,
        payload: {
          step: error.step || context?.currentStep || "unknown",
          retryable,
        },
      });
      if (this.windowInfo) this.windowInfo.accountRuns += 1;
      if (shouldPreserveBrowserWindow(error)) {
        this.logger.warn("preserving browser window after failure for inspection", {
          runId,
          dirId: this.windowInfo?.dirId || "",
          error: error.message,
        });
      } else {
        await this.maybeRotateWindowProxyAfterFailure(error);
      }
      error.runId = error.runId || runId;
      error.email = error.email || finalAccount?.email || "";
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
            preserveBrowserWindow: error.preserveBrowserWindow === true,
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
