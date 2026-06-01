import crypto from "node:crypto";
import { fetchHostedAddress } from "./address-provider.js";
import { paypalLocalPhone, paypalPhoneCountryCode, paypalPhoneDialCode } from "../db/paypal-phone-store.js";

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

function normalizeCardMode(value = "") {
  const mode = String(value || "").trim().toLowerCase();
  if (["meiguodizhi", "provider", "provider-card"].includes(mode)) return "provider";
  if (["auto", "fallback"].includes(mode)) return "auto";
  return "generated-visa-luhn";
}

function cardDigits(value = "") {
  return String(value || "").replace(/\D+/g, "");
}

function isCompleteProviderCard(card = {}) {
  return Boolean(cardDigits(card.number) && String(card.expiry || "").trim() && String(card.cvv || "").trim());
}

function isLuhnValidCardNumber(value = "") {
  const digits = cardDigits(value);
  if (digits.length < 13 || digits.length > 19) return false;
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
  return sum % 10 === 0;
}

function parseCardExpiry(value = "") {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number.parseInt(match[1], 10);
  const rawYear = match[2];
  const year = rawYear.length === 4
    ? Number.parseInt(rawYear, 10)
    : 2000 + Number.parseInt(rawYear, 10);
  if (!Number.isFinite(month) || !Number.isFinite(year) || month < 1 || month > 12) {
    return null;
  }
  return { month, year };
}

function normalizeCardExpiryForCheckout(value = "") {
  const parsed = parseCardExpiry(value);
  if (!parsed) return String(value || "").trim();
  return `${String(parsed.month).padStart(2, "0")} / ${String(parsed.year).slice(-2)}`;
}

function isFutureCardExpiry(value = "", now = new Date()) {
  const parsed = parseCardExpiry(value);
  if (!parsed) return false;
  const expiryEnd = Date.UTC(parsed.year, parsed.month, 0, 23, 59, 59, 999);
  return expiryEnd >= now.getTime();
}

function isUsableProviderCard(card = {}) {
  const cvv = cardDigits(card.cvv);
  return isCompleteProviderCard(card)
    && isLuhnValidCardNumber(card.number)
    && isFutureCardExpiry(card.expiry)
    && /^\d{3,4}$/.test(cvv);
}

function normalizeProviderCard(card = {}, source = "meiguodizhi") {
  const number = cardDigits(card.number);
  return {
    number,
    expiry: normalizeCardExpiryForCheckout(card.expiry),
    cvv: cardDigits(card.cvv),
    last4: card.last4 || number.slice(-4),
    type: String(card.type || "").trim(),
    source,
  };
}

function chooseName(address = {}, profileCfg = {}) {
  const provider = address.providerProfile || {};
  const requiresProviderName = String(address.source || "").startsWith("meiguodizhi:")
    || String(profileCfg.addressProvider || "").toLowerCase() === "meiguodizhi";
  const firstName = String(provider.firstName || (requiresProviderName ? "" : profileCfg.firstName) || "").trim();
  const lastName = String(provider.lastName || (requiresProviderName ? "" : profileCfg.lastName) || "").trim();
  if (!firstName || !lastName) {
    const source = requiresProviderName ? "meiguodizhi 未返回可用 Full_Name" : "checkoutProfile 未配置 firstName/lastName";
    throw new Error(`CHECKOUT_PROFILE_NAME_MISSING::${source}，已停止，避免 PayPal 填入默认英文姓名。`);
  }
  return {
    firstName,
    lastName,
    fullName: String(provider.fullName || `${firstName} ${lastName}`).trim(),
    kanaFirstName: String(provider.kanaFirstName || profileCfg.kanaFirstName || "タロウ").trim(),
    kanaLastName: String(provider.kanaLastName || profileCfg.kanaLastName || "ヤマダ").trim(),
  };
}

function chooseCard(address = {}, profileCfg = {}) {
  const providerCard = address.providerProfile?.card || {};
  const providerCardComplete = isCompleteProviderCard(providerCard);
  const cardMode = normalizeCardMode(profileCfg.cardMode || "generated-visa-luhn");

  if (cardMode === "provider" && providerCardComplete) {
    return normalizeProviderCard(providerCard, "meiguodizhi");
  }

  if (cardMode === "auto" && isUsableProviderCard(providerCard)) {
    return normalizeProviderCard(providerCard, "meiguodizhi");
  }

  return {
    ...buildVisaCard(),
    source: "generated-visa-luhn",
    providerCardPresent: providerCardComplete,
    providerCardType: String(providerCard.type || "").trim(),
    providerCardLast4: providerCard.last4 || cardDigits(providerCard.number).slice(-4),
  };
}

