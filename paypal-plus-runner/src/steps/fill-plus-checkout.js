import { createCheckout } from "../checkout-conversion/index.js";
import { resolveCheckoutOpenTarget } from "../checkout-conversion/hosted-url.js";
import {
  detectPageStage,
  isStripePaypalRedirectSucceededUrl,
  safeGotoWithRetry,
  waitForUrlStage,
} from "../browser/page-utils.js";
import { injectPaypalFlow, injectPlusCheckoutFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { fetchPaypalSmsCode } from "../providers/paypal-phone-code.js";
import { readSessionJson } from "../providers/session-json.js";
import { RunnerError } from "../utils/errors.js";
import {
  buildPaypalRiskBlockedError,
  inspectPaypalRiskBlockedPage,
  isPaypalRiskBlockedState,
} from "./paypal-risk.js";

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
    onRetry: context ? () => ensurePaypalRuntime(page, context) : null,
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

function buildAddressSeed(context) {
  const address = context.checkoutProfile?.address || {};
  return {
    countryCode: address.countryCode || "US",
    forceCountrySelectionBeforeAutocomplete: true,
    skipAutocomplete: true,
    autoCheckAgreement: true,
    fallback: {
      address1: address.street || "123 Main St",
      city: address.city || "New York",
      region: address.state || "New York",
      postalCode: address.zip || "10001",
    },
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
    state.hostedBusyVisible ? "busy" : "",
  ].join("|");
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

async function recreateCheckout(page, context, { logger, attempt, retryMax, amount } = {}) {
  const accessToken = await resolveCheckoutAccessToken(page, context);
  const checkout = await createCheckout({ accessToken, config: context.config, logger });
  context.checkout = checkout;

  const target = resolveCheckoutOpenTarget(checkout, context.config);
  logger?.warn?.("checkout amount is not zero; recreated checkout URL", {
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
      retryAttempt: attempt,
      navigationAttempt,
      maxAttempts,
      amount: formatCheckoutAmount(amount),
      error: error.message,
    }),
  });
}

async function waitForCheckoutAmount(page, context, { logger } = {}) {
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
      address: context.checkoutProfile?.address || {},
    },
  });
  logger?.info?.("hosted OpenAI checkout submit attempted", {
    clicked: Boolean(result?.clicked),
    hostedVerificationVisible: Boolean(result?.hostedVerificationVisible || result?.verificationPopupVisible),
    buttonText: result?.buttonText || "",
  });
  const redirectedStage = await waitForUrlStage(page, (item) => (
    item.stage === "paypal"
    || item.stage === "payments_success"
  ), {
    timeoutMs: Number(context.config.runner?.paypalRedirectTimeoutMs || 120000),
    pollMs: 500,
  });
  return { status: "submitted", stage: redirectedStage };
}

