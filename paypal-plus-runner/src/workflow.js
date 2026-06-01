import { attachPaypalPhoneToCheckoutProfile, buildCheckoutProfile, toPluginGuestProfile } from "./providers/checkout-profile.js";
import { openChatgptStep } from "./steps/open-chatgpt.js";
import { submitSignupEmailStep } from "./steps/submit-signup-email.js";
import { fillPasswordStep } from "./steps/fill-password.js";
import { fetchSignupCodeStep } from "./steps/fetch-signup-code.js";
import { fillProfileStep } from "./steps/fill-profile.js";
import { createPlusCheckoutStep } from "./steps/create-plus-checkout.js";
import { openCheckoutLongLinkStep, saveCheckoutLongLinkStep } from "./steps/checkout-link.js";
import { fillPlusCheckoutStep } from "./steps/fill-plus-checkout.js";
import { plusReturnConfirmStep } from "./steps/plus-return-confirm.js";
import { sessionJsonImportStep } from "./steps/session-json-import.js";
import { fetchCpaOAuthUrlStep } from "./steps/fetch-cpa-oauth-url.js";
import { cpaPlatformVerifyStep } from "./steps/cpa-platform-verify.js";
import { callbackJsonSaveStep } from "./steps/callback-json-save.js";
import {
  bindEmailStep,
  confirmOauthCallbackStep,
  fetchBindEmailCodeStep,
  fetchLoginPhoneCodeStep,
  fetchSignupPhoneCodeStep,
  loginExistingPhoneStep,
  oauthLoginPhoneStep,
  submitSignupPhoneStep,
} from "./steps/phone-flow.js";
import { finishOpenAiPhoneActivation } from "./providers/openai-phone.js";
import { WorkflowNotImplementedError, WorkflowStepRetryError, isClosedPageError } from "./utils/errors.js";
import { compactPageStateForLog, observePageState } from "./browser/page-utils.js";
import { appendContextEvent } from "./db/run-event-store.js";
import { leaseNextOutlookEmail, markOutlookBound, markOutlookRunning } from "./db/outlook-store.js";
import { updateRun } from "./db/run-history-store.js";
import { insertPlusAccount } from "./db/plus-store.js";
import {
  GPT_PHONE_LIFECYCLE,
  markGptAccountEmailBound,
  markGptAccountPlusDone,
} from "./db/gpt-phone-account-store.js";
import { markCheckoutLinkFailed, markCheckoutLinkPaid } from "./db/checkout-link-store.js";
import { PAYPAL_PLUS_PROCESS, paypalPlusProcessFromConfig } from "./plus/process.js";

export const StepStatus = Object.freeze({
  DONE: "done",
  SKIPPED: "skipped",
  RETRY: "retry",
  FAILED: "failed",
});

