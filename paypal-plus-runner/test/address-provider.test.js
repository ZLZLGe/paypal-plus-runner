import assert from "node:assert/strict";
import { fetchHostedAddress, normalizeAddress } from "../src/providers/address-provider.js";

assert.deepEqual(normalizeAddress({
  Trans_Address: "470-1264, Oyaguchi, Itabashi-ku, Tokyo",
  City: "Itabashi-ku",
  Zip_Code: "173-0035",
  State: "Itabashi-ku",
  countryCode: "JP",
}, {
  state: "Tokyo",
  countryCode: "JP",
}), {
  street: "470-1264, Oyaguchi, Itabashi-ku, Tokyo",
  city: "Itabashi-ku",
  state: "Tokyo",
  zip: "173-0035",
  countryCode: "JP",
});

{
  let requested = null;
  const address = await fetchHostedAddress({
    checkoutProfile: {
      addressProvider: "meiguodizhi",
      addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
      fallbackAddress: {
        street: "1-1-2 Otemachi",
        city: "Chiyoda-ku",
        state: "Tokyo",
        zip: "1000004",
        countryCode: "JP",
      },
    },
  }, {
    fetchImpl: async (url, options) => {
      requested = {
        url,
        body: JSON.parse(options.body),
      };
      return new Response(JSON.stringify({
        status: "ok",
        address: {
          Trans_Address: "470-1264, Oyaguchi, Itabashi-ku, Tokyo",
          City: "Itabashi-ku",
          Zip_Code: "173-0035",
          State: "Itabashi-ku",
        },
      }));
    },
  });
  assert.equal(requested.url, "https://www.meiguodizhi.com/api/v1/dz");
  assert.deepEqual(requested.body, {
    city: "Tokyo",
    path: "/jp-address",
    method: "refresh",
  });
  assert.equal(address.countryCode, "JP");
  assert.equal(address.zip, "173-0035");
  assert.equal(address.state, "Tokyo");
  assert.equal(address.source, "meiguodizhi:JP");
}
