import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractHeroSmsCode,
  fetchHeroSmsActiveActivations,
  parseHeroSmsActivation,
  pollHeroSmsActivationCode,
  recoverHeroSmsActivationByPhone,
  requestHeroSmsActivation,
} from "../src/providers/hero-sms.js";
import {
  discardOpenAiPhoneReuseActivation,
} from "../src/providers/openai-phone.js";

assert.deepEqual(parseHeroSmsActivation("ACCESS_NUMBER:12345:447700900123", {
  countryId: 16,
  countryLabel: "United Kingdom",
  serviceCode: "dr",
}), {
  provider: "hero-sms",
  serviceCode: "dr",
  countryId: 16,
  countryLabel: "United Kingdom",
  activationId: "12345",
  phoneNumber: "+447700900123",
});

assert.equal(extractHeroSmsCode("STATUS_OK: OpenAI code 123456"), "123456");
assert.equal(extractHeroSmsCode("STATUS_WAIT_CODE"), "");

{
  const requests = [];
  const activation = await requestHeroSmsActivation({
    openaiPhone: {
      provider: "hero-sms",
      heroSmsApiKey: "test-key",
      heroSmsCountryPool: "16:United Kingdom",
      heroSmsCountryId: 16,
      heroSmsCountryLabel: "United Kingdom",
      heroSmsServiceCode: "dr",
      requestTimeoutMs: 5000,
    },
  }, {
    fetchImpl: async (url) => {
      requests.push(new URL(url));
      const action = requests.at(-1).searchParams.get("action");
      if (action === "getPrices") {
        return new Response(JSON.stringify({ 16: { dr: { cost: 0.03, count: 12, physicalCount: 12 } } }));
      }
      if (action === "getNumberV2") {
        return new Response("BAD_ACTION");
      }
      return new Response("ACCESS_NUMBER:abc:+447700900456");
    },
  });
  assert.equal(activation.activationId, "abc");
  assert.equal(activation.phoneNumber, "+447700900456");
  assert.equal(activation.countryId, 16);
  assert.equal(requests.length, 3);
  assert.equal(requests[1].searchParams.get("action"), "getNumberV2");
  assert.equal(requests[1].searchParams.get("maxPrice"), "0.03");
  assert.equal(requests[1].searchParams.get("fixedPrice"), "true");
  assert.equal(requests[2].searchParams.get("action"), "getNumber");
  assert.equal(requests[1].searchParams.get("service"), "dr");
  assert.equal(requests[1].searchParams.get("country"), "16");
}

{
  const requests = [];
  const activation = await requestHeroSmsActivation({
    openaiPhone: {
      provider: "hero-sms",
      heroSmsApiKey: "test-key",
      heroSmsCountryPool: "16:United Kingdom,151:Chile,73:Brazil,33:Colombia",
      heroSmsServiceCode: "dr",
      heroSmsMaxPrice: "0.07",
      requestTimeoutMs: 5000,
    },
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const action = parsed.searchParams.get("action");
      const country = parsed.searchParams.get("country");
      if (action === "getPrices") {
        const prices = {
          16: { dr: { cost: 0.03, physicalCount: 0 } },
          151: { dr: { cost: 0.03, physicalCount: 10 } },
          73: { dr: { cost: 0.045, physicalCount: 100 } },
          33: { dr: { cost: 0.05, physicalCount: 100 } },
        };
        return new Response(JSON.stringify({ [country]: prices[country] }));
      }
      assert.equal(parsed.searchParams.get("maxPrice"), "0.03");
      assert.equal(parsed.searchParams.get("fixedPrice"), "true");
      assert.equal(country, "151");
      return new Response("ACCESS_NUMBER:cl1:+56912345678");
    },
  });
  assert.equal(activation.countryId, 151);
  assert.equal(activation.countryLabel, "Chile");
  assert.equal(activation.price, 0.03);
  assert.equal(activation.phoneNumber, "+56912345678");
  assert.equal(requests.filter((url) => url.searchParams.get("action") === "getPrices").length, 4);
}

{
  const requests = [];
  const activation = await requestHeroSmsActivation({
    openaiPhone: {
      provider: "hero-sms",
      heroSmsApiKey: "test-key",
      heroSmsCountryPool: "16:United Kingdom,151:Chile",
      heroSmsServiceCode: "dr",
      heroSmsMaxPrice: "0.50",
      requestTimeoutMs: 5000,
    },
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const action = parsed.searchParams.get("action");
      const country = parsed.searchParams.get("country");
      if (action === "getPrices") {
        return new Response(JSON.stringify({ [country]: { dr: { cost: country === "151" ? 0.06 : 0.09, physicalCount: 10 } } }));
      }
      assert.equal(country, "151");
      assert.equal(parsed.searchParams.get("maxPrice"), "0.06");
      return new Response("ACCESS_NUMBER:cap-ok:+56912345678");
    },
  });
  assert.equal(activation.countryId, 151);
  assert.equal(requests.some((url) => url.searchParams.get("country") === "16" && url.searchParams.get("action") !== "getPrices"), false);
}

