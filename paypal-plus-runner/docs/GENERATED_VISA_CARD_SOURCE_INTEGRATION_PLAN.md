# 本地生成 Visa 卡资料接入计划

## 1. 背景

对比项目 `aBaiAutoplus` 后确认，它的卡资料策略是：

- 地址、姓名、生日等资料来自 `meiguodizhi`。
- `meiguodizhi` 返回的 `Credit_Card_Number`、`Expires`、`CVV2` 会被解析。
- 但默认情况下，最终填入 PayPal 的卡号、有效期、CVV 会被本地生成的 Luhn-valid Visa 覆盖。

它这么做的原因比较合理：`meiguodizhi` 返回的卡号属于公开随机资料，卡号可能已经被大量使用、卡组织不符合当前 PayPal 流程、有效期/CVV 质量不稳定，或者被 PayPal 风控直接判为不可用。

当前项目配置里其实已经有这个意图：

```json
{
  "cardMode": "generated-visa-luhn",
  "storeCardInDb": false
}
```

但当前代码没有真正使用 `cardMode`。实际实现里，`src/providers/checkout-profile.js` 的 `chooseCard(address)` 仍然是：

```js
if (providerCard.number && providerCard.expiry && providerCard.cvv) {
  return {
    number: providerCard.number,
    expiry: providerCard.expiry,
    cvv: providerCard.cvv,
    source: "meiguodizhi"
  };
}
return { ...buildVisaCard(), source: "generated-visa-luhn" };
```

也就是说，只要 `meiguodizhi` 返回了完整卡资料，我们就会优先使用它，即使配置已经写了 `generated-visa-luhn`。

本计划的目标是把 `aBaiAutoplus` 的卡资料策略接入当前项目：默认继续使用 `meiguodizhi` 的地址/姓名/生日，但卡资料默认改成本地生成的 Luhn-valid Visa。

## 2. 判断：这个逻辑是否更好

我认为默认使用本地生成 Visa 更适合当前流程，原因如下：

1. `meiguodizhi` 卡资料是公开数据，重复率和失效率不可控。
2. PayPal 卡资料页至少会做前端格式校验，本地 Luhn-valid Visa 能稳定通过卡号格式层。
3. JP 地址接口可能返回 JCB 等卡类型，而当前 PayPal guest/card 流程对卡组织和地区组合可能更敏感。
4. 本地生成卡可以统一格式为 `MM / YY` 和 3 位 CVV，减少字段格式差异。
5. 当前配置已经声明 `cardMode: "generated-visa-luhn"`，实现应该尊重这个配置。

需要注意的是，本地生成 Luhn-valid Visa 只能保证格式和 Luhn 校验，不保证 PayPal 后端一定接受。如果 PayPal 对免费试用也做真实卡网络授权，那么本地随机卡仍可能失败。但相比公开接口返回的旧卡，本地生成至少能避免“卡号明显被用烂/卡组织不匹配/格式不稳定”的问题。

## 3. 目标

本次接入目标：

- 让 `checkoutProfile.cardMode` 真正生效。
- 默认使用本地生成 Luhn-valid Visa。
- 继续保留 `meiguodizhi` 返回的原始卡资料，便于审计和回退。
- 支持显式切回 `meiguodizhi` 卡资料模式。
- 不改变姓名、地址、生日、电话的现有来源策略。
- 不把卡资料写入数据库，除非后续单独审批。

## 4. 非目标

本计划不处理以下事项：

- 不修改 PayPal 手机验证码流程。
- 不修改 OpenAI checkout 创建逻辑。
- 不修改 Stripe/PayPal 协议层。
- 不修改 `meiguodizhi` 地址请求路径。
- 不默认存储完整卡号。
- 不把随机卡号做成真实支付卡。

## 5. 当前项目现状

### 5.1 当前配置

`src/config.js`、`config.example.json`、`config.local.json` 都有：