export function stepResult(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

function pushUniqueStep(list = [], stepName = "") {
  if (!stepName || list.includes(stepName)) return;
  list.push(stepName);
}

async function logObservedPageState(context, logger, message, extra = {}) {
  if (!context.page || !logger) return;
  const observed = await observePageState(context.page, {
    timeoutMs: Number(context.config.runner?.pageObservationTimeoutMs || 1500),
  }).catch((error) => ({ stage: "observe_failed", observeError: error.message, url: context.page.url() }));
  logger.info(message, {
    ...extra,
    ...compactPageStateForLog(observed),
  });
  if (context.db) {
    appendContextEvent(context.db, context, {
      eventType: "page_observed",
      message,
      pageStage: observed.stage || "",
      pageUrl: observed.url || "",
      payload: {
        ...extra,
        ...compactPageStateForLog(observed),
      },
    });
  }
}

export async function prepareRunContext({ account, phoneLease, config, windowInfo = null, runId = "", workerId = "", db = null }) {
  const checkoutProfile = await buildCheckoutProfile({ phoneLease, config });
  const gptPhoneAccountId = account?.gptPhoneAccountId || null;
  const signupPhoneNumber = account?.signupPhoneNumber || account?.accountIdentifier || "";
  const lifecycleStatus = account?.lifecycleStatus || "";
  return {
    runId,
    workerId,
    account,
    phoneLease,
    gptPhoneAccountId,
    gptPhoneLifecycleStatus: lifecycleStatus,
    gptPassword: account?.gptPassword || config.runner?.gptPassword || "",
    boundOutlookEmailId: account?.boundOutlookEmailId || null,
    accountIdentifierType: account?.accountIdentifierType || (signupPhoneNumber ? "phone" : ""),
    accountIdentifier: account?.accountIdentifier || signupPhoneNumber,
    signupPhoneNumber,
    signupPhoneActivation: account?.signupPhoneActivation || null,
    boundEmail: account?.boundEmail || account?.email || "",
    windowInfo,
    page: windowInfo?.page || null,
    browser: windowInfo?.browser || null,
    browserContext: windowInfo?.context || null,
    config,
    db,
    checkoutProfile,
    pluginGuestProfile: toPluginGuestProfile(checkoutProfile),
    completedSteps: [],
    skippedSteps: [],
  };
}

function isSmsOauthFlow(config = {}) {
  return String(config.flow?.plusAccountAccessStrategy || "").trim().toLowerCase() === "sms_oauth";
}

function resolveLifecycleStatus(context = {}) {
  return context.gptPhoneLifecycleStatus || context.gptPhoneAccount?.lifecycle_status || "";
}

export function requiresOutlookAccountForStep(stepName = "", config = {}) {
  return isSmsOauthFlow(config) && stepName === "bind-email";
}

export function releaseDeferredOutlookOnFailure(context = {}, releaseFn = null, { error = "" } = {}) {
  const state = context || {};
  if (
    !isSmsOauthFlow(state.config)
    || state.outlookLeaseDeferred !== true
    || !state.account?.id
    || state.boundEmailCompleted === true
    || typeof releaseFn !== "function"
  ) {
    return false;
  }
  releaseFn(state.account.id, { error });
  return true;
}

export async function ensureOutlookAccountForStep(context, stepName, { logger } = {}) {
  if (stepName === "bind-email" && context.oauthLoginDirectConsentPage) {
    return;
  }
  if (!requiresOutlookAccountForStep(stepName, context.config) || context.account?.id) {
    return;
  }
  if (context.boundOutlookEmailId && context.db) {
    const bound = context.db.prepare("SELECT * FROM outlook_emails WHERE id = ?").get(context.boundOutlookEmailId);
    if (bound?.email) {
      context.account = bound;
      context.outlookLeaseDeferred = false;
      context.reusedBoundOutlookEmail = true;
      context.boundEmail = context.boundEmail || bound.email;
      return;
    }
  }
  if (context.boundEmail && context.db) {
    const bound = context.db.prepare("SELECT * FROM outlook_emails WHERE email = ?").get(context.boundEmail);
    if (bound?.email) {
      context.account = bound;
      context.outlookLeaseDeferred = false;
      context.reusedBoundOutlookEmail = true;
      context.boundOutlookEmailId = bound.id;
      return;
    }
  }
  if (!context.db) {
    throw new Error("延迟租用 Outlook 邮箱需要数据库连接。");
  }
  const account = leaseNextOutlookEmail(context.db, {
    maxAttempts: Number(context.config.runner?.maxAttemptsPerEmail || 5),
    workerId: context.workerId,
    runId: context.runId,
    leaseMinutes: Number(context.config.runner?.outlookLeaseMinutes || 30),
  });
  if (!account) {
    throw new Error("no_outlook_emails");
  }
  markOutlookRunning(context.db, account.id);
  context.account = account;
  context.outlookLeaseDeferred = true;
  context.outlookLeaseStep = stepName;
  logger?.info?.("leased Outlook email for bind-email step", {
    email: account.email,
    step: stepName,
  });
  updateRun(context.db, context.runId, {
    email: account.email,
    outlook_email_id: account.id,
  });
}

async function ensurePaypalPhoneForStep(context, stepName, { logger } = {}) {
  if (!isSmsOauthFlow(context.config) || stepName !== "plus-checkout-billing") return;
  if (context.plusAlreadyPaid) return;
  if (context.phoneLease) return;
  if (typeof context.leasePaypalPhone !== "function") {
    throw new Error("plus checkout billing requires a PayPal phone lease provider");
  }
  const phoneLease = context.leasePaypalPhone();
  if (!phoneLease) {
    throw new Error(`paypal_phone_pool has no available phone for countries: ${(context.config.paypalPhone?.countryCodes || ["JP"]).join(",")}`);
  }
  context.phoneLease = phoneLease;
  context.checkoutProfile = attachPaypalPhoneToCheckoutProfile(context.checkoutProfile, phoneLease);
  context.pluginGuestProfile = toPluginGuestProfile(context.checkoutProfile);
  logger?.info?.("leased PayPal phone for checkout billing", {
    phone: phoneLease.phone,
    paypalLocalPhone: phoneLease.paypal_local_phone,
  });
  if (context.db) {
    updateRun(context.db, context.runId, {
      paypal_phone_id: phoneLease.id,
    });
  }
}

function getSmsOauthSteps(context = {}) {
  const lifecycleStatus = resolveLifecycleStatus(context);
  const cpaSteps = [
    ["fetch-cpa-oauth-url", fetchCpaOAuthUrlStep],
    ["oauth-login-phone", oauthLoginPhoneStep],
    ["fetch-login-phone-code", fetchLoginPhoneCodeStep],
    ["bind-email", bindEmailStep],
    ["fetch-bind-email-code", fetchBindEmailCodeStep],
    ["confirm-oauth-callback", confirmOauthCallbackStep],
    ["cpa-platform-verify", cpaPlatformVerifyStep],
    ["callback-json-save", callbackJsonSaveStep],
  ];
  if (lifecycleStatus === GPT_PHONE_LIFECYCLE.PLUS_DONE || lifecycleStatus === GPT_PHONE_LIFECYCLE.EMAIL_BOUND) {
    return cpaSteps;
  }
  if (lifecycleStatus === GPT_PHONE_LIFECYCLE.REGISTERED) {
    return [
      ["login-existing-phone", loginExistingPhoneStep],
      ["plus-checkout-create", createPlusCheckoutStep],
      ["checkout-link-save", saveCheckoutLongLinkStep],
      ["plus-checkout-billing", fillPlusCheckoutStep],
      ["plus-checkout-return", plusReturnConfirmStep],
      ...cpaSteps,
    ];
  }
  return [
      ["open-chatgpt", openChatgptStep],
      ["submit-signup-phone", submitSignupPhoneStep],
      ["fill-password", fillPasswordStep],
      ["fetch-signup-phone-code", fetchSignupPhoneCodeStep],
      ["fill-profile", fillProfileStep],
      ["plus-checkout-create", createPlusCheckoutStep],
      ["checkout-link-save", saveCheckoutLongLinkStep],
      ["plus-checkout-billing", fillPlusCheckoutStep],
      ["plus-checkout-return", plusReturnConfirmStep],
      ["fetch-cpa-oauth-url", fetchCpaOAuthUrlStep],
      ["oauth-login-phone", oauthLoginPhoneStep],
      ["fetch-login-phone-code", fetchLoginPhoneCodeStep],
      ["bind-email", bindEmailStep],
      ["fetch-bind-email-code", fetchBindEmailCodeStep],
      ["confirm-oauth-callback", confirmOauthCallbackStep],
      ["cpa-platform-verify", cpaPlatformVerifyStep],
      ["callback-json-save", callbackJsonSaveStep],
    ];
}

function getRegisterLinkSteps(context = {}) {
  const lifecycleStatus = resolveLifecycleStatus(context);
  if (lifecycleStatus === GPT_PHONE_LIFECYCLE.REGISTERED) {
    return [
      ["login-existing-phone", loginExistingPhoneStep],
      ["plus-checkout-create", createPlusCheckoutStep],
      ["checkout-link-save", saveCheckoutLongLinkStep],
    ];
  }
  return [
    ["open-chatgpt", openChatgptStep],
    ["submit-signup-phone", submitSignupPhoneStep],
    ["fill-password", fillPasswordStep],
    ["fetch-signup-phone-code", fetchSignupPhoneCodeStep],
    ["fill-profile", fillProfileStep],
    ["plus-checkout-create", createPlusCheckoutStep],
    ["checkout-link-save", saveCheckoutLongLinkStep],
  ];
}

function getPayLinkSteps() {
  return [
    ["open-checkout-link", openCheckoutLongLinkStep],
    ["plus-checkout-billing", fillPlusCheckoutStep],
    ["login-existing-phone", loginExistingPhoneStep],
    ["plus-checkout-return", plusReturnConfirmStep],
  ];
}

function getCpaUploadSteps() {
  return [
    ["fetch-cpa-oauth-url", fetchCpaOAuthUrlStep],
    ["oauth-login-phone", oauthLoginPhoneStep],
    ["fetch-login-phone-code", fetchLoginPhoneCodeStep],
    ["bind-email", bindEmailStep],
    ["fetch-bind-email-code", fetchBindEmailCodeStep],
    ["confirm-oauth-callback", confirmOauthCallbackStep],
    ["cpa-platform-verify", cpaPlatformVerifyStep],
    ["callback-json-save", callbackJsonSaveStep],
  ];
}

function getWorkflowSteps(context = {}) {
  if (isSmsOauthFlow(context.config)) {
    const process = paypalPlusProcessFromConfig(context.config);
    if (process === PAYPAL_PLUS_PROCESS.REGISTER_LINK) return getRegisterLinkSteps(context);
    if (process === PAYPAL_PLUS_PROCESS.PAY_LINK) return getPayLinkSteps(context);
    if (process === PAYPAL_PLUS_PROCESS.CPA_UPLOAD) return getCpaUploadSteps(context);
    return getSmsOauthSteps(context);
  }
  return [
    ["open-chatgpt", openChatgptStep],
    ["submit-signup-email", submitSignupEmailStep],
    ["fill-password", fillPasswordStep],
    ["fetch-signup-code", fetchSignupCodeStep],
    ["fill-profile", fillProfileStep],
    ["plus-checkout-create", createPlusCheckoutStep],
    ["plus-checkout-billing", fillPlusCheckoutStep],
    ["plus-checkout-return", plusReturnConfirmStep],
    ["session-json-import", sessionJsonImportStep],
  ];
}

function isPlusAccountReadyStep(stepName = "", result = {}, context = {}) {
  if (stepName === "plus-checkout-create" && (result?.reason === "already_paid" || context.plusAlreadyPaid)) {
    return true;
  }
  if (stepName !== "plus-checkout-return") return false;
  return result?.reason === "already_paid"
    || result?.reason === "chatgpt_plus_session_confirmed"
    || result?.reason === "chatgpt_login_plus_session_confirmed"
    || result?.reason === "payments_success"
    || result?.reason === "stripe_paypal_redirect_plus_confirmed";
}

function maybeRecordPhonePlusAccount(context, stepName, result = {}, { logger } = {}) {
  if (!context.db || !isSmsOauthFlow(context.config)) return;
  if (!isPlusAccountReadyStep(stepName, result, context)) return;
  const accountIdentifierType = context.accountIdentifierType || "";
  const accountIdentifier = context.accountIdentifier || "";
  const signupPhoneNumber = context.signupPhoneNumber || "";
  if (accountIdentifierType !== "phone" && !signupPhoneNumber) return;

  const row = insertPlusAccount(context.db, context.account || {}, {
    plusAccountOnly: true,
    sessionJson: context.sessionJson || "",
    accountIdentifierType,
    accountIdentifier,
    signupPhoneNumber,
    boundEmail: context.boundEmail || "",
    roxyDirId: context.windowInfo?.dirId || "",
    roxyExitIp: context.windowInfo?.exitIp || "",
    gptPhoneAccountId: context.gptPhoneAccountId || null,
  }, context.config);
  if (context.gptPhoneAccountId) {
    const accountRow = markGptAccountPlusDone(context.db, context.gptPhoneAccountId, {
      gptPassword: context.gptPassword || context.config.runner?.gptPassword || "",
      sessionJson: context.sessionJson || "",
      roxyDirId: context.windowInfo?.dirId || "",
      roxyExitIp: context.windowInfo?.exitIp || "",
    });
    context.gptPhoneLifecycleStatus = accountRow?.lifecycle_status || GPT_PHONE_LIFECYCLE.PLUS_DONE;
    updateRun(context.db, context.runId, {
      account_lifecycle_status: context.gptPhoneLifecycleStatus,
    });
  }
  context.plusAccountRecorded = true;
  if (context.checkoutLink?.id && context.db) {
    const paid = markCheckoutLinkPaid(context.db, context.checkoutLink.id, { runId: context.runId });
    context.checkoutLink = {
      ...context.checkoutLink,
      status: paid?.status || "paid",
      paidAt: paid?.paid_at || "",
    };
  }
  logger?.info?.("phone Plus account recorded", {
    email: row?.email || "",
    accountIdentifierType,
    accountIdentifier,
    signupPhoneNumber,
    importTarget: row?.import_target || "",
  });
}

export async function runWorkflow(context, { dryRun = false, logger, stepsOverride = null } = {}) {
  const accessToken = String(context.config.runner?.debugAccessToken || "").trim();
  const steps = Array.isArray(stepsOverride) ? stepsOverride : getWorkflowSteps(context);

  if (dryRun) {
    logger?.info?.("workflow dry-run prepared", {
      email: context.account?.email || "",
      paypalPhone: context.phoneLease?.phone || "",
      paypalLocalPhone: context.checkoutProfile?.phone?.paypalLocal || "",
      profilePhone: context.pluginGuestProfile.phone,
      cardLast4: context.checkoutProfile.card.last4,
    });
    return {
      status: StepStatus.SKIPPED,
      reason: "dry_run",
      completedSteps: [],
      skippedSteps: steps.map(([name]) => name),
      sessionJson: "",
      roxyDirId: context.windowInfo?.dirId || "",
      roxyExitIp: context.windowInfo?.exitIp || "",
      workflow: isSmsOauthFlow(context.config) ? "sms_oauth" : "default",
    };
  }

  const results = {};
  const retryCounts = {};
  for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
    const [name, fn] = steps[stepIndex];
    context.currentStep = name;
    await ensureOutlookAccountForStep(context, name, { logger });
    await ensurePaypalPhoneForStep(context, name, { logger });
    logger?.info?.("workflow step start", { step: name, email: context.account?.email || "" });
    if (context.db) {
      updateRun(context.db, context.runId, {
        current_step: name,
        account_lifecycle_status: context.gptPhoneLifecycleStatus || "",
      });
      appendContextEvent(context.db, context, {
        eventType: "step_start",
        message: "workflow step start",
        payload: { step: name, email: context.account?.email || "" },
      });
    }
    try {
      const result = await fn(context, { logger, accessToken });
      results[name] = result;
      if (result?.status === StepStatus.SKIPPED) {
        pushUniqueStep(context.skippedSteps, name);
      } else {
        pushUniqueStep(context.completedSteps, name);
      }
      if (result?.sessionJson) context.sessionJson = result.sessionJson;
      if (result?.cpaJsonPath) context.cpaJsonPath = result.cpaJsonPath;
      if (result?.cpaJsonFileName) context.cpaJsonFileName = result.cpaJsonFileName;
      if (result?.cpaUploadStatus) context.cpaUploadStatus = result.cpaUploadStatus;
      if (result?.cpaUploadResult) context.cpaUploadResult = result.cpaUploadResult;
      if (result?.callbackJson) context.callbackJson = result.callbackJson;
      if (result?.callbackJsonPath) context.callbackJsonPath = result.callbackJsonPath;
      if (result?.callbackJsonFileName) context.callbackJsonFileName = result.callbackJsonFileName;
      if (result?.checkout) context.checkout = result.checkout;
      maybeRecordPhonePlusAccount(context, name, result, { logger });
      if (name === "confirm-oauth-callback" && context.boundEmailCompleted && context.gptPhoneAccountId) {
        const accountRow = markGptAccountEmailBound(context.db, context.gptPhoneAccountId, {
          outlookEmailId: context.account?.id || context.boundOutlookEmailId || null,
          email: context.boundEmail || context.account?.email || "",
        });
        context.gptPhoneLifecycleStatus = accountRow?.lifecycle_status || GPT_PHONE_LIFECYCLE.EMAIL_BOUND;
        if (context.account?.id) {
          markOutlookBound(context.db, context.account.id, {
            gptPhoneAccountId: context.gptPhoneAccountId,
            signupPhoneNumber: context.signupPhoneNumber || context.accountIdentifier || "",
          });
        }
        updateRun(context.db, context.runId, {
          account_lifecycle_status: context.gptPhoneLifecycleStatus,
        });
      }
      logger?.info?.("workflow step complete", { step: name, status: result?.status || "done", reason: result?.reason || "" });
      if (context.db) {
        appendContextEvent(context.db, context, {
          eventType: "step_complete",
          message: "workflow step complete",
          payload: { step: name, status: result?.status || "done", reason: result?.reason || "" },
        });
      }
      await logObservedPageState(context, logger, "page observation after workflow step", { step: name });
    } catch (error) {
      if (error instanceof WorkflowNotImplementedError) throw error;
      if (error instanceof WorkflowStepRetryError && error.retryFromStep) {
        const targetIndex = steps.findIndex(([stepName]) => stepName === error.retryFromStep);
        if (targetIndex < 0) {
          error.step = error.step || name;
          throw error;
        }
        const retryMax = Number(error.retryMax || context.config.runner?.workflowStepRetryMax || 3);
        const retryKey = `${name}->${error.retryFromStep}:${error.retryReason || error.code || ""}`;
        retryCounts[retryKey] = Number(retryCounts[retryKey] || 0) + 1;
        if (retryCounts[retryKey] > Math.max(1, retryMax)) {
          error.step = error.step || name;
          throw error;
        }
        logger?.warn?.("workflow step requested retry from earlier step", {
          step: name,
          retryFromStep: error.retryFromStep,
          retryReason: error.retryReason || error.code || "",
          retryAttempt: retryCounts[retryKey],
          retryMax,
        });
        if (context.db) {
          appendContextEvent(context.db, context, {
            level: "warn",
            eventType: "step_retry",
            message: error.message,
            payload: {
              step: name,
              retryFromStep: error.retryFromStep,
              retryReason: error.retryReason || error.code || "",
              retryAttempt: retryCounts[retryKey],
              retryMax,
            },
          });
        }
        await logObservedPageState(context, logger, "page observation before workflow step retry", {
          step: name,
          retryFromStep: error.retryFromStep,
          retryReason: error.retryReason || error.code || "",
        }).catch(() => undefined);
        stepIndex = targetIndex - 1;
        continue;
      }
      if (
        isClosedPageError(error)
        && context.closedPageRetryDone !== true
        && typeof context.recoverClosedPage === "function"
      ) {
        context.closedPageRetryDone = true;
        logger?.warn?.("workflow detected closed page; recovering Roxy window and retrying step once", {
          step: name,
          error: error.message,
        });
        if (context.db) {
          appendContextEvent(context.db, context, {
            level: "warn",
            eventType: "closed_page_retry",
            message: error.message,
            payload: {
              step: name,
              error: error.message,
            },
          });
        }
        let recovered = false;
        try {
          await context.recoverClosedPage({
            step: name,
            reason: error.message,
          });
          recovered = true;
        } catch (recoverError) {
          logger?.warn?.("closed page recovery failed; falling through to normal failure handling", {
            step: name,
            error: error.message,
            recoverError: recoverError.message,
          });
          if (context.db) {
            appendContextEvent(context.db, context, {
              level: "warn",
              eventType: "closed_page_recovery_failed",
              message: recoverError.message,
              payload: {
                step: name,
                originalError: error.message,
                recoverError: recoverError.message,
              },
            });
          }
        }
        if (recovered) {
          await logObservedPageState(context, logger, "page observation after closed page recovery", {
            step: name,
          }).catch(() => undefined);
          stepIndex -= 1;
          continue;
        }
      }
      error.step = error.step || name;
      if (context.db) {
        if (context.checkoutLink?.id) {
          const expired = /expired|not found|invalid.*checkout|checkout.*invalid|checkout.*expired/i
            .test(String(error.message || ""));
          markCheckoutLinkFailed(context.db, context.checkoutLink.id, {
            runId: context.runId,
            error: error.message,
            expired,
          });
        }
        appendContextEvent(context.db, context, {
          level: "error",
          eventType: "step_failed",
          message: error.message,
          payload: { step: name, error: error.message },
        });
      }
      await logObservedPageState(context, logger, "page observation after workflow step failure", {
        step: name,
        error: error.message,
      }).catch(() => undefined);
      throw error;
    }
  }

  if (context.signupPhoneActivation?.provider === "hero-sms") {
    try {
      if (context.gptPhoneLifecycleStatus !== GPT_PHONE_LIFECYCLE.CPA_DONE) {
        logger?.info?.("openai phone activation preserved until CPA done", {
          provider: context.signupPhoneActivation.provider,
          lifecycleStatus: context.gptPhoneLifecycleStatus || "",
        });
      } else {
        const result = await finishOpenAiPhoneActivation(context.signupPhoneActivation, context.config, { db: context.db });
        logger?.info?.("openai phone activation finished", {
          provider: context.signupPhoneActivation.provider,
          supported: result.supported,
        });
      }
    } catch (error) {
      logger?.warn?.("openai phone activation finish failed", {
        provider: context.signupPhoneActivation.provider,
        error: error.message,
      });
    }
  }

  return {
    status: StepStatus.DONE,
    reason: "workflow_complete",
    completedSteps: context.completedSteps,
    skippedSteps: context.skippedSteps,
    results,
    sessionJson: context.sessionJson || results["session-json-import"]?.sessionJson || "",
    cpaJsonPath: context.cpaJsonPath || results["session-json-import"]?.cpaJsonPath || "",
    cpaJsonFileName: context.cpaJsonFileName || results["session-json-import"]?.cpaJsonFileName || "",
    cpaUploadStatus: context.cpaUploadStatus || results["cpa-platform-verify"]?.cpaUploadStatus || "",
    cpaUploadResult: context.cpaUploadResult || results["cpa-platform-verify"]?.cpaUploadResult || null,
    callbackJson: context.callbackJson || results["callback-json-save"]?.callbackJson || null,
    callbackJsonPath: context.callbackJsonPath || results["callback-json-save"]?.callbackJsonPath || "",
    callbackJsonFileName: context.callbackJsonFileName || results["callback-json-save"]?.callbackJsonFileName || "",
    accountIdentifierType: context.accountIdentifierType || "",
    accountIdentifier: context.accountIdentifier || "",
    signupPhoneNumber: context.signupPhoneNumber || "",
    boundEmail: context.boundEmail || "",
    gptPhoneAccountId: context.gptPhoneAccountId || null,
    gptPhoneLifecycleStatus: context.gptPhoneLifecycleStatus || "",
    checkoutLink: context.checkoutLink || null,
    checkoutLongUrl: context.checkoutLongUrl || "",
    roxyDirId: context.windowInfo?.dirId || "",
    roxyExitIp: context.windowInfo?.exitIp || "",
  };
}
