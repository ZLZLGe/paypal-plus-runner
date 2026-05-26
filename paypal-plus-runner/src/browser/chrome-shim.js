export function buildChromeShim() {
  return {
    runtime: {
      sendMessage: () => undefined,
      onMessage: { addListener: () => undefined },
    },
    storage: {
      local: {
        get: async () => ({}),
        set: async () => undefined,
      },
    },
  };
}
