import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CONFIG = {
  database: { path: "data/paypal_plus_runner.db" },
  runner: {
    gptPassword: "myPASSword!2026",
    maxAttemptsPerEmail: 5,
    skipSignupSteps: false,
    skipOpenChatgpt: false,
    debugAccessToken: "",
    pageLoadTimeoutMs: 120000,
    openChatgptNavigationAttempts: 3,
    openChatgptNavigationRetryDelayMs: 1500,
    checkoutTransitionTimeoutMs: 180000,
    checkoutOpenNavigationAttempts: 3,
    checkoutOpenNavigationRetryDelayMs: 1500,
    paypalHostedTimeoutMs: 900000,
    paypalHostedStuckRefreshMs: 50000,
    stripeHostedReadyTimeoutMs: 180000,
    stripeHostedReadyStableMs: 2000,
    paypalVerificationMaxAttempts: 3,
    paypalVerificationDebug: false,
    paypalVerificationDebugLogIntervalMs: 5000,
    paypalVerificationDebugSnapshotStateChanges: true,
    paypalVerificationDebugHtml: true,
    paypalVerificationDebugScreenshot: true,
    cleanupBrowserDataBeforeEachAccount: true,
    screenshotOnFailure: true,
    htmlSnapshotOnFailure: true,
    continueOnAccountFailure: true,
    requirePlusSessionPlan: true,
    plusSessionVerifyTimeoutMs: 180000,
    plusSessionVerifyPollMs: 5000,
  },
  flow: {
    plusModeEnabled: true,
    plusPaymentMethod: "paypal",
    accountAccessStrategyUi: "session_json",
    sessionJsonTarget: "sub2api",
    plusAccountAccessStrategy: "sub2api_codex_session",
    signupMethod: "email",
    smsOauthOutputTarget: "cpa_upload",
  },
  checkoutConversion: {
    enabled: true,
    provider: "local_jp_proxy",
    paymentMethod: "paypal",
    country: "US",
    currency: "USD",
    checkoutUiMode: "hosted",
    isCouponFromQueryParam: false,
    processorEntity: "openai_llc",
    openUrlPreference: "hosted",
    useFreeTrialPromo: true,
    alreadyPaidIsSuccess: true,
    requireStripeHostedUrl: true,
    zeroAmountRetryMax: 3,
    maxAttempts: 3,
    cloud: { apiUrl: "", apiKey: "", timeoutMs: 45000 },
    localJpProxy: {
      mode: "gost_chain",
      runProbe: true,
      requireJpExit: true,
      probeUrl: "https://iplark.com/ipapi/public/ip",
      probeTimeoutMs: 30000,
      geoLookupTimeoutMs: 15000,
      requestTimeoutMs: 45000,
      connectTimeoutMs: 15000,
      checkoutTransport: "curl_cffi",
      pythonExecutable: ".venv/bin/python",
      curlCffiScriptPath: "scripts/curl_cffi_request.py",
      impersonateBrowser: "chrome136",
      fallbackImpersonateBrowser: "chrome133a",
      createStripeHostedUrl: true,
      preferStripeHostedUrl: true,
      stripeInitTimeoutMs: 45000,
      proxyRetryAttempts: 5,
      proxyRetryDelayMs: 1000,
      firstHopProxyUrl: "",
      secondHopProxyUrl: "",
      asnPools: {},
      localHost: "127.0.0.1",
      localPort: 0,
      gostExecutable: "",
      gostStartupTimeoutMs: 8000,
      gostPortRetryAttempts: 5,
    },
  },
  paypalRiskRetry: {
    enabled: true,
    mode: "retry",
    maxAttempts: 3,
    rotateRoxy: true,
    newWindow: true,
    recreateCheckout: true,
    cooldownMs: 5000,
  },
  roxy: {
    api_base: "http://127.0.0.1:50000",
    token: "",
    workspace_id: 1,
    windowCount: 5,
    api_rate_limit_per_min: 90,
    headless: true,
    open_args: [],
    windowNamePrefix: "paypal-plus",
    createAttempts: 3,
    createRetryDelayMs: 8000,
    createIntervalMs: 0,
    cdpConnectTimeoutMs: 45000,
    probeExitIp: true,
    requiredRegion: "JP",
    requireExitCountry: "JP",
    ipProbeUrl: "https://api.ipify.org?format=json",
    ipProbeTimeoutMs: 20000,
    localProxyResolveAttempts: 10,
    localProxyResolveDelayMs: 750,
    rotateProxyPerAccount: false,
    rotateProxyEveryAccounts: 3,
    rotateProxyOnFailure: true,
    rotateProxyOnRiskErrors: true,
    reuseWindowProfile: true,
    reopenWindowOnProxyRotate: true,
    closeWindowsOnExit: true,
    deleteWindowsOnExit: false,
    proxy: {
      host: "",
      port: "",
      password: "",
      check_channel: "IPRust.io",
      username_template: "",
      asn_pools: {},
      proxy_method: "custom",
      proxy_category: "SOCKS5",
      protocol: "SOCKS5",
      username: "",
    },
  },
  paypalPhone: {
    leaseMinutes: 30,
    maxUse: 5,
    countryCodes: ["JP"],
    initialSmsDelayMs: 10000,
    pollIntervalMs: 500,
    pollTimeoutMs: 180000,
    fillLocalUsNumber: false,
  },
  checkoutProfile: {
    mode: "plugin-compatible",
    addressProvider: "meiguodizhi",
    addressEndpoint: "https://www.meiguodizhi.com/api/v1/dz",
    hostedAddressCountryCode: "JP",
    hostedAddressPath: "/jp-address",
    hostedAddressMethod: "refresh",
    guestEmailDomain: "gmail.com",
    cardMode: "generated-visa-luhn",
    storeCardInDb: false,
    fallbackAddress: {
      street: "1-1-2 Otemachi",
      city: "Chiyoda-ku",
      state: "Tokyo",
      zip: "1000004",
      countryCode: "JP",
    },
    billingAddress: {
      preferSameAsHostedAddress: true,
      paypalUsRandomUserFallback: true,
      skipAutocompleteWhenDirectAddressAvailable: true,
    },
  },
  verification: {
    openaiEmailProvider: "ms-oauth2api-next",
    msOauth2ApiBaseUrl: "",
    mailboxes: ["INBOX", "Junk"],
    mailPollIntervalMs: 3000,
    mailMaxAttempts: 60,
    mailFetchMode: "mail_new",
    mailLookbackMs: 600000,
    paypalSmsProvider: "phone-pool-sms-url",
    paypalSmsInitialDelayMs: 10000,
    paypalSmsPollIntervalMs: 3000,
    paypalSmsMaxAttempts: 60,
    paypalSmsRequestTimeoutMs: 15000,
    paypalSmsSeenTtlHours: 24,
  },
  sub2api: { baseUrl: "", email: "", password: "", groupName: "codex" },
  cpa: {
    baseUrl: "",
    authorizationBearer: "",
    timeoutMs: 30000,
    uploadLockTimeoutMs: 900000,
    workerAccountOauthTimeoutMs: 600000,
    multiStateSupported: true,
    localJsonEnabled: true,
    localJsonDir: "cpa-json",
    pluginDir: "",
    relativeAuthDir: ".cli-proxy-api",
  },
  openaiPhone: {
    enabled: false,
    provider: "",
    file: "",
    manualPhone: "",
    manualSmsUrl: "",
    heroSmsApiKey: "",
    heroSmsBaseUrl: "https://hero-sms.com/stubs/handler_api.php",
    heroSmsCountryId: 16,
    heroSmsCountryLabel: "United Kingdom",
    heroSmsCountryPool: "16:United Kingdom,151:Chile,73:Brazil,33:Colombia",
    heroSmsServiceCode: "dr",
    heroSmsMinPrice: "",
    heroSmsMaxPrice: "0.07",
    heroSmsReuseFile: "data/openai-phone-activation.json",
    heroSmsReusePhoneNumber: "",
    heroSmsNumberRequestAttempts: 3,
    heroSmsNumberRequestRetryDelayMs: 10000,
    initialSmsDelayMs: 10000,
    pollIntervalMs: 3000,
    pollTimeoutMs: 180000,
    requestTimeoutMs: 15000,
  },
  callbackJson: {
    enabled: true,
    dir: "callback-json",
    mode: "cpa_upload_summary",
  },
  ui: {
    host: "127.0.0.1",
    port: 8787,
  },
  output: { dir: "output" },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(base, override) {
  if (!isPlainObject(base)) return structuredClone(override);
  const result = structuredClone(base);
  if (!isPlainObject(override)) return result;
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = mergeConfig(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function loadConfig(configPath = "") {
  let loaded = {};
  if (configPath) {
    const fullPath = path.resolve(configPath);
    loaded = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  }
  return mergeConfig(DEFAULT_CONFIG, loaded);
}

export function applyCliOverrides(config, args = {}) {
  const result = mergeConfig(config, {});
  if (args.db) result.database.path = String(args.db);
  if (args.windows !== undefined) result.roxy.windowCount = Number.parseInt(String(args.windows), 10);
  if (args.headless === true) result.roxy.headless = true;
  if (args.headed === true) result.roxy.headless = false;
  if (args["no-delete"] === true) result.roxy.deleteWindowsOnExit = false;
  return result;
}
