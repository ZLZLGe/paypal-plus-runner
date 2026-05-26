import crypto from "node:crypto";

const SID_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function makeRunId(prefix = "run") {
  return `${prefix}_${new Date().toISOString().replace(/[-:.TZ]/g, "")}_${crypto.randomBytes(4).toString("hex")}`;
}

export function randomSid(length = 8) {
  let out = "";
  for (let index = 0; index < length; index += 1) {
    out += SID_ALPHABET[Math.floor(Math.random() * SID_ALPHABET.length)];
  }
  return out;
}
