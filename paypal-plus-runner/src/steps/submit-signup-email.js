import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";

async function ensureSignupRuntime(context) {
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root || "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2",
  });
}

export async function submitSignupEmailStep(context) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("submit-signup-email requires a browser page");
  await ensureSignupRuntime(context);
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "EXECUTE_NODE",
    source: "runner",
    nodeId: "submit-signup-email",
    payload: {
      nodeId: "submit-signup-email",
      email: context.account.email,
      visibleStep: 2,
      signupMethod: "email",
    },
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "signup_email_submitted", result };
}
