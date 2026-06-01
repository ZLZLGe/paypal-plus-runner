// content/paypal-flow.js — PayPal login and approval helper.

console.log('[MultiPage:paypal-flow] Content script loaded on', location.href);

const PAYPAL_FLOW_LISTENER_SENTINEL = 'data-multipage-paypal-flow-listener';
const PAYPAL_HOSTED_DEFAULT_PHONE = '1234567890';
const PAYPAL_HOSTED_STAGE_OUTSIDE = 'outside_paypal';
const PAYPAL_HOSTED_STAGE_LOGIN = 'pay_login';
const PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT = 'guest_checkout';
const PAYPAL_HOSTED_STAGE_VERIFICATION = 'verification';
const PAYPAL_HOSTED_STAGE_REVIEW = 'review_consent';
const PAYPAL_HOSTED_STAGE_APPROVAL = 'approval';
const PAYPAL_HOSTED_STAGE_GENERIC_ERROR = 'generic_error';
const PAYPAL_HOSTED_STAGE_PHONE_REJECTED = 'phone_rejected';
const PAYPAL_HOSTED_STAGE_RISK_BLOCKED = 'risk_blocked';
const PAYPAL_HOSTED_STAGE_PRIVACY_SETTINGS = 'privacy_settings';
const PAYPAL_HOSTED_STAGE_UNKNOWN = 'unknown';
const PAYPAL_HOSTED_HERMES_AUTORUN_SENTINEL = '__MULTIPAGE_PAYPAL_HOSTED_HERMES_AUTORUN__';
const PAYPAL_HOSTED_GUEST_SUBMIT_SENTINEL = '__MULTIPAGE_PAYPAL_HOSTED_GUEST_SUBMIT__';
const PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL = '__MULTIPAGE_PAYPAL_HOSTED_CAPTCHA_GUARD__';
const PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT = '__MULTIPAGE_PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT__';

const paypalFlowRootElement = document.documentElement;
if (!paypalFlowRootElement) {
  console.warn('[MultiPage:paypal-flow] documentElement is not ready; skipping listener registration for this injection');
} else if (paypalFlowRootElement.getAttribute(PAYPAL_FLOW_LISTENER_SENTINEL) !== '1') {
  paypalFlowRootElement.setAttribute(PAYPAL_FLOW_LISTENER_SENTINEL, '1');

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      message.type === 'PAYPAL_GET_STATE'
      || message.type === 'PAYPAL_SUBMIT_LOGIN'
      || message.type === 'PAYPAL_DISMISS_PROMPTS'
      || message.type === 'PAYPAL_CLICK_APPROVE'
      || message.type === 'PAYPAL_HOSTED_GET_STATE'
      || message.type === 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP'
    ) {
      resetStopState();
      handlePayPalCommand(message).then((result) => {
        sendResponse({ ok: true, ...(result || {}) });
      }).catch((err) => {
        if (isStopError(err)) {
          sendResponse({ stopped: true, error: err.message });
          return;
        }
        sendResponse({ error: err.message });
      });
      return true;
    }
  });
} else {
  console.log('[MultiPage:paypal-flow] 消息监听已存在，跳过重复注册');
}

async function performPayPalOperationWithDelay(metadata, operation) {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
  return typeof gate === 'function' ? gate(metadata, operation) : operation();
}

async function handlePayPalCommand(message) {
  switch (message.type) {
    case 'PAYPAL_GET_STATE':
      return inspectPayPalState();
    case 'PAYPAL_SUBMIT_LOGIN':
      return submitPayPalLogin(message.payload || {});
    case 'PAYPAL_DISMISS_PROMPTS':
      return dismissPayPalPrompts();
    case 'PAYPAL_CLICK_APPROVE':
      return clickPayPalApprove();
    case 'PAYPAL_HOSTED_GET_STATE':
      return inspectPayPalState();
    case 'PAYPAL_RUN_HOSTED_CHECKOUT_STEP':
      return runHostedCheckoutStep(message.payload || {});
    default:
      throw new Error(`paypal-flow.js 不处理消息：${message.type}`);
  }
}

async function waitUntil(predicate, options = {}) {
  const intervalMs = Math.max(50, Math.floor(Number(options.intervalMs) || 250));
  const timeoutMs = Math.max(0, Math.floor(Number(options.timeoutMs) || 0));
  const startedAt = Date.now();
  while (true) {
    throwIfStopped();
    const value = await predicate();
    if (value) {
      return value;
    }
    if (timeoutMs > 0 && Date.now() - startedAt >= timeoutMs) {
      throw new Error(options.timeoutMessage || 'PayPal page timed out waiting for target state.');
    }
    await sleep(intervalMs);
  }
}

async function waitForDocumentComplete(options = {}) {
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 30000));
  await waitUntil(() => document.readyState === 'complete', {
    intervalMs: 200,
    timeoutMs,
    timeoutMessage: 'PayPal page did not reach document complete.',
  }).catch((error) => {
    log(`PayPal page document complete wait timed out, continuing with current DOM: ${error?.message || error}`, 'warn');
  });
  await sleep(1000);
}

function isVisibleElement(el) {
  if (!el) return false;
  let node = el;
  while (node && node.nodeType === 1) {
    if (node.hidden || node.getAttribute?.('aria-hidden') === 'true' || node.getAttribute?.('inert') !== null) {
      return false;
    }
    const nodeStyle = window.getComputedStyle(node);
    if (
      nodeStyle.display === 'none'
      || nodeStyle.visibility === 'hidden'
      || nodeStyle.visibility === 'collapse'
      || Number(nodeStyle.opacity) === 0
    ) {
      return false;
    }
    node = node.parentElement;
  }
  const style = window.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  return style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number(rect.width) > 0
    && Number(rect.height) > 0;
}

function normalizeText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function getActionText(el) {
  return normalizeText([
    el?.textContent,
    el?.value,
    el?.getAttribute?.('aria-label'),
    el?.getAttribute?.('title'),
    el?.getAttribute?.('placeholder'),
    el?.getAttribute?.('name'),
    el?.id,
  ].filter(Boolean).join(' '));
}

function getVisibleControls(selector) {
  return Array.from(document.querySelectorAll(selector)).filter(isVisibleElement);
}

function isEnabledControl(el) {
  return Boolean(el)
    && !el.disabled
    && el.getAttribute?.('aria-disabled') !== 'true';
}

function findClickableByText(patterns) {
  const normalizedPatterns = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
  const candidates = getVisibleControls('button, a, [role="button"], input[type="button"], input[type="submit"]');
  return candidates.find((el) => {
    const text = getActionText(el);
    return normalizedPatterns.some((pattern) => pattern.test(text));
  }) || null;
}

function findInputByPatterns(patterns) {
  const inputs = getVisibleControls('input')
    .filter((input) => {
      const type = String(input.getAttribute('type') || input.type || '').trim().toLowerCase();
      return isEnabledControl(input) && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type);
    });
  return inputs.find((input) => {
    const text = getActionText(input);
    return patterns.some((pattern) => pattern.test(text));
  }) || null;
}

function findEmailInput() {
  const isPasswordCandidate = (input) => {
    const type = String(input?.getAttribute?.('type') || input?.type || '').trim().toLowerCase();
    const metadataText = normalizeText([
      input?.textContent,
      input?.getAttribute?.('aria-label'),
      input?.getAttribute?.('title'),
      input?.getAttribute?.('placeholder'),
      input?.getAttribute?.('name'),
      input?.id,
    ].filter(Boolean).join(' '));
    return type === 'password' || /password|pass|密码/i.test(metadataText);
  };
  const inputs = getVisibleControls('input')
    .filter((input) => {
      const type = String(input.getAttribute('type') || input.type || '').trim().toLowerCase();
      return isEnabledControl(input)
        && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type)
        && !isPasswordCandidate(input);
    });
  return inputs.find((input) => [
    /email|e-mail|login|user|address|mail|アドレス|メール|携帯電話|電話番号|账号|邮箱/i,
  ].some((pattern) => pattern.test(getActionText(input))))
    || getVisibleControls('input[type="email"]').find((input) => isVisibleElement(input) && !isPasswordCandidate(input))
    || null;
}

function findPasswordInput() {
  const inputs = getVisibleControls('input')
    .filter((input) => {
      const type = String(input.getAttribute('type') || input.type || '').trim().toLowerCase();
      return isEnabledControl(input) && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type);
    });
  return inputs.find((input) => {
    const type = String(input.getAttribute('type') || input.type || '').trim().toLowerCase();
    const metadataText = normalizeText([
      input?.textContent,
      input?.getAttribute?.('aria-label'),
      input?.getAttribute?.('title'),
      input?.getAttribute?.('placeholder'),
      input?.getAttribute?.('name'),
      input?.id,
    ].filter(Boolean).join(' '));
    return type === 'password' || /password|pass|密码/i.test(metadataText);
  }) || getVisibleControls('input[type="password"]').find(isVisibleElement) || null;
}

function findLoginNextButton() {
  return findClickableByText([
    /next|continue|login|log\s*in|sign\s*in|avançar|avancar|continuar|entrar|prosseguir|seguinte|siguiente/i,
    /次へ|続行|ログイン|サインイン/i,
    /下一步|继续|登录|登入/i,
  ]);
}

function findEmailNextButton() {
  return findClickableByText([
    /next|btn\s*next|btnnext|avançar|avancar|continuar|prosseguir|seguinte|siguiente/i,
    /次へ|続行/i,
    /下一页|下一步/i,
  ]);
}

function findPasswordLoginButton() {
  const button = findClickableByText([
    /login|log\s*in|sign\s*in/i,
    /登录|登入/i,
  ]);
  return button && button !== findEmailNextButton() ? button : null;
}

function findApproveButton() {
  return findClickableByText([
    /同意して続行|同意して支払う|続行|承認|同意/i,
    /同意并继续|同意|继续|授权|确认并继续/i,
    /agree\s*(?:and)?\s*continue|continue|accept|authorize|agree|pay\s*now/i,
  ]);
}

function getPayPalHostedPathname() {
  return String(location?.pathname || '').trim();
}

function isPayPalHostedBillingPage() {
  return /\/pay\/billing(?:\/|$)/i.test(getPayPalHostedPathname());
}

function isPayPalHostedLoginPage() {
  const pathname = getPayPalHostedPathname();
  return pathname === '/pay'
    || Boolean(document.getElementById('email'))
    || Boolean(findEmailInput());
}

function findHostedBillingAddCardButton() {
  if (!isPayPalHostedBillingPage()) {
    return null;
  }
  return findClickableByText([
    /add\s*(?:a\s*)?card|add\s*payment|add\s*payment\s*method/i,
    /添加.*卡|新增.*卡|银行卡|信用卡/i,
  ]);
}

function findHostedInputByCandidates(ids = [], patterns = []) {
  for (const id of ids) {
    const direct = document.getElementById(String(id || '').trim());
    if (direct && isVisibleElement(direct) && isEnabledControl(direct)) {
      return direct;
    }
  }
  const normalizedPatterns = (Array.isArray(patterns) ? patterns : [patterns]).filter(Boolean);
  if (!normalizedPatterns.length) {
    return null;
  }
  return getVisibleControls('input')
    .filter((input) => {
      const type = String(input.getAttribute('type') || input.type || '').trim().toLowerCase();
      return isEnabledControl(input) && !['hidden', 'checkbox', 'radio', 'submit', 'button', 'file'].includes(type);
    })
    .find((input) => {
      const text = getActionText(input);
      return normalizedPatterns.some((pattern) => pattern.test(text));
    }) || null;
}

