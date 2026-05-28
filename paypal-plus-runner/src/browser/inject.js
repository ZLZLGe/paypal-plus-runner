import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildChromeShim } from "./chrome-shim.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PLUGIN_ROOT = path.join(PROJECT_ROOT, "vendor/plugin");

function readPluginScript(pluginRoot, relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
}

async function evaluateScriptSource(page, source, label) {
  await page.waitForFunction(() => Boolean(document.documentElement), null, {
    timeout: 30000,
  }).catch(() => undefined);
  const client = await page.context().newCDPSession(page);
  try {
    await client.send("Page.setBypassCSP", { enabled: true }).catch(() => undefined);
    const result = await client.send("Runtime.evaluate", {
      expression: `${source}\n//# sourceURL=paypal-plus-runner://${label}`,
      awaitPromise: true,
      userGesture: true,
      replMode: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const message = details.exception?.description || details.text || `script evaluation failed: ${label}`;
      throw new Error(message);
    }
  } finally {
    await client.detach().catch(() => undefined);
  }
}

export async function injectPluginScripts(page, { pluginRoot = DEFAULT_PLUGIN_ROOT, scripts = [] } = {}) {
  if (!page) throw new Error("page is required for script injection");
  const requested = scripts.length ? scripts : [
    "content/activation-utils.js",
    "shared/source-registry.js",
    "content/utils.js",
    "content/operation-delay.js",
    "content/paypal-flow.js",
  ];
  await evaluateScriptSource(page, buildChromeShim(), "chrome-shim.js");
  const injected = [];
  for (const relativePath of requested) {
    const source = readPluginScript(pluginRoot, relativePath);
    await evaluateScriptSource(page, source, relativePath);
    injected.push(relativePath);
  }
  return { status: "done", injected };
}

export async function injectPaypalFlow(page, options = {}) {
  return injectPluginScripts(page, options);
}

export async function injectPlusCheckoutFlow(page, { pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  return injectPluginScripts(page, {
    pluginRoot,
    scripts: [
      "content/utils.js",
      "content/operation-delay.js",
      "content/plus-checkout.js",
    ],
  });
}

export async function injectSignupFlow(page, { pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  return injectPluginScripts(page, {
    pluginRoot,
    scripts: [
      "content/activation-utils.js",
      "shared/source-registry.js",
      "content/utils.js",
      "content/operation-delay.js",
      "content/auth-page-recovery.js",
      "content/phone-country-utils.js",
      "content/phone-auth.js",
      "content/signup-page.js",
    ],
  });
}

export async function dispatchChromeRuntimeMessage(page, message, { timeoutMs = 120000, onRetry = null } = {}) {
  if (!page) throw new Error("page is required for runtime message dispatch");
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await page.evaluate(
        async ({ payload, timeout }) => {
          if (!globalThis.chrome?.runtime?.__dispatchMessage) {
            throw new Error("chrome runtime shim is not installed");
          }
          return Promise.race([
            globalThis.chrome.runtime.__dispatchMessage(payload),
            new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: "dispatch timeout" }), timeout)),
          ]);
        },
        { payload: message, timeout: timeoutMs },
      );
    } catch (error) {
      lastError = error;
      const isRetryable = /Execution context was destroyed|Cannot find context|navigation|chrome runtime shim is not installed/i
        .test(String(error.message || ""));
      if (!isRetryable || attempt >= 3) {
        throw error;
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => undefined);
      await page.waitForTimeout(750);
      if (onRetry) await onRetry({ attempt, error });
    }
  }
  throw lastError || new Error("dispatch failed");
}
