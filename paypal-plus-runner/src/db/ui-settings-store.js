import { utcNow } from "./connection.js";

function normalizeKey(key = "") {
  return String(key || "").trim();
}

function boolFromText(value = "", fallback = false) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

function defaultHeadless(config = {}) {
  return config.roxy?.headless !== false;
}

export function getUiSetting(db, key, fallback = "") {
  const normalized = normalizeKey(key);
  if (!normalized) return fallback;
  const row = db.prepare("SELECT value FROM ui_settings WHERE key = ?").get(normalized);
  return row ? String(row.value || "") : fallback;
}

export function setUiSetting(db, key, value = "") {
  const normalized = normalizeKey(key);
  if (!normalized) throw new Error("ui setting key is required");
  const timestamp = utcNow();
  db.prepare(`
    INSERT INTO ui_settings(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(normalized, String(value ?? ""), timestamp);
  return { key: normalized, value: String(value ?? ""), updatedAt: timestamp };
}

export function getUiSettings(db, config = {}) {
  const rawHeadless = getUiSetting(db, "headless", "");
  return {
    headless: rawHeadless ? boolFromText(rawHeadless, defaultHeadless(config)) : defaultHeadless(config),
  };
}

export function saveUiSettings(db, settings = {}, config = {}) {
  if (Object.prototype.hasOwnProperty.call(settings, "headless")) {
    setUiSetting(db, "headless", boolFromText(settings.headless, defaultHeadless(config)) ? "true" : "false");
  }
  return getUiSettings(db, config);
}
