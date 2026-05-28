export async function detectLoggedInChatgpt(page) {
  if (!page) return { loggedIn: false, url: "" };
  return page.evaluate(() => {
    const text = String(document.body?.innerText || document.body?.textContent || "").replace(/\s+/g, " ");
    const url = location.href;
    const host = location.hostname;
    const isChatgpt = /chatgpt\.com|chat\.openai\.com/i.test(host);
    const hasComposer = Boolean(document.querySelector("textarea, [contenteditable='true'], form textarea, main form"));
    const loggedInText = /new chat|search chats|where should we begin|what are you working on|ask anything|projects|library|you're all set/i.test(text);
    const hasLoggedInShell = /new chat|search chats/i.test(text)
      && /chat history|projects|library|apps|codex/i.test(text);
    const authPage = /\/auth|\/log-in|\/create-account|email-verification/i.test(url);
    return {
      loggedIn: isChatgpt && (hasComposer || loggedInText || hasLoggedInShell) && !authPage,
      url,
      hasComposer,
      hasLoggedInShell,
      text: text.slice(0, 300),
    };
  }).catch(() => ({ loggedIn: false, url: page.url() }));
}
