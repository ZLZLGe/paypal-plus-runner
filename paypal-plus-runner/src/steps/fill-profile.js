import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";

export async function fillProfileStep(context) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("fill-profile requires a browser page");
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root || "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2",
  });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "EXECUTE_NODE",
    source: "runner",
    nodeId: "fill-profile",
    payload: {
      nodeId: "fill-profile",
      visibleStep: 5,
      firstName: context.checkoutProfile.guest.firstName,
      lastName: context.checkoutProfile.guest.lastName,
      age: Number(context.config.runner?.signupAge || 25),
    },
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "profile_submitted", result };
}
