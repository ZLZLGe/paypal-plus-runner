import { RunnerError } from "../utils/errors.js";

export const PAYPAL_RISK_BLOCKED_STAGE = "risk_blocked";

function parseUrl(rawUrl = "") {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return {
      host: parsed.hostname.toLowerCase(),
      path: parsed.pathname || "",
    };
  } catch {
    return { host: "", path: "" };
  }
}

function hasPaypalHost(host = "") {
  return /(^|\.)paypal\.com$/i.test(String(host || ""));
}

function collectRiskSignals(text = "") {
  const value = String(text || "");
  const signals = [];
  if (/var\s+dd\s*=/i.test(value)) signals.push("var_dd");
  if (/geo\.ddc\.paypal\.com/i.test(value)) signals.push("geo_ddc_paypal");
  if (/ct\.ddc\.paypal\.com/i.test(value)) signals.push("ct_ddc_paypal");
  if (/datadome/i.test(value)) signals.push("datadome");
  if (/ads-dd-captcha|adsddcaptcha|adsddtoken|adsddsign|adsddm/i.test(value)) signals.push("adsdd_form");
  return [...new Set(signals)];
}

export function inspectPaypalRiskBlockHtml(html = "", rawUrl = "") {
  const { host, path } = parseUrl(rawUrl);
  const isPaypal = hasPaypalHost(host);
  const isApprovalPath = /\/agreements\/approve(?:[/?#]|$)/i.test(path);
  const signals = collectRiskSignals(html);
  const hasDataDome = signals.length > 0;
  const riskBlocked = Boolean(isPaypal && hasDataDome && (isApprovalPath || signals.includes("adsdd_form")));

  return {
    riskBlocked,
    hostedStage: riskBlocked ? PAYPAL_RISK_BLOCKED_STAGE : "",
    host,
    path,
    isApprovalPath,
    signals,
    reason: riskBlocked ? `paypal_datadome_${signals.join("_")}` : "",
  };
}

export function inspectPaypalRiskBlockSnapshot(snapshot = {}) {
  const htmlInspection = inspectPaypalRiskBlockHtml(snapshot.html || "", snapshot.url || "");
  const visibleControlCount = Number(snapshot.visibleControlCount || 0);
  const hasApproveAction = Boolean(snapshot.hasApproveAction);
  const riskBlocked = Boolean(
    htmlInspection.riskBlocked
      && (visibleControlCount === 0 || (htmlInspection.isApprovalPath && !hasApproveAction))
  );

  return {
    ...htmlInspection,
    riskBlocked,
    hostedStage: riskBlocked ? PAYPAL_RISK_BLOCKED_STAGE : "",
    visibleControlCount,
    hasApproveAction,
    reason: riskBlocked
      ? `${htmlInspection.reason || "paypal_datadome"}_visible_controls_${visibleControlCount}`
      : "",
  };
}

export function isPaypalRiskBlockedState(state = {}) {
  if (!state || typeof state !== "object") return false;
  if (state.hostedStage === PAYPAL_RISK_BLOCKED_STAGE) return true;
  if (state.hostedRiskBlocked === true) return true;
  const text = [
    state.riskBlockReason,
    state.hostedErrorText,
    state.bodyTextPreview,
    state.url,
  ].filter(Boolean).join(" ");
  return collectRiskSignals(text).length > 0;
}

export async function inspectPaypalRiskBlockedPage(page) {
  if (!page) return { riskBlocked: false, reason: "no_page" };
  const snapshot = await page.evaluate(() => {
    const isVisibleElement = (el) => {
      if (!el) return false;
      let node = el;
      while (node && node.nodeType === 1) {
        if (node.hidden || node.getAttribute?.("aria-hidden") === "true" || node.getAttribute?.("inert") !== null) {
          return false;
        }
        const nodeStyle = window.getComputedStyle(node);
        if (
          nodeStyle.display === "none"
          || nodeStyle.visibility === "hidden"
          || nodeStyle.visibility === "collapse"
          || Number(nodeStyle.opacity) === 0
        ) {
          return false;
        }
        node = node.parentElement;
      }
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(rect.width) > 0
        && Number(rect.height) > 0;
    };
    const actionText = (el) => String([
      el?.innerText,
      el?.textContent,
      el?.value,
      el?.getAttribute?.("aria-label"),
      el?.getAttribute?.("title"),
      el?.getAttribute?.("name"),
      el?.id,
    ].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
    const controls = Array.from(document.querySelectorAll("button,a,input:not([type='hidden']),select,textarea,[role='button']"))
      .filter(isVisibleElement);
    return {
      url: location.href,
      html: String(document.documentElement?.outerHTML || ""),
      visibleControlCount: controls.length,
      hasApproveAction: controls.some((el) => /agree|continue|authorize|accept|同意|继续|授权/i.test(actionText(el))),
    };
  });

  return inspectPaypalRiskBlockSnapshot(snapshot);
}

export function buildPaypalRiskBlockedError(state = {}, stage = {}) {
  const host = state.host || stage.host || "";
  const path = state.path || stage.path || "";
  const reason = state.riskBlockReason || state.reason || "paypal_datadome_or_empty_approval";
  return new RunnerError(`PAYPAL_RISK_BLOCKED::PayPal risk/DataDome block detected at ${host}${path}; ${reason}`, {
    code: "PAYPAL_RISK_BLOCKED",
    retryable: true,
  });
}
