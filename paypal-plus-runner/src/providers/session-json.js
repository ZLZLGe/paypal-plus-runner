function parseJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export function buildSessionJson(record = {}) {
  const accessToken = String(record.accessToken || record.access_token || "").trim();
  if (!accessToken) throw new Error("session JSON requires accessToken");
  const session = record.session && typeof record.session === "object" ? record.session : {};
  const payload = parseJwtPayload(accessToken);
  const email = String(record.email || session?.user?.email || session.email || payload.email || "").trim();
  const expiresAt = record.expiresAt || session.expires || session.expiresAt || payload.exp ? (
    typeof (record.expiresAt || session.expires || session.expiresAt) === "string"
      ? (record.expiresAt || session.expires || session.expiresAt)
      : new Date(Number(payload.exp || 0) * 1000).toISOString()
  ) : "";
  return JSON.stringify({
    email,
    access_token: accessToken,
    id_token: record.idToken || record.id_token || session.idToken || session.id_token || "",
    refresh_token: record.refreshToken || record.refresh_token || session.refreshToken || session.refresh_token || "",
    session_token: record.sessionToken || record.session_token || session.sessionToken || session.session_token || "",
    expires_at: expiresAt,
    account_id: record.accountId || session?.account?.id || session.account_id || "",
    user_id: record.userId || session?.user?.id || session.user_id || payload.sub || "",
    plan_type: record.planType || session?.account?.planType || session?.account?.plan_type || session.planType || "",
    raw_session: session,
  }, null, 2);
}

export async function readSessionJson(page) {
  if (!page) throw new Error("readSessionJson requires a page");
  const result = await page.evaluate(async () => {
    const candidates = [];
    async function readAuthSession() {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error(`auth session HTTP ${response.status}`);
      return response.json();
    }
    try {
      const session = await readAuthSession();
      candidates.push({
        session,
        accessToken: session?.accessToken || session?.access_token || "",
        email: session?.user?.email || session?.email || "",
        expiresAt: session?.expires || session?.expiresAt || "",
      });
    } catch (error) {
      candidates.push({ error: error.message });
    }
    for (const storage of [localStorage, sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        const value = storage.getItem(key);
        if (/access.?token|session/i.test(`${key} ${value}`)) {
          candidates.push({ key, value });
        }
      }
    }
    return candidates;
  });
  const direct = result.find((item) => item.accessToken);
  if (direct) return { sessionJson: buildSessionJson(direct), accessToken: direct.accessToken, raw: result };
  const tokenMatch = JSON.stringify(result).match(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  if (tokenMatch) {
    const accessToken = tokenMatch[0];
    return { sessionJson: buildSessionJson({ accessToken }), accessToken, raw: result };
  }
  throw new Error("could not extract ChatGPT session accessToken");
}