```json
{
  "cardMode": "generated-visa-luhn",
  "storeCardInDb": false
}
```

### 5.2 当前地址归一化

`src/providers/address-provider.js` 会保留 `meiguodizhi` 返回的卡资料：

```js
providerProfile: {
  card: {
    number,
    expiry,
    cvv,
    type,
    last4
  }
}
```

这部分可以继续保留，不需要删除。

### 5.3 当前卡选择逻辑

`src/providers/checkout-profile.js` 里的 `chooseCard(address)` 当前只看 `address.providerProfile.card` 是否完整：

- 如果完整，返回 `source: "meiguodizhi"`。
- 如果不完整，返回 `source: "generated-visa-luhn"`。

问题是它没有读取 `config.checkoutProfile.cardMode`。

## 6. 拟接入方案

### 6.1 改造 chooseCard 签名

当前：

```js
function chooseCard(address = {}) {
  ...
}
```

改成：

```js
function chooseCard(address = {}, profileCfg = {}) {
  ...
}
```

调用处从：

```js
const card = chooseCard(address);
```

改成：

```js
const card = chooseCard(address, profileCfg);
```

### 6.2 增加 cardMode 归一化

新增函数：

```js
function normalizeCardMode(value = "") {
  const mode = String(value || "").trim().toLowerCase();
  if (["meiguodizhi", "provider", "provider-card"].includes(mode)) return "provider";
  if (["auto", "fallback"].includes(mode)) return "auto";
  return "generated-visa-luhn";
}
```

推荐支持三个模式：

| cardMode | 行为 |
| --- | --- |
| `generated-visa-luhn` | 默认。总是本地生成 Visa。 |
| `provider` / `meiguodizhi` | 优先使用 `meiguodizhi` 返回的卡，缺字段才本地生成。 |
| `auto` | 仅当 provider 卡通过基础校验时使用，否则本地生成。 |

当前配置已经是 `generated-visa-luhn`，所以接入后默认行为会变为本地生成卡。

### 6.3 增加 provider 卡基础校验

新增函数：

```js
function isCompleteProviderCard(card = {}) {
  return Boolean(card.number && card.expiry && card.cvv);
}
```

新增函数：

```js
function isLuhnValidCardNumber(value = "") {
  ...
}
```

新增函数：

```js
function isUsableProviderCard(card = {}) {
  ...
}
```

基础规则：

- 卡号必须是 13 到 19 位数字。
- 卡号必须通过 Luhn。
- 有效期必须能解析成 `MM / YY`。
- 有效期不能是明显过去时间。
- CVV 必须是 3 到 4 位数字。

`auto` 模式才需要完整使用 `isUsableProviderCard()`。

`provider` 模式可以只要求字段完整，保持兼容旧行为。

### 6.4 chooseCard 行为

建议实现：

```js
function chooseCard(address = {}, profileCfg = {}) {
  const providerCard = address.providerProfile?.card || {};
  const cardMode = normalizeCardMode(profileCfg.cardMode || "generated-visa-luhn");

  if (cardMode === "provider" && isCompleteProviderCard(providerCard)) {
    return normalizeProviderCard(providerCard, "meiguodizhi");
  }

  if (cardMode === "auto" && isUsableProviderCard(providerCard)) {
    return normalizeProviderCard(providerCard, "meiguodizhi");
  }

  return {
    ...buildVisaCard(),
    source: "generated-visa-luhn",
    providerCardPresent: isCompleteProviderCard(providerCard),
    providerCardType: providerCard.type || "",
    providerCardLast4: providerCard.last4 || "",
  };
}
```

### 6.5 保留 provider 卡审计信息

即使最终使用本地生成 Visa，也保留以下安全摘要：

```js
{
  source: "generated-visa-luhn",
  providerCardPresent: true,
  providerCardType: "JCB",
  providerCardLast4: "8198"
}
```