function parseDateOfBirth(value = "") {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const month = Number.parseInt(match[1], 10);
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function calculateAge(dateOfBirth, now = new Date()) {
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const currentDay = now.getUTCDate();
  let age = currentYear - dateOfBirth.year;
  if (
    currentMonth < dateOfBirth.month
    || (currentMonth === dateOfBirth.month && currentDay < dateOfBirth.day)
  ) {
    age -= 1;
  }
  return age;
}

function isUsableAdultDateOfBirth(value = "", { minAge = 21, maxAge = 80, now = new Date() } = {}) {
  const dateOfBirth = parseDateOfBirth(value);
  if (!dateOfBirth) return false;
  const age = calculateAge(dateOfBirth, now);
  return age >= minAge && age <= maxAge;
}

function chooseDateOfBirth(address = {}, profileCfg = {}) {
  const fallback = String(profileCfg.fallbackDateOfBirth || "04/15/1986").trim() || "04/15/1986";
  const minAge = Math.max(18, Number.parseInt(String(profileCfg.minAge || profileCfg.minimumAge || 21), 10) || 21);
  const maxAge = Math.max(minAge, Number.parseInt(String(profileCfg.maxAge || profileCfg.maximumAge || 80), 10) || 80);
  const providerDateOfBirth = String(address.providerProfile?.dateOfBirth || "").trim();
  if (isUsableAdultDateOfBirth(providerDateOfBirth, { minAge, maxAge })) return providerDateOfBirth;
  if (isUsableAdultDateOfBirth(fallback, { minAge, maxAge })) return fallback;
  return "04/15/1986";
}

export async function buildCheckoutProfile({ phoneLease, config }, options = {}) {
  const profileCfg = config.checkoutProfile || {};
  const address = await fetchHostedAddress(config, options);
  const name = chooseName(address, profileCfg);
  const card = chooseCard(address, profileCfg);
  const dateOfBirth = chooseDateOfBirth(address, profileCfg);
  const guest = {
    email: randomGuestEmail(profileCfg.guestEmailDomain || "gmail.com"),
    password: randomGuestPassword(),
    firstName: name.firstName,
    lastName: name.lastName,
    fullName: name.fullName,
    kanaFirstName: name.kanaFirstName,
    kanaLastName: name.kanaLastName,
    dateOfBirth,
  };
  return {
    id: crypto.randomUUID(),
    guest,
    phone: {
      raw: phoneLease?.phone || "",
      paypalLocal: phoneLease?.phone ? paypalLocalPhone(phoneLease.phone) : "",
      countryCode: phoneLease?.phone ? paypalPhoneCountryCode(phoneLease.phone) : "",
      dialCode: phoneLease?.phone ? paypalPhoneDialCode(phoneLease.phone) : "",
      smsUrl: phoneLease?.sms_url || "",
    },
    card,
    address,
    source: {
      addressProvider: address.source || "unknown",
      profileMode: profileCfg.mode || "plugin-compatible",
    },
  };
}

export function attachPaypalPhoneToCheckoutProfile(checkoutProfile, phoneLease) {
  if (!phoneLease) throw new Error("phoneLease is required");
  return {
    ...checkoutProfile,
    phone: {
      raw: phoneLease.phone,
      paypalLocal: paypalLocalPhone(phoneLease.phone),
      countryCode: paypalPhoneCountryCode(phoneLease.phone),
      dialCode: paypalPhoneDialCode(phoneLease.phone),
      smsUrl: phoneLease.sms_url,
    },
  };
}

export function toPluginGuestProfile(checkoutProfile) {
  return {
    email: checkoutProfile.guest.email,
    password: checkoutProfile.guest.password,
    phone: checkoutProfile.phone.paypalLocal,
    phoneCountryCode: checkoutProfile.phone.countryCode,
    phoneDialCode: checkoutProfile.phone.dialCode,
    firstName: checkoutProfile.guest.firstName,
    lastName: checkoutProfile.guest.lastName,
    fullName: checkoutProfile.guest.fullName,
    kanaFirstName: checkoutProfile.guest.kanaFirstName,
    kanaLastName: checkoutProfile.guest.kanaLastName,
    dateOfBirth: checkoutProfile.guest.dateOfBirth,
    cardNumber: checkoutProfile.card.number,
    cardExpiry: checkoutProfile.card.expiry,
    cardCvv: checkoutProfile.card.cvv,
    address: checkoutProfile.address,
  };
}
