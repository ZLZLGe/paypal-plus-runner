import crypto from "node:crypto";
import { fetchHostedAddress } from "./address-provider.js";
import { paypalLocalPhone } from "../db/paypal-phone-store.js";

function randomChars(alphabet, length) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function randomGuestEmail(domain = "gmail.com") {
  return `${randomChars("abcdefghijklmnopqrstuvwxyz0123456789", 16)}@${domain}`;
}

function randomGuestPassword() {
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const digits = "0123456789";
  const symbols = "!@#$%^";
  const alphabet = `${lowercase}${uppercase}${digits}${symbols}`;
  const values = [
    randomChars(lowercase, 1),
    randomChars(uppercase, 1),
    randomChars(digits, 1),
    randomChars(symbols, 1),
  ];
  while (values.length < 14) values.push(randomChars(alphabet, 1));
  return values.sort(() => Math.random() - 0.5).join("");
}

function luhnCheckDigit(digits) {
  const reversed = digits.slice().reverse();
  let sum = 0;
  for (let index = 0; index < reversed.length; index += 1) {
    let digit = reversed[index];
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

function buildVisaCard() {
  const prefixes = [[4, 1, 4, 7], [4, 1, 0, 0]];
  const digits = prefixes[Math.floor(Math.random() * prefixes.length)].slice();
  while (digits.length < 15) digits.push(Math.floor(Math.random() * 10));
  digits.push(luhnCheckDigit(digits));
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const year = (new Date().getFullYear() % 100) + Math.floor(Math.random() * 4) + 2;
  const cvv = String(Math.floor(100 + Math.random() * 900));
  const number = digits.join("");
  return { number, expiry: `${month} / ${year}`, cvv, last4: number.slice(-4) };
}

export async function buildCheckoutProfile({ phoneLease, config }) {
  if (!phoneLease) throw new Error("phoneLease is required");
  const profileCfg = config.checkoutProfile || {};
  const firstName = String(profileCfg.firstName || "James").trim();
  const lastName = String(profileCfg.lastName || "Smith").trim();
  const address = await fetchHostedAddress(config);
  const card = buildVisaCard();
  const guest = {
    email: randomGuestEmail(profileCfg.guestEmailDomain || "gmail.com"),
    password: randomGuestPassword(),
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim(),
  };
  return {
    id: crypto.randomUUID(),
    guest,
    phone: {
      raw: phoneLease.phone,
      paypalLocal: paypalLocalPhone(phoneLease.phone),
      smsUrl: phoneLease.sms_url,
    },
    card,
    address,
    source: {
      addressProvider: address.source || "unknown",
      profileMode: profileCfg.mode || "plugin-compatible",
    },
  };
}

export function toPluginGuestProfile(checkoutProfile) {
  return {
    email: checkoutProfile.guest.email,
    password: checkoutProfile.guest.password,
    phone: checkoutProfile.phone.paypalLocal,
    firstName: checkoutProfile.guest.firstName,
    lastName: checkoutProfile.guest.lastName,
    fullName: checkoutProfile.guest.fullName,
    cardNumber: checkoutProfile.card.number,
    cardExpiry: checkoutProfile.card.expiry,
    cardCvv: checkoutProfile.card.cvv,
    address: checkoutProfile.address,
  };
}