export async function fillPlusCheckoutStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("fill-plus-checkout requires a browser page");
  if (context.plusAlreadyPaid || context.checkout?.alreadyPaid) {
    return { status: "skipped", reason: "already_paid", checkout: context.checkout || null };
  }

  let stage = await waitForUrlStage(page, (item) => (
    item.stage === "paypal"
    || item.stage === "hosted_checkout"
    || item.stage === "payments_success"
  ), {
    timeoutMs: Number(context.config.runner?.checkoutTransitionTimeoutMs || 180000),
    pollMs: 500,
  });

  if (stage.stage === "payments_success") {
    return { status: "skipped", reason: "already_on_payments_success", stage };
  }

  const maxMs = Number(context.config.runner?.paypalHostedTimeoutMs || 900000);
  const stuckRefreshMs = Number(context.config.runner?.paypalHostedStuckRefreshMs || 90000);
  const retryMax = Number(context.config.runner?.paypalVerificationMaxAttempts || 3);
  const startedAt = Date.now();
  let injectedUrl = "";
  let lastSignature = "";
  let lastProgressAt = Date.now();
  let verificationSeenAt = 0;
  let verificationRetryCount = 0;
  let nonZeroAmountRetries = 0;
  const attemptedCodes = new Set();
  let lastSubmittedVerificationCode = "";

  while (Date.now() - startedAt < maxMs) {
    stage = await detectPageStage(page);
    if (stage.stage === "payments_success") {
      return { status: "done", reason: "payments_success", stage };
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
        return { status: "done", reason: "stripe_paypal_redirect_succeeded", stage };
      }
      const checkoutResult = await runOpenAiHostedCheckout(page, context, { logger });
      if (checkoutResult.status === "stripe_paypal_redirect_succeeded") {
        context.stripePaypalRedirectSucceeded = true;
        return { status: "done", reason: "stripe_paypal_redirect_succeeded", stage: checkoutResult.stage };
      }
      if (checkoutResult.status === "non_zero_amount") {
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
      injectedUrl = "";
      lastSignature = "";
      lastProgressAt = Date.now();
      if (stage.stage === "payments_success") {
        return { status: "done", reason: "payments_success_after_openai_hosted_checkout", stage };
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
    if (isPaypalRiskBlockedState(state)) {
      logger?.warn?.("paypal risk block detected", {
        stage: state.hostedStage,
        reason: state.riskBlockReason || "",
        visibleControlCount: state.visibleControlCount,
        url: page.url(),
      });
      throw buildPaypalRiskBlockedError(state, stage);
    }

    const riskSnapshot = await inspectPaypalRiskBlockedPage(page).catch((error) => ({
      riskBlocked: false,
      reason: `risk_inspection_failed:${error.message}`,
    }));
    if (riskSnapshot.riskBlocked) {
      logger?.warn?.("paypal risk block detected from DOM snapshot", {
        reason: riskSnapshot.reason,
        visibleControlCount: riskSnapshot.visibleControlCount,
        path: riskSnapshot.path,
        url: page.url(),
      });
      throw buildPaypalRiskBlockedError(riskSnapshot, stage);
    }

    const signature = buildProgressSignature(stage, state);
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt >= stuckRefreshMs) {
      logger?.warn?.("hosted checkout appears stuck; reloading page", {
        stage: state.hostedStage,
        url: page.url(),
      });
      await page.reload({ waitUntil: "domcontentloaded", timeout: Number(context.config.runner?.pageLoadTimeoutMs || 120000) });
      injectedUrl = "";
      lastSignature = "";
      lastProgressAt = Date.now();
      verificationSeenAt = 0;
      continue;
    }

    if (state.hostedErrorVisible || state.hostedStage === "generic_error") {
      return { status: "done", reason: "paypal_generic_error_treated_as_terminal", stage, state };
    }

    if (state.hostedBusyVisible) {
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.hostedStage === "verification" && state.verificationInputsVisible) {
      if (!verificationSeenAt) verificationSeenAt = Date.now();
      if (state.verificationErrorVisible) {
        verificationRetryCount += 1;
        if (verificationRetryCount > retryMax) {
          throw new Error(`PayPal verification failed too many times: ${state.verificationErrorText || "unknown error"}`);
        }
        if (lastSubmittedVerificationCode) attemptedCodes.add(lastSubmittedVerificationCode);
        lastSubmittedVerificationCode = "";
        await runHostedStep(page, context, { requestVerificationRetry: true, closeWaitMs: 2500 });
        verificationSeenAt = Date.now();
        await page.waitForTimeout(1000);
        continue;
      }
      const initialDelayMs = Math.max(
        0,
        Number(context.config.verification?.paypalSmsInitialDelayMs ?? context.config.paypalPhone?.initialSmsDelayMs ?? 10000)
          - (Date.now() - verificationSeenAt),
      );
      const code = await fetchPaypalSmsCode(context.phoneLease, {
        initialDelayMs,
        pollIntervalMs: Number(context.config.verification?.paypalSmsPollIntervalMs || 3000),
        timeoutMs: Number(context.config.verification?.paypalSmsMaxAttempts || 60)
          * Number(context.config.verification?.paypalSmsPollIntervalMs || 3000),
        requestTimeoutMs: Number(context.config.verification?.paypalSmsRequestTimeoutMs || 15000),
        ignoreCodes: [...attemptedCodes],
      });
      lastSubmittedVerificationCode = code;
      await runHostedStep(page, context, { verificationCode: code });
      await page.waitForTimeout(3000);
      continue;
    }
    verificationSeenAt = 0;

    if (state.hostedStage === "pay_login") {
      await runHostedStep(page, context, { email: context.pluginGuestProfile.email });
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.hostedStage === "guest_checkout" || state.hasHostedGuestCheckout) {
      await runHostedStep(page, context, context.pluginGuestProfile);
      await page.waitForTimeout(1500);
      continue;
    }

    if (state.hostedStage === "review_consent") {
      await runHostedStep(page, context, {});
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.approveReady || state.hostedStage === "approval") {
      await runHostedStep(page, context, {});
      await page.waitForTimeout(1500);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("PayPal hosted checkout automation timed out");
}
