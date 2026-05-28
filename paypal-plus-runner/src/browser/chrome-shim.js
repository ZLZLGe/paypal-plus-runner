export function buildChromeShim() {
  return `
(() => {
  if (globalThis.chrome?.runtime?.__dispatchMessage) return;
  const state = globalThis.__PAYPAL_PLUS_RUNNER_CHROME_SHIM__ || {
    listeners: [],
    storageData: {},
  };
  globalThis.__PAYPAL_PLUS_RUNNER_CHROME_SHIM__ = state;
  const existingChrome = globalThis.chrome || {};
  const existingRuntime = existingChrome.runtime || {};
  const listeners = state.listeners;
  const storageData = state.storageData;
  globalThis.chrome = {
    ...existingChrome,
    runtime: {
      ...existingRuntime,
      sendMessage(message, callback) {
        if (message?.type === "LOG") {
          console.debug("[runner:content-log]", message?.payload?.level || "info", message?.payload?.message || "");
        }
        if (typeof callback === "function") callback({ ok: true });
        return Promise.resolve({ ok: true });
      },
      onMessage: {
        addListener(listener) {
          if (typeof listener === "function" && !listeners.includes(listener)) listeners.push(listener);
        },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      __dispatchMessage(message) {
        return new Promise((resolve) => {
          let asyncResponse = false;
          let settled = false;
          const sendResponse = (payload) => {
            if (settled) return;
            settled = true;
            resolve(payload);
          };
          for (const listener of listeners) {
            const result = listener(message, { id: "paypal-plus-runner" }, sendResponse);
            asyncResponse = asyncResponse || result === true;
            if (settled) return;
          }
          if (!asyncResponse && !settled) resolve({ ok: false, error: "no content listener handled message" });
          setTimeout(() => {
            if (!settled) resolve({ ok: false, error: "content listener response timeout" });
          }, 120000);
        });
      },
    },
    storage: existingChrome.storage || {
      local: {
        async get(keys) {
          if (!keys) return { ...storageData };
          if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storageData[key]]));
          if (typeof keys === "string") return { [keys]: storageData[keys] };
          return { ...keys, ...Object.fromEntries(Object.keys(keys).map((key) => [key, storageData[key] ?? keys[key]])) };
        },
        async set(values) {
          Object.assign(storageData, values || {});
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
        },
      },
      session: {
        async get(keys) { return globalThis.chrome.storage.local.get(keys); },
        async set(values) { return globalThis.chrome.storage.local.set(values); },
        async remove(keys) { return globalThis.chrome.storage.local.remove(keys); },
      },
    },
  };
})();
`;
}
