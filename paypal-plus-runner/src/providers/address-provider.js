export function normalizeAddress(raw = {}, fallback = {}) {
  const fb = fallback || {};
  return {
    street: String(raw.Address || raw.Trans_Address || raw.street || fb.street || "123 Main St").trim(),
    city: String(raw.City || raw.city || fb.city || "New York").trim(),
    state: String(raw.State_Full || raw.State || raw.state || fb.state || "New York").trim(),
    zip: String(raw.Zip_Code || raw.zip || raw.postalCode || fb.zip || "10001").trim().slice(0, 5) || "10001",
    countryCode: String(raw.countryCode || fb.countryCode || "US").trim().toUpperCase(),
  };
}

export async function fetchHostedAddress(config = {}) {
  const profile = config.checkoutProfile || {};
  const fallback = profile.fallbackAddress || {};
  const endpoint = String(profile.addressEndpoint || "").trim();
  if (!endpoint || profile.addressProvider === "fallback") {
    return { ...normalizeAddress({}, fallback), source: "fallback" };
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        path: profile.hostedAddressPath || "/",
        method: profile.hostedAddressMethod || "address",
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json();
    return { ...normalizeAddress(data?.address || data || {}, fallback), source: "meiguodizhi" };
  } catch (error) {
    return { ...normalizeAddress({}, fallback), source: "fallback", warning: error.message };
  }
}
