function positiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function waitForPageTimeout(page, ms) {
  if (page?.waitForTimeout) {
    await page.waitForTimeout(ms);
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function dismissChatgptPrivacyDialog(page, {
  timeoutMs = 6000,
  stableAbsentMs = 800,
  pollMs = 200,
} = {}) {
  if (!page?.evaluate) {
    return { present: false, clicked: false, settled: true, reason: "no_page" };
  }

  const timeout = positiveInt(timeoutMs, 6000);
  const stableAbsent = Math.max(0, positiveInt(stableAbsentMs, 800));
  const poll = positiveInt(pollMs, 200);
  const startedAt = Date.now();
  let absentSince = 0;
  let lastResult = null;
  const clickedButtons = [];

  while (Date.now() - startedAt < timeout) {
    lastResult = await page.evaluate(() => {
      const normalizeText = (value = "") => String(value || "").replace(/\s+/g, " ").trim();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && style.opacity !== "0"
          && rect.width > 0
          && rect.height > 0;
      };
      const actionText = (el) => normalizeText([
        el?.textContent,
        el?.innerText,
        el?.value,
        el?.getAttribute?.("aria-label"),
        el?.getAttribute?.("title"),
        el?.id,
        el?.className,
      ].filter(Boolean).join(" "));
      const hasPrivacyText = (text = "") => /cookie|cookies|privacy|クッキー|プライバシ|隐私|隱私/i.test(text);
      const buttonSelector = [
        "button",
        "[role='button']",
        "input[type='button']",
        "input[type='submit']",
      ].join(", ");
      const enabledControl = (el) => visible(el)
        && !el.disabled
        && el.getAttribute?.("aria-disabled") !== "true";
      const scoreControl = (el) => {
        const text = actionText(el);
        if (!text) return 0;
        if (/close|dismiss|閉じる|关闭|關閉/i.test(text)) return 100;
        if (/accept all|accept|agree|allow|got it|ok|okay|continue|save|すべて同意|同意|受け入れ|許可|続行|保存|接受|允许|允許|继续|繼續|知道了|好的|确定|確認/i.test(text)) {
          if (/manage|settings|設定を管理|cookie.*settings/i.test(text)) return 20;
          return 90;
        }
        return 0;
      };
      const containerSelectors = [
        "[role='dialog']",
        "[aria-modal='true']",
        "[data-testid*='cookie' i]",
        "[data-testid*='privacy' i]",
        "[id*='cookie' i]",
        "[id*='privacy' i]",
        "[class*='cookie' i]",
        "[class*='privacy' i]",
      ].join(", ");
      const containers = new Set();
      for (const el of Array.from(document.querySelectorAll(containerSelectors))) {
        if (visible(el) && hasPrivacyText(normalizeText(el.innerText || el.textContent || ""))) {
          containers.add(el);
        }
      }
      for (const el of Array.from(document.querySelectorAll("body > div, body > section, body > aside"))) {
        if (!visible(el)) continue;
        const style = window.getComputedStyle(el);
        const position = String(style.position || "").toLowerCase();
        const text = normalizeText(el.innerText || el.textContent || "");
        const hasButton = el.querySelectorAll(buttonSelector).length > 0;
        if (hasButton && hasPrivacyText(text) && (position === "fixed" || position === "sticky")) {
          containers.add(el);
        }
      }
      const visibleContainers = Array.from(containers);
      if (!visibleContainers.length) {
        return { present: false, clicked: false, reason: "privacy_dialog_not_present" };
      }

      for (const container of visibleContainers) {
        const candidates = Array.from(container.querySelectorAll(buttonSelector))
          .filter(enabledControl)
          .map((el) => ({ el, text: actionText(el), score: scoreControl(el) }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score);
        const target = candidates[0];
        if (!target) continue;
        target.el.click();
        return {
          present: true,
          clicked: true,
          reason: "privacy_dialog_clicked",
          buttonText: target.text.slice(0, 120),
          containerCount: visibleContainers.length,
        };
      }

      return {
        present: true,
        clicked: false,
        reason: "privacy_dialog_present_no_action",
        containerCount: visibleContainers.length,
      };
    }).catch((error) => ({
      present: false,
      clicked: false,
      settled: false,
      reason: "privacy_dialog_eval_failed",
      error: error.message,
    }));

    if (lastResult.clicked) {
      clickedButtons.push(lastResult.buttonText || "privacy_dialog_button");
      absentSince = 0;
      await waitForPageTimeout(page, poll);
      continue;
    }
    if (lastResult.present) {
      return {
        ...lastResult,
        settled: false,
        clicked: clickedButtons.length > 0,
        clickedButtons,
      };
    }
    if (!absentSince) absentSince = Date.now();
    if (Date.now() - absentSince >= stableAbsent) {
      return {
        present: false,
        clicked: clickedButtons.length > 0,
        clickedButtons,
        settled: true,
        reason: clickedButtons.length > 0 ? "privacy_dialog_dismissed_and_absent" : "privacy_dialog_absent_stable",
      };
    }
    await waitForPageTimeout(page, poll);
  }

  return {
    ...(lastResult || { present: false, clicked: false, reason: "privacy_dialog_timeout" }),
    clicked: clickedButtons.length > 0,
    clickedButtons,
    settled: false,
  };
}
