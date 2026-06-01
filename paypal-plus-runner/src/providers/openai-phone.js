import fs from "node:fs";
import path from "node:path";
import { sleep } from "../utils/sleep.js";
import { extractSmsCode, parseSmsBody } from "./paypal-phone-code.js";
import {
  cancelHeroSmsActivation,
  finishHeroSmsActivation,
  pollHeroSmsActivationCode,
  recoverHeroSmsActivationByPhone,
  requestHeroSmsActivation,
  requestHeroSmsAdditionalSms,
} from "./hero-sms.js";
import {
  createPendingGptPhoneAccountFromActivation,
  getActiveOpenAiPhoneActivationForAccount,
  markOpenAiPhoneActivationStatus,
  recordOpenAiPhoneActivation,
} from "../db/gpt-phone-account-store.js";

function normalizePhone(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const digits = text.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return digits.startsWith("1") ? `+${digits}` : `+${digits}`;
}

function parsePhoneLine(line = "") {
  const raw = String(line || "").trim();
  if (!raw || raw.startsWith("#")) return null;
  const parts = raw.includes("|") ? raw.split("|") : raw.split("----");
  const phone = normalizePhone(parts[0]);
  const smsUrl = String(parts.slice(1).join(raw.includes("|") ? "|" : "----") || "").trim();
  if (!phone || !smsUrl) return null;
  return { phone, smsUrl };
}

function loadPhoneFile(filePath = "") {
  const resolved = path.resolve(String(filePath || ""));
  const text = fs.readFileSync(resolved, "utf8");
  return text.split(/\r?\n/).map(parsePhoneLine).filter(Boolean);
}

function normalizeOpenAiPhoneProvider(config = {}) {
  return String(config.openaiPhone?.provider || "").trim().toLowerCase();
}

function resolveHeroSmsReuseFile(config = {}) {
  const configured = String(config.openaiPhone?.heroSmsReuseFile || "").trim();
  return path.resolve(configured || "data/openai-phone-activation.json");
}

function readHeroSmsReuseActivation(config = {}) {
  const file = resolveHeroSmsReuseFile(config);
  if (!fs.existsSync(file)) return null;
  try {
    const activation = JSON.parse(fs.readFileSync(file, "utf8"));
    if (activation?.provider !== "hero-sms" || !activation.activationId || !activation.phoneNumber) {
      return null;
    }
    return {
      provider: "hero-sms",
      serviceCode: String(activation.serviceCode || config.openaiPhone?.heroSmsServiceCode || "dr"),
      countryId: Number(activation.countryId || config.openaiPhone?.heroSmsCountryId || 16),
      countryLabel: String(activation.countryLabel || config.openaiPhone?.heroSmsCountryLabel || "United Kingdom"),
      statusAction: String(activation.statusAction || "getStatus"),
      activationId: String(activation.activationId),
      phoneNumber: normalizePhone(activation.phoneNumber),
      reused: true,
      reuseFile: file,
    };
  } catch {
    return null;
  }
}

