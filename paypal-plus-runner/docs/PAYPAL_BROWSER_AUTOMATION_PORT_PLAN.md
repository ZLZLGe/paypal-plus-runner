# PayPal 浏览器自动化移植计划

## 1. 背景

当前项目已经具备 PayPal hosted checkout 的基础自动化能力，核心代码在：

- `vendor/plugin/content/paypal-flow.js`
- `src/steps/fill-plus-checkout.js`
- `src/providers/address-provider.js`
- `src/providers/checkout-profile.js`

对比项目 `aBaiAutoplus` 的 PayPal 浏览器自动化后，发现它在两个方面更激进、更稳：

1. 进入 PayPal guest/card 填卡流程时，它不只依赖页面按钮，还会从 PayPal signin URL 中提取 `EC` / `BA` token，然后直接跳转到 `/checkoutweb/signup`。
2. 在 PayPal 统一 guest 表单里，它按精确 DOM id 填字段，并在 PayPal React 重渲染后做最终复检和补填。

我们项目已经有一部分相同能力，例如精确 id 填 `cardNumber`、`billingLine1`、`billingState`，但还缺少一些关键补强：

- 没有专门的 PayPal guest/card 入口阶段。
- 没有从 signin / approve URL 中抽 `EC` / `BA` token 并直达 `/checkoutweb/signup` 的能力。
- `requiredFieldsReady` 没检查 `billingState`，可能导致都道府县/州字段红框，但流程误以为字段已完整。
- 对 PayPal React 重渲染清空字段的最终补填还不够强。

## 2. 目标

本次计划的目标是把 `aBaiAutoplus` 中有效的 PayPal 浏览器自动化策略移植到当前项目，但不直接整段复制代码，而是按当前项目结构重写。

最终希望达到：

- 更稳定地进入 PayPal guest/card 填卡页面。
- 减少卡资料页字段红框。
- 避免 `billingState` 被清空后仍继续提交。
- 保持现有 `meiguodizhi` 地址流程和当前 runner 调度结构不被破坏。
- 避免日志泄漏完整 `EC`、`BA`、checkout session、手机号验证码等敏感信息。

## 3. 不做的事情

本计划只处理 PayPal 浏览器自动化，不处理以下内容：

- 不重写 Stripe checkout 创建逻辑。
- 不改 OpenAI checkout payload。
- 不改 PayPal 手机验证码供应商逻辑。
- 不改数据库 schema。
- 不默认切换卡资料来源，除非后续单独审批。
- 不直接复制 `aBaiAutoplus` 的大段源码。

## 4. 当前项目现状

### 4.1 地址和卡资料来源

当前项目配置中已经使用 `meiguodizhi`：

```json
{
  "addressProvider": "meiguodizhi",
  "addressEndpoint": "https://www.meiguodizhi.com/api/v1/dz",
  "hostedAddressCountryCode": "JP",
  "hostedAddressPath": "/jp-address",
  "hostedAddressMethod": "refresh"
}
```

地址请求由 `src/providers/address-provider.js` 发出，返回后会归一化成 checkout profile，再传给 PayPal content script。

### 4.2 PayPal guest 填卡

当前 `vendor/plugin/content/paypal-flow.js` 已经能填以下字段：

- `#email`
- `#phone`
- `#cardNumber`
- `#cardExpiry`
- `#cardCvv`
- `#password`
- `#dateOfBirth`
- `#firstName`
- `#lastName`
- `#countrySpecificFirstName`
- `#countrySpecificLastName`
- `#billingLine1`
- `#billingCity`
- `#billingPostalCode`
- `#billingState`

现有问题是字段填完后，readiness 只检查了大部分 input，没有把 `billingState` 纳入必填校验。

### 4.3 当前调度流程

`src/steps/fill-plus-checkout.js` 负责在 checkout 页面、PayPal 页面、payments success 页面之间切换。

核心循环里会根据 content script 返回的 `hostedStage` 做动作：

- `pay_login`: 填 PayPal login 邮箱。
- `guest_checkout`: 填卡和账单资料。
- `verification`: 拉 PayPal 手机验证码并提交。
- `review_consent`: 点击 PayPal Hermes review consent。
- `approval`: 点击 approve。
- `generic_error` / `phone_rejected`: 抛出错误。