function findHostedCardNumberInput() {
  return findHostedInputByCandidates(
    ['cardNumber', 'cardnumber', 'card-number', 'card_number', 'cc-number', 'cc_number', 'creditCardNumber'],
    [/card\s*number|cardnumber|credit\s*card|cc-?number|卡号|银行卡/i]
  );
}

function hasHostedCardPaymentInputs() {
  return Boolean(findHostedCardNumberInput());
}

function hasPayPalHostedBusyIndicator() {
  const selectors = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '[data-testid*="loading"]',
    '[data-testid*="spinner"]',
    '[class*="spinner"]',
    '[class*="Spinner"]',
    '[class*="loading"]',
    '[class*="Loading"]',
    '[class*="loader"]',
    '[class*="progress"]',
    '[id*="spinner"]',
    '[id*="loading"]',
    'svg[aria-label]',
  ];
  let candidates = [];
  try {
    candidates = Array.from(document.querySelectorAll(selectors.join(',')));
  } catch {
    candidates = [];
  }
  return candidates.some((element) => {
    if (!isVisibleElement(element)) {
      return false;
    }
    const metadata = normalizeText([
      element.id,
      element.className,
      element.getAttribute?.('role'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('aria-busy'),
      element.getAttribute?.('data-testid'),
    ].filter(Boolean).join(' '));
    return element.getAttribute?.('aria-busy') === 'true'
      || element.getAttribute?.('role') === 'progressbar'
      || /spinner|loading|loader|progress|busy|processing|wait/i.test(metadata);
  }) || hasPayPalHostedLoginSubmitBusyState();
}

function hasPayPalHostedLoginSubmitBusyState() {
  if (!isPayPalHostedLoginPage()) {
    return false;
  }

  const emailInput = document.getElementById('email') || document.getElementById('login_email');
  const enteredEmail = normalizeText(emailInput?.value || emailInput?.getAttribute?.('value') || '');
  if (!enteredEmail) {
    return false;
  }

  const controls = getVisibleControls('button, [role="button"], input[type="submit"], input[type="button"]');
  return controls.some((control) => {
    const text = getActionText(control);
    if (!/(?:next|continue|login|log\s*in|sign\s*in|avançar|avancar|continuar|entrar|prosseguir|seguinte|siguiente|continuar|下一步|继续|登录|登入)/i.test(text)) {
      return false;
    }

    const metadata = normalizeText([
      control.id,
      control.className,
      control.getAttribute?.('role'),
      control.getAttribute?.('aria-label'),
      control.getAttribute?.('aria-busy'),
      control.getAttribute?.('data-testid'),
    ].filter(Boolean).join(' '));
    const hasSpinnerChild = Boolean(control.querySelector?.(
      '[aria-busy="true"], [role="progressbar"], [class*="spinner"], [class*="loading"], [class*="loader"], [class*="progress"], svg'
    ));

    return control.disabled
      || control.getAttribute?.('aria-disabled') === 'true'
      || control.getAttribute?.('aria-busy') === 'true'
      || /spinner|loading|loader|progress|busy|processing|wait/i.test(metadata)
      || hasSpinnerChild;
  });
}

function isPayPalHostedGuestCheckoutPage() {
  const pathname = getPayPalHostedPathname();
  return /\/checkoutweb\//i.test(pathname)
    || isPayPalHostedBillingPage()
    || Boolean(findHostedBillingAddCardButton())
    || hasHostedCardPaymentInputs()
    || Boolean(document.getElementById('cardNumber'))
    || Boolean(document.getElementById('billingLine1'));
}

function getPayPalHostedBodyText() {
  return normalizeText([
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join(' '));
}

function getPayPalHostedHtmlText() {
  return String(document.documentElement?.outerHTML || '');
}

function getPayPalHostedVisibleControlCount() {
  return getVisibleControls('button, a, input:not([type="hidden"]), select, textarea, [role="button"]').length;
}

function getPayPalHostedRiskSignals() {
  const htmlText = getPayPalHostedHtmlText();
  const signals = [];
  if (/var\s+dd\s*=/i.test(htmlText)) signals.push('var_dd');
  if (/geo\.ddc\.paypal\.com/i.test(htmlText)) signals.push('geo_ddc_paypal');
  if (/ct\.ddc\.paypal\.com/i.test(htmlText)) signals.push('ct_ddc_paypal');
  if (/datadome/i.test(htmlText)) signals.push('datadome');
  if (/ads-dd-captcha|adsddcaptcha|adsddtoken|adsddsign|adsddm/i.test(htmlText)) signals.push('adsdd_form');
  return [...new Set(signals)];
}

function isPayPalHostedRiskBlockedPage() {
  return false;
}

function getPayPalHostedRiskBlockReason() {
  const signals = getPayPalHostedRiskSignals();
  if (!signals.length) {
    return '';
  }
  return `paypal_datadome_${signals.join('_')}_visible_controls_${getPayPalHostedVisibleControlCount()}`;
}

function isPayPalHostedGenericErrorPage() {
  const pathname = getPayPalHostedPathname();
  if (/\/checkoutweb\/genericerror(?:\/|$)/i.test(pathname) || /\/pay\/generic-error(?:\/|$)/i.test(pathname)) {
    return true;
  }
  const pageText = getPayPalHostedBodyText();
  return /things\s+don.?t\s+appear\s+to\s+be\s+working\s+at\s+the\s+moment/i.test(pageText)
    || /couldn.?t\s+complete\s+your\s+payment/i.test(pageText)
    || /check\s+your\s+account/i.test(pageText);
}

function getPayPalHostedPhoneRejectedText() {
  const pageText = getPayPalHostedBodyText();
  const match = pageText.match(/別の電話番号をお試しください。?/i)
    || pageText.match(/try\s+(?:a\s+)?different\s+phone\s+number\.?/i)
    || pageText.match(/try\s+(?:another|a different)\s+mobile\s+number\.?/i)
    || pageText.match(/请(?:尝试|使用)(?:其他|另一个)电话号码/i);
  return match ? normalizeText(match[0]) : '';
}

function isPayPalHostedPhoneRejectedPage() {
  return Boolean(getPayPalHostedPhoneRejectedText());
}

function getPayPalHostedGenericErrorText() {
  const pageText = getPayPalHostedBodyText();
  if (!pageText) {
    return isPayPalHostedGenericErrorPage() ? 'PayPal hosted genericError' : '';
  }
  const match = pageText.match(/things\s+don.?t\s+appear\s+to\s+be\s+working\s+at\s+the\s+moment\.?/i)
    || pageText.match(/we\s+couldn.?t\s+complete\s+your\s+payment\s+for\s+you\.?/i)
    || pageText.match(/check\s+your\s+account/i);
  if (match) {
    return normalizeText(match[0]);
  }
  return isPayPalHostedGenericErrorPage()
    ? pageText.slice(0, 240)
    : '';
}

function isPayPalHostedReviewPage() {
  return /\/webapps\/hermes/i.test(getPayPalHostedPathname());
}

function hasHostedReviewSignals() {
  const pageText = normalizeText([
    document.title,
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join(' '));
  if (!pageText) {
    return false;
  }
  return [
    /set\s+up\s+once.*pay\s+faster\s+next\s+time/i,
    /pay\s+faster\s+next\s+time/i,
    /review\s+your\s+payment/i,
    /お支払いをご確認ください/,
    /1回限りの設定で、よりスピーディーにお支払いを行えます/,
    /対象となるカードが登録されていません/,
    /銀行口座またはカードを追加/,
    /同意して続行/,
  ].some((pattern) => pattern.test(pageText));
}

function findHostedVerificationInputs() {
  return Array.from({ length: 6 }, (_, index) => document.getElementById(`ci-ciBasic-${index}`))
    .filter((input) => isVisibleElement(input));
}

function getHostedVerificationPromptText() {
  const pageText = normalizeText([
    document.title,
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join(' '));
  if (!pageText) {
    return '';
  }

  const patterns = [
    /enter\s+the\s+code/i,
    /(?:6|six)\s*[- ]?\s*digit\s+code/i,
    /we\s+sent[^.]{0,120}code/i,
    /コードを入力する/,
    /コードを入力/,
    /(?:6桁|６桁)のコード/,
    /コードを[^。]{0,80}送信しました/,
    /新しいコードを送信しました/,
    /验证码|驗證碼|输入代码|輸入代碼/,
  ];
  for (const pattern of patterns) {
    const match = pageText.match(pattern);
    if (match) {
      return normalizeText(match[0]);
    }
  }
  return '';
}

function hasActiveHostedVerificationDialog() {
  const inputs = findHostedVerificationInputs();
  if (inputs.length < 6) {
    return false;
  }
  if (getHostedVerificationPromptText()) {
    return true;
  }
  if (findHostedVerificationCloseButton()) {
    return true;
  }
  return inputs.includes(document.activeElement);
}

function hasHostedVerificationInputs() {
  const inputs = findHostedVerificationInputs();
  if (inputs.length < 6) {
    return false;
  }
  if (hasActiveHostedVerificationDialog()) {
    return true;
  }
  if (hasHostedGuestCheckoutCoreFields() && findHostedGuestSubmitButton()) {
    return false;
  }
  return true;
}

function getHostedVerificationErrorText() {
  const pageText = normalizeText([
    document.body?.innerText,
    document.body?.textContent,
  ].filter(Boolean).join(' '));

  const patterns = [
    /sorry,\s*something went wrong\.?\s*get a new code\.?/i,
    /verification code[^.。]{0,80}(?:wrong|invalid|expired|incorrect)/i,
    /code[^.。]{0,80}(?:wrong|invalid|expired|incorrect)/i,
    /(?:コード|認証コード)[^。]{0,80}(?:正しく|無効|期限|間違|失敗|エラー)/i,
    /問題が発生しました[^。]{0,80}(?:コード|再送|新しい)/i,
    /新しいコード[^。]{0,80}(?:取得|送信|再送)/i,
    /(?:验证码|驗證碼|代码|代碼)[^.。]{0,40}(?:错误|錯誤|无效|無效|过期|過期|不正确|不正確)/i,
  ];
  if (pageText) {
    for (const pattern of patterns) {
      const match = pageText.match(pattern);
      if (match) {
        return normalizeText(match[0]);
      }
    }
  }

  const inputs = findHostedVerificationInputs();
  if (inputs.length < 6) {
    return '';
  }

  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[data-testid*="error" i]',
    '[id*="error" i]',
    '[class*="error" i]',
    '[class*="alert" i]',
  ].join(',');
  const roots = getHostedVerificationControlRoots();
  const candidates = [];
  const seen = new Set();
  const addCandidate = (node) => {
    if (!node || seen.has(node) || node === document.body || node === document.documentElement) return;
    seen.add(node);
    candidates.push(node);
  };
  for (const root of roots) {
    try {
      root.querySelectorAll?.(selectors)?.forEach(addCandidate);
    } catch {
      // Ignore selector issues in unusual PayPal DOM fragments.
    }
  }
  try {
    document.querySelectorAll?.(selectors)?.forEach(addCandidate);
  } catch {
    // Ignore.
  }

  const visibleAlert = candidates.find((node) => {
    if (!isVisibleElement(node)) return false;
    const metadata = normalizeText([
      node.id,
      node.className,
      node.getAttribute?.('role'),
      node.getAttribute?.('aria-live'),
      node.getAttribute?.('data-testid'),
    ].filter(Boolean).join(' '));
    if (/cookie|privacy|close|modalclose/i.test(metadata)) return false;
    const nodeText = normalizeText(node.innerText || node.textContent || node.getAttribute?.('aria-label') || '');
    if (nodeText && !/cookie|privacy/i.test(nodeText)) return true;
    try {
      const style = window.getComputedStyle(node);
      const colorText = `${style.backgroundColor || ''} ${style.borderColor || ''} ${style.color || ''}`;
      return /rgb\(\s*(?:18[0-9]|19[0-9]|2[0-5][0-9])\s*,\s*(?:0|[1-9]\d?)\s*,\s*(?:0|[1-9]\d?)\s*\)/i.test(colorText)
        || /error|alert/i.test(metadata);
    } catch {
      return /error|alert/i.test(metadata);
    }
  });
  if (visibleAlert) {
    const text = normalizeText(visibleAlert.innerText || visibleAlert.textContent || visibleAlert.getAttribute?.('aria-label') || '');
    return text || 'paypal_verification_error_banner_visible';
  }
  return '';
}

function hasHostedVerificationError() {
  return Boolean(getHostedVerificationErrorText());
}

function getHostedVerificationControlRoots() {
  const roots = [];
  const seen = new Set();
  findHostedVerificationInputs().forEach((input) => {
    let node = input?.parentElement || null;
    let depth = 0;
    while (node && depth < 8) {
      if (!seen.has(node)) {
        seen.add(node);
        roots.push(node);
      }
      node = node.parentElement || null;
      depth += 1;
    }
  });
  return roots;
}

function isHostedCookieControl(control) {
  let node = control;
  let depth = 0;
  while (node && depth < 5) {
    const text = normalizeText([
      node.textContent,
      node.innerText,
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      node.id,
      node.className,
    ].filter(Boolean).join(' '));
    if (/cookie|cookies|manage cookies|accept cookies|decline/i.test(text)) {
      return true;
    }
    node = node.parentElement || null;
    depth += 1;
  }
  return false;
}

function isHostedVerificationCloseControl(control) {
  const text = getActionText(control);
  if (!text || isHostedCookieControl(control)) {
    return false;
  }
  if (/cancel\s+and\s+return|return\s+to\s+merchant|agree|create\s+account|continue|pay|subscribe/i.test(text)
    || /キャンセル|戻る|同意|続行|支払|購入|アカウント/.test(text)) {
    return false;
  }
  return /^(?:×|x)$/i.test(text)
    || /\bclose\b/i.test(text)
    || /\bdismiss\b/i.test(text)
    || /閉じる|关闭|關閉/.test(text);
}

function findHostedVerificationCloseButton() {
  const selectors = 'button, a, [role="button"], [aria-label], [title]';
  for (const root of getHostedVerificationControlRoots()) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      continue;
    }
    const match = Array.from(root.querySelectorAll(selectors))
      .filter((control) => control !== root && isVisibleElement(control) && isEnabledControl(control))
      .find(isHostedVerificationCloseControl);
    if (match) {
      return match;
    }
  }

  return getVisibleControls(selectors)
    .filter((control) => isEnabledControl(control))
    .find(isHostedVerificationCloseControl) || null;
}