function writeHeroSmsReuseActivation(config = {}, activation = {}) {
  if (activation.provider !== "hero-sms" || !activation.activationId || !activation.phoneNumber) return;
  const file = resolveHeroSmsReuseFile(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = {
    provider: "hero-sms",
    activationId: String(activation.activationId),
    phoneNumber: normalizePhone(activation.phoneNumber),
    serviceCode: String(activation.serviceCode || config.openaiPhone?.heroSmsServiceCode || "dr"),
    countryId: Number(activation.countryId || config.openaiPhone?.heroSmsCountryId || 16),
    countryLabel: String(activation.countryLabel || config.openaiPhone?.heroSmsCountryLabel || "United Kingdom"),
    statusAction: String(activation.statusAction || "getStatus"),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

function clearHeroSmsReuseActivation(config = {}, activation = {}) {
  const file = String(activation.reuseFile || resolveHeroSmsReuseFile(config));
  if (file && fs.existsSync(file)) {
    fs.rmSync(file, { force: true });
  }
}

export function discardOpenAiPhoneReuseActivation(activation = {}, config = {}) {
  if (activation.provider !== "hero-sms") {
    return { supported: false, skipped: true };
  }
  clearHeroSmsReuseActivation(config, activation);
  activation.discardedAt = new Date().toISOString();
  return { supported: true, discarded: true };
}

async function recoverConfiguredHeroSmsActivation(config = {}) {
  const phoneNumber = normalizePhone(
    config.openaiPhone?.heroSmsReusePhoneNumber
      || config.openaiPhone?.heroSmsPhoneNumber
      || config.openaiPhone?.manualPhone
      || "",
  );
  if (!phoneNumber) return null;
  const activation = await recoverHeroSmsActivationByPhone(config, phoneNumber);
  if (!activation) return null;
  const reused = { ...activation, phoneNumber, reused: true, reuseFile: resolveHeroSmsReuseFile(config) };
  writeHeroSmsReuseActivation(config, reused);
  return reused;
}

function isNonReusableGptPhoneAccountError(error) {
  return /already belongs to a non-reusable GPT account/i.test(String(error?.message || error || ""));
}

async function cancelDuplicateHeroSmsActivation(config, db, activation, activationRow, cause) {
  const completed = { ...activation, duplicateRejectedAt: new Date().toISOString() };
  try {
    completed.cancelMessage = await cancelHeroSmsActivation(config, activation);
    completed.cancelledAt = new Date().toISOString();
    markOpenAiPhoneActivationStatus(db, { dbActivationId: activationRow.id }, "cancelled", {
      error: cause.message,
      completed,
    });
  } catch (cancelError) {
    completed.cancelError = cancelError.message;
    markOpenAiPhoneActivationStatus(db, { dbActivationId: activationRow.id }, "failed", {
      error: `${cause.message}; cancel failed: ${cancelError.message}`,
      completed,
    });
  }
}

export async function resolveOpenAiPhoneActivation(config = {}, options = {}) {
  if (normalizeOpenAiPhoneProvider(config) === "hero-sms") {
    if (options.db) {
      if (options.gptPhoneAccountId) {
        const existing = getActiveOpenAiPhoneActivationForAccount(options.db, options.gptPhoneAccountId);
        if (existing) return existing;
        if (options.allowNew === false) {
          throw new Error(`GPT phone account ${options.gptPhoneAccountId} has no active OpenAI phone activation`);
        }
      }
      const maxAttempts = Math.max(1, Number.parseInt(String(
        options.maxAttempts || config.runner?.signupPhoneActivationMaxAttempts || 3,
      ), 10) || 3);
      let lastDuplicateError = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const activation = await requestHeroSmsActivation(config);
        const activationRow = recordOpenAiPhoneActivation(options.db, activation, {
          gptPhoneAccountId: options.gptPhoneAccountId || null,
          runId: options.runId || "",
          workerId: options.workerId || "",
          status: "requested",
          leaseMinutes: Number(options.leaseMinutes || config.runner?.gptAccountLeaseMinutes || 120),
        });
        let accountRow = null;
        try {
          accountRow = options.gptPhoneAccountId
            ? null
            : createPendingGptPhoneAccountFromActivation(options.db, activation, {
                activationId: activationRow.id,
                workerId: options.workerId || "",
                runId: options.runId || "",
                leaseMinutes: Number(options.leaseMinutes || config.runner?.gptAccountLeaseMinutes || 120),
                gptPassword: options.gptPassword || config.runner?.gptPassword || "",
              });
        } catch (error) {
          if (!options.gptPhoneAccountId && isNonReusableGptPhoneAccountError(error)) {
            lastDuplicateError = error;
            await cancelDuplicateHeroSmsActivation(config, options.db, activation, activationRow, error);
            if (attempt < maxAttempts) continue;
          }
          throw error;
        }
        if (accountRow?.id && !activationRow.gpt_phone_account_id) {
          activationRow.gpt_phone_account_id = accountRow.id;
        }
        return {
          ...activation,
          dbActivationId: activationRow.id,
          gptPhoneAccountId: options.gptPhoneAccountId || accountRow?.id || activationRow.gpt_phone_account_id || null,
        };
      }
      throw lastDuplicateError || new Error("HeroSMS activation request failed before returning an OpenAI phone");
    }
    const saved = readHeroSmsReuseActivation(config);
    if (saved) return saved;
    const recovered = await recoverConfiguredHeroSmsActivation(config);
    if (recovered) return recovered;
    const activation = await requestHeroSmsActivation(config);
    writeHeroSmsReuseActivation(config, activation);
    return { ...activation, reuseFile: resolveHeroSmsReuseFile(config) };
  }

  const manualPhone = normalizePhone(config.openaiPhone?.manualPhone || config.openaiPhone?.phone || "");
  const manualSmsUrl = String(config.openaiPhone?.manualSmsUrl || config.openaiPhone?.smsUrl || "").trim();
  if (manualPhone && manualSmsUrl) {
    return { provider: "manual", phoneNumber: manualPhone, smsUrl: manualSmsUrl };
  }
  const file = String(config.openaiPhone?.file || "").trim();
  if (file) {
    const phones = loadPhoneFile(file);
    if (!phones.length) throw new Error(`openaiPhone.file has no valid phone rows: ${file}`);
    return { provider: "file", phoneNumber: phones[0].phone, smsUrl: phones[0].smsUrl, file };
  }
  throw new Error("openaiPhone manualPhone/manualSmsUrl or openaiPhone.file is required");
}

export async function pollOpenAiPhoneCode(activation = {}, config = {}, { ignoreCodes = [], timeoutMs, intervalMs } = {}) {
  if (activation.provider === "hero-sms") {
    return pollHeroSmsActivationCode(config, activation, {
      ignoreCodes,
      timeoutMs: Number(timeoutMs || config.openaiPhone?.pollTimeoutMs || 180000),
      intervalMs: Number(intervalMs || config.openaiPhone?.pollIntervalMs || 3000),
    });
  }

  const smsUrl = String(activation.smsUrl || "").trim();
  if (!smsUrl) throw new Error("OpenAI phone activation smsUrl is empty");
  const initialDelayMs = Number(config.openaiPhone?.initialSmsDelayMs ?? 10000);
  const pollIntervalMs = Math.max(250, Number(intervalMs ?? config.openaiPhone?.pollIntervalMs ?? 3000));
  const resolvedTimeoutMs = Math.max(1000, Number(timeoutMs ?? config.openaiPhone?.pollTimeoutMs ?? 180000));
  const requestTimeoutMs = Math.max(1000, Number(config.openaiPhone?.requestTimeoutMs ?? 15000));
  const ignored = new Set(ignoreCodes.map((item) => String(item).trim()).filter(Boolean));
  if (initialDelayMs > 0) await sleep(initialDelayMs);
  const startedAt = Date.now();
  let lastResponse = "";
  while (Date.now() - startedAt < resolvedTimeoutMs) {
    const url = smsUrl.includes("?") ? `${smsUrl}&t=${Date.now()}` : `${smsUrl}?t=${Date.now()}`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      const response = await fetch(url, {
        headers: { Accept: "application/json,text/plain,*/*" },
        signal: controller.signal,
      });
      clearTimeout(timer);
      lastResponse = await response.text();
      if (response.ok) {
        const parsed = parseSmsBody(lastResponse);
        const code = extractSmsCode(parsed.payload || lastResponse);
        if (code && !ignored.has(code)) return { code, lastResponse };
      }
    } catch (error) {
      lastResponse = `request_error=${error.message}`;
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`OpenAI phone code timeout for ${activation.phoneNumber}, last_response=${lastResponse.slice(0, 160)}`);
}

export async function requestOpenAiPhoneAdditionalSms(activation = {}, config = {}) {
  if (activation.provider !== "hero-sms") {
    return { supported: false, activation };
  }
  const result = await requestHeroSmsAdditionalSms(config, activation);
  return { supported: true, ...result };
}

export async function finishOpenAiPhoneActivation(activation = {}, config = {}, options = {}) {
  if (activation.provider !== "hero-sms" || activation.finishedAt || activation.cancelledAt) {
    return { supported: activation.provider === "hero-sms", skipped: true };
  }
  const message = await finishHeroSmsActivation(config, activation);
  activation.finishedAt = new Date().toISOString();
  clearHeroSmsReuseActivation(config, activation);
  if (options.db && activation.dbActivationId) {
    markOpenAiPhoneActivationStatus(options.db, activation, "finished", { completed: activation });
  }
  return { supported: true, message };
}

export async function cancelOpenAiPhoneActivation(activation = {}, config = {}, options = {}) {
  if (activation.provider !== "hero-sms" || activation.finishedAt || activation.cancelledAt) {
    return { supported: activation.provider === "hero-sms", skipped: true };
  }
  const message = await cancelHeroSmsActivation(config, activation);
  activation.cancelledAt = new Date().toISOString();
  clearHeroSmsReuseActivation(config, activation);
  if (options.db && activation.dbActivationId) {
    markOpenAiPhoneActivationStatus(options.db, activation, "cancelled", { completed: activation });
  }
  return { supported: true, message };
}
