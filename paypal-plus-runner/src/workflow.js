import { buildCheckoutProfile, toPluginGuestProfile } from "./providers/checkout-profile.js";
import { openChatgptStep } from "./steps/open-chatgpt.js";
import { submitSignupEmailStep } from "./steps/submit-signup-email.js";
import { fillPasswordStep } from "./steps/fill-password.js";
import { fetchSignupCodeStep } from "./steps/fetch-signup-code.js";
import { fillProfileStep } from "./steps/fill-profile.js";
import { createPlusCheckoutStep } from "./steps/create-plus-checkout.js";
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
  oauthLoginPhoneStep,
  submitSignupPhoneStep,
} from "./steps/phone-flow.js";
import { finishOpenAiPhoneActivation } from "./providers/openai-phone.js";
import { WorkflowNotImplementedError } from "./utils/errors.js";
import { compactPageStateForLog, observePageState } from "./browser/page-utils.js";
import { appendContextEvent } from "./db/run-event-store.js";
import { leaseNextOutlookEmail, markOutlookRunning } from "./db/outlook-store.js";
import { updateRun } from "./db/run-history-store.js";

export const StepStatus = Object.freeze({
  DONE: "done",
  SKIPPED: "skipped",
  RETRY: "retry",
  FAILED: "failed",
});

export function stepResult(status, reason, extra = {}) {
  return { status, reason, ...extra };
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
  return {
    runId,
    workerId,
    account,
    phoneLease,
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

export function requiresOutlookAccountForStep(stepName = "", config = {}) {
  return isSmsOauthFlow(config) && stepName === "bind-email";
}

export function releaseDeferredOutlookOnFailure(context = {}, releaseFn = null, { error = "" } = {}) {
  const state = context || {};
  if (
    !isSmsOauthFlow(state.config)
    || state.outlookLeaseDeferred !== true
    || !state.account?.id
    || state.boundEmailSubmitted === true
    || typeof releaseFn !== "function"
  ) {
    return false;
  }
  releaseFn(state.account.id, { error });
  return true;
}

export async function ensureOutlookAccountForStep(context, stepName, { logger } = {}) {
  if (!requiresOutlookAccountForStep(stepName, context.config) || context.account?.id) {
    return;
  }
  if (!context.db) {
    throw new Error("延迟租用 Outlook 邮箱需要数据库连接。");
  }
  const account = leaseNextOutlookEmail(context.db, {
    maxAttempts: Number(context.config.runner?.maxAttemptsPerEmail || 5),
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

function getWorkflowSteps(config = {}) {
  if (isSmsOauthFlow(config)) {
    return [
      ["open-chatgpt", openChatgptStep],
      ["submit-signup-phone", submitSignupPhoneStep],
      ["fill-password", fillPasswordStep],
      ["fetch-signup-phone-code", fetchSignupPhoneCodeStep],
      ["fill-profile", fillProfileStep],
      ["plus-checkout-create", createPlusCheckoutStep],
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

export async function runWorkflow(context, { dryRun = false, logger } = {}) {
  const accessToken = String(context.config.runner?.debugAccessToken || "").trim();
  const steps = getWorkflowSteps(context.config);

  if (dryRun) {
    logger?.info?.("workflow dry-run prepared", {
      email: context.account?.email || "",
      paypalPhone: context.phoneLease.phone,
      paypalLocalPhone: context.checkoutProfile.phone.paypalLocal,
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
  for (const [name, fn] of steps) {
    context.currentStep = name;
    await ensureOutlookAccountForStep(context, name, { logger });
    logger?.info?.("workflow step start", { step: name, email: context.account?.email || "" });
    if (context.db) {
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
        context.skippedSteps.push(name);
      } else {
        context.completedSteps.push(name);
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
      error.step = error.step || name;
      if (context.db) {
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
      const result = await finishOpenAiPhoneActivation(context.signupPhoneActivation, context.config);
      logger?.info?.("openai phone activation finished", {
        provider: context.signupPhoneActivation.provider,
        supported: result.supported,
      });
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
    roxyDirId: context.windowInfo?.dirId || "",
    roxyExitIp: context.windowInfo?.exitIp || "",
  };
}