function isHostedVerificationResendControl(control) {
  const text = getActionText(control);
  if (!text || isHostedCookieControl(control) || isHostedVerificationCloseControl(control)) {
    return false;
  }
  if (/cancel\s+and\s+return|return\s+to\s+merchant|agree|create\s+account|continue|pay|subscribe|login|log\s*in/i.test(text)
    || /キャンセル|戻る|マーチャント|同意|続行|支払|購入|ログイン|アカウント/.test(text)) {
    return false;
  }
  return /(?:^|\b)(?:resend|send\s+(?:it\s+)?again|send\s+(?:a\s+)?new\s+code|get\s+(?:a\s+)?new\s+code)(?:\b|$)/i.test(text)
    || /再送|新しいコード|コードを再送|コードを送信/.test(text);
}

function findHostedVerificationResendButton() {
  const selectors = 'button, a, [role="button"], [aria-label], [title]';
  const directResend = document.querySelector?.('button[data-testid="resend-link"]');
  if (directResend && isVisibleElement(directResend) && isEnabledControl(directResend)) {
    return directResend;
  }
  for (const root of getHostedVerificationControlRoots()) {
    if (!root || typeof root.querySelectorAll !== 'function') {
      continue;
    }
    const match = Array.from(root.querySelectorAll(selectors))
      .filter((control) => control !== root && isVisibleElement(control) && isEnabledControl(control))
      .find(isHostedVerificationResendControl);
    if (match) {
      return match;
    }
  }

  return getVisibleControls(selectors)
    .filter((control) => isEnabledControl(control))
    .find(isHostedVerificationResendControl) || null;
}

function clickHostedControl(control) {
  if (!control) {
    return false;
  }
  try {
    control.scrollIntoView?.({ block: 'center', inline: 'center' });
  } catch {
    // Best effort only.
  }
  try {
    dispatchHostedGenericClick(control);
    return true;
  } catch {
    if (typeof simulateClick === 'function') {
      simulateClick(control);
      return true;
    }
    if (typeof control.click === 'function') {
      control.click();
      return true;
    }
  }
  return false;
}

function findClickableInContext(contextPatterns, buttonPatterns) {
  const contexts = (Array.isArray(contextPatterns) ? contextPatterns : [contextPatterns]).filter(Boolean);
  const buttons = (Array.isArray(buttonPatterns) ? buttonPatterns : [buttonPatterns]).filter(Boolean);
  const candidates = getVisibleControls('button, a, [role="button"], input[type="button"], input[type="submit"]')
    .filter(isEnabledControl);

  return candidates.find((control) => {
    const actionText = getActionText(control);
    if (!buttons.some((pattern) => pattern.test(actionText))) {
      return false;
    }

    let node = control;
    let depth = 0;
    while (node && depth < 7) {
      const contextText = normalizeText([
        node.textContent,
        node.innerText,
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.id,
        node.className,
      ].filter(Boolean).join(' '));
      if (contexts.some((pattern) => pattern.test(contextText))) {
        return true;
      }
      node = node.parentElement || null;
      depth += 1;
    }
    return false;
  }) || null;
}

function isHostedPrivacySettingsPage() {
  const pathname = String(location?.pathname || '');
  const submitButton = document.getElementById('submitCookiesBtn');
  const closeButton = document.getElementById('privacyModalCloseIconButton');
  const isPrivacyPath = /\/myaccount\/privacy\/cookiePrefs(?:\/|$)/i.test(pathname);
  return isPrivacyPath
    || Boolean(submitButton && (isPrivacyPath || isVisibleElement(submitButton)))
    || Boolean(closeButton && isVisibleElement(closeButton));
}

function getHostedPrivacyReturnUrl() {
  const scriptText = Array.from(document.scripts || [])
    .map((script) => script.textContent || '')
    .join('\n');
  const match = scriptText.match(/decodedReturnUrl\s*:\s*(['"])(.*?)\1/i);
  const rawUrl = match ? match[2] : '';
  if (!rawUrl) {
    return '';
  }
  try {
    const url = new URL(rawUrl, location.href);
    if (!/paypal\./i.test(url.hostname)) {
      return '';
    }
    return url.href;
  } catch {
    return '';
  }
}

function dismissHostedPrivacySettingsPage() {
  if (!isHostedPrivacySettingsPage()) {
    return null;
  }
  const submitButton = document.getElementById('submitCookiesBtn');
  const closeButton = document.getElementById('privacyModalCloseIconButton');
  const returnUrl = getHostedPrivacyReturnUrl();
  const targetButton = submitButton || (closeButton && isVisibleElement(closeButton) ? closeButton : null);
  if (!targetButton && !returnUrl) {
    return null;
  }
  const buttonText = targetButton
    ? getActionText(targetButton) || targetButton.id || 'privacy_cookie_button'
    : 'privacy_return_url';
  setTimeout(() => {
    if (submitButton && isEnabledControl(submitButton)) {
      const cookieAction = document.querySelector('.cookieAction');
      if (cookieAction) {
        cookieAction.style.display = 'block';
      }
      clickHostedControl(submitButton);
    } else if (closeButton && isVisibleElement(closeButton) && isEnabledControl(closeButton)) {
      clickHostedControl(closeButton);
    }
    setTimeout(() => {
      if (isHostedPrivacySettingsPage() && returnUrl) {
        window.location.replace(returnUrl);
      }
    }, submitButton ? 3500 : 800);
  }, 50);
  return {
    clicked: 1,
    clickedButtons: [buttonText],
    blockingPromptVisible: true,
    privacySettingsVisible: true,
    navigationScheduled: true,
    returnUrl,
  };
}

function findHostedBlockingPromptButton() {
  const saveAddressDismiss = findClickableInContext([
    /住所を保存|save\s+(?:your\s+)?address|save\s+(?:your\s+)?information|pay\s+faster\s+next\s+time/i,
  ], [
    /利用しない|保存しない|今はしない|いいえ/i,
    /not\s+now|do\s+not\s+save|don.?t\s+save|skip|no\s+thanks|no/i,
  ]);
  if (saveAddressDismiss) {
    return saveAddressDismiss;
  }

  const cookieAccept = findClickableInContext([
    /cookie|cookies|クッキー|プライバシー|privacy/i,
  ], [
    /^はい$/i,
    /すべて同意|同意して閉じる|同意して続行|受け入れ|許可/i,
    /accept\s+all|accept|agree\s+and\s+(?:close|continue)|allow|got\s+it|ok/i,
  ]);
  if (cookieAccept) {
    return cookieAccept;
  }

  const privacyClose = document.getElementById('privacyModalCloseIconButton');
  if (privacyClose && isVisibleElement(privacyClose) && isEnabledControl(privacyClose)) {
    return privacyClose;
  }

  const cookieSettingsClose = findClickableInContext([
    /Cookieの設定を管理する|manage\s+cookie\s+settings|cookie\s+settings/i,
  ], [
    /^(?:×|x)$/i,
    /close|閉じる/i,
  ]);
  if (cookieSettingsClose) {
    return cookieSettingsClose;
  }

  return findClickableInContext([
    /cookie|cookies|クッキー|プライバシー|privacy/i,
  ], [
    /^(?:×|x)$/i,
    /close|dismiss|閉じる|閉じて/i,
  ]);
}

async function dismissHostedBlockingPrompts(maxRounds = 3) {
  const clickedButtons = [];
  for (let round = 0; round < Math.max(1, Number(maxRounds) || 1); round += 1) {
    const privacyDismiss = dismissHostedPrivacySettingsPage();
    if (privacyDismiss) {
      return {
        clicked: clickedButtons.length + privacyDismiss.clicked,
        clickedButtons: clickedButtons.concat(privacyDismiss.clickedButtons || []),
        blockingPromptVisible: true,
        privacySettingsVisible: true,
        navigationScheduled: true,
        returnUrl: privacyDismiss.returnUrl || '',
      };
    }
    const button = findHostedBlockingPromptButton();
    if (!button) {
      break;
    }
    const buttonText = getActionText(button);
    clickHostedControl(button);
    clickedButtons.push(buttonText);
    await sleep(700);
  }
  return {
    clicked: clickedButtons.length,
    clickedButtons,
    blockingPromptVisible: Boolean(findHostedBlockingPromptButton()),
  };
}

function getHostedStableSignature() {
  return [
    location.href,
    document.readyState,
    detectPayPalHostedCheckoutStage(),
    getPayPalHostedVisibleControlCount(),
    getVisibleControls('input:not([type="hidden"]), select, textarea').length,
    hasPayPalHostedBusyIndicator() ? 'busy' : 'idle',
    findHostedBlockingPromptButton() ? 'blocked' : 'clear',
  ].join('|');
}

async function waitForHostedPageStable(options = {}) {
  const label = options.label || 'PayPal hosted page';
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 15000));
  const intervalMs = Math.max(100, Math.floor(Number(options.intervalMs) || 500));
  const stablePolls = Math.max(2, Math.floor(Number(options.stablePolls) || 3));
  const targetReady = typeof options.targetReady === 'function' ? options.targetReady : () => true;
  const startedAt = Date.now();
  let lastSignature = '';
  let stableCount = 0;
  let lastDismiss = { clicked: 0, clickedButtons: [], blockingPromptVisible: false };

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    lastDismiss = await dismissHostedBlockingPrompts(1).catch(() => lastDismiss);
    if (lastDismiss?.navigationScheduled) {
      return {
        stable: false,
        signature: lastSignature,
        dismissedPrompts: lastDismiss,
        navigationScheduled: true,
        reason: `${label} dismissed privacy settings page`,
      };
    }
    const ready = document.readyState === 'complete'
      && !hasPayPalHostedBusyIndicator()
      && !findHostedBlockingPromptButton()
      && Boolean(targetReady());
    const signature = getHostedStableSignature();

    if (ready && signature === lastSignature) {
      stableCount += 1;
    } else {
      stableCount = ready ? 1 : 0;
    }

    if (stableCount >= stablePolls) {
      return {
        stable: true,
        signature,
        dismissedPrompts: lastDismiss,
      };
    }

    lastSignature = signature;
    await sleep(intervalMs);
  }

  return {
    stable: false,
    signature: lastSignature,
    dismissedPrompts: lastDismiss,
    reason: `${label} did not become stable within ${timeoutMs}ms`,
  };
}

