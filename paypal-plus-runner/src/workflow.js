import { buildCheckoutProfile, toPluginGuestProfile } from "./providers/checkout-profile.js";

export const StepStatus = Object.freeze({
  DONE: "done",
  SKIPPED: "skipped",
  RETRY: "retry",
  FAILED: "failed",
});

export function stepResult(status, reason, extra = {}) {
  return { status, reason, ...extra };
}

export class WorkflowNotImplementedError extends Error {
  constructor(step) {
    super(`browser automation step is not implemented yet: ${step}`);
    this.name = "WorkflowNotImplementedError";
    this.step = step;
  }
}

export async function prepareRunContext({ account, phoneLease, config }) {
  const checkoutProfile = await buildCheckoutProfile({ phoneLease, config });
  return {
    account,
    phoneLease,
    checkoutProfile,
    pluginGuestProfile: toPluginGuestProfile(checkoutProfile),
    completedSteps: [],
    skippedSteps: [],
  };
}

export async function runWorkflow(context, { dryRun = false, logger } = {}) {
  const steps = [
    "open-chatgpt",
    "submit-signup-email",
    "fill-password",
    "fetch-signup-code",
    "fill-profile",
    "plus-checkout-create",
    "plus-checkout-billing",
    "paypal-approve",
    "plus-checkout-return",
    "session-json-import",
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
      skippedSteps: steps,
      sessionJson: "",
    };
  }

  throw new WorkflowNotImplementedError("open-chatgpt");
}