目前没有单独的 `guest_entry` 阶段，所以如果页面停在 PayPal signin、PayPal approve、Pay with card 入口页，自动化只能靠现有 login / approval 逻辑碰运气。

## 5. 参考项目关键策略

`aBaiAutoplus` 的相关策略可以概括为四点：

### 5.1 从 PayPal signin URL 直达 guest signup

如果当前 URL 中存在：

- `token=EC-...`
- `ba_token=BA-...`

它会直接构造：

```text
https://www.paypal.com/checkoutweb/signup?token=EC-...&ba_token=BA-...&rcache=1&cookieBannerVariant=hidden
```

这样可以绕过按钮文案、页面语言、signin 页面是否渲染完整等不稳定因素。

### 5.2 点击 PayPal guest/card 入口

如果不能直达，它会尝试点击类似按钮：

- `Pay with debit or credit card`
- `Pay with card`
- `Continue as Guest`
- `Guest checkout`
- `Create account`
- `新規登録`
- `アカウントを開設`

这些入口可能把页面推进到 `/checkoutweb/signup` 或同等 guest 表单。

### 5.3 统一 guest 表单按精确 id 填

进入 `/checkoutweb/signup` 后，它以 `#cardNumber` 作为统一 guest 表单是否出现的关键判断。

出现后，按 id 直接填：

- `#email`
- `#phone`
- `#cardNumber`
- `#cardExpiry`
- `#cardCvv`
- `#billingPostalCode`
- `#billingState`
- `#billingCity`
- `#billingLine1`
- `#billingLine2`
- `#password`
- `#dateOfBirth`
- `#firstName`
- `#lastName`
- `#countrySpecificFirstName`
- `#countrySpecificLastName`

### 5.4 最终复检和补填

PayPal 页面经常在切换国家、渲染 DOB、渲染姓名区域后清空前面已经填过的字段。

参考项目会在最后再扫一遍关键字段：

- 空了就补。
- 格式化字段用归一化方式比较，例如卡号忽略空格。
- `billingState` 放到最后再选一次。

## 6. 拟改动方案

### 6.1 增加 PayPal guest entry 阶段

在 `vendor/plugin/content/paypal-flow.js` 中新增阶段：

```js
const PAYPAL_HOSTED_STAGE_GUEST_ENTRY = 'guest_entry';
```

该阶段用于表示：

- 当前页面还不是填卡页。
- 页面上存在 PayPal guest/card 入口。
- 或 URL 中存在可用于直达 `/checkoutweb/signup` 的 `EC` / `BA` token。

检测顺序建议调整为：

1. outside PayPal
2. phone rejected
3. generic error
4. verification
5. guest checkout
6. review consent
7. guest entry
8. pay login
9. approval
10. unknown

把 `guest entry` 放在 login / approval 前面，是为了优先走 guest/card 路径，而不是误走 PayPal 账号登录。

### 6.2 增加 token 抽取和直达 signup

新增函数：

```js
function extractHostedGuestSignupTokens(rawUrl = location.href)
```

返回结构：

```js
{
  ecToken: 'EC-...',
  baToken: 'BA-...',
  hasEcToken: true,
  hasBaToken: true
}
```

注意：

- 日志和返回给 runner 的状态不应包含完整 token。
- 只返回 `hasEcToken` / `hasBaToken` / `targetPath` 这类安全摘要。
- 如果 `EC` token 存在，优先构造 signup URL。

新增函数：

```js
function buildHostedGuestSignupUrl(tokens, payload = {})
```

构造目标 URL：

```text
/checkoutweb/signup?token=EC...&ba_token=BA...&rcache=1&cookieBannerVariant=hidden
```

如果 payload 中能确定国家是 JP，则补：

```text
country.x=JP&locale.x=ja_JP
```

如果当前 URL 已经带了 `country.x` / `locale.x`，优先沿用当前 URL 参数。

### 6.3 增加 guest/card 入口按钮识别

新增函数：

```js
function findHostedGuestEntryButton()
```

匹配文案包括：

- `pay with debit`
- `pay with credit`
- `pay with card`
- `debit or credit card`
- `continue as guest`
- `guest checkout`
- `check out as guest`
- `create account`
- `sign up`
- `カードで支払`
- `デビットカード`
- `クレジットカード`
- `ゲスト`
- `新規登録`
- `アカウントを開設`
- `アカウントを作成`
- `访客`
- `游客`
- `银行卡`
- `信用卡`
- `创建账户`

