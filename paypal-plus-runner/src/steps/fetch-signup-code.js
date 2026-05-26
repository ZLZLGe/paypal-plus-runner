import { injectSignupFlow, dispatchChromeRuntimeMessage } from "../browser/inject.js";
import { pollOpenAiEmailCode } from "../providers/ms-oauth2api-next-mail.js";

export async function fetchSignupCodeStep(context) {
  if (context.config.runner?.skipSignupSteps === true) {
    return { status: "skipped", reason: "skipSignupSteps" };
  }
  if (!context.page) throw new Error("fetch-signup-code requires a browser page");
  const { code, mailbox } = await pollOpenAiEmailCode(context.account, context.config);
  await injectSignupFlow(context.page, {
    pluginRoot: context.config.plugin?.root || "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2",
  });
  const result = await dispatchChromeRuntimeMessage(context.page, {
    type: "FILL_CODE",
    source: "runner",
    step: 4,
    payload: {
      visibleStep: 4,
      code,
      signupProfile: {
        firstName: context.checkoutProfile.guest.firstName,
        lastName: context.checkoutProfile.guest.lastName,
        age: Number(context.config.runner?.signupAge || 25),
      },
    },
  });
  if (result?.error) throw new Error(result.error);
  return { status: "done", reason: "signup_code_submitted", mailbox, result };
}
