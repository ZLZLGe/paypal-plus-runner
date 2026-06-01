import assert from "node:assert/strict";
import { fetchHostedAddress, normalizeAddress } from "../src/providers/address-provider.js";
import { buildCheckoutProfile, toPluginGuestProfile } from "../src/providers/checkout-profile.js";

function isLuhnValid(value = "") {
  const digits = String(value || "").replace(/\D+/g, "");
  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number.parseInt(digits[index], 10);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return digits.length >= 13 && sum % 10 === 0;
}

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
  providerProfile: {
    fullName: "",
    firstName: "",
    lastName: "",
    kanaFirstName: "",
    kanaLastName: "",
    title: "",
    phone: "",
    email: "",
    username: "",
    password: "",
    birthday: "",
    dateOfBirth: "",
    card: {
      number: "",
      expiry: "",
      cvv: "",
      type: "",
      last4: "",
    },
  },
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
  assert.equal(address.providerProfile.fullName, "");
}

{
  const address = normalizeAddress({
    Trans_Address: "1246-4, Honshio-cho, Shinjuku-ku, Tokyo",
    City: "Tokyo",
    Zip_Code: "160-0003",
    State: "Tokyo",
    countryCode: "JP",
    Full_Name: "より 金居",
    Telephone: "+8182-976-1342",
    Expires: "07/2030",
    Credit_Card_Type: "JCB",
    Credit_Card_Number: "3555125332518198",
    CVV2: "554",
    Temporary_mail: "kqdwwwdecb@iubridge.com",
    Birthday: "4/15/1986",
  }, {
    countryCode: "JP",
  });
  assert.equal(address.providerProfile.fullName, "より 金居");
  assert.equal(address.providerProfile.firstName, "より");
  assert.equal(address.providerProfile.lastName, "金居");
  assert.equal(address.providerProfile.kanaFirstName, "より");
  assert.equal(address.providerProfile.kanaLastName, "");
  assert.equal(address.providerProfile.phone, "+8182-976-1342");
  assert.equal(address.providerProfile.email, "kqdwwwdecb@iubridge.com");
  assert.equal(address.providerProfile.birthday, "4/15/1986");
  assert.equal(address.providerProfile.dateOfBirth, "04/15/1986");
  assert.deepEqual(address.providerProfile.card, {
    number: "3555125332518198",
    expiry: "07 / 30",
    cvv: "554",
    type: "JCB",
    last4: "8198",
  });
}

{
  const profile = await buildCheckoutProfile({
    phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
    config: {
      checkoutProfile: {
        addressProvider: "meiguodizhi",
        addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
        hostedAddressCountryCode: "JP",
        fallbackAddress: { countryCode: "JP" },
        minAge: 21,
      },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      address: {
        Full_Name: "正幸 八子",
        Birthday: "06/14/2008",
      },
    })),
  });
  assert.equal(profile.address.providerProfile.dateOfBirth, "06/14/2008");
  assert.equal(profile.guest.dateOfBirth, "04/15/1986");
}

{
  const profile = await buildCheckoutProfile({
    phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
    config: {
      checkoutProfile: {
        addressProvider: "meiguodizhi",
        addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
        hostedAddressCountryCode: "JP",
        hostedAddressPath: "/jp-address",
        guestEmailDomain: "gmail.com",
        cardMode: "generated-visa-luhn",
        fallbackAddress: {
          street: "1-1-2 Otemachi",
          city: "Chiyoda-ku",
          state: "Tokyo",
          zip: "1000004",
          countryCode: "JP",
        },
      },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      address: {
        Trans_Address: "1246-4, Honshio-cho, Shinjuku-ku, Tokyo",
        City: "Tokyo",
        Zip_Code: "160-0003",
        State: "Tokyo",
        Full_Name: "より 金居",
        Telephone: "+8182-976-1342",
        Expires: "07/2030",
        Credit_Card_Type: "JCB",
        Credit_Card_Number: "3555125332518198",
        CVV2: "554",
        Birthday: "4/15/1986",
      },
    })),
  });
  assert.equal(profile.guest.firstName, "より");
  assert.equal(profile.guest.lastName, "金居");
  assert.equal(profile.guest.fullName, "より 金居");
  assert.equal(profile.guest.kanaFirstName, "より");
  assert.equal(profile.guest.kanaLastName, "ヤマダ");
  assert.equal(profile.card.source, "generated-visa-luhn");
  assert.match(profile.card.number, /^4\d{15}$/);
  assert.notEqual(profile.card.number, "3555125332518198");
  assert.equal(isLuhnValid(profile.card.number), true);
  assert.equal(profile.card.last4, profile.card.number.slice(-4));
  assert.equal(profile.card.providerCardPresent, true);
  assert.equal(profile.card.providerCardType, "JCB");
  assert.equal(profile.card.providerCardLast4, "8198");
  assert.equal(profile.address.providerProfile.card.number, "3555125332518198");
  assert.equal(profile.address.providerProfile.card.expiry, "07 / 30");
  assert.equal(profile.address.providerProfile.card.cvv, "554");
  assert.equal(profile.phone.paypalLocal, "7094717091");
  assert.equal(profile.phone.countryCode, "JP");
  assert.equal(profile.phone.dialCode, "81");
  assert.equal(profile.guest.dateOfBirth, "04/15/1986");
  const pluginProfile = toPluginGuestProfile(profile);
  assert.equal(pluginProfile.phone, "7094717091");
  assert.equal(pluginProfile.phoneCountryCode, "JP");
  assert.equal(pluginProfile.phoneDialCode, "81");
  assert.equal(pluginProfile.dateOfBirth, "04/15/1986");
  assert.equal(pluginProfile.kanaFirstName, "より");
  assert.equal(pluginProfile.kanaLastName, "ヤマダ");
  assert.equal(pluginProfile.cardNumber, profile.card.number);
  assert.equal(pluginProfile.cardExpiry, profile.card.expiry);
  assert.equal(pluginProfile.cardCvv, profile.card.cvv);
  assert.equal(pluginProfile.address.providerProfile.phone, "+8182-976-1342");
}