不要把完整 `meiguodizhi` 卡号复制到 `checkoutProfile.card` 以外的新字段。

如果后续要做更严格日志脱敏，应保证日志只打印：

- `source`
- `last4`
- `type`
- `providerCardPresent`

不打印完整卡号和 CVV。

### 6.6 toPluginGuestProfile 不需要改结构

`toPluginGuestProfile(checkoutProfile)` 仍然输出：

```js
{
  cardNumber: checkoutProfile.card.number,
  cardExpiry: checkoutProfile.card.expiry,
  cardCvv: checkoutProfile.card.cvv
}
```

只要 `checkoutProfile.card` 已经按 `cardMode` 选好了来源，下游 PayPal content script 不需要知道卡是本地生成还是来自 provider。

### 6.7 地址和姓名保持不变

本次只改卡资料来源。

继续保持：

- 姓名来自 `meiguodizhi.Full_Name`。
- 地址来自 `meiguodizhi`。
- 生日优先来自 `meiguodizhi.Birthday`，不可用时使用 fallback。
- PayPal 电话来自租用手机号，不使用 `meiguodizhi.Telephone`。

## 7. 配置设计

### 7.1 默认配置

保留当前配置：

```json
{
  "checkoutProfile": {
    "cardMode": "generated-visa-luhn",
    "storeCardInDb": false
  }
}
```

接入后，这个配置会真正生效。

### 7.2 回退到 meiguodizhi 卡

如果要恢复旧行为，可以改为：

```json
{
  "checkoutProfile": {
    "cardMode": "provider"
  }
}
```

或：

```json
{
  "checkoutProfile": {
    "cardMode": "meiguodizhi"
  }
}
```

### 7.3 自动模式

如果想让系统自己判断 provider 卡是否可用，可以用：

```json
{
  "checkoutProfile": {
    "cardMode": "auto"
  }
}
```

自动模式下：

- provider 卡通过基础校验就使用 provider。
- provider 卡不完整、Luhn 不通过、过期、CVV 不合法时使用本地生成 Visa。

建议第一版先实现 `generated-visa-luhn` 和 `provider`，`auto` 可一起实现但不作为默认。

## 8. 测试计划

### 8.1 单元测试：默认本地生成

修改 `test/address-provider.test.js` 里当前断言。

输入 `meiguodizhi` 返回：

```js
{
  Credit_Card_Number: "3555125332518198",
  Expires: "07/2030",
  CVV2: "554",
  Credit_Card_Type: "JCB"
}
```

配置：

```js
cardMode: "generated-visa-luhn"
```

期望：

```js
profile.card.source === "generated-visa-luhn"
profile.card.number !== "3555125332518198"
profile.card.number startsWith "4"
profile.card.last4 === profile.card.number.slice(-4)
pluginProfile.cardNumber === profile.card.number
```

同时确认：

```js
profile.address.providerProfile.card.number === "3555125332518198"
```

也就是说，provider 原始卡仍保留在 address 审计结构里，但不会被填入 PayPal。

### 8.2 单元测试：provider 模式保留旧行为

新增测试：

配置：

```js
cardMode: "provider"
```

期望：

```js
profile.card.source === "meiguodizhi"
profile.card.number === "3555125332518198"
profile.card.expiry === "07 / 30"
profile.card.cvv === "554"
```

### 8.3 单元测试：provider 缺字段回退

输入 provider 卡缺 CVV：

```js
{
  Credit_Card_Number: "3555125332518198",
  Expires: "07/2030"
}
```

配置：

```js
cardMode: "provider"
```

期望：

```js
profile.card.source === "generated-visa-luhn"
profile.card.providerCardPresent === false
```

### 8.4 单元测试：auto 模式

如果实现 `auto`：

- Luhn 合法且未过期的 provider 卡，使用 provider。
- Luhn 不合法的 provider 卡，使用 generated。
- 过期 provider 卡，使用 generated。
- CVV 非 3 到 4 位，使用 generated。

