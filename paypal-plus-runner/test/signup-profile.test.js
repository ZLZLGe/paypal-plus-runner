import assert from "node:assert/strict";
import { buildSignupProfilePayload } from "../src/steps/signup-profile.js";

{
  const payload = buildSignupProfilePayload({
    checkoutProfile: {
      guest: {
        firstName: "Mai",
        lastName: "Wakita",
        dateOfBirth: "04/15/1986",
      },
    },
    config: { runner: { signupAge: 25 } },
  });
  assert.equal(payload.firstName, "Mai");
  assert.equal(payload.lastName, "Wakita");
  assert.equal(payload.year, 1986);
  assert.equal(payload.month, 4);
  assert.equal(payload.day, 15);
  assert.equal(payload.age, 25);
}

{
  const payload = buildSignupProfilePayload({
    checkoutProfile: {
      guest: {
        firstName: "Mai",
        lastName: "Wakita",
      },
    },
    config: { runner: {} },
  });
  assert.equal(payload.year, 1986);
  assert.equal(payload.month, 4);
  assert.equal(payload.day, 15);
}

{
  const payload = buildSignupProfilePayload({
    checkoutProfile: {
      guest: {
        firstName: "Mai",
        lastName: "Wakita",
        dateOfBirth: "2026/05/31",
      },
    },
    config: { runner: { signupDateOfBirth: "1988-07-09" } },
  });
  assert.equal(payload.year, 1988);
  assert.equal(payload.month, 7);
  assert.equal(payload.day, 9);
}

console.log("signup-profile tests passed");

