import fs from "node:fs";
import path from "node:path";
import { buildChromeShim } from "./chrome-shim.js";

const DEFAULT_PLUGIN_ROOT = "/Users/leviviya/Documents/GuJumpgate-v0.1.3 2";

function readPluginScript(pluginRoot, relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
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
  await page.addScriptTag({ content: buildChromeShim() });
  const injected = [];
  for (const relativePath of requested) {
    const source = readPluginScript(pluginRoot, relativePath);
    await page.addScriptTag({ content: source });
    injected.push(relativePath);
  }
  return { status: "done", injected };
}

export async function injectPaypalFlow(page, options = {}) {
  return injectPluginScripts(page, options);
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

export async function dispatchChromeRuntimeMessage(page, message, { timeoutMs = 120000 } = {}) {
  if (!page) throw new Error("page is required for runtime message dispatch");
  return page.evaluate(
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
}
