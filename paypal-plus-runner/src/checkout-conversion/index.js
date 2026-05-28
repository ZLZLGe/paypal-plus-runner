import { createCloudCheckout } from "./cloud-provider.js";
import { createLocalJpCheckout } from "./local-jp-provider.js";

export async function createCheckout({ accessToken, config, logger = null }) {
  if (!accessToken) throw new Error("accessToken is required");
  const provider = String(config.checkoutConversion?.provider || "local_jp_proxy");
  if (provider === "cloud") return createCloudCheckout({ accessToken, config, logger });
  if (provider === "local_jp_proxy") return createLocalJpCheckout({ accessToken, config, logger });
  if (provider === "direct") return createLocalJpCheckout({
    accessToken,
    logger,
    config: {
      ...config,
      checkoutConversion: {
        ...config.checkoutConversion,
        provider: "local_jp_proxy",
        localJpProxy: {
          ...(config.checkoutConversion?.localJpProxy || {}),
          mode: "direct_proxy_url",
          secondHopProxyUrl: "direct-region-JP-sid-{SID}",
          asnPools: {},
        },
      },
    },
  });
  throw new Error(`unknown checkoutConversion.provider: ${provider}`);
}
