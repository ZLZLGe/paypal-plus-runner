import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";

export async function fillPasswordStep(context) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("fill-password requires a browser page");
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root || "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2",
  });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "EXECUTE_NODE",
    source: "runner",
    nodeId: "fill-password",
    payload: {
      nodeId: "fill-password",
      visibleStep: 3,
      email: context.account.email,
      password: context.config.runner?.gptPassword || "myPASSword!",
      accountIdentifierType: "email",
      accountIdentifier: context.account.email,
    },
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "signup_password_submitted", result };
}