{
  const profile = await buildCheckoutProfile({
    phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
    config: {
      checkoutProfile: {
        addressProvider: "meiguodizhi",
        addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
        hostedAddressCountryCode: "JP",
        hostedAddressPath: "/jp-address",
        cardMode: "provider",
        fallbackAddress: {
          street: "1-1-2 Otemachi",
          city: "Chiyoda-ku",
          state: "Tokyo",
          zip: "1000004",
          countryCode: "JP",
        },
      },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      address: {
        Trans_Address: "1246-4, Honshio-cho, Shinjuku-ku, Tokyo",
        City: "Tokyo",
        Zip_Code: "160-0003",
        State: "Tokyo",
        Full_Name: "より 金居",
        Expires: "07/2030",
        Credit_Card_Type: "JCB",
        Credit_Card_Number: "3555125332518198",
        CVV2: "554",
      },
    })),
  });
  assert.equal(profile.card.source, "meiguodizhi");
  assert.equal(profile.card.number, "3555125332518198");
  assert.equal(profile.card.expiry, "07 / 30");
  assert.equal(profile.card.cvv, "554");
  assert.equal(profile.card.type, "JCB");
  assert.equal(profile.card.last4, "8198");
}

{
  const profile = await buildCheckoutProfile({
    phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
    config: {
      checkoutProfile: {
        addressProvider: "meiguodizhi",
        addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
        hostedAddressCountryCode: "JP",
        hostedAddressPath: "/jp-address",
        cardMode: "provider",
        fallbackAddress: {
          street: "1-1-2 Otemachi",
          city: "Chiyoda-ku",
          state: "Tokyo",
          zip: "1000004",
          countryCode: "JP",
        },
      },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      address: {
        Trans_Address: "1246-4, Honshio-cho, Shinjuku-ku, Tokyo",
        City: "Tokyo",
        Zip_Code: "160-0003",
        State: "Tokyo",
        Full_Name: "より 金居",
        Expires: "07/2030",
        Credit_Card_Number: "3555125332518198",
      },
    })),
  });
  assert.equal(profile.card.source, "generated-visa-luhn");
  assert.match(profile.card.number, /^4\d{15}$/);
  assert.notEqual(profile.card.number, "3555125332518198");
  assert.equal(profile.card.providerCardPresent, false);
  assert.equal(profile.card.providerCardLast4, "8198");
}

{
  const address = normalizeAddress({
    Full_Name: "光 国富",
    countryCode: "JP",
  }, {
    countryCode: "JP",
  });
  assert.equal(address.providerProfile.firstName, "光");
  assert.equal(address.providerProfile.lastName, "国富");
  assert.equal(address.providerProfile.kanaFirstName, "");
  assert.equal(address.providerProfile.kanaLastName, "");
}

{
  await assert.rejects(
    () => buildCheckoutProfile({
      phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
      config: {
        checkoutProfile: {
          addressProvider: "meiguodizhi",
          addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
          hostedAddressCountryCode: "JP",
          hostedAddressPath: "/jp-address",
          fallbackAddress: {
            street: "1-1-2 Otemachi",
            city: "Chiyoda-ku",
            state: "Tokyo",
            zip: "1000004",
            countryCode: "JP",
          },
        },
      },
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        status: "ok",
        address: {
          Trans_Address: "470-1264, Oyaguchi, Itabashi-ku, Tokyo",
          City: "Tokyo",
          Zip_Code: "173-0035",
          State: "Tokyo",
        },
      })),
    }),
    /CHECKOUT_PROFILE_NAME_MISSING/,
  );
}

{
  const address = normalizeAddress({
    countryCode: "JP",
    Birthday: "10/07/19",
  }, {
    countryCode: "JP",
  });
  assert.equal(address.providerProfile.birthday, "10/07/19");
  assert.equal(address.providerProfile.dateOfBirth, "");
}

{
  const profile = await buildCheckoutProfile({
    phoneLease: { phone: "+817094717091", sms_url: "https://sms.test/1" },
    config: {
      checkoutProfile: {
        addressProvider: "meiguodizhi",
        addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
        hostedAddressCountryCode: "JP",
        fallbackAddress: { countryCode: "JP" },
      },
    },
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      status: "ok",
      address: {
        Full_Name: "正幸 八子",
        Birthday: "10/07/19",
      },
    })),
  });
  assert.equal(profile.guest.dateOfBirth, "04/15/1986");
}
