import { randomSid } from "../utils/ids.js";
import { chooseAsnForTemplate, renderProxyTemplate } from "../roxy/proxy-asn.js";
import { curlRequest } from "./curl-transport.js";
import { startGostChain, stopGostChain } from "./gost-chain.js";
import { detectCountryCode, extractIp, lookupCountryCodeForIp } from "./geo-probe.js";

function normalizeProxyUrl(value) {
  const proxy = String(value || "").trim();
  if (!proxy) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(proxy) ? proxy : `http://${proxy}`;
}

export async function probeLocalJpCheckoutProxy(config) {
  const local = config.checkoutConversion?.localJpProxy || {};
  const secondHop = String(local.secondHopProxyUrl || "").trim();
  if (!secondHop) throw new Error("checkoutConversion.localJpProxy.secondHopProxyUrl is empty");
  const sid = randomSid();
  const { asn, region } = chooseAsnForTemplate(secondHop, local.asnPools, "JP");
  const renderedSecondHop = renderProxyTemplate(secondHop, { sid, asn });
  const mode = String(local.mode || "direct_proxy_url");
  let chain = null;
  let proxyUrl = normalizeProxyUrl(renderedSecondHop);
  try {
    if (mode === "gost_chain") {
      chain = await startGostChain({
        firstHopProxyUrl: local.firstHopProxyUrl,
        secondHopProxyUrl: renderedSecondHop,
        sid,
        localHost: local.localHost || "127.0.0.1",
        localPort: Number(local.localPort || 0),
        startupTimeoutMs: Number(local.gostStartupTimeoutMs || 8000),
        portRetryAttempts: Number(local.gostPortRetryAttempts || 5),
        executable: local.gostExecutable || "",
      });
      proxyUrl = chain.proxyUrl;
    } else if (mode !== "direct_proxy_url") {
      throw new Error(`unsupported localJpProxy.mode: ${mode}`);
    }

    const response = await curlRequest({
      url: String(local.probeUrl || "https://iplark.com/ipapi/public/ip"),
      proxyUrl,
      timeoutMs: Number(local.probeTimeoutMs || local.requestTimeoutMs || 45000),
      connectTimeoutMs: Number(local.connectTimeoutMs || 15000),
      headers: { Accept: "application/json,text/plain,*/*" },
    });
    const exitIp = extractIp(response.text) || response.remoteIp || "";
    let countryCode = detectCountryCode(response.text);
    if (!countryCode && exitIp) {
      countryCode = await lookupCountryCodeForIp(exitIp, {
        timeoutMs: Number(local.geoLookupTimeoutMs || 15000),
        connectTimeoutMs: Number(local.connectTimeoutMs || 8000),
      });
    }
    return {
      ok: response.status >= 200 && response.status < 400,
      mode,
      sid,
      asn,
      region,
      proxyUrl,
      status: response.status,
      countryCode,
      exitIp,
      body: response.text.slice(0, 1200),
      gostPid: chain?.pid || 0,
      gostLogPath: chain?.logPath || "",
    };
  } finally {
    if (chain) await stopGostChain(chain);
  }
}