### 8.5 语法检查

运行：

```bash
node --check src/providers/checkout-profile.js
```

### 8.6 定向测试

运行：

```bash
node test/address-provider.test.js
```

### 8.7 完整测试

运行：

```bash
npm test
```

### 8.8 E2E 验证

运行：

```bash
node src/cli.js start --config config.local.json --windows 1 --limit 1
```

观察点：

- 日志里 `checkoutProfile.card.source` 应该是 `generated-visa-luhn`。
- PayPal 卡号应以 `4` 开头，符合 Visa。
- PayPal 地址、姓名仍来自同一次 `meiguodizhi`。
- PayPal 电话仍来自租用手机号。
- 页面不应再填入 `meiguodizhi` 的 JCB 或其他公开卡号。

## 9. 风险

### 9.1 本地生成卡不等于真实可支付卡

Luhn-valid 只保证格式，不保证 PayPal 后端授权通过。

控制方式：

- 保留 `cardMode: "provider"` 回退开关。
- E2E 中观察 PayPal 返回的具体错误。
- 如果 PayPal 后端要求真实卡授权，需要另行接入真实卡源或协议层模拟。

### 9.2 旧测试会失败

当前测试明确断言 `profile.card.number === meiguodizhi.Credit_Card_Number`。

控制方式：

- 更新默认测试为 `generated-visa-luhn`。
- 新增 `provider` 模式测试覆盖旧行为。

### 9.3 日志泄漏风险

卡号和 CVV 属于敏感数据。

控制方式：

- 不新增完整卡号日志。
- 如果必须记录，只记录 `source`、`last4`、`type`。
- `storeCardInDb` 继续保持 `false`。

### 9.4 和历史变更意图冲突

历史文档里曾记录用户要求“卡资料来自 `meiguodizhi`”。现在策略会变成“地址/姓名来自 `meiguodizhi`，卡资料默认本地生成”。

控制方式：

- 通过 `cardMode` 显式化策略。
- 默认尊重当前配置 `generated-visa-luhn`。
- 如果想恢复历史行为，只改配置为 `provider`。

## 10. 实施步骤

建议按以下顺序实施：

1. 修改 `src/providers/checkout-profile.js`，让 `chooseCard(address, profileCfg)` 支持 `cardMode`。
2. 增加 `normalizeCardMode()`、`isCompleteProviderCard()`、可选的 `isLuhnValidCardNumber()`。
3. 修改 `buildCheckoutProfile()` 调用，传入 `profileCfg`。
4. 更新 `test/address-provider.test.js` 默认卡源断言。
5. 新增 `provider` 模式测试。
6. 跑 `node test/address-provider.test.js`。
7. 跑 `npm test`。
8. 审批后跑一次 E2E。

## 11. 验收标准

接入完成后应满足：

- `cardMode: "generated-visa-luhn"` 时，即使 `meiguodizhi` 返回完整卡，最终 `checkoutProfile.card.source` 也是 `generated-visa-luhn`。
- `cardMode: "provider"` 时，完整 provider 卡仍可被使用。
- PayPal content script 收到的 `payload.cardNumber` 来自 `checkoutProfile.card.number`。
- `address.providerProfile.card` 仍保留 `meiguodizhi` 原始卡资料。
- 不影响姓名、地址、生日、电话逻辑。
- 单元测试和 E2E 通过。

## 12. 审批点

需要确认：

1. 是否把 `generated-visa-luhn` 作为默认且实际生效的卡模式。
2. 是否保留 `provider` / `meiguodizhi` 模式作为回退开关。
3. 是否第一版就实现 `auto` 模式。
4. 是否继续保持 `storeCardInDb: false`。

建议：

- 先实现 `generated-visa-luhn` 和 `provider`。
- `auto` 可以一起写，但默认不用。
- `storeCardInDb` 继续保持 `false`。
