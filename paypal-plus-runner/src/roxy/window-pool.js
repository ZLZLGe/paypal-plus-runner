import { RoxyClient } from "./client.js";
import { connectOverCdp } from "../browser/connect-cdp.js";
import { probeIp, probeWindowExitIp } from "./proxy-probe.js";
import { lookupCountryCodeForIp } from "../checkout-conversion/geo-probe.js";
import { sleep } from "../utils/sleep.js";

function buildWindowName(prefix, index) {
  const safePrefix = String(prefix || "paypal-plus").trim() || "paypal-plus";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${safePrefix}-${stamp}-${String(index).padStart(2, "0")}`;
}

export class WindowPool {
  constructor({ windows = [], client = null, logger = null, config = {} } = {}) {
    this.windows = windows;
    this.client = client;
    this.logger = logger;
    this.config = config;
  }

  add(windowInfo) {
    this.windows.push(windowInfo);
  }

  all() {
    return [...this.windows];
  }

  async closeAll({ deleteWindows = false } = {}) {
    if (!this.client) return { closed: 0, deleted: 0, failed: 0 };
    const summary = { closed: 0, deleted: 0, failed: 0 };
    for (const item of [...this.windows].reverse()) {
      try {
        await item.browser?.close?.();
      } catch {
        // CDP disconnect can fail after Roxy window closes.
      }
      try {
        await this.client.closeWindow(item.dirId);
        summary.closed += 1;
      } catch (error) {
        summary.failed += 1;
        this.logger?.warn?.("roxy close failed", { dirId: item.dirId, error: error.message });
      }
      if (deleteWindows) {
        try {
          await this.client.deleteWindow(item.dirId);
          summary.deleted += 1;
        } catch (error) {
          summary.failed += 1;
          this.logger?.warn?.("roxy delete failed", { dirId: item.dirId, error: error.message });
        }
      }
    }
    return summary;
  }
}

export async function openManagedRoxyWindow(config, { client = null, name = "", logger = null } = {}) {
  const roxyCfg = config.roxy || {};
  const roxyClient = client || new RoxyClient(roxyCfg);
  const windowInfo = await roxyClient.createOrRecoverAndOpen(name, {
    attempts: Number(roxyCfg.createAttempts || 3),
    retryDelayMs: Number(roxyCfg.createRetryDelayMs || 8000),
  });
  const dirId = String(windowInfo.dirId || "");
  const connected = await connectOverCdp(windowInfo.ws, {
    timeoutMs: Number(roxyCfg.cdpConnectTimeoutMs || 45000),
  });
  let localProxyUrl = "";
  try {
    localProxyUrl = await RoxyClient.buildLocalWindowProxyUrlWithRetry(dirId, {
      attempts: Number(roxyCfg.localProxyResolveAttempts || 10),
      delayMs: Number(roxyCfg.localProxyResolveDelayMs || 750),
    });
  } catch (error) {
    logger?.warn?.("local roxy proxy resolve failed", { dirId, error: error.message });
  }

  let probe = { ok: false, ip: "", error: "" };
  if (roxyCfg.probeExitIp !== false) {
    try {
      const probeOptions = {
        probeUrl: String(roxyCfg.ipProbeUrl || "https://api.ipify.org?format=json"),
        timeoutMs: Number(roxyCfg.ipProbeTimeoutMs || 20000),
      };
      probe = localProxyUrl
        ? await probeIp({ ...probeOptions, proxyUrl: localProxyUrl })
        : await probeWindowExitIp(connected.page, probeOptions);
      const requiredCountry = String(roxyCfg.requireExitCountry || "").trim().toUpperCase();
      const configuredRegion = String(windowInfo.region || "").trim().toUpperCase();
      if (requiredCountry && configuredRegion && configuredRegion !== requiredCountry) {
        throw new Error(`roxy browser proxy region is ${configuredRegion}, expected ${requiredCountry}`);
      }
      if (requiredCountry && !probe.ok && !configuredRegion) {
        throw new Error(`roxy browser exit probe failed before PayPal flow: ${probe.error || probe.status || "unknown"}`);
      }
      if (requiredCountry && probe.ip) {
        probe.countryCode = await lookupCountryCodeForIp(probe.ip, {
          timeoutMs: Number(roxyCfg.geoLookupTimeoutMs || 15000),
          connectTimeoutMs: Number(roxyCfg.geoLookupConnectTimeoutMs || 8000),
        });
        if (!probe.countryCode && !configuredRegion) {
          throw new Error(`roxy browser exit country could not be detected, expected ${requiredCountry}; ip=${probe.ip}`);
        }
        if (probe.countryCode && probe.countryCode !== requiredCountry) {
          throw new Error(`roxy browser exit country is ${probe.countryCode}, expected ${requiredCountry}; ip=${probe.ip}`);
        }
      }
    } catch (error) {
      probe = { ok: false, ip: "", error: error.message };
      if (roxyCfg.requireExitCountry) {
        try {
          await connected.browser?.close?.();
        } catch {
          // CDP may already be disconnected if the probe failed during navigation.
        }
        await roxyClient.closeWindow(dirId).catch(() => undefined);
        throw error;
      }
    }
  }

  return {
    ...windowInfo,
    name,
    dirId,
    ws: windowInfo.ws,
    localProxyUrl,
    exitIp: probe.ip || "",
    exitProbe: probe,
    browser: connected.browser,
    context: connected.context,
    page: connected.page,
    accountRuns: 0,
  };
}

export async function createRoxyWindowPool(config, { count, logger } = {}) {
  const roxyCfg = config.roxy || {};
  const client = new RoxyClient(roxyCfg);
  const pool = new WindowPool({ client, logger, config });
  const requested = Math.max(1, Number.parseInt(String(count || roxyCfg.windowCount || 1), 10));
  const namePrefix = String(roxyCfg.windowNamePrefix || "paypal-plus").trim() || "paypal-plus";
  const createAttempts = Number(roxyCfg.createAttempts || 3);
  const createRetryDelayMs = Number(roxyCfg.createRetryDelayMs || 8000);
  const createIntervalMs = Number(roxyCfg.createIntervalMs || 0);

  for (let index = 1; index <= requested; index += 1) {
    const name = buildWindowName(namePrefix, index);
    logger?.info?.("creating roxy window", { index, requested, name });
    const managed = await openManagedRoxyWindow(config, { client, name, logger, createAttempts, createRetryDelayMs });
    pool.add(managed);
    logger?.info?.("roxy window ready", {
      name,
      dirId: managed.dirId,
      asn: managed.asn || "",
      region: managed.region || "",
      exitIp: managed.exitIp,
      exitCountry: managed.exitProbe?.countryCode || "",
      localProxyUrl: managed.localProxyUrl ? "resolved" : "",
    });
    if (index < requested && createIntervalMs > 0) await sleep(createIntervalMs);
  }
  return pool;
}
