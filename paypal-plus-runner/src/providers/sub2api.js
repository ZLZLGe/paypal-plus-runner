export async function importToSub2Api({ sessionJson, account, config }) {
  const baseUrl = String(config.sub2api?.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return { status: "skipped", reason: "sub2api.baseUrl_empty" };
  const email = String(config.sub2api?.email || account?.email || "").trim();
  const password = String(config.sub2api?.password || config.runner?.gptPassword || "myPASSword!").trim();
  const groupName = String(config.sub2api?.groupName || "codex").trim();
  const headers = { Accept: "application/json", "Content-Type": "application/json" };
  const response = await fetch(`${baseUrl}/api/v1/auth-files`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: `${account.email}.json`,
      email,
      password,
      group: groupName,
      content: typeof sessionJson === "string" ? sessionJson : JSON.stringify(sessionJson || {}),
    }),
    signal: AbortSignal.timeout(Number(config.sub2api?.timeoutMs || 45000)),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) throw new Error(`sub2api import failed HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return { status: "done", data };
}
