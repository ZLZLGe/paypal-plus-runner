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
import { WorkflowNotImplementedError } from "./utils/errors.js";

export const StepStatus = Object.freeze({
  DONE: "done",
  SKIPPED: "skipped",
  RETRY: "retry",
  FAILED: "failed",
});

export function stepResult(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

export async function prepareRunContext({ account, phoneLease, config, windowInfo = null, runId = "", workerId = "" }) {
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
    checkoutProfile,
    pluginGuestProfile: toPluginGuestProfile(checkoutProfile),
    completedSteps: [],
    skippedSteps: [],
  };
}

export async function runWorkflow(context, { dryRun = false, logger } = {}) {
  const accessToken = String(context.config.runner?.debugAccessToken || "").trim();
  const steps = [
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

  if (dryRun) {
    logger?.info?.("workflow dry-run prepared", {
      email: context.account.email,
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
    };
  }

  const results = {};
  for (const [name, fn] of steps) {
    logger?.info?.("workflow step start", { step: name, email: context.account.email });
    try {
      const result = await fn(context, { logger, accessToken });
      results[name] = result;
      if (result?.status === StepStatus.SKIPPED) {
        context.skippedSteps.push(name);
      } else {
        context.completedSteps.push(name);
      }
      if (result?.sessionJson) context.sessionJson = result.sessionJson;
      if (result?.checkout) context.checkout = result.checkout;
      logger?.info?.("workflow step complete", { step: name, status: result?.status || "done", reason: result?.reason || "" });
    } catch (error) {
      if (error instanceof WorkflowNotImplementedError) throw error;
      error.step = error.step || name;
      throw error;
    }
  }

  return {
    status: StepStatus.DONE,
    reason: "workflow_complete",
    completedSteps: context.completedSteps,
    skippedSteps: context.skippedSteps,
    results,
    sessionJson: context.sessionJson || results["session-json-import"]?.sessionJson || "",
    roxyDirId: context.windowInfo?.dirId || "",
    roxyExitIp: context.windowInfo?.exitIp || "",
  };
}
