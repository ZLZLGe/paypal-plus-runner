import { sleep } from "../utils/sleep.js";

const OPENAI_CODE_PATTERNS = [
  /(?:chatgpt\s+log-?in\s+code|enter\s+this\s+code)[^0-9]{0,24}(\d{6})/i,
  /your\s+chatgpt\s+code\s+is\s+(\d{6})/i,
  /(?:verification\s+code|temporary\s+verification\s+code|your\s+chatgpt\s+code|code(?:\s+is)?)[^0-9]{0,16}(\d{6})/i,
  /(?<!\d)(\d{6})(?!\d)/,
];

function extractMailCode(mail) {
  const text = [mail?.subject, mail?.text, mail?.html].map((item) => String(item || "")).join("\n");
  for (const pattern of OPENAI_CODE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1] || match[0];
  }
  return "";
}

function normalizeMailList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.messages)) return payload.messages;
  if (Array.isArray(payload?.mail)) return payload.mail;
  return [];
}

async function fetchMailbox(baseUrl, account, mailbox, mode) {
  const endpoint = mode === "mail_all" ? "mail_all" : "mail_new";
  const url = new URL(`/api/${endpoint}`, String(baseUrl).replace(/\/+$/, ""));
  url.searchParams.set("email", account.email);
  url.searchParams.set("client_id", account.client_id || "");
  url.searchParams.set("refresh_token", account.refresh_token || "");
  url.searchParams.set("mailbox", mailbox);
  const response = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*" } });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { data: [], raw: text };
  }
}

export async function pollOpenAiEmailCode(account, config = {}, options = {}) {
  const baseUrl = String(config.verification?.msOauth2ApiBaseUrl || "").trim();
  if (!baseUrl) throw new Error("verification.msOauth2ApiBaseUrl is empty");
  const mailboxes = Array.isArray(config.verification?.mailboxes) ? config.verification.mailboxes : ["INBOX", "Junk"];
  const intervalMs = Number(config.verification?.mailPollIntervalMs || 3000);
  const maxAttempts = Number(config.verification?.mailMaxAttempts || 60);
  const mode = String(config.verification?.mailFetchMode || "mail_new");
  const excludeCodes = new Set((options.excludeCodes || []).map((item) => String(item).trim()).filter(Boolean));
  let lastSeen = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    for (const mailbox of mailboxes) {
      const payload = await fetchMailbox(baseUrl, account, mailbox, mode);
      for (const mail of normalizeMailList(payload)) {
        const code = extractMailCode(mail);
        if (code) {
          lastSeen = code;
          if (!excludeCodes.has(code)) return { code, mailbox, mail };
        }
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`openai email code timeout for ${account.email}, last_seen=${lastSeen}`);
}