async function waitForHostedGuestCheckoutCoreFields(options = {}) {
  const timeoutMs = Math.max(1000, Math.floor(Number(options.timeoutMs) || 25000));
  const intervalMs = Math.max(100, Math.floor(Number(options.intervalMs) || 200));
  const startedAt = Date.now();
  let lastDismiss = { clicked: 0, clickedButtons: [], blockingPromptVisible: false };

  while (Date.now() - startedAt < timeoutMs) {
    throwIfStopped();
    lastDismiss = await dismissHostedBlockingPrompts(1).catch(() => lastDismiss);
    if (lastDismiss?.navigationScheduled) {
      return {
        ready: false,
        dismissedPrompts: lastDismiss,
        navigationScheduled: true,
        reason: 'dismissed privacy settings page',
      };
    }
    if (isPayPalHostedGuestCheckoutPage() && hasHostedGuestCheckoutCoreFields()) {
      return {
        ready: true,
        dismissedPrompts: lastDismiss,
      };
    }
    await sleep(intervalMs);
  }

  return {
    ready: false,
    dismissedPrompts: lastDismiss,
    reason: `PayPal hosted guest checkout core fields did not appear within ${timeoutMs}ms`,
  };
}

async function closeHostedVerificationDialog() {
  const closeButton = findHostedVerificationCloseButton();
  if (closeButton) {
    clickHostedControl(closeButton);
    await sleep(1000);
    return {
      closed: true,
      method: 'close_button',
      buttonText: getActionText(closeButton),
    };
  }

  const historyApi = typeof window !== 'undefined' ? window.history : null;
  if (historyApi && typeof historyApi.back === 'function' && Number(historyApi.length || 0) > 1) {
    historyApi.back();
    await sleep(1500);
    return {
      closed: true,
      method: 'history_back',
      buttonText: '',
    };
  }

  return {
    closed: false,
    method: 'not_found',
    buttonText: '',
  };
}

function findHostedReviewConsentButton() {
  const direct = document.getElementById('consentButton')
    || document.querySelector('button[data-testid="consentButton"]');
  if (direct && isVisibleElement(direct) && isEnabledControl(direct)) {
    return direct;
  }
  return findClickableByText([
    /agree\s*(?:and)?\s*continue|accept|continue/i,
    /同意并继续|同意|继续/i,
  ]);
}

