import assert from "node:assert/strict";
import fs from "node:fs";
import {
  inspectStrictSignupEmailEntryHtml,
  isThirdPartyOAuthDetourUrl,
  STRICT_SIGNUP_EMAIL_SELECTORS,
} from "../src/steps/submit-signup-email.js";

assert.equal(isThirdPartyOAuthDetourUrl("https://accounts.google.com/v3/signin/identifier"), true);
assert.equal(isThirdPartyOAuthDetourUrl("https://appleid.apple.com/auth/authorize"), true);
assert.equal(isThirdPartyOAuthDetourUrl("https://login.live.com/oauth20_authorize.srf"), true);
assert.equal(isThirdPartyOAuthDetourUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"), true);
assert.equal(isThirdPartyOAuthDetourUrl("https://chatgpt.com/auth/login"), false);
assert.equal(isThirdPartyOAuthDetourUrl("https://auth.openai.com/u/signup"), false);
assert.equal(isThirdPartyOAuthDetourUrl("not-a-url"), false);

const chatgptLoginHtml = `
  <div data-testid="login-form">
    <h2>Log in or sign up</h2>
    <form autocomplete="on" novalidate>
      <button type="button"><div>Continue with Google</div></button>
      <button type="button"><div>Continue with Apple</div></button>
      <button type="button"><div>Continue with phone</div></button>
      <div>
        <label for="email"></label>
        <input
          type="email"
          id="email"
          aria-label="Email address"
          placeholder="Email address"
          autocomplete="email webauthn"
          name="email"
          value=""
        >
      </div>
      <button type="submit"><div>Continue</div></button>
    </form>
  </div>
`;
const chatgptEntry = inspectStrictSignupEmailEntryHtml(chatgptLoginHtml, "https://chatgpt.com/auth/login");
assert.equal(chatgptEntry.ok, true);
assert.equal(chatgptEntry.hasExactEmailInput, true);
assert.equal(chatgptEntry.hasStrictSubmitButton, true);
assert.equal(STRICT_SIGNUP_EMAIL_SELECTORS.emailInput, "[data-testid='login-form'] form input#email[name='email'][type='email'][aria-label='Email address']");
assert.equal(STRICT_SIGNUP_EMAIL_SELECTORS.submitButton, "[data-testid='login-form'] form button[type='submit']");

const googleOauthHtml = `
  <base href="https://accounts.google.com/v3/signin/">
  <input
    type="email"
    class="whsOnd zHQkBf"
    autocomplete="username webauthn"
    aria-label="Email or phone"
    name="identifier"
    id="identifierId"
  >
  <div id="identifierNext"><button>Next</button></div>
`;
const googleEntry = inspectStrictSignupEmailEntryHtml(googleOauthHtml, "https://accounts.google.com/v3/signin/identifier");
assert.equal(googleEntry.ok, false);
assert.equal(googleEntry.reason, "third_party_oauth_detour");
assert.equal(googleEntry.hasExactEmailInput, false);
assert.equal(googleEntry.hasStrictSubmitButton, false);

const broadButWrongEmailHtml = `
  <form>
    <input type="email" name="identifier" id="identifierId" aria-label="Email or phone">
    <button type="submit">Next</button>
  </form>
`;
const wrongEntry = inspectStrictSignupEmailEntryHtml(broadButWrongEmailHtml, "https://chatgpt.com/auth/login");
assert.equal(wrongEntry.ok, false);
assert.equal(wrongEntry.reason, "missing_strict_signup_email_entry");
assert.equal(wrongEntry.hasExactEmailInput, false);

const optionalArtifact = "output/worker_1_20260527110412678_ee9dd62b/submit-signup-email.html";
if (fs.existsSync(optionalArtifact)) {
  const artifactEntry = inspectStrictSignupEmailEntryHtml(fs.readFileSync(optionalArtifact, "utf8"), "https://chatgpt.com/auth/login");
  assert.equal(artifactEntry.ok, true);
}

console.log("signup-detour tests passed");
