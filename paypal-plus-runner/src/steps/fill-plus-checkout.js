import fs from "node:fs/promises";
import path from "node:path";
import { createCheckout } from "../checkout-conversion/index.js";
import { resolveCheckoutOpenTarget } from "../checkout-conversion/hosted-url.js";
import {
  detectPageStage,
  isStripePaypalRedirectSucceededUrl,
  safeGotoWithRetry,
} from "../browser/page-utils.js";
import { injectPaypalFlow, injectPlusCheckoutFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { fetchPaypalSmsCode, fetchPaypalSmsSnapshot } from "../providers/paypal-phone-code.js";
import { assertPlusSessionJson, readSessionJson } from "../providers/session-json.js";
import { RunnerError } from "../utils/errors.js";
import { updateRun } from "../db/run-history-store.js";
import { appendContextEvent } from "../db/run-event-store.js";
import {
  getRecentPaypalPhoneSmsCodes,
  recordPaypalPhoneSmsCodes,
} from "../db/paypal-phone-sms-code-store.js";

function setCheckoutSubstep(context = {}, substep = "") {
  const currentStep = substep ? `plus-checkout-billing/${substep}` : "plus-checkout-billing";
  context.currentStep = currentStep;
  if (context.db && context.runId) {
    updateRun(context.db, context.runId, { current_step: currentStep });
  }
}

async function ensurePaypalRuntime(page, context) {
  await injectPaypalFlow(page, {
    pluginRoot: context.config.plugin?.root,
  });
}

async function ensurePlusCheckoutRuntime(page, context) {
  await injectPlusCheckoutFlow(page, {
    pluginRoot: context.config.plugin?.root,
  });
}

async function getPlusCheckoutState(page, context = null) {
  const result = await dispatchChromeRuntimeMessage(page, {
    type: "PLUS_CHECKOUT_GET_STATE",
    source: "runner",
  }, {
    onRetry: context ? () => ensurePlusCheckoutRuntime(page, context) : null,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function runPlusCheckoutMessage(page, context, message) {
  const result = await dispatchChromeRuntimeMessage(page, {
    source: "runner",
    ...message,
  }, {
    onRetry: context ? () => ensurePlusCheckoutRuntime(page, context) : null,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function getHostedState(page, context = null) {
  const result = await dispatchChromeRuntimeMessage(page, {
    type: "PAYPAL_HOSTED_GET_STATE",
    source: "runner",
  }, {
    attempts: 5,
    onRetry: context ? () => ensurePaypalRuntime(page, context) : null,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function runHostedStep(page, context, payload = {}) {
  const result = await dispatchChromeRuntimeMessage(page, {
    type: "PAYPAL_RUN_HOSTED_CHECKOUT_STEP",
    source: "runner",
    payload,
  }, {
    attempts: 5,
    onRetry: context ? () => ensurePaypalRuntime(page, context) : null,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

function buildAddressSeed(context) {
  const address = context.checkoutProfile?.address || {};
  const fallbackAddress = context.config?.checkoutProfile?.fallbackAddress || {};
  const countryCode = address.countryCode || context.config?.checkoutProfile?.hostedAddressCountryCode || fallbackAddress.countryCode || "JP";
  return {
    countryCode,
    forceCountrySelectionBeforeAutocomplete: true,
    skipAutocomplete: true,
    autoCheckAgreement: true,
    fallback: {
      address1: address.street || fallbackAddress.street || "1-1-2 Otemachi",
      city: address.city || fallbackAddress.city || "Chiyoda-ku",
      region: address.state || fallbackAddress.state || "Tokyo",
      postalCode: address.zip || fallbackAddress.zip || "1000004",
    },
  };
}

export function buildHostedGuestPayload(context, overrides = {}) {
  return {
    ...context.pluginGuestProfile,
    address: context.checkoutProfile?.address || context.pluginGuestProfile?.address || {},
    addressSeed: buildAddressSeed(context),
    ...overrides,
  };
}

function buildProgressSignature(stage, state = {}) {
  return [
    stage.url,
    state.hostedStage,
    state.loginPhase,
    state.hasEmailInput ? "email" : "",
    state.hasPasswordInput ? "password" : "",
    state.verificationInputsVisible ? "otp" : "",
    state.verificationErrorVisible ? "otp_error" : "",
    state.hostedBusyVisible ? "busy" : "",
  ].join("|");
}

function safePageUrl(page) {
  try {
    return page?.url?.() || "";
  } catch {
    return "";
  }
}

function safeArtifactName(value = "") {
  return String(value || "paypal-debug").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

function isPaypalVerificationDebugEnabled(context = {}) {
  return context.config?.runner?.paypalVerificationDebug === true
    || process.env.PAYPAL_VERIFICATION_DEBUG === "1"
    || /^true$/i.test(String(process.env.PAYPAL_VERIFICATION_DEBUG || ""));
}

function paypalDebugOutputDir(context = {}) {
  const baseDir = path.resolve(String(context.config?.output?.dir || "output"));
  return path.join(baseDir, safeArtifactName(context.runId || "paypal-debug"), "paypal-debug");
}

function paypalDebugStateSummary(state = {}) {
  return {
    hostedStage: state.hostedStage || "",
    verificationInputsVisible: Boolean(state.verificationInputsVisible),
    verificationErrorVisible: Boolean(state.verificationErrorVisible),
    verificationErrorText: state.verificationErrorText || "",
    hostedBusyVisible: Boolean(state.hostedBusyVisible),
    hostedBlockingPromptVisible: Boolean(state.hostedBlockingPromptVisible),
    hostedErrorVisible: Boolean(state.hostedErrorVisible),
    hostedErrorText: state.hostedErrorText || "",
    hostedPhoneRejected: Boolean(state.hostedPhoneRejected),
    hostedPhoneRejectedText: state.hostedPhoneRejectedText || "",
    visibleControlCount: Number(state.visibleControlCount || 0),
    reviewConsentReady: Boolean(state.reviewConsentReady),
    bodyTextPreview: state.bodyTextPreview || "",
  };
}

async function writePaypalVerificationDebugArtifact(context, page, state = {}, label = "state", {
  logger = null,
  extra = {},
} = {}) {
  if (!isPaypalVerificationDebugEnabled(context) || !page) return null;
  const dir = paypalDebugOutputDir(context);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stage = safeArtifactName(state?.hostedStage || extra.stage || "unknown");
  const base = `${timestamp}-${safeArtifactName(label)}-${stage}`;
  const metaPath = path.join(dir, `${base}.json`);
  const htmlPath = path.join(dir, `${base}.html`);
  const screenshotPath = path.join(dir, `${base}.png`);
  await fs.mkdir(dir, { recursive: true });
  const meta = {
    createdAt: new Date().toISOString(),
    label,
    runId: context.runId || "",
    workerId: context.workerId || "",
    currentStep: context.currentStep || "",
    pageUrl: safePageUrl(page),
    state: paypalDebugStateSummary(state),
    extra,
    files: {},
  };
  try {
    if (context.config?.runner?.paypalVerificationDebugHtml !== false) {
      const html = await page.content();
      await fs.writeFile(htmlPath, html, "utf8");
      meta.files.html = htmlPath;
    }
  } catch (error) {
    meta.files.htmlError = error.message;
  }
  try {
    if (context.config?.runner?.paypalVerificationDebugScreenshot !== false) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
      meta.files.screenshot = screenshotPath;
    }
  } catch (error) {
    meta.files.screenshotError = error.message;
  }
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  meta.files.meta = metaPath;
  logger?.info?.("paypal verification debug artifact written", {
    label,
    hostedStage: meta.state.hostedStage,
    verificationInputsVisible: meta.state.verificationInputsVisible,
    verificationErrorVisible: meta.state.verificationErrorVisible,
    dir,
    meta: metaPath,
    html: meta.files.html || "",
    screenshot: meta.files.screenshot || "",
  });
  return meta;
}

async function logPaypalVerificationDebugState(context, page, state = {}, {
  logger = null,
  label = "state",
  forceSnapshot = false,
  extra = {},
} = {}) {
  if (!isPaypalVerificationDebugEnabled(context)) return;
  const summary = paypalDebugStateSummary(state);
  const signature = [
    safePageUrl(page),
    summary.hostedStage,
    summary.verificationInputsVisible ? "otp" : "",
    summary.verificationErrorVisible ? "otp_error" : "",
    summary.hostedErrorVisible ? "hosted_error" : "",
    summary.hostedPhoneRejected ? "phone_rejected" : "",
    summary.hostedBusyVisible ? "busy" : "",
  ].join("|");
  const now = Date.now();
  const intervalMs = Math.max(1000, Number(context.config?.runner?.paypalVerificationDebugLogIntervalMs || 5000));
  const signatureChanged = signature !== context.paypalVerificationDebugLastSignature;
  if (
    forceSnapshot
    || signatureChanged
    || now - Number(context.paypalVerificationDebugLastLogAt || 0) >= intervalMs
  ) {
    context.paypalVerificationDebugLastSignature = signature;
    context.paypalVerificationDebugLastLogAt = now;
    logger?.info?.("paypal verification debug state", {
      label,
      url: safePageUrl(page),
      ...summary,
      ...extra,
    });
  }

  const snapshotStateChanges = context.config?.runner?.paypalVerificationDebugSnapshotStateChanges !== false;
  const shouldSnapshot = forceSnapshot
    || (snapshotStateChanges && signatureChanged)
    || summary.hostedStage === "verification"
    || summary.verificationInputsVisible
    || summary.verificationErrorVisible
    || summary.hostedErrorVisible
    || summary.hostedPhoneRejected;
  if (!shouldSnapshot) return;
  const snapshotKey = `${label}|${signature}`;
  context.paypalVerificationDebugSnapshotKeys ||= new Set();
  if (!forceSnapshot && context.paypalVerificationDebugSnapshotKeys.has(snapshotKey)) return;
  context.paypalVerificationDebugSnapshotKeys.add(snapshotKey);
  await writePaypalVerificationDebugArtifact(context, page, state, label, { logger, extra }).catch((error) => {
    logger?.warn?.("paypal verification debug artifact failed", {
      label,
      error: error.message,
    });
  });
}

const PAYPAL_VERIFICATION_RESEND_WAIT_MS = 30000;

function isPaypalSmsTimeoutError(error = {}) {
  return /paypal phone otp timeout/i.test(String(error?.message || error || ""));
}

function paypalSmsSeenTtlHours(context = {}) {
  return Math.max(1, Number.parseInt(String(context.config?.verification?.paypalSmsSeenTtlHours || 24), 10) || 24);
}

function paypalPhoneForSms(context = {}) {
  return {
    phoneId: context.phoneLease?.id ?? null,
    phone: String(context.phoneLease?.phone || "").trim(),
  };
}

function uniqueCodes(codes = []) {
  const items = Array.isArray(codes) ? codes : [codes];
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function emitPaypalSmsEvent(context = {}, logger = null, {
  eventType = "paypal-sms-event",
  message = "",
  level = "info",
  payload = {},
} = {}) {
  const logPayload = {
    phone: context.phoneLease?.phone || "",
    phoneId: context.phoneLease?.id || null,
    ...payload,
  };
  if (level === "warn") logger?.warn?.(message || eventType, logPayload);
  else logger?.info?.(message || eventType, logPayload);
  if (context.db) {
    appendContextEvent(context.db, context, {
      level,
      eventType,
      message: message || eventType,
      payload: logPayload,
    });
  }
}

function recordPaypalSmsCodesForContext(context = {}, {
  codes = [],
  source = "",
  logger = null,
  eventType = "",
  message = "",
  forceLog = false,
  extra = {},
} = {}) {
  const normalizedCodes = uniqueCodes(codes);
  if (!normalizedCodes.length) return { recorded: 0, codes: [] };
  const { phoneId, phone } = paypalPhoneForSms(context);
  if (!phone) return { recorded: 0, codes: normalizedCodes };
  let result = { recorded: normalizedCodes.length, codes: normalizedCodes };
  if (context.db) {
    result = recordPaypalPhoneSmsCodes(context.db, {
      phoneId,
      phone,
      codes: normalizedCodes,
      source,
      runId: context.runId || "",
    });
  }

  const keyPrefix = `${source}:${phone}:`;
  context.paypalSmsLoggedCodeKeys ||= new Set();
  const newLogCodes = normalizedCodes.filter((code) => {
    const key = `${keyPrefix}${code}`;
    if (context.paypalSmsLoggedCodeKeys.has(key)) return false;
    context.paypalSmsLoggedCodeKeys.add(key);
    return true;
  });
  if (forceLog || newLogCodes.length) {
    emitPaypalSmsEvent(context, logger, {
      eventType: eventType || `paypal-sms-${source}`,
      message: message || `paypal sms ${source}`,
      payload: {
        source,
        codeCount: normalizedCodes.length,
        newLogCodeCount: forceLog ? normalizedCodes.length : newLogCodes.length,
        ...extra,
      },
    });
  }
  return result;
}

function getRecentPaypalSmsCodesForContext(context = {}) {
  const { phone } = paypalPhoneForSms(context);
  if (!context.db || !phone) return [];
  return getRecentPaypalPhoneSmsCodes(context.db, {
    phone,
    ttlHours: paypalSmsSeenTtlHours(context),
  });
}

function buildPaypalSmsIgnoreCodes(context = {}, extraCodes = []) {
  return uniqueCodes([
    ...uniqueCodes(extraCodes),
    ...(context.paypalSmsBaselineCodes ? [...context.paypalSmsBaselineCodes] : []),
    ...getRecentPaypalSmsCodesForContext(context),
  ]);
}

function buildPaypalSmsFetchCallbacks(context = {}, {
  attemptedCodes = [],
  logger = null,
} = {}) {
  return {
    ignoreCodes: uniqueCodes(attemptedCodes),
    getIgnoreCodes: () => buildPaypalSmsIgnoreCodes(context),
    onCodesIgnored: async (codes) => {
      recordPaypalSmsCodesForContext(context, {
        codes,
        source: "ignored",
        logger,
        eventType: "paypal-sms-ignored-old-code",
        message: "paypal sms old code ignored",
      });
    },
    onCodeAccepted: async (code) => {
      recordPaypalSmsCodesForContext(context, {
        codes: [code],
        source: "received",
        logger,
        eventType: "paypal-sms-new-code-received",
        message: "paypal sms new code received",
        forceLog: true,
      });
    },
  };
}

async function recordPaypalSmsBaseline(context = {}, page, {
  logger = null,
  fetchSnapshot = fetchPaypalSmsSnapshot,
} = {}) {
  if (!context.phoneLease?.sms_url) return { recorded: 0, codes: [] };
  context.paypalSmsBaselineRecordedUrls ||= new Set();
  const url = safePageUrl(page);
  const key = `${context.phoneLease?.id || ""}:${url || "unknown"}`;
  if (context.paypalSmsBaselineRecordedUrls.has(key)) {
    return { recorded: 0, codes: [...(context.paypalSmsBaselineCodes || [])], skipped: true };
  }
  context.paypalSmsBaselineRecordedUrls.add(key);
  context.paypalSmsBaselineCodes ||= new Set();

  try {
    const snapshot = await fetchSnapshot(context.phoneLease, {
      requestTimeoutMs: Number(context.config?.verification?.paypalSmsRequestTimeoutMs || 15000),
    });
    const codes = uniqueCodes(snapshot.codes || []);
    for (const code of codes) context.paypalSmsBaselineCodes.add(code);
    if (!codes.length) {
      emitPaypalSmsEvent(context, logger, {
        eventType: "paypal-sms-baseline",
        message: "paypal sms baseline recorded",
        payload: {
          source: "baseline",
          codeCount: 0,
          httpOk: Boolean(snapshot.ok),
          status: snapshot.status || 0,
        },
      });
    }
    const result = recordPaypalSmsCodesForContext(context, {
      codes,
      source: "baseline",
      logger,
      eventType: "paypal-sms-baseline",
      message: "paypal sms baseline recorded",
      forceLog: true,
      extra: {
        httpOk: Boolean(snapshot.ok),
        status: snapshot.status || 0,
      },
    });
    if (isPaypalVerificationDebugEnabled(context)) {
      const state = await getHostedState(page, context).catch((error) => ({
        hostedStage: "debug_state_failed",
        hostedErrorText: error.message,
      }));
      await logPaypalVerificationDebugState(context, page, state, {
        logger,
        label: "paypal-sms-baseline",
        forceSnapshot: true,
        extra: {
          codeCount: codes.length,
          httpOk: Boolean(snapshot.ok),
          status: snapshot.status || 0,
        },
      });
    }
    return result;
  } catch (error) {
    emitPaypalSmsEvent(context, logger, {
      eventType: "paypal-sms-baseline-failed",
      message: "paypal sms baseline fetch failed; continuing checkout",
      level: "warn",
      payload: {
        error: error.message,
      },
    });
    return { recorded: 0, codes: [], error };
  }
}

async function logPaypalVerificationSubmitSnapshot(context = {}, page, {
  logger = null,
  forceFillAfterError = false,
} = {}) {
  if (!isPaypalVerificationDebugEnabled(context)) return;
  const state = await getHostedState(page, context).catch((error) => ({
    hostedStage: "debug_state_failed",
    hostedErrorText: error.message,
  }));
  await logPaypalVerificationDebugState(context, page, state, {
    logger,
    label: "paypal-verification-submit-code",
    forceSnapshot: true,
    extra: {
      codeLength: 6,
      forceFillAfterError,
    },
  });
}

export async function requestPaypalVerificationResend(context, page, {
  reason = "",
  logger = null,
  runHosted = runHostedStep,
  buildPayload = buildHostedGuestPayload,
} = {}) {
  if (context.paypalVerificationResendAttempted) {
    throw new Error("PayPal verification resend already attempted for this checkout");
  }
  setCheckoutSubstep(context, "paypal-verification-resend-code");
  if (isPaypalVerificationDebugEnabled(context)) {
    const beforeResendState = await getHostedState(page, context).catch((error) => ({
      hostedStage: "debug_state_failed",
      hostedErrorText: error.message,
    }));
    await logPaypalVerificationDebugState(context, page, beforeResendState, {
      logger,
      label: "resend-before-click",
      forceSnapshot: true,
      extra: { reason },
    });
  }

  let resendResult = null;
  try {
    resendResult = await runHosted(page, context, buildPayload(context, {
      requestVerificationResend: true,
    }));
  } catch (error) {
    if (!/未找到验证码再送按钮|resend button|再送按钮/i.test(String(error.message || ""))) {
      throw error;
    }
    logger?.warn?.("paypal verification resend button not found; falling back to close retry once", {
      reason,
      error: error.message,
    });
    const fallbackResult = await runHosted(page, context, buildPayload(context, {
      requestVerificationRetry: true,
      closeWaitMs: 2500,
    }));
    resendResult = {
      ...fallbackResult,
      verificationResendRequested: false,
      fallbackRetry: true,
      resendError: error.message,
    };
  }

  context.paypalVerificationResendAttempted = true;
  context.paypalVerificationResendReason = reason;
  context.paypalVerificationResendResult = resendResult;
  emitPaypalSmsEvent(context, logger, {
    eventType: "paypal-verification-resend-requested",
    message: "paypal verification resend requested",
    level: reason === "verification_error" ? "warn" : "info",
    payload: {
      reason,
      buttonText: resendResult?.buttonText || "",
      verificationRequired: Boolean(resendResult?.verificationRequired),
      fallbackRetry: Boolean(resendResult?.fallbackRetry),
      clicked: Boolean(resendResult?.verificationResendRequested),
    },
  });

  if (isPaypalVerificationDebugEnabled(context)) {
    const afterResendState = await getHostedState(page, context).catch((error) => ({
      hostedStage: "debug_state_failed",
      hostedErrorText: error.message,
    }));
    await logPaypalVerificationDebugState(context, page, afterResendState, {
      logger,
      label: "resend-after-click",
      forceSnapshot: true,
      extra: {
        reason,
        resendResult,
      },
    });
  }
  return resendResult;
}

export async function fetchPaypalSmsCodeWithSingleResend(context, page, {
  initialDelayMs = 0,
  pollIntervalMs = 3000,
  requestTimeoutMs = 15000,
  ignoreCodes = [],
  logger = null,
  fetchSmsCode = fetchPaypalSmsCode,
  runHosted = runHostedStep,
  buildPayload = buildHostedGuestPayload,
  firstWaitMs = PAYPAL_VERIFICATION_RESEND_WAIT_MS,
  afterResendWaitMs = PAYPAL_VERIFICATION_RESEND_WAIT_MS,
  getIgnoreCodes = null,
  onCodesIgnored = null,
  onCodeAccepted = null,
} = {}) {
  const firstWindowMs = Math.max(1000, Number(firstWaitMs) || PAYPAL_VERIFICATION_RESEND_WAIT_MS);
  const secondWindowMs = Math.max(1000, Number(afterResendWaitMs) || PAYPAL_VERIFICATION_RESEND_WAIT_MS);
  const firstInitialDelayMs = Math.max(0, Math.min(Number(initialDelayMs) || 0, firstWindowMs));
  const firstPollTimeoutMs = Math.max(1000, firstWindowMs - firstInitialDelayMs);
  let firstTimeoutError = null;
  try {
    return await fetchSmsCode(context.phoneLease, {
      initialDelayMs: firstInitialDelayMs,
      pollIntervalMs,
      timeoutMs: firstPollTimeoutMs,
      requestTimeoutMs,
      ignoreCodes,
      getIgnoreCodes,
      onCodesIgnored,
      onCodeAccepted,
    });
  } catch (error) {
    if (!isPaypalSmsTimeoutError(error)) throw error;
    firstTimeoutError = error;
  }

  if (context.paypalVerificationResendAttempted) {
    throw firstTimeoutError;
  }

  await requestPaypalVerificationResend(context, page, {
    reason: "sms_timeout",
    logger,
    runHosted,
    buildPayload,
  });

  return fetchSmsCode(context.phoneLease, {
    initialDelayMs: 0,
    pollIntervalMs,
    timeoutMs: secondWindowMs,
    requestTimeoutMs,
    ignoreCodes,
    getIgnoreCodes,
    onCodesIgnored,
    onCodeAccepted,
  });
}

function isUsablePage(page) {
  try {
    return Boolean(page) && !(typeof page.isClosed === "function" && page.isClosed());
  } catch {
    return false;
  }
}

function listContextPages(context, currentPage) {
  const pages = [];
  const add = (page) => {
    if (!isUsablePage(page) || pages.includes(page)) return;
    pages.push(page);
  };

  add(currentPage);
  const browserPages = typeof context.browserContext?.pages === "function"
    ? context.browserContext.pages()
    : [];
  for (const page of browserPages || []) add(page);
  return pages;
}

async function detectPageStageSafe(page) {
  try {
    return await detectPageStage(page);
  } catch (error) {
    return {
      stage: "detect_failed",
      url: safePageUrl(page),
      error: error.message,
    };
  }
}

async function tryConfirmPlusSessionOnPage(page, context, stage = null, { logger } = {}) {
  const pageStage = stage || await detectPageStageSafe(page);
  if (pageStage.stage !== "chatgpt") return null;
  try {
    const session = await readSessionJson(page);
    const plus = assertPlusSessionJson(session.sessionJson);
    context.sessionJson = session.sessionJson;
    context.checkoutAccessToken = session.accessToken;
    logger?.info?.("ChatGPT Plus session confirmed during checkout billing", {
      url: pageStage.url || safePageUrl(page),
      planType: plus.planType,
    });
    return {
      page,
      stage: pageStage,
      verified: { status: "done", reason: "plus_session_confirmed", planType: plus.planType },
    };
  } catch {
    return null;
  }
}

async function findConfirmedPlusSessionPage(context, currentPage, { logger } = {}) {
  const intervalMs = positiveInt(context.config?.runner?.chatgptPlusSessionProbeIntervalMs, 5000);
  const now = Date.now();
  if (context.lastChatgptPlusSessionProbeAt && now - context.lastChatgptPlusSessionProbeAt < intervalMs) {
    return null;
  }
  context.lastChatgptPlusSessionProbeAt = now;

  for (const page of listContextPages(context, currentPage)) {
    const stage = await detectPageStageSafe(page);
    const confirmed = await tryConfirmPlusSessionOnPage(page, context, stage, { logger });
    if (confirmed) return confirmed;
  }
  return null;
}

export async function findStagePage(context, currentPage, predicate, { preferStages = [] } = {}) {
  const matches = [];
  for (const page of listContextPages(context, currentPage)) {
    const stage = await detectPageStageSafe(page);
    if (predicate(stage)) matches.push({ page, stage });
  }

  for (const preferred of preferStages) {
    const match = matches.find((item) => item.stage?.stage === preferred);
    if (match) return match;
  }
  return matches[0] || null;
}

export async function waitForStageAcrossContext(context, currentPage, predicate, {
  timeoutMs = 120000,
  pollMs = 500,
  preferStages = [],
} = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = await findStagePage(context, currentPage, predicate, { preferStages });
    if (match) return match;

    const waitPage = isUsablePage(currentPage) ? currentPage : context.page;
    if (waitPage?.waitForTimeout) {
      await waitPage.waitForTimeout(pollMs);
    } else {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  return {
    page: currentPage,
    stage: await detectPageStageSafe(currentPage),
  };
}

function useStagePage(context, currentPage, match, { logger, reason = "" } = {}) {
  const nextPage = match?.page || currentPage;
  if (!nextPage || nextPage === currentPage) return currentPage;

  logger?.info?.("switched active checkout page", {
    reason,
    fromUrl: safePageUrl(currentPage),
    toUrl: match?.stage?.url || safePageUrl(nextPage),
    stage: match?.stage?.stage || "",
  });
  context.page = nextPage;
  return nextPage;
}

function isPostPaymentChatgptStage(stage = {}) {
  return stage.stage === "chatgpt_login" || stage.stage === "chatgpt";
}

async function resolvePostPaymentChatgptStage(context, page, stage = {}, { logger } = {}) {
  if (stage.stage === "chatgpt") {
    const confirmed = await tryConfirmPlusSessionOnPage(page, context, stage, { logger });
    if (confirmed) {
      setCheckoutSubstep(context, "chatgpt-plus-session-confirmed");
      return {
        status: "done",
        reason: "chatgpt_plus_session_confirmed",
        stage: confirmed.stage,
        verified: confirmed.verified,
      };
    }
  }
  setCheckoutSubstep(context, stage.stage === "chatgpt_login" ? "chatgpt-login-after-paypal" : "chatgpt-after-paypal");
  return { status: "done", reason: `${stage.stage}_after_paypal`, stage };
}

function getCheckoutAmountRetryMax(context) {
  const configured = context.config.checkoutConversion?.zeroAmountRetryMax
    ?? context.config.runner?.zeroAmountRetryMax
    ?? context.config.checkoutConversion?.maxAttempts
    ?? 3;
  const parsed = Number.parseInt(String(configured), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3;
}

function formatCheckoutAmount(amount = {}) {
  return amount.rawAmount || String(amount.amount ?? "");
}

function buildNonFreeTrialError({ retryMax, amount, causeMessage = "" } = {}) {
  const rawAmount = formatCheckoutAmount(amount) || "unknown";
  const suffix = causeMessage ? `; last error: ${causeMessage}` : "";
  return new RunnerError(`PLUS_CHECKOUT_NON_FREE_TRIAL::today due amount is not zero after ${retryMax} hosted URL retries (${rawAmount})${suffix}`, {
    code: "PLUS_CHECKOUT_NON_FREE_TRIAL",
    retryable: false,
  });
}

function buildPaypalPhoneRejectedError(state = {}) {
  const detail = String(state.hostedPhoneRejectedText || state.bodyTextPreview || "").trim();
  const suffix = detail ? `; ${detail}` : "";
  return new RunnerError(`PAYPAL_PHONE_REJECTED::PayPal rejected the current phone number${suffix}`, {
    code: "PAYPAL_PHONE_REJECTED",
    retryable: false,
  });
}

function parseAccessTokenFromSessionJson(sessionJson = "") {
  try {
    const parsed = JSON.parse(String(sessionJson || "{}"));
    return String(parsed.access_token || parsed.accessToken || "").trim();
  } catch {
    return "";
  }
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function resolveCheckoutAccessToken(page, context) {
  const debugToken = String(context.config.runner?.debugAccessToken || "").trim();
  if (debugToken) {
    context.checkoutAccessToken = debugToken;
    return debugToken;
  }
  if (context.checkoutAccessToken) return context.checkoutAccessToken;
  const sessionJsonToken = parseAccessTokenFromSessionJson(context.sessionJson);
  if (sessionJsonToken) {
    context.checkoutAccessToken = sessionJsonToken;
    return sessionJsonToken;
  }

  const stage = await detectPageStage(page);
  if (stage.stage !== "chatgpt") {
    throw new Error("cannot recreate checkout URL without cached ChatGPT accessToken");
  }
  const session = await readSessionJson(page);
  context.sessionJson = session.sessionJson;
  context.checkoutAccessToken = session.accessToken;
  return session.accessToken;
}

async function recreateCheckout(page, context, { logger, attempt, retryMax, amount, reason = "non_zero_amount" } = {}) {
  setCheckoutSubstep(context, "stripe-recreate-checkout");
  const accessToken = await resolveCheckoutAccessToken(page, context);
  const checkout = await createCheckout({ accessToken, config: context.config, logger });
  context.checkout = checkout;

  const target = resolveCheckoutOpenTarget(checkout, context.config);
  logger?.warn?.("recreated checkout URL", {
    reason,
    retryAttempt: attempt,
    retryMax,
    amount: formatCheckoutAmount(amount),
    checkoutSessionId: checkout.checkoutSessionId,
    targetType: target.type,
    targetPreference: target.preference,
    processorEntity: checkout.processorEntity,
    country: checkout.country,
    currency: checkout.currency,
    exitRegion: checkout.exitRegion,
    exitIp: checkout.exitIp,
  });

  return safeGotoWithRetry(page, target.url, {
    waitUntil: "domcontentloaded",
    timeoutMs: Number(context.config.runner?.pageLoadTimeoutMs || 120000),
    attempts: positiveInt(context.config.runner?.checkoutOpenNavigationAttempts, 3),
    retryDelayMs: positiveInt(context.config.runner?.checkoutOpenNavigationRetryDelayMs, 1500),
    onRetry: ({ attempt: navigationAttempt, maxAttempts, error }) => logger?.warn?.("recreated checkout URL navigation failed; retrying", {
      reason,
      retryAttempt: attempt,
      navigationAttempt,
      maxAttempts,
      amount: formatCheckoutAmount(amount),
      error: error.message,
    }),
  });
}

async function waitForCheckoutAmount(page, context, { logger } = {}) {
  setCheckoutSubstep(context, "stripe-check-amount");
  const timeoutMs = Number(context.config.runner?.checkoutAmountWaitTimeoutMs || 45000);
  const pollMs = Number(context.config.runner?.checkoutAmountPollMs || 1000);
  const startedAt = Date.now();
  let lastState = null;

  while (Date.now() - startedAt < timeoutMs) {
    const stage = await detectPageStage(page);
    if (stage.stage !== "hosted_checkout") {
      return { state: lastState, amount: lastState?.checkoutAmountSummary || null, stage };
    }
    try {
      const state = await getPlusCheckoutState(page, context);
      lastState = state;
      const amount = state?.checkoutAmountSummary;
      if (amount?.hasTodayDue) return { state, amount, stage };
    } catch (error) {
      logger?.warn?.("checkout amount inspection failed; retrying", {
        error: error.message,
        url: page.url(),
      });
      await ensurePlusCheckoutRuntime(page, context).catch(() => undefined);
    }
    await page.waitForTimeout(pollMs);
  }

  return {
    state: lastState,
    amount: lastState?.checkoutAmountSummary || { hasTodayDue: false, amount: null, isZero: false, rawAmount: "" },
    stage: await detectPageStage(page),
  };
}

async function runOpenAiHostedCheckout(page, context, { logger } = {}) {
  setCheckoutSubstep(context, "stripe-hosted");
  if (isStripePaypalRedirectSucceededUrl(page.url())) {
    context.stripePaypalRedirectSucceeded = true;
    return {
      status: "stripe_paypal_redirect_succeeded",
      stage: await detectPageStage(page),
    };
  }
  await ensurePlusCheckoutRuntime(page, context);
  const { amount, stage } = await waitForCheckoutAmount(page, context, { logger });
  if (stage?.stage === "payments_success") {
    return { status: "submitted", stage };
  }
  if (stage?.stage === "paypal") {
    return { status: "submitted", stage };
  }
  if (amount?.hasTodayDue && !amount.isZero) {
    return { status: "non_zero_amount", amount };
  }
  if (!amount?.hasTodayDue) {
    logger?.warn?.("checkout amount not detected; continuing to paypal selection", {
      url: page.url(),
    });
  }

  const result = await runPlusCheckoutMessage(page, context, {
    type: "RUN_HOSTED_OPENAI_CHECKOUT_STEP",
    payload: {
      email: context.pluginGuestProfile?.email || "",
      address: context.checkoutProfile?.address || {},
      readyTimeoutMs: Number(context.config.runner?.stripeHostedReadyTimeoutMs || 180000),
      readyStableMs: Number(context.config.runner?.stripeHostedReadyStableMs || 2000),
    },
  });
  logger?.info?.("hosted OpenAI checkout submit attempted", {
    clicked: Boolean(result?.clicked),
    loading: Boolean(result?.loading),
    reason: result?.reason || "",
    contactEmail: result?.contactEmail || context.pluginGuestProfile?.email || "",
    emailFilled: Boolean(result?.emailFillResult?.filled),
    hostedVerificationVisible: Boolean(result?.hostedVerificationVisible || result?.verificationPopupVisible),
    buttonText: result?.buttonText || "",
  });
  setCheckoutSubstep(context, "stripe-wait-paypal-redirect");
  if (result?.loading) {
    return { status: "loading", reason: result.reason || "hosted_checkout_loading_surface", stage: await detectPageStage(page) };
  }
  const redirected = await waitForStageAcrossContext(context, page, (item) => (
    item.stage === "paypal"
    || item.stage === "payments_success"
  ), {
    timeoutMs: Number(context.config.runner?.paypalRedirectTimeoutMs || 120000),
    pollMs: 500,
    preferStages: ["payments_success", "paypal"],
  });
  page = useStagePage(context, page, redirected, {
    logger,
    reason: "hosted_checkout_paypal_redirect",
  });
  return { status: "submitted", stage: redirected.stage, page };
}

export async function fillPlusCheckoutStep(context, { logger } = {}) {
  setCheckoutSubstep(context, "wait-checkout-page");
  let page = context.page;
  if (!page) throw new Error("fill-plus-checkout requires a browser page");
  if (context.plusAlreadyPaid || context.checkout?.alreadyPaid) {
    return { status: "skipped", reason: "already_paid", checkout: context.checkout || null };
  }

  let stageMatch = await waitForStageAcrossContext(context, page, (item) => (
    item.stage === "paypal"
    || item.stage === "hosted_checkout"
    || item.stage === "payments_success"
    || isPostPaymentChatgptStage(item)
  ), {
    timeoutMs: Number(context.config.runner?.checkoutTransitionTimeoutMs || 180000),
    pollMs: 500,
    preferStages: ["payments_success", "chatgpt_login", "chatgpt", "paypal", "hosted_checkout"],
  });
  page = useStagePage(context, page, stageMatch, {
    logger,
    reason: "checkout_transition",
  });
  let stage = stageMatch.stage;

  if (stage.stage === "payments_success") {
    setCheckoutSubstep(context, "payments-success");
    return { status: "skipped", reason: "already_on_payments_success", stage };
  }
  if (isPostPaymentChatgptStage(stage)) {
    return resolvePostPaymentChatgptStage(context, page, stage, { logger });
  }

  const maxMs = Number(context.config.runner?.paypalHostedTimeoutMs || 900000);
  const stuckRefreshMs = Number(context.config.runner?.paypalHostedStuckRefreshMs || 50000);
  const retryMax = Number(context.config.runner?.paypalVerificationMaxAttempts || 3);
  const verificationPostSubmitGraceMs = Number(context.config.runner?.paypalVerificationPostSubmitGraceMs || 90000);
  const startedAt = Date.now();
  let injectedUrl = "";
  let lastSignature = "";
  let lastProgressAt = Date.now();
  let verificationSeenAt = 0;
  let verificationSubmittedAt = 0;
  let verificationRetryCount = 0;
  let nonZeroAmountRetries = 0;
  const attemptedCodes = new Set();
  let lastSubmittedVerificationCode = "";
  let guestCheckoutSubmittedUrl = "";
  let guestCheckoutSubmittedAt = 0;
  let guestCheckoutWaitLoggedAt = 0;
  let guestCheckoutFilledUrl = "";
  let guestCheckoutFillWaitLoggedAt = 0;

  while (Date.now() - startedAt < maxMs) {
    const plusSessionMatch = await findConfirmedPlusSessionPage(context, page, { logger });
    if (plusSessionMatch) {
      page = useStagePage(context, page, plusSessionMatch, {
        logger,
        reason: "chatgpt_plus_session_confirmed",
      });
      setCheckoutSubstep(context, "chatgpt-plus-session-confirmed");
      return {
        status: "done",
        reason: "chatgpt_plus_session_confirmed",
        stage: plusSessionMatch.stage,
        verified: plusSessionMatch.verified,
      };
    }

    const activeMatch = await findStagePage(context, page, (item) => (
      item.stage === "paypal"
      || item.stage === "hosted_checkout"
      || item.stage === "payments_success"
      || isPostPaymentChatgptStage(item)
    ), {
      preferStages: ["payments_success", "chatgpt_login", "chatgpt", "paypal", "hosted_checkout"],
    });
    if (activeMatch) {
      page = useStagePage(context, page, activeMatch, {
        logger,
        reason: "checkout_loop",
      });
      stage = activeMatch.stage;
    } else {
      stage = await detectPageStage(page);
    }
    if (stage.stage === "payments_success") {
      setCheckoutSubstep(context, "payments-success");
      return { status: "done", reason: "payments_success", stage };
    }
    if (isPostPaymentChatgptStage(stage)) {
      return resolvePostPaymentChatgptStage(context, page, stage, { logger });
    }
    if (stage.stage !== "paypal" && stage.stage !== "hosted_checkout") {
      await page.waitForTimeout(1000);
      continue;
    }

    if (stage.stage === "hosted_checkout") {
      if (isStripePaypalRedirectSucceededUrl(stage.url)) {
        context.stripePaypalRedirectSucceeded = true;
        logger?.info?.("stripe hosted checkout reports PayPal redirect succeeded; deferring final Plus verification", {
          url: stage.url,
        });
        setCheckoutSubstep(context, "stripe-paypal-redirect-succeeded");
        return { status: "done", reason: "stripe_paypal_redirect_succeeded", stage };
      }
      const checkoutResult = await runOpenAiHostedCheckout(page, context, { logger });
      if (checkoutResult.status === "stripe_paypal_redirect_succeeded") {
        context.stripePaypalRedirectSucceeded = true;
        setCheckoutSubstep(context, "stripe-paypal-redirect-succeeded");
        return { status: "done", reason: "stripe_paypal_redirect_succeeded", stage: checkoutResult.stage };
      }
      if (checkoutResult.status === "loading") {
        setCheckoutSubstep(context, "stripe-loading");
        logger?.info?.("stripe hosted checkout still loading; waiting before PayPal selection", {
          reason: checkoutResult.reason || "",
          url: checkoutResult.stage?.url || page.url(),
        });
        await page.waitForTimeout(2000);
        continue;
      }
      if (checkoutResult.status === "non_zero_amount") {
        setCheckoutSubstep(context, "stripe-recreate-non-zero");
        const retryMax = getCheckoutAmountRetryMax(context);
        const amount = checkoutResult.amount || {};

        while (true) {
          if (nonZeroAmountRetries >= retryMax) {
            throw buildNonFreeTrialError({ retryMax, amount });
          }
          nonZeroAmountRetries += 1;
          try {
            stage = await recreateCheckout(page, context, {
              logger,
              attempt: nonZeroAmountRetries,
              retryMax,
              amount,
            });
            break;
          } catch (error) {
            if (nonZeroAmountRetries >= retryMax) {
              throw buildNonFreeTrialError({ retryMax, amount, causeMessage: error.message });
            }
            logger?.warn?.("checkout navigation failed; retrying with a new JP checkout URL", {
              retryAttempt: nonZeroAmountRetries,
              retryMax,
              amount: formatCheckoutAmount(amount),
              error: error.message,
            });
            await page.goto("about:blank", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
            await page.waitForTimeout(1000);
          }
        }

        injectedUrl = "";
        lastSignature = "";
        lastProgressAt = Date.now();
        await page.waitForTimeout(1000);
        continue;
      }
      stage = checkoutResult.stage;
      if (checkoutResult.page) {
        page = checkoutResult.page;
        context.page = page;
      }
      injectedUrl = "";
      lastSignature = "";
      lastProgressAt = Date.now();
      if (stage.stage === "payments_success") {
        setCheckoutSubstep(context, "payments-success");
        return { status: "done", reason: "payments_success_after_openai_hosted_checkout", stage };
      }
      if (isPostPaymentChatgptStage(stage)) {
        return resolvePostPaymentChatgptStage(context, page, stage, { logger });
      }
      if (stage.stage !== "paypal") {
        await page.waitForTimeout(1000);
        continue;
      }
    }

    if (page.url() !== injectedUrl) {
      await ensurePaypalRuntime(page, context);
      injectedUrl = page.url();
    }

    const state = await getHostedState(page, context);
    await logPaypalVerificationDebugState(context, page, state, {
      logger,
      label: "loop-state",
      extra: {
        stripeStage: stage.stage || "",
      },
    });

    if (page.url() !== injectedUrl) {
      await ensurePaypalRuntime(page, context);
      injectedUrl = page.url();
    }

    const signature = buildProgressSignature(stage, state);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= stuckRefreshMs) {
      if (
        state.hostedStage === "verification"
        && lastSubmittedVerificationCode
        && verificationSubmittedAt
        && !state.verificationErrorVisible
        && Date.now() - verificationSubmittedAt < verificationPostSubmitGraceMs
      ) {
        setCheckoutSubstep(context, "paypal-verification-post-submit-wait");
        logger?.warn?.("paypal verification still processing after code submit; waiting without reload", {
          elapsedMs: Date.now() - verificationSubmittedAt,
          graceMs: verificationPostSubmitGraceMs,
          url: page.url(),
        });
        lastProgressAt = Date.now();
        await page.waitForTimeout(2000);
        continue;
      }
      if ((state.hostedStage === "guest_checkout" || state.hasHostedGuestCheckout) && guestCheckoutSubmittedUrl === page.url()) {
        if (Date.now() - guestCheckoutWaitLoggedAt >= stuckRefreshMs) {
          logger?.warn?.("paypal guest checkout still waiting after submit; not reloading or refilling the same page", {
            url: page.url(),
          });
          guestCheckoutWaitLoggedAt = Date.now();
        }
        lastProgressAt = Date.now();
        await page.waitForTimeout(2000);
        continue;
      }
      logger?.warn?.("hosted checkout appears stuck; reloading page", {
        stage: state.hostedStage,
        url: page.url(),
      });
      setCheckoutSubstep(context, `paypal-reload-stuck-${state.hostedStage || "unknown"}`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: Number(context.config.runner?.pageLoadTimeoutMs || 120000) });
      injectedUrl = "";
      lastSignature = "";
      lastProgressAt = Date.now();
      verificationSeenAt = 0;
      continue;
    }

    if (state.hostedErrorVisible || state.hostedStage === "generic_error") {
      setCheckoutSubstep(context, "paypal-generic-error");
      const detail = String(state.hostedErrorText || state.bodyTextPreview || "").trim();
      const suffix = detail ? `; ${detail}` : "";
      throw new RunnerError(`PAYPAL_GENERIC_ERROR::PayPal checkout entered generic error page${suffix}`, {
        code: "PAYPAL_GENERIC_ERROR",
        retryable: true,
      });
    }

    if (state.hostedStage === "privacy_settings" || state.hostedPrivacySettingsVisible) {
      setCheckoutSubstep(context, "paypal-privacy-settings");
      const dismissResult = await runHostedStep(page, context, { dismissPrivacySettings: true });
      logger?.info?.("paypal privacy settings dismissed", {
        clicked: Number(dismissResult?.clicked || 0),
        clickedButtons: dismissResult?.clickedButtons || [],
        navigationScheduled: Boolean(dismissResult?.navigationScheduled),
        returnUrl: dismissResult?.returnUrl || "",
      });
      injectedUrl = "";
      lastSignature = "";
      lastProgressAt = Date.now();
      await page.waitForTimeout(dismissResult?.navigationScheduled ? 4500 : 1200);
      continue;
    }

    if (state.hostedPhoneRejected || state.hostedStage === "phone_rejected") {
      setCheckoutSubstep(context, "paypal-phone-rejected");
      throw buildPaypalPhoneRejectedError(state);
    }

    if (state.hostedBusyVisible) {
      setCheckoutSubstep(context, "paypal-busy");
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.hostedStage === "verification" && state.verificationInputsVisible) {
      setCheckoutSubstep(context, state.verificationErrorVisible ? "paypal-verification-retry" : "paypal-verification-wait-code");
      if (!verificationSeenAt) {
        verificationSeenAt = Date.now();
        await logPaypalVerificationDebugState(context, page, state, {
          logger,
          label: "verification-entered",
          forceSnapshot: true,
        });
      }
      if (
        lastSubmittedVerificationCode
        && verificationSubmittedAt
        && !state.verificationErrorVisible
        && Date.now() - verificationSubmittedAt < verificationPostSubmitGraceMs
      ) {
        setCheckoutSubstep(context, "paypal-verification-post-submit-wait");
        await page.waitForTimeout(2000);
        continue;
      }
      if (state.verificationErrorVisible) {
        verificationRetryCount += 1;
        if (verificationRetryCount > retryMax) {
          throw new Error(`PayPal verification failed too many times: ${state.verificationErrorText || "unknown error"}`);
        }
        if (lastSubmittedVerificationCode) attemptedCodes.add(lastSubmittedVerificationCode);
        if (lastSubmittedVerificationCode) {
          recordPaypalSmsCodesForContext(context, {
            codes: [lastSubmittedVerificationCode],
            source: "submitted",
            logger,
            eventType: "paypal-verification-submit-code",
            message: "paypal verification submitted code marked after error",
            forceLog: true,
            extra: {
              codeLength: lastSubmittedVerificationCode.length,
              verificationErrorVisible: true,
            },
          });
        }
        lastSubmittedVerificationCode = "";
        await logPaypalVerificationDebugState(context, page, state, {
          logger,
          label: "paypal-verification-error-resend",
          forceSnapshot: true,
          extra: {
            resendAlreadyAttempted: Boolean(context.paypalVerificationResendAttempted),
          },
        });
        if (context.paypalVerificationResendAttempted) {
          throw new RunnerError(`PAYPAL_VERIFICATION_FAILED_AFTER_RESEND::${state.verificationErrorText || "PayPal verification error after resend"}`, {
            code: "PAYPAL_VERIFICATION_FAILED_AFTER_RESEND",
            retryable: true,
          });
        }
        await requestPaypalVerificationResend(context, page, {
          reason: "verification_error",
          logger,
        });
        verificationSeenAt = Date.now();
        const resendCode = await fetchPaypalSmsCodeWithSingleResend(context, page, {
          initialDelayMs: 0,
          pollIntervalMs: Number(context.config.verification?.paypalSmsPollIntervalMs || 3000),
          requestTimeoutMs: Number(context.config.verification?.paypalSmsRequestTimeoutMs || 15000),
          ...buildPaypalSmsFetchCallbacks(context, {
            attemptedCodes: [...attemptedCodes],
            logger,
          }),
          logger,
        });
        lastSubmittedVerificationCode = resendCode;
        setCheckoutSubstep(context, "paypal-verification-submit-code");
        await runHostedStep(page, context, buildHostedGuestPayload(context, {
          verificationCode: resendCode,
          forceFillAfterError: true,
        }));
        recordPaypalSmsCodesForContext(context, {
          codes: [resendCode],
          source: "submitted",
          logger,
          eventType: "paypal-verification-submit-code",
          message: "paypal verification code submitted",
          forceLog: true,
          extra: {
            codeLength: resendCode.length,
            forceFillAfterError: true,
          },
        });
        await logPaypalVerificationSubmitSnapshot(context, page, {
          logger,
          forceFillAfterError: true,
        });
        verificationSubmittedAt = Date.now();
        lastProgressAt = verificationSubmittedAt;
        await page.waitForTimeout(3000);
        continue;
      }
      const initialDelayMs = Math.max(
        0,
        Number(context.config.verification?.paypalSmsInitialDelayMs ?? context.config.paypalPhone?.initialSmsDelayMs ?? 10000)
          - (Date.now() - verificationSeenAt),
      );
      const code = await fetchPaypalSmsCodeWithSingleResend(context, page, {
        initialDelayMs,
        pollIntervalMs: Number(context.config.verification?.paypalSmsPollIntervalMs || 3000),
        requestTimeoutMs: Number(context.config.verification?.paypalSmsRequestTimeoutMs || 15000),
        ...buildPaypalSmsFetchCallbacks(context, {
          attemptedCodes: [...attemptedCodes],
          logger,
        }),
        logger,
      });
      lastSubmittedVerificationCode = code;
      setCheckoutSubstep(context, "paypal-verification-submit-code");
      await runHostedStep(page, context, buildHostedGuestPayload(context, {
        verificationCode: code,
      }));
      recordPaypalSmsCodesForContext(context, {
        codes: [code],
        source: "submitted",
        logger,
        eventType: "paypal-verification-submit-code",
        message: "paypal verification code submitted",
        forceLog: true,
        extra: {
          codeLength: code.length,
          forceFillAfterError: false,
        },
      });
      await logPaypalVerificationSubmitSnapshot(context, page, {
        logger,
        forceFillAfterError: false,
      });
      verificationSubmittedAt = Date.now();
      lastProgressAt = verificationSubmittedAt;
      await page.waitForTimeout(3000);
      continue;
    }
    verificationSeenAt = 0;
    verificationSubmittedAt = 0;

    if (state.hostedStage === "pay_login") {
      setCheckoutSubstep(context, "paypal-login");
      await runHostedStep(page, context, buildHostedGuestPayload(context, {
        email: context.pluginGuestProfile.email,
      }));
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.hostedStage === "guest_checkout" || state.hasHostedGuestCheckout) {
      if (guestCheckoutSubmittedUrl === page.url()) {
        setCheckoutSubstep(context, "paypal-wait-after-submit");
        if (Date.now() - guestCheckoutSubmittedAt >= stuckRefreshMs && Date.now() - guestCheckoutWaitLoggedAt >= stuckRefreshMs) {
          logger?.warn?.("paypal guest checkout did not advance after submit; waiting without duplicate fill", {
            url: page.url(),
          });
          guestCheckoutWaitLoggedAt = Date.now();
        }
        await page.waitForTimeout(2000);
        continue;
      }
      const shouldSubmitGuestCheckout = guestCheckoutFilledUrl === page.url();
      setCheckoutSubstep(context, shouldSubmitGuestCheckout ? "paypal-submit-guest" : "paypal-fill-guest");
      if (shouldSubmitGuestCheckout) {
        await recordPaypalSmsBaseline(context, page, { logger });
      }
      const guestResult = await runHostedStep(page, context, buildHostedGuestPayload(context, {
        submitGuestCheckout: shouldSubmitGuestCheckout,
      }));
      if (guestResult?.stage && guestResult.stage !== "guest_checkout") {
        logger?.info?.("paypal hosted stage changed during guest checkout step", {
          previousStage: state.hostedStage || "",
          nextStage: guestResult.stage,
          url: page.url(),
          verificationRequired: Boolean(guestResult.requiresVerificationCode || guestResult.verificationRequired),
        });
        lastProgressAt = Date.now();
        await page.waitForTimeout(500);
        continue;
      }
      if (guestResult?.fillResults) {
        logger?.info?.("paypal guest checkout fill result", {
          fillResults: guestResult.fillResults,
          requiredFieldsReady: Boolean(guestResult.requiredFieldsReady),
          missingRequiredFields: guestResult.missingRequiredFields || [],
          countryCode: guestResult.countryCode || "",
          countrySelected: Boolean(guestResult.countrySelected),
          phoneCountryCode: guestResult.phoneCountryCode || "",
          phoneCountrySelected: Boolean(guestResult.phoneCountrySelected),
          fieldErrors: guestResult.fieldErrors || [],
        });
      }
      if (!shouldSubmitGuestCheckout) {
        if (!guestResult?.requiredFieldsReady) {
          if (Date.now() - guestCheckoutFillWaitLoggedAt >= 10000) {
            setCheckoutSubstep(context, "paypal-fill-guest-wait-fields");
            logger?.warn?.("paypal guest checkout fields not ready after fill; waiting before submit", {
              missingRequiredFields: guestResult?.missingRequiredFields || [],
              fieldErrors: guestResult?.fieldErrors || [],
              url: page.url(),
            });
            guestCheckoutFillWaitLoggedAt = Date.now();
          }
          await page.waitForTimeout(1500);
          continue;
        }
        guestCheckoutFilledUrl = page.url();
        await page.waitForTimeout(Number(context.config.runner?.paypalGuestSubmitDelayMs || 2500));
        continue;
      }
      if (guestResult?.submitted) {
        guestCheckoutSubmittedUrl = page.url();
        guestCheckoutSubmittedAt = Date.now();
        guestCheckoutWaitLoggedAt = 0;
      } else {
        guestCheckoutFilledUrl = "";
      }
      lastProgressAt = Date.now();
      await page.waitForTimeout(1500);
      continue;
    }

    if (state.hostedStage === "review_consent") {
      setCheckoutSubstep(context, "paypal-review-consent");
      await runHostedStep(page, context, buildHostedGuestPayload(context));
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.approveReady || state.hostedStage === "approval") {
      setCheckoutSubstep(context, "paypal-approval");
      await runHostedStep(page, context, buildHostedGuestPayload(context));
      await page.waitForTimeout(1500);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("PayPal hosted checkout automation timed out");
}
