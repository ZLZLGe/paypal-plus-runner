import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chooseAsnForTemplate, renderProxyTemplate } from "./proxy-asn.js";
import { randomSid } from "../utils/ids.js";
import { sleep } from "../utils/sleep.js";

function asBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

export class RoxyClient {
  constructor(config = {}) {
    this.config = config;
    this.apiBase = String(config.api_base || "").replace(/\/+$/, "");
    this.token = String(config.token || "").trim();
    this.workspaceId = Number(config.workspace_id || 1);
    this.headless = asBool(config.headless, true);
    this.openArgs = Array.isArray(config.open_args) ? config.open_args : [];
    this.proxy = config.proxy || {};
    if (!this.apiBase) throw new Error("roxy.api_base is empty");
    if (!this.token) throw new Error("roxy.token is empty");
  }

  headers() {
    return { token: this.token, "Content-Type": "application/json" };
  }

  async request(pathname, { method = "GET", body, params } = {}) {
    const url = new URL(`${this.apiBase}${pathname}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(45000),
    });
    const payload = await response.json();
    if (Number(payload.code ?? 500) !== 0) {
      throw new Error(`roxy ${pathname} failed: ${JSON.stringify(payload)}`);
    }
    return payload.data || {};
  }

  effectiveWorkspaceId(workspaceId = undefined) {
    const value = workspaceId === undefined || workspaceId === null ? this.workspaceId : workspaceId;
    const parsed = Number(value || 0);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid roxy workspace_id: ${value}`);
    return parsed;
  }

  chooseProxyAsn() {
    const defaultRegion = this.proxy.default_region || this.config.requiredRegion || "US";
    return chooseAsnForTemplate(this.proxy.username_template || "", this.proxy.asn_pools, defaultRegion);
  }

  buildProxyUsername(sid, asn = "") {
    const fixed = String(this.proxy.username || "").trim();
    if (fixed) return fixed;
    return renderProxyTemplate(this.proxy.username_template || "", { sid, asn });
  }

  buildProxyInfo(sid, asn = "") {
    return {
      proxyMethod: this.proxy.proxy_method || "custom",
      proxyCategory: this.proxy.proxy_category || "SOCKS5",
      protocol: this.proxy.protocol || this.proxy.proxy_category || "SOCKS5",
      ipType: "IPV4",
      host: this.proxy.host || "",
      port: String(this.proxy.port || ""),
      proxyUserName: this.buildProxyUsername(sid, asn),
      proxyPassword: this.proxy.password || "",
      checkChannel: this.proxy.check_channel || "IPRust.io",
    };
  }

  windowDirId(row = {}) {
    return String(row.dirId || row.id || row.dir_id || "").trim();
  }

  windowName(row = {}) {
    return String(row.windowName || row.name || row.browserName || "").trim();
  }

