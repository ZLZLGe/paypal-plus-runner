export function normalizeCheckoutResult(data = {}, provider = "") {
  const preferredCheckoutUrl = String(
    data.preferredCheckoutUrl
    || data.hostedCheckoutUrl
    || data.convertedCheckoutUrl
    || data.chatgptCheckoutUrl
    || data.checkoutUrl
    || data.stripe_payurl
    || "",
  ).trim();
  const alreadyPaid = Boolean(data.alreadyPaid) || /user is already paid/i.test(String(data.detail || data.message || ""));
  if (!preferredCheckoutUrl && !alreadyPaid) {
    throw new Error(`checkout conversion missing checkout url: ${JSON.stringify(data).slice(0, 1000)}`);
  }
  return {
    ok: true,
    provider,
    checkoutSessionId: String(data.checkoutSessionId || data.checkout_session_id || ""),
    checkoutUrl: String(data.checkoutUrl || ""),
    chatgptCheckoutUrl: String(data.chatgptCheckoutUrl || data.convertedCheckoutUrl || ""),
    hostedCheckoutUrl: String(data.hostedCheckoutUrl || data.stripe_payurl || ""),
    preferredCheckoutUrl,
    processorEntity: String(data.processorEntity || "openai_llc"),
    country: String(data.country || "US"),
    currency: String(data.currency || "USD"),
    alreadyPaid,
    alreadyPaidReason: alreadyPaid ? String(data.detail || data.message || data.alreadyPaidReason || "User is already paid") : "",
    exitRegion: String(data.exitRegion || data.gost_region || ""),
    exitIp: String(data.exitIp || ""),
    asn: String(data.asn || data.gost_asn || ""),
    sid: String(data.sid || data.gost_sid || ""),
    raw: data,
  };
}