识别到后，使用现有 `clickHostedControl` 点击，避免只调用 `.click()`。

### 6.4 增加 guest entry 执行函数

新增函数：

```js
async function enterHostedGuestCheckoutEntry(payload = {})
```

执行优先级：

1. 如果能从 URL 抽到 `EC` token，直接 `window.location.assign(signupUrl)`。
2. 否则查找 guest/card 入口按钮并点击。
3. 如果都没有，返回 `entered: false`，交给 runner 后续等待或刷新。

返回结构示例：

```js
{
  stage: 'guest_entry',
  entered: true,
  method: 'direct_signup_url',
  hasEcToken: true,
  hasBaToken: true,
  targetPath: '/checkoutweb/signup'
}
```

或：

```js
{
  stage: 'guest_entry',
  entered: true,
  method: 'click_guest_entry',
  buttonText: 'Pay with debit or credit card'
}
```

### 6.5 接入 runHostedCheckoutStep

在 `runHostedCheckoutStep(payload)` 中加入：

```js
if (stage === PAYPAL_HOSTED_STAGE_GUEST_ENTRY) {
  return enterHostedGuestCheckoutEntry(payload);
}
```

这样 `src/steps/fill-plus-checkout.js` 不需要大改，仍然只负责根据 `hostedStage` 调 content script。

### 6.6 runner 侧处理 guest_entry

在 `src/steps/fill-plus-checkout.js` 中增加分支：

```js
if (state.hostedStage === 'guest_entry') {
  setCheckoutSubstep(context, 'paypal-guest-entry');
  await runHostedStep(page, context, buildHostedGuestPayload(context));
  await page.waitForTimeout(1500);
  continue;
}
```

这样如果 content script 只负责返回状态，runner 也能主动执行推进。

### 6.7 billingState 纳入 readiness

当前 readiness 需要新增：

```js
billingState: hostedSelectMatches('billingState', expected.address?.state || '')
```

需要新增 select 比较函数：

```js
function hostedSelectMatches(id, expected)
```

比较逻辑：

- expected 为空时可跳过。
- select 当前 value 不为空，且 option label/value 能匹配 expected，则 true。
- JP 地址要先用 `normalizeHostedJpPrefecture` 转成日文都道府县。

目的：

- 如果 `billingState` 被 PayPal 清空，`requiredFieldsReady` 必须是 false。
- runner 不应该提交红框状态的表单。

### 6.8 最终补填

在 `fillHostedGuestCheckout(payload)` 末尾增加最终复检：

```js
async function refillHostedGuestCheckoutMissingFields(expected)
```

复检字段：

- `email`
- `phone`
- `cardNumber`
- `cardExpiry`
- `cardCvv`
- `password`
- `dateOfBirth`
- `firstName`
- `lastName`
- `countrySpecificFirstName`
- `countrySpecificLastName`
- `billingLine1`
- `billingCity`
- `billingPostalCode`
- `billingState`

复检策略：

- 最多 2 轮。
- input 字段按 id 检查当前值。
- 卡号和 CVV 用纯数字比较。
- 有效期忽略空格比较。
- `billingState` 每轮最后再选一次。
- 每轮之间 sleep 300-500ms，等 React 重新渲染。

### 6.9 日志保护

新增日志时避免输出：

- 完整 `EC` token。
- 完整 `BA` token。
- 完整 checkout session id。
- 完整 URL hash。
- 验证码。
- 完整手机号。

可以输出：

```js
{
  hasEcToken: true,
  hasBaToken: true,
  targetPath: '/checkoutweb/signup'
}
```

## 7. 测试计划

### 7.1 单元测试

修改 `test/paypal-flow-detection.test.js`，增加以下测试。

#### 7.1.1 token 抽取

输入：

```text
https://www.paypal.com/signin?ba_token=BA-abc&token=EC-def
```

期望：

```js
hasEcToken === true
hasBaToken === true
```

不检查完整 token 日志，只检查函数结果。

#### 7.1.2 signup URL 构造

输入：

```js
{
  ecToken: 'EC-def',
  baToken: 'BA-abc'
}
```

期望：

```text
pathname === '/checkoutweb/signup'
searchParams.get('token') === 'EC-def'
searchParams.get('ba_token') === 'BA-abc'
searchParams.get('rcache') === '1'
searchParams.get('cookieBannerVariant') === 'hidden'
```

