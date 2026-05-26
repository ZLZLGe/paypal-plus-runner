export function extractGenericCode(payload) {
  const candidates = [];
  if (payload && typeof payload === "object") {
    candidates.push(payload.data, payload.code, payload.text, payload.message);
  }
  candidates.push(payload);
  for (const candidate of candidates) {
    const match = String(candidate || "").match(/\d{6}/);
    if (match) return match[0];
  }
  return "";
}