  async listWindows({ pageIndex = 1, pageSize = 500, workspaceId = undefined } = {}) {
    const data = await this.request("/browser/list_v3", {
      params: {
        workspaceId: this.effectiveWorkspaceId(workspaceId),
        page_index: pageIndex,
        page_size: pageSize,
      },
    });
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.rows)) return data.rows;
    if (Array.isArray(data.list)) return data.list;
    return [];
  }

  async findWindowByName(name) {
    const target = String(name || "").trim();
    if (!target) return null;
    const rows = await this.listWindows();
    return rows.find((row) => this.windowName(row) === target && this.windowDirId(row)) || null;
  }

  async createWindow(name) {
    const sid = randomSid();
    const { asn, region } = this.chooseProxyAsn();
    const data = await this.request("/browser/create", {
      method: "POST",
      body: {
        workspaceId: this.effectiveWorkspaceId(),
        windowName: name,
        proxyInfo: this.buildProxyInfo(sid, asn),
      },
    });
    return { ...data, sid, asn, region, proxyUserName: this.buildProxyUsername(sid, asn) };
  }

  async openWindow(dirId) {
    return this.request("/browser/open", {
      method: "POST",
      body: {
        workspaceId: this.effectiveWorkspaceId(),
        dirId,
        headless: this.headless,
        ...(this.openArgs.length ? { args: this.openArgs } : {}),
      },
    });
  }

  async reopenWindow(dirId) {
    try {
      await this.closeWindow(dirId);
    } catch {
      // Roxy returns an error when a profile is already closed; opening again is still valid.
    }
    return this.openWindow(dirId);
  }

  async closeWindow(dirId) {
    return this.request("/browser/close", {
      method: "POST",
      body: { workspaceId: this.effectiveWorkspaceId(), dirId },
    });
  }

  async deleteWindow(dirId) {
    return this.request("/browser/delete", {
      method: "POST",
      body: { workspaceId: this.effectiveWorkspaceId(), dirIds: [dirId] },
    });
  }

  async modifyWindowProxy(dirId, { reopen = false } = {}) {
    const sid = randomSid();
    const { asn, region } = this.chooseProxyAsn();
    const data = await this.request("/browser/mdf", {
      method: "POST",
      body: {
        workspaceId: this.effectiveWorkspaceId(),
        dirId,
        proxyInfo: this.buildProxyInfo(sid, asn),
      },
    });
    let opened = null;
    if (reopen) opened = await this.reopenWindow(dirId);
    const ws = extractRoxyWebSocketUrl(opened) || extractRoxyWebSocketUrl(data);
    return { ...data, sid, asn, region, proxyUserName: this.buildProxyUsername(sid, asn), ws, rawOpen: opened };
  }

  async createAndOpen(name) {
    const created = await this.createWindow(name);
    const dirId = this.windowDirId(created);
    if (!dirId) throw new Error(`roxy create missing dirId: ${JSON.stringify(created)}`);
    const opened = await this.openWindow(dirId);
    const ws = extractRoxyWebSocketUrl(opened);
    if (!ws) throw new Error(`roxy open missing ws: ${JSON.stringify(opened)}`);
    return { ...created, dirId, ws, rawOpen: opened };
  }

  async recoverAndOpen(name) {
    const found = await this.findWindowByName(name);
    if (!found) return null;
    const dirId = this.windowDirId(found);
    const opened = await this.openWindow(dirId);
    const ws = extractRoxyWebSocketUrl(opened) || extractRoxyWebSocketUrl(found);
    if (!ws) throw new Error(`roxy recover open missing ws: ${JSON.stringify(opened)}`);
    return { ...found, dirId, ws, rawOpen: opened, recovered: true };
  }

  async createOrRecoverAndOpen(name, { attempts = 3, retryDelayMs = 8000 } = {}) {
    let lastError = null;
    const total = Math.max(1, Number.parseInt(String(attempts || 1), 10));
    for (let attempt = 1; attempt <= total; attempt += 1) {
      try {
        return await this.createAndOpen(name);
      } catch (error) {
        lastError = error;
        const recovered = await this.recoverAndOpen(name).catch(() => null);
        if (recovered) return recovered;
        if (attempt < total) await sleep(retryDelayMs);
      }
    }
    throw lastError || new Error(`roxy create failed: ${name}`);
  }

  static resolveLocalProxyPort(dirId) {
    const target = String(dirId || "").trim();
    const logDir = path.join(os.homedir(), "Library", "Logs", "RoxyBrowser");
    const perWindow = new RegExp(`SocksProxyAgent url socks5h://${target}:${target}@127\\.0\\.0\\.1:(\\d+)`);
    const generic = /report_proxy_server\s+(\d+)/;
    if (!fs.existsSync(logDir)) throw new Error("Roxy log dir not found");
    const files = fs.readdirSync(logDir).filter((file) => file.endsWith(".log"))
      .map((file) => path.join(logDir, file))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const fallback = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).reverse();
      for (const line of lines) {
        const match = line.match(perWindow);
        if (match) return Number(match[1]);
        const genericMatch = line.match(generic);
        if (genericMatch) fallback.push(Number(genericMatch[1]));
      }
    }
    if (fallback.length) return fallback[0];
    throw new Error(`cannot resolve roxy local proxy port for dir_id=${target}`);
  }

  static buildLocalWindowProxyUrl(dirId) {
    const port = RoxyClient.resolveLocalProxyPort(dirId);
    return `socks5://${dirId}:${dirId}@127.0.0.1:${port}`;
  }

  static async buildLocalWindowProxyUrlWithRetry(dirId, { attempts = 10, delayMs = 750 } = {}) {
    let lastError = null;
    const total = Math.max(1, Number.parseInt(String(attempts || 1), 10));
    for (let attempt = 1; attempt <= total; attempt += 1) {
      try {
        return RoxyClient.buildLocalWindowProxyUrl(dirId);
      } catch (error) {
        lastError = error;
        if (attempt < total) await sleep(delayMs);
      }
    }
    throw lastError || new Error(`cannot resolve roxy local proxy for dir_id=${dirId}`);
  }
}

export function extractRoxyWebSocketUrl(payload = {}) {
  return String(
    payload?.ws
      || payload?.webSocketDebuggerUrl
      || payload?.websocketDebuggerUrl
      || payload?.browserWSEndpoint
      || payload?.webSocketUrl
      || "",
  ).trim();
}
