import { detectPageStage, waitForUrlStage } from "../browser/page-utils.js";
import { injectPaypalFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { fetchPaypalSmsCode } from "../providers/paypal-phone-code.js";

async function ensurePaypalRuntime(page, context) {
  await injectPaypalFlow(page, {
    pluginRoot: context.config.plugin?.root || "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2",
  });
}

async function getHostedState(page) {
  const result = await dispatchChromeRuntimeMessage(page, {
    type: "PAYPAL_HOSTED_GET_STATE",
    source: "runner",
  });
  if (result?.error) throw new Error(result.error);
  return result;
}

async function runHostedStep(page, payload = {}) {
  const result = await dispatchChromeRuntimeMessage(page, {
    type: "PAYPAL_RUN_HOSTED_CHECKOUT_STEP",
    source: "runner",
    payload,
  });
  if (result?.error) throw new Error(result.error);
  return result;
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

export async function fillPlusCheckoutStep(context, { logger } = {}) {
  const page = context.page;
  if (!page) throw new Error("fill-plus-checkout requires a browser page");

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
  const attemptedCodes = new Set();

  while (Date.now() - startedAt < maxMs) {
    stage = await detectPageStage(page);
    if (stage.stage === "payments_success") {
      return { status: "done", reason: "payments_success", stage };
    }
    if (stage.stage !== "paypal" && stage.stage !== "hosted_checkout") {
      await page.waitForTimeout(1000);
      continue;
    }

    if (page.url() !== injectedUrl) {
      await ensurePaypalRuntime(page, context);
      injectedUrl = page.url();
    }

    const state = await getHostedState(page);
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
        await runHostedStep(page, { requestVerificationRetry: true, closeWaitMs: 2500 });
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
      attemptedCodes.add(code);
      await runHostedStep(page, { verificationCode: code });
      await page.waitForTimeout(3000);
      continue;
    }
    verificationSeenAt = 0;

    if (state.hostedStage === "pay_login") {
      await runHostedStep(page, { email: context.pluginGuestProfile.email });
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.hostedStage === "guest_checkout" || state.hasHostedGuestCheckout) {
      await runHostedStep(page, context.pluginGuestProfile);
      await page.waitForTimeout(1500);
      continue;
    }

    if (state.hostedStage === "review_consent") {
      await runHostedStep(page, {});
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.approveReady || state.hostedStage === "approval") {
      throw new Error("hosted checkout unexpectedly reached normal PayPal approval page");
    }

    await page.waitForTimeout(1000);
  }

  throw new Error("PayPal hosted checkout automation timed out");
}
