export function buildCheckoutPayload(config = {}) {
  return {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    checkout_ui_mode: "hosted",
    billing_details: {
      country: String(config.country || "US").toUpperCase(),
      currency: String(config.currency || "USD").toUpperCase(),
    },
    promo_campaign: {
      promo_campaign_id: config.useFreeTrialPromo === false ? "" : "plus-1-month-free",
      is_coupon_from_query_param: config.useFreeTrialPromo !== false,
    },
  };
}

export function buildCheckoutHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: "https://chatgpt.com",
    Referer: "https://chatgpt.com/",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
}