#### 7.1.3 guest entry 按钮识别

构造按钮：

```text
Pay with debit or credit card
```

期望：

```js
findHostedGuestEntryButton() === button
detectPayPalHostedCheckoutStage() === 'guest_entry'
```

#### 7.1.4 billingState readiness

构造 JP checkout 表单：

- `email` 已填。
- `phone` 已填。
- `cardNumber` 已填。
- `cardExpiry` 已填。
- `cardCvv` 已填。
- 地址字段已填。
- `billingState` 为空。

期望：

```js
required.ready === false
required.missing.includes('billingState') === true
```

然后设置 `billingState = '東京都'`，期望：

```js
required.ready === true
```

### 7.2 语法检查

运行：

```bash
node --check vendor/plugin/content/paypal-flow.js
node --check src/steps/fill-plus-checkout.js
```

### 7.3 定向测试

运行：

```bash
node test/paypal-flow-detection.test.js
```

### 7.4 完整测试

如果定向测试通过，运行：

```bash
npm test
```

### 7.5 E2E 验证

审批通过并合入后，做一次真实 E2E：

```bash
node src/cli.js start --config config.local.json --windows 1 --limit 1
```

观察点：

- 是否能从 PayPal signin / approve 进入 `/checkoutweb/signup`。
- 是否能稳定填 `billingState`。
- 卡资料页是否还出现红色必填提示。
- 是否出现重复提交。
- 是否泄漏敏感 token 到日志。

## 8. 风险和回滚

### 8.1 风险：误点 Create account

有些 PayPal 页面上的 `Create account` 可能不是 guest checkout 的入口，而是普通 PayPal 注册入口。

控制方式：

- 只有当前 host 是 PayPal 且不在 `guest_checkout` / `review_consent` / `verification` 时才识别。
- 优先 token 直达。
- 点击后如果没有进入 `/checkoutweb/signup`，runner 继续按现有超时和重试逻辑处理。

### 8.2 风险：误判 login 页面

如果 guest entry 检测太宽，可能把普通邮箱登录页误判为 guest entry。

控制方式：

- guest entry 按钮必须匹配 guest/card/create-account 类文案。
- 只有 URL 存在 `EC` token 时才执行直达。
- 没有按钮且没有 token 时仍走现有 `pay_login`。

### 8.3 风险：billingState 匹配过严

如果 `meiguodizhi` 返回英文 state，而 PayPal select option 是日文，都道府县可能匹配失败。

控制方式：

- JP 先调用 `normalizeHostedJpPrefecture`。
- 比较 option value 和 option label。
- 保留 loose select 匹配逻辑。

### 8.4 风险：重复补填影响页面状态

反复填字段可能触发 PayPal 表单校验或重渲染。

控制方式：

- 最多 2 轮。
- 只补当前值和 expected 不一致的字段。
- `billingState` 放最后。
- 如果字段不存在，不抛错，交给 readiness 返回 missing。

### 8.5 回滚方式

如果上线后 E2E 表现变差，回滚范围很小：

- 删除 `guest_entry` 阶段相关函数和分支。
- 删除 `billingState` readiness 检查。
- 删除最终补填函数。

主要修改集中在：

- `vendor/plugin/content/paypal-flow.js`
- `src/steps/fill-plus-checkout.js`
- `test/paypal-flow-detection.test.js`

## 9. 预计改动文件

### 9.1 必改

- `vendor/plugin/content/paypal-flow.js`
- `src/steps/fill-plus-checkout.js`
- `test/paypal-flow-detection.test.js`

### 9.2 可能不改

- `src/providers/address-provider.js`
- `src/providers/checkout-profile.js`
- `config.local.json`

这些文件只有在后续决定同步 `meiguodizhi` 请求参数或卡资料来源策略时才需要改。

## 10. 审批点

需要确认以下决策：

1. 是否允许新增 `guest_entry` 阶段。
2. 是否允许从 PayPal URL 抽 `EC` / `BA` token 并直达 `/checkoutweb/signup`。
3. 是否允许把 `billingState` 纳入必填 readiness。
4. 是否允许增加最终补填逻辑。
5. 是否保持当前卡资料来源策略不变，即暂时不改成默认本地生成 Visa。

建议本次先只做 1 到 4，保持第 5 点不动。
