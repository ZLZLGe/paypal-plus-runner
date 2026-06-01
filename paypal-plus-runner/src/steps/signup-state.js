export async function detectLoggedInChatgpt(page) {
  if (!page) return { loggedIn: false, url: "" };
  return page.evaluate(async () => {
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const url = location.href;
    const host = location.hostname;
    const isChatgpt = /chatgpt\.com|chat\.openai\.com/i.test(host);
    const hasComposer = Boolean(document.querySelector("textarea, [contenteditable='true'], form textarea, main form"));
    const html = String(document.documentElement?.innerHTML || "");
    const loggedInText = /new chat|search chats|where should we begin|what are you working on|ask anything|projects|library|you're all set|新しいチャット|チャットを検索|どんなことをしてますか|プロジェクト|ライブラリ/i.test(text);
    const hasLoggedInShell = /new chat|search chats|新しいチャット|チャットを検索/i.test(text)
      && /chat history|projects|library|apps|codex|チャット履歴|プロジェクト|ライブラリ|アプリ/i.test(text);
    const hasServerUserContext = /"userID":"user-|workspace_id|account_id|has_logged_in_before|plan_type/i.test(html);
    let hasAuthSession = false;
    let authSessionStatus = 0;
    try {
      const response = await fetch("/api/auth/session", {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      authSessionStatus = response.status;
      if (response.ok) {
        const session = await response.json().catch(() => ({}));
        hasAuthSession = Boolean(session?.accessToken || session?.access_token || session?.user?.id || session?.user?.email);
      }
    } catch {
      hasAuthSession = false;
    }
    const authPage = /\/auth|\/log-in|\/create-account|email-verification/i.test(url);
    return {
      loggedIn: isChatgpt && (hasComposer || loggedInText || hasLoggedInShell || hasServerUserContext || hasAuthSession) && !authPage,
      url,
      hasComposer,
      hasLoggedInShell,
      hasServerUserContext,
      hasAuthSession,
      authSessionStatus,
      text: text.slice(0, 300),
    };
  }).catch(() => ({ loggedIn: false, url: page.url() }));
}