{
  await assert.rejects(
    () => requestHeroSmsActivation({
      openaiPhone: {
        provider: "hero-sms",
        heroSmsApiKey: "test-key",
        heroSmsCountryPool: "16:United Kingdom,151:Chile,73:Brazil,33:Colombia",
        heroSmsServiceCode: "dr",
        heroSmsMaxPrice: "0.07",
        requestTimeoutMs: 5000,
      },
    }, {
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.searchParams.get("action") === "getPrices") {
          const country = parsed.searchParams.get("country");
          return new Response(JSON.stringify({ [country]: { dr: { cost: 0.071, physicalCount: 99 } } }));
        }
        return new Response("ACCESS_NUMBER:too-expensive:+5511999999999");
      },
    }),
    /<=0\.07/,
  );
}

{
  let calls = 0;
  const result = await pollHeroSmsActivationCode({
    openaiPhone: {
      heroSmsApiKey: "test-key",
      pollTimeoutMs: 5000,
      pollIntervalMs: 1000,
      requestTimeoutMs: 5000,
    },
  }, {
    provider: "hero-sms",
    activationId: "abc",
    phoneNumber: "+447700900456",
    statusAction: "getStatus",
  }, {
    ignoreCodes: ["111111"],
    timeoutMs: 5000,
    intervalMs: 1000,
  }, {
    fetchImpl: async () => {
      calls += 1;
      return new Response(calls === 1 ? "STATUS_OK:111111" : "STATUS_OK:222222");
    },
  });
  assert.equal(result.code, "222222");
  assert.equal(calls, 2);
}

{
  const requests = [];
  const activation = await requestHeroSmsActivation({
    openaiPhone: {
      provider: "hero-sms",
      heroSmsApiKey: "test-key",
      heroSmsCountryPool: "151:Chile",
      heroSmsServiceCode: "dr",
      heroSmsMaxPrice: "0.07",
      heroSmsNumberRequestAttempts: 2,
      heroSmsNumberRequestRetryDelayMs: 1,
      requestTimeoutMs: 5000,
    },
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requests.push(parsed);
      const action = parsed.searchParams.get("action");
      if (action === "getPrices") {
        return new Response(JSON.stringify({ 151: { dr: { cost: 0.03, physicalCount: 1 } } }));
      }
      const getNumberCalls = requests.filter((item) => item.searchParams.get("action") === "getNumber").length;
      if (action === "getNumberV2") return new Response("BAD_ACTION");
      return new Response(getNumberCalls === 1 ? "NO_NUMBERS" : "ACCESS_NUMBER:retry-ok:+56912345678");
    },
  });
  assert.equal(activation.activationId, "retry-ok");
  assert.equal(activation.countryId, 151);
  assert.equal(requests.filter((url) => url.searchParams.get("action") === "getPrices").length, 2);
  assert.equal(requests.filter((url) => url.searchParams.get("action") === "getNumber").length, 2);
}

{
  const activations = await fetchHeroSmsActiveActivations({
    openaiPhone: {
      heroSmsApiKey: "test-key",
      heroSmsCountryId: 16,
      heroSmsCountryLabel: "United Kingdom",
      heroSmsServiceCode: "dr",
    },
  }, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      assert.equal(parsed.searchParams.get("action"), "getActiveActivations");
      return new Response(JSON.stringify({
        activations: [
          { activationId: "keep", phoneNumber: "447706647244" },
        ],
      }));
    },
  });
  assert.equal(activations.length, 1);
  assert.equal(activations[0].activationId, "keep");
  assert.equal(activations[0].phoneNumber, "+447706647244");
}

{
  const recovered = await recoverHeroSmsActivationByPhone({
    openaiPhone: {
      heroSmsApiKey: "test-key",
      heroSmsCountryId: 16,
      heroSmsCountryLabel: "United Kingdom",
      heroSmsServiceCode: "dr",
    },
  }, "+447706647244", {
    fetchImpl: async () => new Response(JSON.stringify({
      activations: [
        { activationId: "other", phoneNumber: "447700900456" },
        { activationId: "target", phoneNumber: "447706647244" },
      ],
    })),
  });
  assert.equal(recovered.activationId, "target");
}

{
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-phone-reuse-"));
  const reuseFile = path.join(tmpDir, "activation.json");
  fs.writeFileSync(reuseFile, JSON.stringify({
    provider: "hero-sms",
    activationId: "registered",
    phoneNumber: "+447700900999",
  }));
  const result = discardOpenAiPhoneReuseActivation({
    provider: "hero-sms",
    activationId: "registered",
    phoneNumber: "+447700900999",
    reuseFile,
  }, {
    openaiPhone: {
      heroSmsReuseFile: reuseFile,
    },
  });
  assert.equal(result.discarded, true);
  assert.equal(fs.existsSync(reuseFile), false);
}

console.log("hero-sms tests passed");