function detectPayPalHostedCheckoutStage() {
  if (!/paypal\./i.test(String(location?.host || ''))) {
    return PAYPAL_HOSTED_STAGE_OUTSIDE;
  }
  if (isHostedPrivacySettingsPage()) {
    return PAYPAL_HOSTED_STAGE_PRIVACY_SETTINGS;
  }
  if (isPayPalHostedPhoneRejectedPage()) {
    return PAYPAL_HOSTED_STAGE_PHONE_REJECTED;
  }
  if (isPayPalHostedGenericErrorPage()) {
    return PAYPAL_HOSTED_STAGE_GENERIC_ERROR;
  }
  if (hasHostedVerificationInputs()) {
    return PAYPAL_HOSTED_STAGE_VERIFICATION;
  }
  if (isPayPalHostedGuestCheckoutPage()) {
    return PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT;
  }
  if (isPayPalHostedReviewPage() && findHostedReviewConsentButton()) {
    return PAYPAL_HOSTED_STAGE_REVIEW;
  }
  if (isPayPalHostedLoginPage()) {
    return PAYPAL_HOSTED_STAGE_LOGIN;
  }
  if (/\/agreements\/approve(?:[/?#]|$)/i.test(String(location?.pathname || '')) || Boolean(findApproveButton())) {
    return PAYPAL_HOSTED_STAGE_APPROVAL;
  }
  return PAYPAL_HOSTED_STAGE_UNKNOWN;
}

function fillHostedInputById(id, value) {
  const input = document.getElementById(String(id || '').trim());
  if (!input || !isVisibleElement(input) || !isEnabledControl(input)) {
    return false;
  }
  fillInput(input, String(value || ''));
  return true;
}

function fillHostedInputByIdLoose(id, value) {
  const input = document.getElementById(String(id || '').trim());
  if (!input || !isVisibleElement(input) || !isEnabledControl(input)) {
    return false;
  }
  fillInput(input, String(value || ''));
  return true;
}

function fillHostedInputCandidates(ids = [], patterns = [], value = '') {
  const input = findHostedInputByCandidates(ids, patterns);
  if (!input) {
    return false;
  }
  fillInput(input, String(value || ''));
  return true;
}

function markHostedFill(fillResults, key, filled) {
  fillResults[key] = Boolean(fillResults[key] || filled);
  return fillResults[key];
}

function hasHostedGuestCheckoutCoreFields() {
  return Boolean(
    document.getElementById('email')
    && document.getElementById('phone')
    && document.getElementById('cardNumber')
    && document.getElementById('cardExpiry')
    && document.getElementById('cardCvv')
  );
}

function getHostedGuestCheckoutErrors() {
  const selectors = [
    '[role="alert"]',
    '[aria-invalid="true"]',
    '[id$="-error"]',
    '[class*="Error"]',
    '[class*="error"]',
  ].join(', ');
  return Array.from(document.querySelectorAll(selectors))
    .filter((node) => isVisibleElement(node) || node.getAttribute?.('aria-invalid') === 'true')
    .map((node) => ({
      id: node.id || '',
      tag: String(node.tagName || '').toLowerCase(),
      value: node.value || '',
      text: normalizeText(node.innerText || node.textContent || node.getAttribute?.('aria-describedby') || ''),
      ariaDescribedBy: node.getAttribute?.('aria-describedby') || '',
    }))
    .filter((item) => item.text || item.value || item.ariaDescribedBy)
    .slice(0, 12);
}

function hostedComparableValue(value = '') {
  return normalizeText(value).replace(/\s+/g, '').toLowerCase();
}

function hostedDigits(value = '') {
  return String(value || '').replace(/\D+/g, '');
}

function hostedFieldValueById(id = '') {
  const input = document.getElementById(String(id || '').trim());
  return input ? String(input.value || '') : '';
}

function hostedFieldMatches(id, expected, { digits = false, allowEmpty = false } = {}) {
  const expectedValue = String(expected || '');
  const actualValue = hostedFieldValueById(id);
  if (!expectedValue && allowEmpty) return true;
  if (digits) {
    return Boolean(expectedValue) && hostedDigits(actualValue) === hostedDigits(expectedValue);
  }
  return Boolean(expectedValue) && hostedComparableValue(actualValue) === hostedComparableValue(expectedValue);
}

function getHostedGuestRequiredReadiness(expected = {}) {
  const isJp = normalizeText(expected.countryCode || expected.address?.countryCode || '').toUpperCase() === 'JP';
  const checks = {
    email: hostedFieldMatches('email', expected.email),
    phone: hostedFieldMatches('phone', expected.phone, { digits: true }),
    cardNumber: hostedFieldMatches('cardNumber', expected.cardNumber, { digits: true }),
    cardExpiry: hostedFieldMatches('cardExpiry', expected.cardExpiry),
    cardCvv: hostedFieldMatches('cardCvv', expected.cardCvv, { digits: true }),
    password: hostedFieldMatches('password', expected.password),
    dateOfBirth: hostedFieldMatches('dateOfBirth', expected.dateOfBirth),
    firstName: isJp
      ? hostedFieldMatches('countrySpecificFirstName', expected.kanaFirstName) && hostedFieldMatches('firstName', expected.firstName)
      : (hostedFieldMatches('countrySpecificFirstName', expected.firstName) || hostedFieldMatches('firstName', expected.firstName)),
    lastName: isJp
      ? hostedFieldMatches('countrySpecificLastName', expected.kanaLastName) && hostedFieldMatches('lastName', expected.lastName)
      : (hostedFieldMatches('countrySpecificLastName', expected.lastName) || hostedFieldMatches('lastName', expected.lastName)),
    billingLine1: hostedFieldMatches('billingLine1', expected.address?.street || ''),
    billingCity: hostedFieldMatches('billingCity', expected.address?.city || ''),
    billingPostalCode: hostedFieldMatches('billingPostalCode', expected.address?.zip || ''),
  };
  return {
    checks,
    ready: Object.values(checks).every(Boolean),
    missing: Object.entries(checks)
      .filter(([, value]) => !value)
      .map(([key]) => key),
  };
}

function selectHostedOptionByIdText(id, text) {
  const select = document.getElementById(String(id || '').trim());
  const expectedText = normalizeText(text);
  if (!select || !expectedText || !Array.isArray(Array.from(select.options || []))) {
    return false;
  }
  const match = Array.from(select.options || []).find((option) => {
    const label = normalizeText(option?.textContent || option?.label || '');
    const value = normalizeText(option?.value || '');
    return label.toLowerCase().includes(expectedText.toLowerCase())
      || value.toLowerCase().includes(expectedText.toLowerCase());
  });
  if (!match) {
    return false;
  }
  select.value = match.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function selectHostedOptionByIdTextLoose(id, text) {
  const select = document.getElementById(String(id || '').trim());
  const expectedText = normalizeText(text);
  if (!select || !expectedText || !Array.isArray(Array.from(select.options || []))) {
    return false;
  }
  const match = Array.from(select.options || []).find((option) => {
    const label = normalizeText(option?.textContent || option?.label || '');
    const value = normalizeText(option?.value || '');
    return label.toLowerCase().includes(expectedText.toLowerCase())
      || value.toLowerCase().includes(expectedText.toLowerCase());
  });
  if (!match) {
    return false;
  }
  select.value = match.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

const PAYPAL_HOSTED_JP_PREFECTURES = Object.freeze({
  hokkaido: '北海道',
  aomori: '青森県',
  iwate: '岩手県',
  miyagi: '宮城県',
  akita: '秋田県',
  yamagata: '山形県',
  fukushima: '福島県',
  ibaraki: '茨城県',
  tochigi: '栃木県',
  gunma: '群馬県',
  saitama: '埼玉県',
  chiba: '千葉県',
  tokyo: '東京都',
  kanagawa: '神奈川県',
  niigata: '新潟県',
  toyama: '富山県',
  ishikawa: '石川県',
  fukui: '福井県',
  yamanashi: '山梨県',
  nagano: '長野県',
  gifu: '岐阜県',
  shizuoka: '静岡県',
  aichi: '愛知県',
  mie: '三重県',
  shiga: '滋賀県',
  kyoto: '京都府',
  osaka: '大阪府',
  hyogo: '兵庫県',
  nara: '奈良県',
  wakayama: '和歌山県',
  tottori: '鳥取県',
  shimane: '島根県',
  okayama: '岡山県',
  hiroshima: '広島県',
  yamaguchi: '山口県',
  tokushima: '徳島県',
  kagawa: '香川県',
  ehime: '愛媛県',
  kochi: '高知県',
  fukuoka: '福岡県',
  saga: '佐賀県',
  nagasaki: '長崎県',
  kumamoto: '熊本県',
  oita: '大分県',
  miyazaki: '宮崎県',
  kagoshima: '鹿児島県',
  okinawa: '沖縄県',
});

function normalizeHostedJpPrefecture(value = '') {
  const raw = normalizeText(value);
  if (!raw) return '';
  if (/[都道府県]$/.test(raw) && Object.values(PAYPAL_HOSTED_JP_PREFECTURES).includes(raw)) {
    return raw;
  }
  const compact = raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
  if (PAYPAL_HOSTED_JP_PREFECTURES[compact]) {
    return PAYPAL_HOSTED_JP_PREFECTURES[compact];
  }
  return Object.entries(PAYPAL_HOSTED_JP_PREFECTURES).find(([english, japanese]) => {
    const japaneseCompact = japanese.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
    return compact.includes(english) || compact.includes(japaneseCompact);
  })?.[1] || raw;
}

function normalizeHostedDateOfBirth(value = '') {
  const raw = normalizeText(value);
  const match = raw.match(/(\d{1,4})\D+(\d{1,2})\D+(\d{1,4})/);
  if (!match) return '1986/04/15';
  const first = Number.parseInt(match[1], 10);
  const second = Number.parseInt(match[2], 10);
  const third = Number.parseInt(match[3], 10);
  const hasFullYear = match[1].length === 4 || match[3].length === 4;
  if (!hasFullYear) return '1986/04/15';
  const year = match[1].length === 4 ? first : third;
  const month = match[1].length === 4 ? second : first;
  const day = match[1].length === 4 ? third : second;
  if (year < 1900 || year > 2008 || month < 1 || month > 12 || day < 1 || day > 31) {
    return '1986/04/15';
  }
  return `${String(year).padStart(4, '0')}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
}

function findHostedCountrySelect() {
  const direct = document.getElementById('country');
  if (direct && String(direct.tagName || '').toUpperCase() === 'SELECT') {
    return direct;
  }
  return Array.from(document.querySelectorAll('select'))
    .find((select) => /country|region/i.test(String(select.id || select.name || select.getAttribute?.('aria-label') || ''))) || null;
}

function optionMatchesHostedCountry(option, countryCode) {
  const target = normalizeText(countryCode).toUpperCase();
  if (!option || !target) return false;
  const value = normalizeText(option.value).toUpperCase();
  const label = normalizeText(option.textContent || option.label).toLowerCase();
  if (value === target) return true;
  if (target === 'JP') return /japan|日本/.test(label);
  if (target === 'US') return /united states|usa|美国|米国/.test(label);
  return label.includes(target.toLowerCase());
}

function optionMatchesHostedPhoneCountry(option, countryCode, dialCode) {
  const target = normalizeText(countryCode).toUpperCase();
  const dial = String(dialCode || '').replace(/\D+/g, '');
  const value = normalizeText(option?.value || '').toUpperCase();
  const label = normalizeText(option?.textContent || option?.label || '');
  const comparable = `${value} ${label}`.toLowerCase();

  if (target && value === target) return true;
  if (target === 'JP' && /japan|日本/.test(comparable)) return true;
  if (target === 'US' && /united states|usa|美国|米国/.test(comparable)) return true;
  if (dial && new RegExp(`(?:\\+|00)?${dial}(?:\\D|$)`).test(label)) return true;
  return false;
}

async function selectHostedCountry(countryCode) {
  const target = normalizeText(countryCode || 'JP').toUpperCase();
  const select = findHostedCountrySelect();
  if (!select || !target) return { selected: false, changed: false };
  if (optionMatchesHostedCountry(select.selectedOptions?.[0], target) || normalizeText(select.value).toUpperCase() === target) {
    return { selected: true, changed: false };
  }
  const match = Array.from(select.options || []).find((option) => optionMatchesHostedCountry(option, target));
  if (!match) return { selected: false, changed: false };
  select.value = match.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(3000);
  return { selected: true, changed: true };
}

function findHostedPhoneCountrySelect() {
  return Array.from(document.querySelectorAll('select')).find((select) => {
    const text = normalizeText([
      select.id,
      select.name,
      select.getAttribute?.('aria-label'),
      select.getAttribute?.('title'),
      select.closest?.('label')?.textContent,
    ].filter(Boolean).join(' '));
    return /phone|mobile|tel|電話|携帯|国番号|country\s*code|dial/i.test(text);
  }) || null;
}

async function selectHostedPhoneCountry(countryCode, dialCode) {
  const targetCountry = normalizeText(countryCode).toUpperCase();
  const targetDial = String(dialCode || '').replace(/\D+/g, '');
  if (!targetCountry && !targetDial) return false;

  const select = findHostedPhoneCountrySelect();
  if (!select) return false;
  if (optionMatchesHostedPhoneCountry(select.selectedOptions?.[0], targetCountry, targetDial)) {
    return true;
  }

  const match = Array.from(select.options || [])
    .find((option) => optionMatchesHostedPhoneCountry(option, targetCountry, targetDial));
  if (!match) return false;

  select.value = match.value;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(1000);
  return true;
}

function removeHostedCaptchaArtifacts() {
  let removed = false;
  const selectors = [
    '#captcha-standalone',
    '.captcha-overlay',
    '.captcha-container',
    '[id*="captcha"][class*="overlay"]',
    '[class*="captcha"][class*="overlay"]',
  ];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      try {
        node.remove();
        removed = true;
        const rootScope = typeof window !== 'undefined' ? window : globalThis;
        rootScope[PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT] = Number(rootScope[PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT] || 0) + 1;
      } catch {
        // Ignore non-removable overlays.
      }
    });
  });
  return removed;
}

function pulseHostedCaptchaGuard() {
  return removeHostedCaptchaArtifacts();
}

function startHostedCaptchaCleanupObserver(timeoutMs = 180000) {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  if (rootScope[PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL]) {
    return rootScope[PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL];
  }
  rootScope[PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT] = Number(rootScope[PAYPAL_HOSTED_CAPTCHA_REMOVED_COUNT] || 0);
  const observer = new MutationObserver(() => {
    removeHostedCaptchaArtifacts();
  });
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });
  const intervalId = setInterval(() => {
    removeHostedCaptchaArtifacts();
  }, 100);
  const guard = { observer, intervalId };
  rootScope[PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL] = guard;
  setTimeout(() => {
    observer.disconnect();
    clearInterval(intervalId);
    if (rootScope[PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL] === guard) {
      rootScope[PAYPAL_HOSTED_CAPTCHA_GUARD_SENTINEL] = null;
    }
  }, Math.max(1000, Number(timeoutMs) || 180000));
  return guard;
}

function findHostedGuestSubmitButton() {
  return document.querySelector('button[data-testid="submit-button"]')
    || document.querySelector('button[data-testid="hosted-payment-submit-button"]')
    || document.querySelector('button[data-atomic-wait-intent="Submit_Email"]')
    || document.querySelector('button.SubmitButton--complete')
    || findClickableByText([
      /pay|continue|next|agree|subscribe/i,
      /支払|続行|次へ|同意|登録|申し込む/i,
      /支付|继续|下一步|同意|订阅/i,
    ]);
}

function buildHostedRandomEmail() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let value = '';
  for (let index = 0; index < 16; index += 1) {
    value += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `${value}@gmail.com`;
}

function buildHostedRandomPassword() {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const symbols = '!@#$%^';
  const alphabet = `${lowercase}${uppercase}${digits}${symbols}`;
  const value = [
    lowercase[Math.floor(Math.random() * lowercase.length)],
    uppercase[Math.floor(Math.random() * uppercase.length)],
    digits[Math.floor(Math.random() * digits.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];
  while (value.length < 14) {
    value.push(alphabet[Math.floor(Math.random() * alphabet.length)]);
  }
  return value.sort(() => Math.random() - 0.5).join('');
}

function buildHostedVisaCard() {
  const prefixes = [
    [4, 1, 4, 7],
    [4, 1, 0, 0],
  ];
  const digits = prefixes[Math.floor(Math.random() * prefixes.length)].slice();
  while (digits.length < 15) {
    digits.push(Math.floor(Math.random() * 10));
  }
  const reversed = digits.slice().reverse();
  let sum = 0;
  for (let index = 0; index < reversed.length; index += 1) {
    let digit = reversed[index];
    if (index % 2 === 0) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  digits.push(checkDigit);
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, '0');
  const currentYear = new Date().getFullYear() % 100;
  const year = currentYear + Math.floor(Math.random() * 4) + 2;
  const cvv = String(Math.floor(100 + Math.random() * 900));
  return {
    number: digits.join(''),
    expiry: `${month} / ${year}`,
    cvv,
  };
}

function dispatchHostedGenericClick(button) {
  const rect = button.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const eventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX,
    clientY,
  };
  button.dispatchEvent(new PointerEvent('pointerdown', eventInit));
  button.dispatchEvent(new MouseEvent('mousedown', eventInit));
  button.dispatchEvent(new PointerEvent('pointerup', eventInit));
  button.dispatchEvent(new MouseEvent('mouseup', eventInit));
  button.dispatchEvent(new MouseEvent('click', eventInit));
}

async function clickHostedGenericSubmitButton(retries = 0, options = {}) {
  const maxRetries = Math.max(0, Math.floor(Number(options.maxRetries ?? 10)));
  const waitForChange = options.waitForChange !== false;
  removeHostedCaptchaArtifacts();
  await waitForHostedPageStable({
    label: 'PayPal hosted submit',
    timeoutMs: 12000,
    targetReady: () => Boolean(findHostedGuestSubmitButton() || findEmailNextButton() || findLoginNextButton()),
  });
  const button = findHostedGuestSubmitButton() || findEmailNextButton() || findLoginNextButton();
  if (!button) {
    if (retries >= maxRetries) {
      throw new Error('PayPal hosted checkout 未找到可点击的继续/提交按钮。');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1, options);
  }

  const buttonText = normalizeText(button.textContent || '');
  if (button.disabled) {
    if (retries >= maxRetries) {
      throw new Error('PayPal hosted checkout 按钮长时间处于 disabled 状态。');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1, options);
  }

  const rect = button.getBoundingClientRect();
  if (rect.height === 0) {
    if (retries >= maxRetries) {
      throw new Error('PayPal hosted checkout 按钮长时间不可见。');
    }
    await sleep(1000);
    return clickHostedGenericSubmitButton(retries + 1, options);
  }

  dispatchHostedGenericClick(button);
  await sleep(1000);
  removeHostedCaptchaArtifacts();

  if (hasHostedVerificationInputs()) {
    return {
      clicked: true,
      verificationRequired: true,
      buttonText,
    };
  }

  if (!waitForChange) {
    return {
      clicked: true,
      verificationRequired: false,
      buttonText,
    };
  }

  const currentText = normalizeText(button.textContent || '');
  if (!/processing/i.test(currentText) && currentText === buttonText) {
    if (retries >= maxRetries) {
      return {
        clicked: true,
        verificationRequired: false,
        buttonText,
        retried: true,
      };
    }
    await sleep(2000);
    return clickHostedGenericSubmitButton(retries + 1, options);
  }

  return {
    clicked: true,
    verificationRequired: false,
    buttonText,
  };
}

function normalizeHostedVerificationCode(value = '') {
  const digits = String(value || '').replace(/\D+/g, '');
  return digits.slice(0, 6);
}

async function submitHostedPayLogin(payload = {}) {
  await waitForDocumentComplete();
  removeHostedCaptchaArtifacts();
  await waitForHostedPageStable({
    label: 'PayPal hosted login',
    timeoutMs: 18000,
    targetReady: () => Boolean((document.getElementById('email') || findEmailInput()) && (findHostedGuestSubmitButton() || findEmailNextButton() || findLoginNextButton())),
  });
  if (hasPayPalHostedBusyIndicator()) {
    return {
      stage: PAYPAL_HOSTED_STAGE_LOGIN,
      submitted: false,
      hostedBusyVisible: true,
    };
  }
  const email = normalizeText(payload.email || buildHostedRandomEmail());
  if (!email) {
    throw new Error('PayPal hosted checkout 缺少邮箱。');
  }
  const emailInput = document.getElementById('email') || findEmailInput();
  if (!emailInput) {
    throw new Error('PayPal hosted checkout 未找到邮箱输入框。');
  }
  await sleep(2000);
  refillPayPalEmailInput(emailInput, email);
  await sleep(1000);
  const clickResult = await clickHostedGenericSubmitButton(0);
  return {
    stage: PAYPAL_HOSTED_STAGE_LOGIN,
    submitted: true,
    generatedEmail: email,
    verificationRequired: Boolean(clickResult?.verificationRequired),
    nextExpected: 'guest_checkout_or_verification',
  };
}

async function fillHostedVerificationCode(payload = {}) {
  const delayOperation = typeof performPayPalOperationWithDelay === 'function'
    ? performPayPalOperationWithDelay
    : async (_metadata, operation) => operation();
  await waitForDocumentComplete();
  await waitForHostedPageStable({
    label: 'PayPal hosted verification',
    timeoutMs: 12000,
    targetReady: () => hasHostedVerificationInputs(),
  });
  const verificationErrorText = getHostedVerificationErrorText();
  if (verificationErrorText && !payload.forceFillAfterError) {
    return {
      stage: PAYPAL_HOSTED_STAGE_VERIFICATION,
      codeSubmitted: false,
      verificationErrorVisible: true,
      verificationErrorText,
    };
  }
  const code = normalizeHostedVerificationCode(payload.verificationCode || payload.code || '');
  if (code.length !== 6) {
    throw new Error('PayPal hosted checkout 验证码无效。');
  }
  const inputs = findHostedVerificationInputs();
  if (inputs.length < 6) {
    throw new Error('PayPal hosted checkout 当前页面未显示验证码输入框。');
  }
  await delayOperation({ stepKey: 'plus-checkout-create', kind: 'fill', label: 'hosted-paypal-verification-code' }, async () => {
    inputs.forEach((input, index) => {
      fillInput(input, code[index] || '');
    });
  });
  return {
    stage: PAYPAL_HOSTED_STAGE_VERIFICATION,
    codeSubmitted: true,
  };
}

async function retryHostedVerificationFromCheckout(payload = {}) {
  await waitForDocumentComplete();
  await waitForHostedPageStable({
    label: 'PayPal hosted verification retry',
    timeoutMs: 12000,
    targetReady: () => hasHostedVerificationInputs() || Boolean(findHostedGuestSubmitButton()),
  });
  const errorText = getHostedVerificationErrorText();
  const closeResult = await closeHostedVerificationDialog();
  const closeWaitMs = Math.max(1000, Math.floor(Number(payload.closeWaitMs) || 2500));
  await sleep(closeWaitMs);

  const clickResult = await clickHostedGenericSubmitButton(0, {
    maxRetries: 3,
    waitForChange: false,
  });
  return {
    stage: detectPayPalHostedCheckoutStage(),
    verificationRetryRequested: true,
    verificationErrorText: errorText,
    closeResult,
    submitButtonText: clickResult?.buttonText || '',
    verificationRequired: Boolean(clickResult?.verificationRequired || hasHostedVerificationInputs()),
  };
}

async function resendHostedVerificationCode() {
  await waitForDocumentComplete();
  await waitForHostedPageStable({
    label: 'PayPal hosted verification resend',
    timeoutMs: 12000,
    targetReady: () => hasHostedVerificationInputs(),
  });
  const stage = detectPayPalHostedCheckoutStage();
  if (stage !== PAYPAL_HOSTED_STAGE_VERIFICATION || !hasHostedVerificationInputs()) {
    throw new Error('PayPal hosted checkout 当前页面未显示验证码输入框，不能点击再送。');
  }
  const resendButton = findHostedVerificationResendButton();
  if (!resendButton) {
    throw new Error('PayPal hosted checkout 未找到验证码再送按钮。');
  }
  const clicked = clickHostedControl(resendButton);
  await sleep(1000);
  return {
    stage,
    verificationResendRequested: Boolean(clicked),
    verificationRequired: Boolean(hasHostedVerificationInputs()),
    buttonText: getActionText(resendButton),
  };
}

async function expandHostedBillingAddCardForm() {
  await waitForHostedPageStable({
    label: 'PayPal hosted billing add-card',
    timeoutMs: 12000,
    targetReady: () => hasHostedCardPaymentInputs() || Boolean(findHostedBillingAddCardButton()),
  });
  if (!isPayPalHostedBillingPage() || hasHostedCardPaymentInputs()) {
    return false;
  }
  const addCardButton = findHostedBillingAddCardButton();
  if (!addCardButton) {
    return false;
  }
  clickHostedControl(addCardButton);
  await waitUntil(() => hasHostedCardPaymentInputs(), {
    intervalMs: 300,
    timeoutMs: 15000,
    timeoutMessage: 'PayPal hosted checkout 补卡页点击 Add card 后未出现卡片输入框。',
  });
  await sleep(1000);
  return true;
}

async function fillHostedGuestCheckout(payload = {}) {
  await waitForDocumentComplete({ timeoutMs: 5000 });
  startHostedCaptchaCleanupObserver();
  removeHostedCaptchaArtifacts();
  log(`PayPal guest checkout：收到 payload.phone=${String(payload?.phone || '').trim() || '(空)'}，payload.address=${JSON.stringify(payload?.address || {})}`, 'info');

  const coreWait = await waitForHostedGuestCheckoutCoreFields({
    timeoutMs: Number(payload.guestCoreFieldsTimeoutMs || 25000),
    intervalMs: 200,
  });
  if (!coreWait.ready) {
    log(`PayPal guest checkout：核心字段未快速就绪，回退稳定等待 reason=${coreWait.reason || ''}`, 'warn');
    await waitForHostedPageStable({
      label: 'PayPal hosted guest checkout',
      timeoutMs: 8000,
      intervalMs: 200,
      stablePolls: 1,
      targetReady: () => isPayPalHostedGuestCheckoutPage() && hasHostedGuestCheckoutCoreFields(),
    });
  }
  const expandedBillingCardForm = await expandHostedBillingAddCardForm();
  const card = buildHostedVisaCard();
  const email = normalizeText(payload.email || buildHostedRandomEmail());
  const phone = normalizeText(payload.phone || PAYPAL_HOSTED_DEFAULT_PHONE);
  const phoneCountryCode = normalizeText(payload.phoneCountryCode || payload.phoneCountry || '').toUpperCase();
  const phoneDialCode = normalizeText(payload.phoneDialCode || '');
  const password = String(payload.password || buildHostedRandomPassword());
  const firstName = normalizeText(payload.firstName || '');
  const lastName = normalizeText(payload.lastName || '');
  const kanaFirstName = normalizeText(payload.kanaFirstName || payload.firstNameKana || payload.address?.providerProfile?.kanaFirstName || 'タロウ');
  const kanaLastName = normalizeText(payload.kanaLastName || payload.lastNameKana || payload.address?.providerProfile?.kanaLastName || 'ヤマダ');
  const fullName = normalizeText(payload.fullName || `${firstName} ${lastName}`);
  const dateOfBirth = normalizeHostedDateOfBirth(payload.dateOfBirth || payload.birthday || payload.address?.providerProfile?.dateOfBirth);
  const cardNumber = String(payload.cardNumber || card.number).replace(/\s+/g, '');
  const cardExpiry = normalizeText(payload.cardExpiry || card.expiry);
  const cardCvv = normalizeText(payload.cardCvv || card.cvv);
  const address = payload.address && typeof payload.address === 'object' ? payload.address : {};
  const countryCode = normalizeText(address.countryCode || payload.addressSeed?.countryCode || 'JP').toUpperCase();
  const countrySelection = await selectHostedCountry(countryCode);
  const countrySelected = Boolean(countrySelection?.selected ?? countrySelection);
  pulseHostedCaptchaGuard();
  if (countrySelection?.changed) {
    await waitForHostedPageStable({
      label: 'PayPal hosted country switch',
      timeoutMs: 15000,
      targetReady: () => isPayPalHostedGuestCheckoutPage(),
    });
  }
  const billingState = countryCode === 'JP' ? normalizeHostedJpPrefecture(address.state || 'Tokyo') : address.state;

  if (!email || !password || !firstName || !lastName || !cardNumber || !cardExpiry || !cardCvv) {
    throw new Error('PayPal hosted checkout 缺少卡支付所需资料。');
  }

  try {
    (document.getElementById('email') || document.getElementById('cardNumber'))?.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  } catch {
    try {
      window.scrollTo(0, 0);
    } catch {
      // Best effort only.
    }
  }

  const fillResults = {};
  markHostedFill(fillResults, 'email', fillHostedInputById('email', email));
  markHostedFill(fillResults, 'email', fillHostedInputCandidates(['email'], [/email|e-mail|邮箱|電郵/i], email));
  pulseHostedCaptchaGuard();
  const phoneCountrySelected = await selectHostedPhoneCountry(phoneCountryCode || countryCode, phoneDialCode);
  markHostedFill(fillResults, 'phone', fillHostedInputById('phone', phone));
  markHostedFill(fillResults, 'phone', fillHostedInputCandidates(['phone', 'phoneNumber', 'tel'], [/phone|mobile|tel|电话号码|手机号/i], phone));
  pulseHostedCaptchaGuard();
  markHostedFill(fillResults, 'cardNumber', fillHostedInputById('cardNumber', cardNumber));
  markHostedFill(fillResults, 'cardNumber', fillHostedInputCandidates(['cardNumber', 'cardnumber', 'card-number', 'card_number', 'cc-number', 'cc_number', 'creditCardNumber'], [/card\s*number|cardnumber|credit\s*card|cc-?number|卡号|银行卡/i], cardNumber));
  markHostedFill(fillResults, 'cardExpiry', fillHostedInputById('cardExpiry', cardExpiry));
  markHostedFill(fillResults, 'cardExpiry', fillHostedInputCandidates(['cardExpiry', 'cardExpiration', 'expiry', 'expirationDate', 'exp-date', 'expDate', 'cc-exp'], [/expir|expiry|expiration|exp\s*date|mm\s*\/?\s*yy|有效期/i], cardExpiry));
  markHostedFill(fillResults, 'cardCvv', fillHostedInputById('cardCvv', cardCvv));
  markHostedFill(fillResults, 'cardCvv', fillHostedInputCandidates(['cardCvv', 'cardCVV', 'cvv', 'cvc', 'securityCode', 'security-code', 'cc-csc'], [/cvv|cvc|security\s*code|card\s*code|安全码/i], cardCvv));
  pulseHostedCaptchaGuard();
  markHostedFill(fillResults, 'password', fillHostedInputById('password', password));
  markHostedFill(fillResults, 'password', fillHostedInputCandidates(['password'], [/password|pass|密码/i], password));
  markHostedFill(fillResults, 'fullName', fillHostedInputById('full-name', fullName));
  markHostedFill(fillResults, 'countrySpecificFirstName', fillHostedInputById('countrySpecificFirstName', countryCode === 'JP' ? kanaFirstName : firstName));
  markHostedFill(fillResults, 'countrySpecificLastName', fillHostedInputById('countrySpecificLastName', countryCode === 'JP' ? kanaLastName : lastName));
  markHostedFill(fillResults, 'dateOfBirth', fillHostedInputById('dateOfBirth', dateOfBirth));
  markHostedFill(fillResults, 'firstName', fillHostedInputById('firstName', firstName));
  markHostedFill(fillResults, 'lastName', fillHostedInputById('lastName', lastName));
  if (countryCode !== 'JP') {
    markHostedFill(fillResults, 'firstName', fillHostedInputCandidates(['firstName', 'fname', 'givenName', 'first-name'], [/first\s*name|given\s*name|fname|名/i], firstName));
    markHostedFill(fillResults, 'lastName', fillHostedInputCandidates(['lastName', 'lname', 'familyName', 'last-name'], [/last\s*name|family\s*name|surname|lname|姓/i], lastName));
  }
  markHostedFill(fillResults, 'billingLine1', fillHostedInputById('billingLine1', address.street || ''));
  markHostedFill(fillResults, 'billingLine1', fillHostedInputCandidates(['billingLine1', 'billingAddressLine1', 'addressLine1', 'line1', 'billing-line1'], [/billing.*address|address\s*line\s*1|street|address|地址/i], address.street || ''));
  markHostedFill(fillResults, 'billingCity', fillHostedInputById('billingCity', address.city || ''));
  markHostedFill(fillResults, 'billingCity', fillHostedInputCandidates(['billingCity', 'city', 'locality'], [/city|locality|城市/i], address.city || ''));
  markHostedFill(fillResults, 'billingPostalCode', fillHostedInputById('billingPostalCode', address.zip || ''));
  markHostedFill(fillResults, 'billingPostalCode', fillHostedInputCandidates(['billingPostalCode', 'postalCode', 'zip', 'postcode', 'billingZip'], [/postal|zip|postcode|邮编/i], address.zip || ''));
  pulseHostedCaptchaGuard();
  markHostedFill(fillResults, 'billingState', selectHostedOptionByIdText('billingState', billingState || ''));
  markHostedFill(fillResults, 'billingState', selectHostedOptionByIdTextLoose('billingState', billingState || ''));
  const readiness = getHostedGuestRequiredReadiness({
    email,
    phone,
    password,
    firstName,
    lastName,
    kanaFirstName,
    kanaLastName,
    dateOfBirth,
    cardNumber,
    cardExpiry,
    cardCvv,
    address,
    countryCode,
  });
  log(`PayPal guest checkout：字段填充结果 ${JSON.stringify(fillResults)} readiness=${JSON.stringify(readiness)}`, 'info');

  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  const shouldSubmit = payload.submitGuestCheckout === true || payload.submit === true;
  if (shouldSubmit && readiness.ready && !rootScope[PAYPAL_HOSTED_GUEST_SUBMIT_SENTINEL]) {
    rootScope[PAYPAL_HOSTED_GUEST_SUBMIT_SENTINEL] = true;
    await clickHostedGenericSubmitButton(0, { maxRetries: 0, waitForChange: false });
  } else if (shouldSubmit && !readiness.ready) {
    log(`PayPal guest checkout：关键字段未就绪，跳过提交 missing=${readiness.missing.join(',')}`, 'warn');
  }

  return {
    stage: PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT,
    submitted: Boolean(shouldSubmit && readiness.ready),
    verificationRequired: Boolean(hasHostedVerificationInputs()),
    submitScheduled: Boolean(shouldSubmit && readiness.ready),
    expandedBillingCardForm,
    countryCode,
    countrySelected,
    phoneCountryCode: phoneCountryCode || countryCode,
    phoneCountrySelected,
    fillResults,
    requiredFieldsReady: readiness.ready,
    missingRequiredFields: readiness.missing,
    requiredFieldChecks: readiness.checks,
    fieldErrors: getHostedGuestCheckoutErrors(),
  };
}

async function clickHostedReviewConsent() {
  await waitForDocumentComplete();
  await waitForHostedPageStable({
    label: 'PayPal Hermes review',
    timeoutMs: 15000,
    targetReady: () => isPayPalHostedReviewPage() || Boolean(findHostedReviewConsentButton()),
  });
  log(`PayPal Hermes：开始等待 review consent 按钮。当前 URL：${location.href}`, 'info');
  let waited = 0;
  while (waited < 30) {
    waited += 1;
    const reviewSignals = hasHostedReviewSignals();
    const button = findHostedReviewConsentButton();
    if (button && (reviewSignals || isPayPalHostedReviewPage())) {
      log(`PayPal Hermes：第 ${waited}/30 秒命中 review 信号，准备点击 consentButton。`, 'info');
      button.click();
      return {
        stage: PAYPAL_HOSTED_STAGE_REVIEW,
        submitted: true,
      };
    }
    if (waited === 1 || waited % 5 === 0) {
      log(`PayPal Hermes：尚未准备好 review consent 按钮，继续等待（${waited}/30，signals=${reviewSignals}）。`, 'info');
    }
    await sleep(1000);
  }
  log('PayPal Hermes：等待 30 秒后仍未准备好 review consent 按钮。', 'warn');
  throw new Error('PayPal hosted checkout 账单确认页超时，未检测到 review consent 按钮。');
}

async function runHostedCheckoutStep(payload = {}) {
  await waitForDocumentComplete({ timeoutMs: 5000 });
  const privacyDismiss = dismissHostedPrivacySettingsPage();
  if (privacyDismiss) {
    return {
      stage: PAYPAL_HOSTED_STAGE_PRIVACY_SETTINGS,
      ...privacyDismiss,
    };
  }
  if (payload.dismissPrivacySettings === true) {
    return {
      stage: detectPayPalHostedCheckoutStage(),
      submitted: false,
      privacySettingsVisible: false,
      clicked: 0,
      clickedButtons: [],
    };
  }
  if (!(isPayPalHostedGuestCheckoutPage() && hasHostedGuestCheckoutCoreFields())) {
    await waitForHostedPageStable({
      label: 'PayPal hosted stage detection',
      timeoutMs: 12000,
    });
  }
  if (isPayPalHostedReviewPage()) {
    return clickHostedReviewConsent();
  }
  if (payload.requestVerificationResend) {
    return resendHostedVerificationCode(payload);
  }
  if (payload.requestVerificationRetry) {
    return retryHostedVerificationFromCheckout(payload);
  }
  const stage = detectPayPalHostedCheckoutStage();
  if (stage === PAYPAL_HOSTED_STAGE_VERIFICATION) {
    if (!payload.verificationCode && !payload.code) {
      return {
        stage,
        requiresVerificationCode: true,
      };
    }
    return fillHostedVerificationCode(payload);
  }
  if (stage === PAYPAL_HOSTED_STAGE_LOGIN) {
    return submitHostedPayLogin(payload);
  }
  if (stage === PAYPAL_HOSTED_STAGE_GENERIC_ERROR) {
    return {
      stage,
      submitted: false,
      hostedErrorVisible: true,
      hostedErrorText: getPayPalHostedGenericErrorText(),
    };
  }
  if (stage === PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT) {
    return fillHostedGuestCheckout(payload);
  }
  if (stage === PAYPAL_HOSTED_STAGE_REVIEW) {
    return clickHostedReviewConsent();
  }
  if (stage === PAYPAL_HOSTED_STAGE_APPROVAL) {
    return clickPayPalApprove();
  }
  return {
    stage,
    submitted: false,
    approveReady: Boolean(findApproveButton()),
  };
}

function shouldAutoRunHostedHermesReview() {
  const rootScope = typeof window !== 'undefined' ? window : globalThis;
  if (!isPayPalHostedReviewPage()) {
    return false;
  }
  if (rootScope[PAYPAL_HOSTED_HERMES_AUTORUN_SENTINEL]) {
    return false;
  }
  rootScope[PAYPAL_HOSTED_HERMES_AUTORUN_SENTINEL] = true;
  return true;
}

function scheduleHostedHermesAutoRun() {
  if (!shouldAutoRunHostedHermesReview()) {
    return;
  }
  log(`PayPal Hermes 页面已命中，按油猴脚本方式自动等待并点击 Agree and Continue。当前 URL：${location.href}`, 'info');
  setTimeout(() => {
    clickHostedReviewConsent().then(() => {
      log('PayPal Hermes：已按油猴脚本方式执行 Agree and Continue。', 'ok');
    }).catch((error) => {
      log(`PayPal Hermes：自动点击 Agree and Continue 失败：${error?.message || error}`, 'warn');
    });
  }, 0);
}

function findPasskeyPromptButtons() {
  const promptPatterns = [
    /passkey|通行密钥|安全密钥|下次登录|faster|save/i,
  ];
  const bodyText = normalizeText(document.body?.innerText || '');
  const likelyPrompt = promptPatterns.some((pattern) => pattern.test(bodyText));
  if (!likelyPrompt) {
    return [];
  }

  const cancelOrClose = getVisibleControls('button, a, [role="button"]')
    .filter((el) => {
      const text = getActionText(el);
      return /取消|稍后|不保存|不用|关闭|cancel|not now|maybe later|skip|close|x/i.test(text)
        || el.getAttribute?.('aria-label')?.match(/close|关闭/i);
    });

  const iconCloseButtons = getVisibleControls('button, [role="button"]')
    .filter((el) => {
      const text = getActionText(el);
      const rect = el.getBoundingClientRect();
      return (/^×$|^x$/i.test(text) || /close|关闭/i.test(text))
        && rect.width <= 64
        && rect.height <= 64;
    });

  return [...cancelOrClose, ...iconCloseButtons];
}

function hasPasskeyPrompt() {
  return findPasskeyPromptButtons().length > 0;
}

function getPayPalLoginPhase(emailInput, passwordInput) {
  const emailNextButton = findEmailNextButton();
  const passwordLoginButton = findPasswordLoginButton();
  if (emailInput && emailNextButton && isEnabledControl(emailNextButton) && (!passwordInput || !passwordLoginButton)) {
    return 'email';
  }
  if (emailInput && passwordInput) return 'login_combined';
  if (passwordInput) return 'password';
  if (emailInput) return 'email';
  return '';
}

function refillPayPalEmailInput(emailInput, email) {
  if (!emailInput) return;
  if (typeof emailInput.focus === 'function') {
    emailInput.focus();
  }
  fillInput(emailInput, '');
  fillInput(emailInput, email);
  if (typeof emailInput.blur === 'function') {
    emailInput.blur();
  }
}

async function submitPayPalLogin(payload = {}) {
  const delayOperation = typeof performPayPalOperationWithDelay === 'function'
    ? performPayPalOperationWithDelay
    : async (metadata, operation) => {
        const rootScope = typeof window !== 'undefined' ? window : globalThis;
        const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
        return typeof gate === 'function' ? gate(metadata, operation) : operation();
      };
  await waitForDocumentComplete();
  await waitForHostedPageStable({
    label: 'PayPal login page',
    timeoutMs: 18000,
    targetReady: () => Boolean(findEmailInput() || findPasswordInput()),
  });

  const email = normalizeText(payload.email || '');
  const password = String(payload.password || '');
  if (!password) {
    throw new Error('PayPal 密码为空，请先在侧边栏配置。');
  }

  let passwordInput = findPasswordInput();
  const emailInput = findEmailInput();
  const emailNextButton = findEmailNextButton();

  if (emailInput && emailNextButton && isEnabledControl(emailNextButton) && (!passwordInput || !findPasswordLoginButton())) {
    await delayOperation({ stepKey: 'paypal-approve', kind: 'submit', label: 'paypal-email' }, async () => {
      refillPayPalEmailInput(emailInput, email);
      simulateClick(emailNextButton);
    });
    return {
      submitted: false,
      phase: 'email_submitted',
      awaiting: 'password_page',
    };
  }

  if (!passwordInput && emailInput && email) {
    await delayOperation({ stepKey: 'paypal-approve', kind: 'submit', label: 'paypal-email' }, async () => {
      refillPayPalEmailInput(emailInput, email);
      const nextButton = await waitUntil(() => {
        const button = findEmailNextButton() || findLoginNextButton();
        return button && isEnabledControl(button) ? button : null;
      }, {
        intervalMs: 250,
        timeoutMs: 8000,
        timeoutMessage: 'PayPal email page did not expose a clickable next/continue button.',
      });
      simulateClick(nextButton);
    });
    return {
      submitted: false,
      phase: 'email_submitted',
      awaiting: 'password_page',
    };
  } else if (!passwordInput && emailInput && !email) {
    throw new Error('PayPal 账号为空，请先在侧边栏配置。');
  } else if (emailInput && email) {
    await delayOperation({ stepKey: 'paypal-approve', kind: 'fill', label: 'paypal-email' }, async () => {
      refillPayPalEmailInput(emailInput, email);
    });
  }

  passwordInput = passwordInput || await waitUntil(() => findPasswordInput(), {
    intervalMs: 250,
    timeoutMs: 8000,
    timeoutMessage: 'PayPal password page did not expose a password input.',
  });
  await delayOperation({ stepKey: 'paypal-approve', kind: 'submit', label: 'paypal-password' }, async () => {
    fillInput(passwordInput, password);
    await sleep(1000);

    const loginButton = await waitUntil(() => {
      const button = findClickableByText([
        /login|log\s*in|sign\s*in|continue/i,
        /登录|登入|继续/i,
      ]);
      return button && isEnabledControl(button) ? button : null;
    }, {
      intervalMs: 250,
      timeoutMs: 8000,
      timeoutMessage: 'PayPal password page did not expose a clickable login/continue button.',
    });

    simulateClick(loginButton);
  });
  return {
    submitted: true,
    phase: 'password_submitted',
    awaiting: 'redirect_or_approval',
  };
}

async function dismissPayPalPrompts() {
  const delayOperation = typeof performPayPalOperationWithDelay === 'function'
    ? performPayPalOperationWithDelay
    : async (metadata, operation) => {
        const rootScope = typeof window !== 'undefined' ? window : globalThis;
        const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
        return typeof gate === 'function' ? gate(metadata, operation) : operation();
      };
  await waitForDocumentComplete();
  const hostedDismiss = await dismissHostedBlockingPrompts(3).catch(() => ({ clicked: 0, clickedButtons: [] }));
  const buttons = findPasskeyPromptButtons();
  let clicked = Number(hostedDismiss?.clicked || 0);
  for (const button of buttons) {
    if (!isVisibleElement(button) || !isEnabledControl(button)) {
      continue;
    }
    await delayOperation({ stepKey: 'paypal-approve', kind: 'click', label: 'paypal-dismiss-prompt' }, async () => {
      simulateClick(button);
    });
    clicked += 1;
    await sleep(500);
  }
  return {
    clicked,
    hostedClickedButtons: hostedDismiss?.clickedButtons || [],
    hasPromptAfterClick: hasPasskeyPrompt(),
  };
}

async function clickPayPalApprove() {
  const delayOperation = typeof performPayPalOperationWithDelay === 'function'
    ? performPayPalOperationWithDelay
    : async (metadata, operation) => {
        const rootScope = typeof window !== 'undefined' ? window : globalThis;
        const gate = rootScope?.CodexOperationDelay?.performOperationWithDelay;
        return typeof gate === 'function' ? gate(metadata, operation) : operation();
      };
  await waitForDocumentComplete();
  await dismissPayPalPrompts().catch(() => ({ clicked: 0 }));
  await waitForHostedPageStable({
    label: 'PayPal approve',
    timeoutMs: 15000,
    targetReady: () => Boolean(findApproveButton()),
  });

  const button = findApproveButton();
  if (!button || !isEnabledControl(button)) {
    return {
      clicked: false,
      state: inspectPayPalState(),
    };
  }

  await delayOperation({ stepKey: 'paypal-approve', kind: 'click', label: 'paypal-approve' }, async () => {
    simulateClick(button);
  });
  return {
    clicked: true,
    buttonText: getActionText(button),
  };
}

function inspectPayPalState() {
  const emailInput = findEmailInput();
  const passwordInput = findPasswordInput();
  const approveButton = findApproveButton();
  const loginPhase = getPayPalLoginPhase(emailInput, passwordInput);
  const hostedStage = detectPayPalHostedCheckoutStage();
  const hostedPrivacySettingsVisible = hostedStage === PAYPAL_HOSTED_STAGE_PRIVACY_SETTINGS || isHostedPrivacySettingsPage();
  const hostedBusyVisible = hasPayPalHostedBusyIndicator();
  const hostedBlockingPromptVisible = hostedPrivacySettingsVisible || Boolean(findHostedBlockingPromptButton());
  const verificationErrorText = getHostedVerificationErrorText();
  const hostedErrorText = hostedStage === PAYPAL_HOSTED_STAGE_GENERIC_ERROR
    ? getPayPalHostedGenericErrorText()
    : '';
  const hostedPhoneRejectedText = hostedStage === PAYPAL_HOSTED_STAGE_PHONE_REJECTED
    ? getPayPalHostedPhoneRejectedText()
    : '';
  const riskBlockReason = hostedStage === PAYPAL_HOSTED_STAGE_RISK_BLOCKED
    ? getPayPalHostedRiskBlockReason()
    : '';
  return {
    url: location.href,
    readyState: document.readyState,
    hostedStage,
    needsLogin: Boolean(loginPhase),
    loginPhase,
    hasEmailInput: Boolean(emailInput),
    hasPasswordInput: Boolean(passwordInput),
    hasHostedGuestCheckout: hostedStage === PAYPAL_HOSTED_STAGE_GUEST_CHECKOUT,
    hostedPrivacySettingsVisible,
    hostedBusyVisible,
    hostedBlockingPromptVisible,
    hostedPhoneRejected: hostedStage === PAYPAL_HOSTED_STAGE_PHONE_REJECTED,
    hostedPhoneRejectedText,
    hostedErrorVisible: hostedStage === PAYPAL_HOSTED_STAGE_GENERIC_ERROR,
    hostedErrorText,
    hostedRiskBlocked: hostedStage === PAYPAL_HOSTED_STAGE_RISK_BLOCKED,
    riskBlockReason,
    visibleControlCount: getPayPalHostedVisibleControlCount(),
    verificationInputsVisible: hasHostedVerificationInputs(),
    verificationErrorVisible: Boolean(verificationErrorText),
    verificationErrorText,
    reviewConsentReady: Boolean(findHostedReviewConsentButton()),
    approveReady: Boolean(approveButton && isEnabledControl(approveButton)),
    approveButtonText: approveButton ? getActionText(approveButton) : '',
    hasPasskeyPrompt: hasPasskeyPrompt(),
    bodyTextPreview: normalizeText(document.body?.innerText || '').slice(0, 240),
  };
}

if (typeof globalThis !== 'undefined' && globalThis.__PAYPAL_FLOW_TEST_HOOKS__) {
  Object.assign(globalThis.__PAYPAL_FLOW_TEST_HOOKS__, {
    findHostedReviewConsentButton,
    hasHostedReviewSignals,
    getHostedVerificationPromptText,
    hasActiveHostedVerificationDialog,
    hasHostedVerificationInputs,
    getHostedVerificationErrorText,
    hasHostedVerificationError,
    isHostedVerificationResendControl,
    findHostedVerificationResendButton,
    resendHostedVerificationCode,
    isHostedPrivacySettingsPage,
    detectPayPalHostedCheckoutStage,
    inspectPayPalState,
  });
}

scheduleHostedHermesAutoRun();
