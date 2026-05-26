# PayPal Plus Roxy Runner 项目计划

## 1. 项目目标

把 `/Users/leviviya/Documents/GuJumpgate-v0.1.3 2` 这个 Chrome 插件里的 PayPal Plus 自动化流程，改造成一个非插件形态的终端项目。

最终效果：

- 在终端启动一个 runner。
- runner 通过 Roxy API 打开多个 Roxy 浏览器窗口。
- 每个 Roxy 窗口使用动态代理配置。
- 多个窗口共享同一个 SQLite 数据库。
- 每个窗口作为一个 worker，不断从数据库领取未注册 Outlook 邮箱。
- 每个 worker 在自己的 Roxy 窗口里完整执行 PayPal Plus 流程。
- 流程采用插件里的 `SESSION JSON导入` 账号接入策略。
- 成功出现 Plus 后，把邮箱完整四字段写入 `plus_accounts` 表。
- GPT 注册密码统一固定为 `myPASSword!`。

本项目不再以 Chrome 扩展形式运行，也不依赖扩展侧边栏。所有配置、任务领取、状态记录和并发控制都由终端 runner 和数据库完成。

## 2. 已确认需求

### 2.1 浏览器与代理

- 使用 Roxy 浏览器窗口，不直接使用普通 Chrome。
- 参考现有脚本：
  - `/Users/leviviya/Documents/gpt/playwright/scripts/open_roxy_dynamic_windows.py`
  - `/Users/leviviya/Documents/gpt/playwright/modules/roxy_client.py`
- Roxy 窗口通过 Roxy 本地 API 创建、打开、关闭、修改代理。
- Playwright 通过 Roxy 返回的 CDP `ws` 地址连接窗口。
- 每个窗口拥有独立动态代理。
- 窗口数量必须可配置，不固定为 5。
- 窗口之间共享同一个数据库。

### 2.2 代理轮换策略

采用折中策略，不做每个账号都新建窗口，也不长期固定同一个 IP。

默认策略：

- 启动时创建指定数量的 Roxy 窗口。
- 每个窗口绑定一个 worker。
- 每个窗口同一个代理最多连续跑 `rotateProxyEveryAccounts` 个账号。
- 默认 `rotateProxyEveryAccounts = 3`。
- 跑满数量后：
  - 关闭当前 Roxy 窗口。
  - 对同一个 `dir_id` 调用 Roxy 修改代理接口。
  - 重新打开同一个窗口。
  - Playwright 重新连接新的 CDP `ws`。
- 遇到风控类错误、网络异常、PayPal/Stripe/OpenAI 异常时，即使没跑满数量，也立即换代理。
- 不为每个账号创建新的 Roxy 窗口档案，默认复用窗口档案。

配置示例：

```json
{
  "roxy": {
    "windowCount": 5,
    "rotateProxyPerAccount": false,
    "rotateProxyEveryAccounts": 3,
    "rotateProxyOnFailure": true,
    "rotateProxyOnRiskErrors": true,
    "reuseWindowProfile": true,
    "reopenWindowOnProxyRotate": true
  }
}
```

`windowCount` 只是默认配置，实际启动时可以通过命令行覆盖：

```bash
npm run start -- --windows 10
```

优先级：

```text
命令行 --windows > config.json roxy.windowCount > 默认值 5
```

如果数据库可用邮箱数量少于窗口数，runner 可以只开启需要的窗口数，避免空窗口浪费资源。

### 2.3 PayPal Plus 流程

使用插件里的 PayPal Plus 模式，并采用 `SESSION JSON导入`。

不采用普通 OAuth 尾部流程。

流程完成标准：

- OpenAI/ChatGPT 账号注册完成。
- PayPal Plus 支付授权完成。
- ChatGPT 账号显示 Plus 或插件等价判断成功。
- 读取当前 ChatGPT session。
- 按 `SESSION JSON导入` 模式导入目标平台，或保存 session JSON。
- 成功邮箱写入 `plus_accounts` 表。

### 2.4 验证码

验证码采用两层 provider：

- OpenAI 注册/登录邮箱验证码：优先原生对接用户已部署的 `HChaoHui/MS_OAuth2API_Next`。
- PayPal / Hosted Checkout / 其他短信验证码：使用当前 run 租到的 `paypal_phone_pool.sms_url`，格式来自 `/Users/leviviya/Documents/gpt/playwright/phone.txt`。

`MS_OAuth2API_Next` 已支持用 Outlook 四字段读取邮件：

```text
email
client_id
refresh_token
mailbox
```

runner 会使用 `outlook_emails` 表中的 `email/client_id/refresh_token` 调用邮件 API，不需要网页登录 Outlook，也不需要单独配置 IMAP/Graph。邮件服务本身会自动判断 Graph 或 IMAP。

PayPal 手机短信接口按现有项目解析：

```text
no
yes|Your PayPal code is 123456
```

触发 PayPal/Hosted Checkout 发送短信后，必须先等待 10 秒，再开始请求 `sms_url` 并解析验证码。

支持的验证码节点：

- OpenAI 注册邮箱验证码：`MS_OAuth2API_Next` provider。
- OpenAI 登录邮箱验证码：`MS_OAuth2API_Next` provider，如果所选 SESSION JSON 模式仍需要登录校验。
- PayPal 验证码：`phone-pool-sms-url` provider，使用当前 run 租到的 `paypal_phone_pool.sms_url`。
- Hosted Checkout/PayPal 手机验证码：`phone-pool-sms-url` provider，触发短信后先等待 10 秒再轮询。

### 2.5 数据库

使用 SQLite。

原因：

- 单机多窗口并发足够。
- 方便直接查看和备份。
- 当前 `/Users/leviviya/Documents/gpt/playwright` 已经使用 SQLite。
- 后续需要多机器时再迁移 PostgreSQL。

数据库开启 WAL：

```sql
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
```

表保持简洁。

初始 Outlook 邮箱表参考现有项目的邮箱格式：

```text
email----password----client_id----refresh_token
```

Plus 表也记录完整四字段：

```text
email
password
client_id
refresh_token
```

GPT 注册密码统一固定为：

```text
myPASSword!
```

### 2.6 PayPal 接码手机号

PayPal Plus 流程还需要 PayPal 接码手机号。

PayPal 手机号来源改为现有项目的 `phone.txt` 标准格式：

```text
+15722337281|http://a.62-us.com/api/get_sms?key=a7ff3404e9b36b7726f90d30cf8757a9
```

runner 会单独维护 PayPal 接码手机号池，不和 Outlook 邮箱表混在一起。

手机号规范：

- 数据库里 `phone` 保持 `phone.txt` 里的 `+1XXXXXXXXXX` 格式，和 `/Users/leviviya/Documents/gpt/playwright/modules/phone_store.py` 保持一致。
- PayPal 页面里填写时，运行时从 `phone` 派生不带 `+1` 的 US 本地 10 位号码。
- `sms_url` 是该手机号绑定的接码接口。
- 每行只包含一组手机号和接码接口，中间用 `|` 分隔。

使用策略：

- 每个 PayPal Plus run 领取一个 PayPal 接码手机号。
- 领取逻辑优先选择使用次数最少、最近使用最早的号码。
- 该号码的 `sms_url` 用于 PayPal / Hosted Checkout 验证码。
- 成功后增加使用次数。
- 验证码失败或 PayPal 风控时记录错误，必要时暂停该号码。

### 2.7 PayPal/Hosted Checkout 填写资料来源

原插件在填写 PayPal / Hosted Checkout 信息时，不是只依赖静态配置。它会在运行时生成一组付款流程资料，并从外部地址接口抓取账单地址。

插件里的关键实现位置：

```text
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/create-plus-checkout.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/fill-plus-checkout.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/content/paypal-flow.js
```

Hosted Checkout 阶段使用的地址接口：

```text
POST https://www.meiguodizhi.com/api/v1/dz
Content-Type: application/json

{
  "path": "/",
  "method": "address"
}
```

插件映射字段：

```text
Address    -> street
City       -> city
State_Full -> state
State      -> state fallback
Zip_Code   -> zip
```

插件生成的 Hosted Checkout guest profile 包含：

```text
email       随机 gmail 风格邮箱
password    随机强密码
phone       当前 PayPal/Hosted 接码手机号
firstName   James
lastName    Smith
fullName    James Smith
cardNumber  运行时生成的 Visa 风格卡号
cardExpiry  运行时生成的有效期
cardCvv     运行时生成的 CVV
address     meiguodizhi 返回的地址
```

新 runner 必须实现一个独立的 `checkout-profile` 模块来完成这件事。默认策略是直接复刻插件方法：

- 地址优先调用 `meiguodizhi`。
- 姓名默认使用 `James Smith`，后续可以切到插件 `data/names.js` 的随机姓名池。
- 手机号使用 `paypal_phone_pool` 当前 run 租到的 10 位 US 本地号码。
- guest 邮箱和 guest 密码按插件逻辑随机生成，不使用 Outlook 邮箱。
- 卡资料按插件 `buildHostedCheckoutVisaCard` 的 Luhn 逻辑生成。
- 如果外部地址接口不可用，回退到 `config.checkoutProfile.fallbackAddress`。
- 不在数据库保存完整卡号，只在 run 日志里记录 `cardLast4`，避免把敏感付款资料写入长期表。

资料产出结构建议：

```json
{
  "guest": {
    "email": "randomlocalpart@gmail.com",
    "password": "randomPassword",
    "firstName": "James",
    "lastName": "Smith",
    "fullName": "James Smith"
  },
  "phone": {
    "raw": "+15722370626",
    "paypalLocal": "5722370626",
    "smsUrl": "https://..."
  },
  "card": {
    "number": "4147...",
    "expiry": "08 / 28",
    "cvv": "123",
    "last4": "1234"
  },
  "address": {
    "street": "123 Main St",
    "city": "New York",
    "state": "New York",
    "zip": "10001",
    "countryCode": "US"
  },
  "source": {
    "addressProvider": "meiguodizhi",
    "profileMode": "plugin-compatible"
  }
}
```

步骤接入方式：

- worker 领取 Outlook 邮箱后，立即领取一个 PayPal 手机号。
- `checkout-profile` 用该手机号生成本次 run 的完整 PayPal/Hosted Checkout profile。
- 步骤 6 创建 Plus Checkout 时把 `guestProfile` 传给 Hosted/OpenAI 支付页自动化。
- PayPal guest checkout 页面填写 email、phone、card、password、firstName、lastName、billing address。
- 步骤 7 ChatGPT billing address 页面继续使用同一个 address seed 或按插件 `fill-plus-checkout.js` 的地址解析逻辑重新取地址。
- PayPal/Hosted 触发短信验证码时，用当前手机号绑定的 `sms_url` 取码。
- run 成功或失败后释放手机号租约。

账单地址策略需要保留插件的两条路径：

- Hosted Checkout guest flow：默认调用 `meiguodizhi` 的 `/` + `address` 模式，直接得到 US 地址。
- ChatGPT billing step 7：优先复刻插件 `fill-plus-checkout.js`，根据国家解析地址；PayPal + US 场景可使用 `randomuser.me` 或 `meiguodizhi`，失败后使用本地兜底地址。

第一版建议先实现“插件兼容模式”，不要引入新的资料生成网站。只有当 `meiguodizhi` 不稳定或返回字段不完整时，再启用配置化兜底。

### 2.8 支付转换 Provider（云端 / 本地 JP 可切换）

当前插件里的“云端支付转换”不是普通页面点击逻辑，而是把 ChatGPT Plus checkout session 创建动作抽成了一个服务。

关键参考：

```text
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/services/checkout-converter/app.py
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/services/checkout-converter/README.md
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/create-plus-checkout.js
```

插件云端转换的核心逻辑：

- 从 ChatGPT 当前页面读取 `accessToken`。
- 调用云端 `POST /api/checkout`。
- 请求体包含 `accessToken`、`paymentMethod`、`country`、`currency`、`processorEntity`。
- 云端服务向 `https://chatgpt.com/backend-api/payments/checkout` 创建 checkout session。
- PayPal 模式默认 `US / USD`，`checkout_ui_mode = hosted`。
- 返回 `checkoutUrl`、`chatgptCheckoutUrl`、`hostedCheckoutUrl`、`preferredCheckoutUrl`。
- PayPal 优先使用 `preferredCheckoutUrl` 或 `hostedCheckoutUrl`。
- 返回 `User is already paid` 时，不应视为致命失败，应标记账号已具备 Plus 并跳过支付节点。

插件 README 里对支付转换代理的要求是：支付转换代理出口必须是 JP。这个需求可以不依赖云端服务，runner 可以自己完成。

新 runner 设计成可切换 provider：

```text
cloud           使用插件同款云端 checkout-converter 服务
local_jp_proxy  使用本机/runner 自己的 JP 动态代理完成支付转换
direct          调试模式，不额外指定 JP 代理，第一版不建议用于批量
```

默认建议：

```text
checkoutConversion.provider = local_jp_proxy
```

这样可以把支付转换能力握在本地，同时保留云端 provider 作为备用。

#### cloud provider

行为：

- 读取 ChatGPT `accessToken`。
- 调用配置里的 `checkoutConversion.cloud.apiUrl`。
- 请求头可带 `X-API-Key`。
- 请求体沿用插件云端协议。
- 解析 `preferredCheckoutUrl`、`hostedCheckoutUrl`、`chatgptCheckoutUrl`。
- 处理 `User is already paid`。

适用场景：

- 云端服务可用且稳定。
- 希望复用插件已部署的服务。
- 本地不想启动 GOST 或本地 Python helper。

#### local_jp_proxy provider

行为：

- 读取 ChatGPT `accessToken`。
- 使用本地配置生成 JP 动态代理出口。
- 通过该 JP 出口请求 ChatGPT checkout API。
- 返回与 cloud provider 相同的标准化结果。
- 失败时轮换 JP `SID` / `ASN` 后重试。

本地 JP 动态代理参考：

```text
/Users/leviviya/Documents/gpt/playwright/modules/pay_url.py
/Users/leviviya/Documents/gpt/playwright/动态代理配置说明.md
/Users/leviviya/Documents/gpt/playwright/config.json
```

现有项目的关键模式：

```json
{
  "payurl": {
    "use_gost_chain": true,
    "run_probe": true,
    "gost_chain": {
      "first_hop_proxy_url": "http://127.0.0.1:7890",
      "second_hop_proxy_url": "socks5://账号-region-JP-asn-{ASN}-sid-{SID}-t-20:密码@代理host:代理端口",
      "asn_pools": {
        "JP": ["AS9605", "AS17676", "AS2516", "AS138384", "AS4713", "AS2518", "AS2527", "AS17511"]
      }
    }
  }
}
```

runner 本地实现要点：

- `local_jp_proxy` 只接管“创建 checkout URL 的 HTTP 请求”。
- 不强制把整个 Roxy 浏览器窗口切到 JP。
- PayPal 页面后续 guest/card/短信流程仍使用当前 worker 的 Roxy 浏览器窗口代理。
- JP 出口只用于 ChatGPT checkout session 创建，避免影响 PayPal 页面本身。
- 每次转换生成新的 `SID`。
- 如果代理模板包含 `{ASN}`，从 `asnPools.JP` 随机选择。
- 请求前先探测出口 IP 和地区。
- 如果 `requireJpExit=true` 且探测不是 JP，立即换 SID/ASN 重试。
- 转换成功后关闭本次 GOST 链路或释放临时代理资源。

标准化返回结构：

```json
{
  "ok": true,
  "provider": "local_jp_proxy",
  "checkoutSessionId": "cs_live_xxx",
  "checkoutUrl": "https://chatgpt.com/checkout/openai_ie/cs_live_xxx",
  "chatgptCheckoutUrl": "https://chatgpt.com/checkout/openai_llc/cs_live_xxx",
  "hostedCheckoutUrl": "https://pay.openai.com/c/pay/...",
  "preferredCheckoutUrl": "https://pay.openai.com/c/pay/...",
  "country": "US",
  "currency": "USD",
  "processorEntity": "openai_llc",
  "exitRegion": "JP",
  "exitIp": "x.x.x.x",
  "asn": "AS9605",
  "sid": "abc12345",
  "alreadyPaid": false
}
```

失败处理：

- `User is already paid`：标记 `plusCheckoutAlreadyPaid=true`，直接进入 session JSON 导入。
- Cloudflare challenge / 403 / 429：本地 JP provider 轮换 SID/ASN 重试；多次失败后让 worker 触发代理轮换策略。
- JP 出口探测失败：不请求 checkout，直接换 JP 代理重试。
- 未返回 checkout URL：记录原始响应摘要、截图/HTML、run history。

## 3. 插件流程映射

### 3.1 原插件关键文件

需要参考和迁移的插件文件：

```text
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/data/step-definitions.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/content/signup-page.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/content/plus-checkout.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/content/paypal-flow.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/create-plus-checkout.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/fill-plus-checkout.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/paypal-approve.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/plus-return-confirm.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/sub2api-session-import.js
/Users/leviviya/Documents/GuJumpgate-v0.1.3 2/background/steps/cpa-session-import.js
```

### 3.2 SESSION JSON 导入对应关系

插件侧边栏里的“账号接入策略”有两个 UI 值：

```text
oauth
session_json
```

`SESSION JSON导入` 在插件内部会根据导出目标映射为不同运行模式：

- 导出目标是 SUB2API：
  - `plusAccountAccessStrategy = "sub2api_codex_session"`
- 导出目标是 CPA：
  - `plusAccountAccessStrategy = "cpa_codex_session"`
- 导出目标是本地 CPA JSON 无 RT：
  - `panelMode = "local-cpa-json-no-rt"`

新 runner 不依赖侧边栏，直接用配置表达：

```json
{
  "flow": {
    "plusModeEnabled": true,
    "plusPaymentMethod": "paypal",
    "accountAccessStrategyUi": "session_json",
    "sessionJsonTarget": "sub2api",
    "plusAccountAccessStrategy": "sub2api_codex_session"
  }
}
```

可选目标：

```text
sub2api
cpa
local-cpa-json-no-rt
```

默认建议先实现 `local-cpa-json-no-rt` 或 `sub2api`，因为它们最符合“SESSION JSON导入”的使用方式。具体默认值可以在开发前最终确认。

## 4. 完整 PayPal Plus 流程

### 4.1 标准 PayPal Plus + SESSION JSON 流程

如果采用 `SESSION JSON导入`，流程不跑普通 OAuth 尾部，而是在 PayPal Plus 成功后直接读取当前 ChatGPT session 并导入。

推荐流程：

```text
1. open-chatgpt
2. submit-signup-email
3. fill-password
4. fetch-signup-code
5. fill-profile
6. plus-checkout-create
7. plus-checkout-billing
8. paypal-approve
9. plus-checkout-return
10. session-json-import
```

其中 `session-json-import` 会根据配置实际执行：

```text
sub2api-session-import
cpa-session-import
local-cpa-json-export
```

### 4.2 每个步骤说明

#### 1. open-chatgpt

动作：

- 清理当前 Roxy 窗口内的相关站点数据。
- 打开 ChatGPT 官网或注册入口。

需要清理的域名：

```text
chatgpt.com
chat.openai.com
openai.com
auth.openai.com
auth0.openai.com
accounts.openai.com
pay.openai.com
paypal.com
stripe.com
checkout.stripe.com
```

#### 2. submit-signup-email

动作：

- 从数据库领取 Outlook 邮箱。
- 使用该邮箱作为 OpenAI 注册邮箱。
- 通过页面自动化输入邮箱并继续。

注意：

- GPT 注册密码不取 Outlook 邮箱密码。
- GPT 注册密码统一使用 `myPASSword!`。

#### 3. fill-password

动作：

- 在 OpenAI 注册页填写固定 GPT 密码。

固定密码：

```text
myPASSword!
```

#### 4. fetch-signup-code

动作：

- 调用验证码 API 获取 OpenAI 注册验证码。
- 把验证码填入页面。
- 如果页面拒绝验证码，排除旧验证码并继续轮询新验证码。

#### 5. fill-profile

动作：

- 填写姓名和生日。
- 可复用插件里的姓名和生日生成逻辑。

#### 6. plus-checkout-create

动作：

- 进入 ChatGPT Plus checkout。
- 从当前 ChatGPT 页面读取 `accessToken`。
- 按 `checkoutConversion.provider` 选择云端支付转换或本地 JP 支付转换。
- 创建 PayPal hosted checkout 链路。
- 如果触发 Hosted Checkout/OpenAI 验证码，调用验证码 API。

支付转换 provider：

- `cloud`：调用插件同款 checkout-converter 云端服务。
- `local_jp_proxy`：runner 使用本地 JP 动态代理创建 checkout session。
- `direct`：调试用直连模式，不建议批量使用。

#### 7. plus-checkout-billing

动作：

- 填写账单地址。
- 选择 PayPal。
- 提交订单或跳转到 PayPal。

#### 8. paypal-approve

动作：

- 在 PayPal 页面登录或创建/授权。
- 填写 PayPal 所需信息。
- 如果 PayPal 要验证码，调用验证码 API。
- 完成授权。

#### 9. plus-checkout-return

动作：

- 等待 PayPal 回跳 OpenAI/Stripe/ChatGPT。
- 确认订阅完成。
- 判断账号是否成功出现 Plus。

#### 10. session-json-import

动作：

- 从当前 ChatGPT 登录会话中读取 session/access token。
- 按配置导入目标平台，或保存本地 session JSON。
- 写入 `plus_accounts`。

### 4.3 动态页面跳过与状态机

不能把 PayPal Plus 流程实现成固定线性点击。OpenAI、Hosted Checkout、PayPal 每轮可能出现的页面不同，runner 必须按页面状态判断“执行、跳过、重试、失败”。

总体原则：

- 每个步骤先探测当前页面状态，再决定动作。
- 如果目标页面已经完成或不存在，就跳过该步骤。
- 如果进入了等价成功状态，直接推进后续步骤。
- 如果进入了不可恢复错误状态，结束当前邮箱并记录失败。
- 所有跳过都要写 run history，方便排查。

建议每个 step 返回统一结构：

```json
{
  "status": "done | skipped | retry | failed",
  "reason": "already_completed | page_not_required | already_paid | direct_success | blocked | timeout",
  "nextStep": "..."
}
```

#### 注册阶段可跳过页面

可能跳过：

- 已经登录 ChatGPT：跳过 `submit-signup-email`、`fill-password`、`fetch-signup-code`。
- 输入邮箱后页面直接进入验证码：跳过密码页探测中的等待。
- 页面提示邮箱已存在但可登录：按配置决定登录继续或标记失败。
- profile 页面未出现：如果已进入 ChatGPT 主界面或 checkout，可跳过 `fill-profile`。
- 生日/姓名页面已填写过：跳过 `fill-profile`。

#### Plus Checkout 阶段可跳过页面

可能跳过：

- `checkoutConversion` 返回 `User is already paid`：跳过 `plus-checkout-billing`、`paypal-approve`、`plus-checkout-return`，直接进入 `session-json-import`。
- hosted checkout 创建后直接进入支付成功页：跳过 PayPal guest/card 填写和回跳等待。
- ChatGPT billing 页面没有出现但已经拿到 `preferredCheckoutUrl`：直接跳 PayPal/Hosted URL。
- 页面显示当前账号已有 Plus：跳过支付节点，进入 session JSON。
- 免费试用不可用或今日应付金额非 0：结束当前邮箱，标记业务失败，不继续 PayPal。

#### PayPal/Hosted Checkout 阶段可跳过页面

PayPal 页面不是固定顺序，必须按 `hostedStage` 判断：

```text
pay_login        填 guest 邮箱继续
guest_checkout   填卡、姓名、手机号、地址
verification     触发短信后等待 10 秒，再从 sms_url 取码
review_consent   点击 Agree and Continue
approval         如果是普通授权页，按当前 PayPal Plus guest 流配置判断是否失败或继续
generic_error    按插件已有逻辑判断是否可视为完成或失败
outside_paypal   等待跳转或回到 ChatGPT
```

可能跳过：

- PayPal 未出现登录页，直接出现 guest checkout：跳过 `pay_login`。
- PayPal 未要求验证码：跳过短信取码。
- PayPal 未出现 review consent：跳过同意页点击。
- PayPal 提交后直接跳 ChatGPT success：跳过 `plus-checkout-return` 中的长等待。
- PayPal 验证码错误后重新触发短信：旧验证码加入 `excludeCodes`，不要重复提交。

#### SESSION JSON 模式跳过项

因为当前只做 `SESSION JSON导入`：

- 不跑插件普通 OAuth 尾部。
- 不跑 OAuth 手机验证。
- 不跑 CPA OAuth phone 流程。
- Plus 成功后直接读取当前 ChatGPT session 并导入目标平台。

#### 实现要求

- 每个页面识别函数必须返回明确 stage，而不是只依赖单个 selector。
- 每个 step 都要支持 idempotent，即重复执行不会破坏当前状态。
- `alreadyPaid`、`directSuccess`、`nonFreeTrial`、`captchaBlocked` 等特殊结果要用错误码或状态码表达，不要只靠字符串判断。
- 跳过不是静默跳过，必须写日志和 `run_history.current_step/status/reason`。

## 5. Roxy 窗口池设计

### 5.1 启动阶段

runner 启动后：

1. 读取配置。
2. 打开数据库。
3. 初始化 schema。
4. 查询可用邮箱数量。
5. 根据 `--windows` 或 `config.roxy.windowCount` 计算实际窗口数。
6. 创建 Roxy 窗口。
7. 探测每个窗口的出口 IP。
8. 为每个窗口启动一个 worker。

### 5.2 Roxy API 调用

创建窗口：

```text
POST /browser/create
```

打开窗口：

```text
POST /browser/open
```

关闭窗口：

```text
POST /browser/close
```

删除窗口：

```text
POST /browser/delete
```

修改窗口代理：

```text
POST /browser/mdf
```

### 5.3 动态代理用户名

沿用现有 RoxyClient 逻辑。

模板示例：

```text
mqtz1176005-region-US-asn-{ASN}-sid-{SID}-t-20
```

每次代理轮换时：

- 生成新的 `SID`。
- 从 ASN 池选择一个 `ASN`。
- 渲染代理用户名。
- 调用 Roxy 修改代理。

### 5.4 Playwright 连接方式

Roxy `/browser/open` 返回：

```json
{
  "ws": "ws://127.0.0.1:xxxxx/devtools/browser/..."
}
```

Playwright 连接：

```js
const browser = await chromium.connectOverCDP(ws);
```

每次窗口重开后：

- 旧 CDP 连接失效。
- 需要读取新的 `ws`。
- 重新 `connectOverCDP`。
- 重新获取 context/page。

### 5.5 本地窗口代理探测

参考现有 `RoxyClient.build_local_window_proxy_url(dir_id)`。

探测逻辑：

- 从 Roxy 日志解析本地 SOCKS 代理端口。
- 构造本地代理：

```text
socks5://{dir_id}:{dir_id}@127.0.0.1:{port}
```

- 用 `https://api.ipify.org?format=json` 探测出口 IP。
- 保存到 worker 状态和数据库。

## 6. 数据库设计

### 6.1 outlook_emails

初始 Outlook 邮箱池。

字段保持简洁，但保留现有邮箱格式的四个核心字段。

```sql
CREATE TABLE IF NOT EXISTS outlook_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  leased_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

状态：

```text
new          未领取
leased       已被 worker 领取
running      正在执行流程
plus_done    已成功出现 Plus，已写入 plus_accounts
failed       不可重试失败
```

### 6.2 plus_accounts

PayPal Plus 成功账号表。

要求记录邮箱完整四个字段。

```sql
CREATE TABLE IF NOT EXISTS plus_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL DEFAULT '',
  client_id TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  gpt_password TEXT NOT NULL DEFAULT 'myPASSword!',
  session_json TEXT NOT NULL DEFAULT '',
  import_target TEXT NOT NULL DEFAULT 'session_json',
  roxy_dir_id TEXT NOT NULL DEFAULT '',
  roxy_exit_ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

成功写入规则：

- `email` 复制自 `outlook_emails.email`。
- `password` 复制自 `outlook_emails.password`。
- `client_id` 复制自 `outlook_emails.client_id`。
- `refresh_token` 复制自 `outlook_emails.refresh_token`。
- `gpt_password` 固定为 `myPASSword!`。
- `session_json` 保存最终读取到的 SESSION JSON，或保存导入结果里可复用的 JSON。
- `import_target` 保存 `sub2api`、`cpa` 或 `local-cpa-json-no-rt`。
- `roxy_dir_id` 保存成功时的 Roxy 窗口 ID。
- `roxy_exit_ip` 保存成功时的出口 IP。

### 6.3 paypal_phone_pool

PayPal Plus 流程需要 PayPal 接码手机号。该表参考现有项目 `/Users/leviviya/Documents/gpt/playwright/modules/phone_store.py` 里的 `phone_pool`，但新项目必须额外支持并发租约，确保多个 Roxy 窗口不会同时使用同一个手机号。

现有项目的 `phone_pool` 字段是：

```sql
phone
sms_url
used_count
max_use
status
imported_at
updated_at
last_error
```

新项目建议表：

```sql
CREATE TABLE IF NOT EXISTS paypal_phone_pool (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  sms_url TEXT NOT NULL,
  used_count INTEGER NOT NULL DEFAULT 0,
  max_use INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'active',
  leased_by TEXT NOT NULL DEFAULT '',
  current_run_id TEXT NOT NULL DEFAULT '',
  leased_at TEXT NOT NULL DEFAULT '',
  lease_expires_at TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

字段说明：

```text
phone             原始手机号，保持 phone.txt 的 +1XXXXXXXXXX 格式
sms_url           该手机号绑定的接码接口
used_count        已成功或已尝试使用次数
max_use           最大使用次数
status            active / leased / exhausted / disabled / failed
leased_by         当前占用它的 workerId
current_run_id    当前占用它的 runId
leased_at         租用时间
lease_expires_at  租约过期时间，防止 worker 崩溃后永久占用
last_error        最近一次错误
```

手机号导入格式以 `/Users/leviviya/Documents/gpt/playwright/phone.txt` 为准：

```text
+15722370626|http://a.62-us.com/api/get_sms?key=xxxx
```

第一版只要求支持 `|` 分隔格式。可以保留对 `----` 的兼容解析，但文档、导入命令和示例统一使用 `phone.txt` 格式。

导入时规范化：

- 去除空格、横线、括号等非数字字符。
- 如果是 11 位且以 `1` 开头，保存为 `+1` + 后 10 位。
- 如果是 10 位，保存为 `+1` + 10 位。
- PayPal 页面填写时再派生 `paypalLocalPhone = phone.replace(/^\+1/, '')`。
- 其他格式第一版直接拒绝，避免 PayPal 填号异常。

### 6.4 PayPal 手机号租约事务

多窗口并发时，必须保证一个 PayPal 手机号同一时间只被一个 worker 使用。

领取手机号时使用 `BEGIN IMMEDIATE`：

```sql
BEGIN IMMEDIATE;

SELECT id
FROM paypal_phone_pool
WHERE (
    status = 'active'
    OR (status = 'leased' AND lease_expires_at < CURRENT_TIMESTAMP)
  )
  AND used_count < max_use
ORDER BY used_count ASC, updated_at ASC, id ASC
LIMIT 1;

UPDATE paypal_phone_pool
SET status = 'leased',
    leased_by = ?,
    current_run_id = ?,
    leased_at = CURRENT_TIMESTAMP,
    lease_expires_at = datetime('now', '+30 minutes'),
    updated_at = CURRENT_TIMESTAMP,
    last_error = ''
WHERE id = ?;

COMMIT;
```

关键点：

- `BEGIN IMMEDIATE` 会拿写锁，避免两个窗口同时选中同一行。
- 租约有效期默认 30 分钟，可配置。
- worker 正常运行时定期续租，避免完整 PayPal 流程超过租约时间。
- worker 崩溃后，超过 `lease_expires_at` 的号码可以被其他 worker 回收。

### 6.5 PayPal 手机号释放与成功更新

成功后：

```sql
BEGIN IMMEDIATE;

UPDATE paypal_phone_pool
SET used_count = used_count + 1,
    status = CASE
      WHEN used_count + 1 >= max_use THEN 'exhausted'
      ELSE 'active'
    END,
    leased_by = '',
    current_run_id = '',
    leased_at = '',
    lease_expires_at = '',
    last_error = '',
    updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND current_run_id = ?;

COMMIT;
```

可重试失败后释放：

```sql
BEGIN IMMEDIATE;

UPDATE paypal_phone_pool
SET status = CASE
      WHEN used_count >= max_use THEN 'exhausted'
      ELSE 'active'
    END,
    leased_by = '',
    current_run_id = '',
    leased_at = '',
    lease_expires_at = '',
    last_error = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND current_run_id = ?;

COMMIT;
```

不可重试手机号错误后禁用：

```sql
BEGIN IMMEDIATE;

UPDATE paypal_phone_pool
SET status = 'disabled',
    leased_by = '',
    current_run_id = '',
    leased_at = '',
    lease_expires_at = '',
    last_error = ?,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ? AND current_run_id = ?;

COMMIT;
```

### 6.6 PayPal 手机号使用范围

PayPal 手机号只用于 PayPal / Hosted Checkout 接码，不用于 Outlook 邮箱验证码。

在每个 run 中：

- 领取 Outlook 邮箱。
- 领取 PayPal 手机号。
- OpenAI 邮箱验证码走 `MS_OAuth2API_Next`。
- PayPal / Hosted Checkout 验证码走该 PayPal 手机号绑定的 `sms_url`。
- PayPal 页面里填写该手机号的 10 位本地号码。
- run 结束后释放或更新该手机号。

### 6.7 可选 run_history

邮箱表和 Plus 表保持简洁。为了排错，建议增加一个独立运行记录表，不污染核心表。

```sql
CREATE TABLE IF NOT EXISTS run_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL DEFAULT '',
  outlook_email_id INTEGER,
  worker_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
  current_step TEXT NOT NULL DEFAULT '',
  roxy_dir_id TEXT NOT NULL DEFAULT '',
  roxy_exit_ip TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT '',
  finished_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

这个表建议保留，因为多窗口并发时排查问题很有用。

### 6.8 领取邮箱事务

每个 worker 从同一个数据库领取邮箱时必须加事务锁，避免重复领取。

```sql
BEGIN IMMEDIATE;

SELECT id
FROM outlook_emails
WHERE status = 'new'
ORDER BY id ASC
LIMIT 1;

UPDATE outlook_emails
SET status = 'leased',
    leased_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP
WHERE id = ?;

COMMIT;
```

实际实现应在事务内完成 `SELECT` 和 `UPDATE`。

### 6.9 成功事务

```sql
BEGIN IMMEDIATE;

INSERT INTO plus_accounts (
  email,
  password,
  client_id,
  refresh_token,
  gpt_password,
  session_json,
  import_target,
  roxy_dir_id,
  roxy_exit_ip
) VALUES (?, ?, ?, ?, 'myPASSword!', ?, ?, ?, ?)
ON CONFLICT(email) DO UPDATE SET
  password = excluded.password,
  client_id = excluded.client_id,
  refresh_token = excluded.refresh_token,
  gpt_password = excluded.gpt_password,
  session_json = excluded.session_json,
  import_target = excluded.import_target,
  roxy_dir_id = excluded.roxy_dir_id,
  roxy_exit_ip = excluded.roxy_exit_ip;

UPDATE outlook_emails
SET status = 'plus_done',
    updated_at = CURRENT_TIMESTAMP,
    last_error = ''
WHERE id = ?;

COMMIT;
```

### 6.10 失败处理

失败分两类。

可重试失败：

- 页面加载超时。
- 临时网络失败。
- 验证码暂未到达。
- PayPal/Stripe 临时异常。
- Roxy CDP 连接断开。

处理：

```text
outlook_emails.status = 'new'
last_error = 错误摘要
```

不可重试失败：

- 邮箱已被 OpenAI 使用且无法恢复。
- 邮箱凭据无效。
- OpenAI 明确拒绝注册。
- PayPal 明确拒绝该账号。
- 达到最大尝试次数。

处理：

```text
outlook_emails.status = 'failed'
last_error = 错误摘要
```

## 7. 验证码 Provider

### 7.1 Provider 分层

验证码分两类处理。

第一类是 Outlook 邮箱验证码：

- 用于 OpenAI 注册验证码。
- 用于 OpenAI 登录验证码。
- 直接对接 `MS_OAuth2API_Next`。
- 使用邮箱表中的 `email/client_id/refresh_token`。
- 查询 `INBOX` 和 `Junk`。
- 从邮件 `subject/text/html` 里提取 6 位验证码。
- 按 OpenAI 邮件规则过滤发件人、标题、关键词和时间窗口。

第二类是 PayPal 手机号短信验证码：

- 用于 PayPal 验证码。
- 用于 Hosted Checkout/OpenAI/Stripe 弹窗验证码。
- 直接使用 `paypal_phone_pool.sms_url`。
- `sms_url` 来自 `/Users/leviviya/Documents/gpt/playwright/phone.txt`。
- 解析逻辑参考 `/Users/leviviya/Documents/gpt/playwright/modules/phone_store.py` 和增强版 `/Users/leviviya/Documents/gpt/playwright/modules/oauth_phone_store.py`。
- 接口返回 `no`、`wait`、`err` 时继续等待或记录错误。
- 接口返回 `yes|短信内容` 时，从短信内容中提取验证码。

这样做的原因：

- OpenAI 邮箱验证码可以直接用 Outlook 四字段读取邮件，稳定且和邮箱数据库天然绑定。
- PayPal/Hosted Checkout 验证码和手机号一一绑定，直接走手机号池里的 `sms_url` 可以避免多窗口拿错验证码。
- 如果以后希望统一所有验证码，也可以在自建服务外面加一个 runner 专用 `/code` 聚合接口。

### 7.2 MS_OAuth2API_Next 邮箱验证码配置

全局配置：

```json
{
  "verification": {
    "openaiEmailProvider": "ms-oauth2api-next",
    "msOauth2ApiBaseUrl": "https://your-ms-oauth2api-next.example.com",
    "mailboxes": ["INBOX", "Junk"],
    "mailPollIntervalMs": 3000,
    "mailMaxAttempts": 60,
    "mailFetchMode": "mail_new",
    "mailProxyMode": "none",
    "mailProxyFromRoxy": false,
    "paypalSmsProvider": "phone-pool-sms-url",
    "paypalSmsInitialDelayMs": 10000,
    "paypalSmsPollIntervalMs": 3000,
    "paypalSmsMaxAttempts": 60
  }
}
```

`MS_OAuth2API_Next` 官方接口：

```text
GET/POST /api/mail_new
GET/POST /api/mail_all
GET/POST /api/process-mailbox
GET/POST /api/test-proxy
```

runner 主要使用：

```text
/api/mail_new
/api/mail_all
```

请求参数：

```text
refresh_token  来自 outlook_emails.refresh_token
client_id      来自 outlook_emails.client_id
email          来自 outlook_emails.email
mailbox        INBOX 或 Junk
socks5         可选
http           可选
```

默认优先使用 `GET /api/mail_new`：

```text
GET {baseUrl}/api/mail_new?email={email}&client_id={client_id}&refresh_token={refresh_token}&mailbox=INBOX
```

如果 `mail_new` 未找到有效验证码，可以按配置降级或补查：

```text
GET {baseUrl}/api/mail_all?...&mailbox=INBOX
GET {baseUrl}/api/mail_new?...&mailbox=Junk
GET {baseUrl}/api/mail_all?...&mailbox=Junk
```

### 7.3 Outlook 邮件验证码提取规则

`MS_OAuth2API_Next` 返回格式外层通常为：

```json
{
  "code": "200",
  "data": [
    {
      "id": "...",
      "send": "...",
      "subject": "...",
      "text": "...",
      "html": "...",
      "date": "..."
    }
  ]
}
```

runner 从每封邮件的以下字段提取验证码：

```text
subject
text
html
```

OpenAI 邮件验证码匹配规则沿用插件中的 `flows/openai/mail-rules.js` 思路：

```text
(?:chatgpt\s+log-?in\s+code|enter\s+this\s+code)[^0-9]{0,24}(\d{6})
your\s+chatgpt\s+code\s+is\s+(\d{6})
(?:verification\s+code|temporary\s+verification\s+code|your\s+chatgpt\s+code|code(?:\s+is)?)[^0-9]{0,16}(\d{6})
```

发件人、标题和关键词过滤：

```text
sender: openai, noreply, verify, auth, chatgpt, duckduckgo, forward
subject: verify, verification, code, 验证码, confirm, login
keyword: openai, chatgpt, verify, verification, confirm, 验证码, 代码
```

时间过滤：

- 每个验证码步骤开始时记录 `stepStartedAt`。
- 默认只接受 `date >= stepStartedAt - lookbackMs` 的邮件。
- `lookbackMs` 默认 10 分钟，可配置。
- 如果页面请求重新发送验证码，则更新时间窗口。

旧验证码排除：

- 如果页面拒绝某个验证码，把它加入 `excludeCodes`。
- 后续轮询中如果仍看到相同验证码，继续等待新邮件。

### 7.4 PayPal 手机短信验证码配置

用于 PayPal、Hosted Checkout 和其他非 Outlook 邮箱验证码。第一版不单独配置额外取码 URL，而是使用当前 run 租到的手机号记录里的 `sms_url`。

配置：

```json
{
  "verification": {
    "paypalSmsProvider": "phone-pool-sms-url",
    "paypalSmsInitialDelayMs": 10000,
    "paypalSmsPollIntervalMs": 3000,
    "paypalSmsMaxAttempts": 60,
    "paypalSmsRequestTimeoutMs": 15000
  }
}
```

手机号池导入文件：

```text
/Users/leviviya/Documents/gpt/playwright/phone.txt
```

导入格式：

```text
+15722337281|http://a.62-us.com/api/get_sms?key=a7ff3404e9b36b7726f90d30cf8757a9
```

### 7.5 PayPal 手机短信请求方式

PayPal 页面触发发送短信验证码后，不要马上请求 `sms_url`。必须先等待 10 秒，再开始轮询。

原因：

- 接码接口通常在短信入库前会返回 `no`。
- 立即高频请求会浪费请求次数，也容易拿到旧状态。
- 固定等待 10 秒后再轮询，更接近现有项目的稳定运行方式。

请求流程：

```text
1. 页面点击发送 PayPal/Hosted Checkout 短信验证码
2. sleep(paypalPhone.initialSmsDelayMs)，默认 10000ms
3. 开始 GET paypal_phone_pool.sms_url
4. 如果返回 no/wait/err，按 pollIntervalMs 继续轮询
5. 如果返回 yes|短信内容，从内容提取验证码
```

每次轮询请求：

```text
GET {paypal_phone_pool.sms_url}
```

为了避免接口缓存，可以在实现里可选追加 cache buster：

```text
GET {sms_url}&t={Date.now()}
```

请求头：

```text
Accept: application/json,text/plain,*/*
```

### 7.6 PayPal 手机短信解析规则

基础解析参考 `modules/phone_store.py`：

```text
no                  尚未收到验证码，继续轮询
yes|短信内容         已收到短信，从短信内容提取验证码
```

增强解析参考 `modules/oauth_phone_store.py`：

```text
空响应              按 no 处理
"yes|短信内容"       如果响应被 JSON 字符串包裹，先反序列化
yes丨短信内容        兼容中文竖线
yes短信内容          没有分隔符时取 yes 后面的内容
wait...             按 no 处理
err...              按 no 处理，并记录 last_response
unknown             记录响应并继续等待
```

验证码提取规则：

```text
优先匹配独立 6 位数字：(?<!\d)(\d{6})(?!\d)
如果 PayPal 实际返回 4-8 位，可启用兼容匹配：(?<!\d)(\d{4,8})(?!\d)
```

旧验证码排除：

- 如果页面提示验证码错误，记录 `ignoreCode`。
- 后续轮询如果再次拿到同一个 code，视为 stale code，继续等待。
- 收到不同的新 code 后再提交。

### 7.7 可选新协议建议

如果后续愿意在 `MS_OAuth2API_Next` 外面加一个轻量 wrapper，推荐提供 runner 专用接口：

```text
GET /api/code/openai?email={email}&purpose=signup&after={timestamp}
GET /api/code/openai?email={email}&purpose=login&after={timestamp}
GET /api/code/paypal?email={email}&phone={paypalPhone}&after={timestamp}
```

推荐响应：

```json
{
  "ok": true,
  "code": "123456",
  "source": "INBOX",
  "messageId": "...",
  "receivedAt": "2026-05-27T00:00:00.000Z"
}
```

无验证码时：

```json
{
  "ok": false,
  "code": "",
  "retryAfterMs": 3000,
  "message": "no code yet"
}
```

这个新协议不是第一版必须项。第一版直接对接 `MS_OAuth2API_Next` 现有接口即可。

### 7.8 旧验证码排除

如果页面提示验证码错误，provider 会把该验证码加入 `excludeCodes`。

下一次轮询时：

- 如果接口仍返回旧验证码，继续等待。
- 如果返回新验证码，再提交。

## 8. 配置文件设计

### 8.1 config.json

```json
{
  "database": {
    "path": "data/paypal_plus_runner.db"
  },
  "runner": {
    "gptPassword": "myPASSword!",
    "maxAttemptsPerEmail": 5,
    "cleanupBrowserDataBeforeEachAccount": true,
    "screenshotOnFailure": true,
    "htmlSnapshotOnFailure": true
  },
  "flow": {
    "plusModeEnabled": true,
    "plusPaymentMethod": "paypal",
    "accountAccessStrategyUi": "session_json",
    "sessionJsonTarget": "sub2api",
    "plusAccountAccessStrategy": "sub2api_codex_session"
  },
  "checkoutConversion": {
    "enabled": true,
    "provider": "local_jp_proxy",
    "paymentMethod": "paypal",
    "country": "US",
    "currency": "USD",
    "processorEntity": "openai_llc",
    "useFreeTrialPromo": true,
    "alreadyPaidIsSuccess": true,
    "maxAttempts": 3,
    "cloud": {
      "apiUrl": "https://your-checkout-converter.example.com/api/checkout",
      "apiKey": "",
      "timeoutMs": 45000
    },
    "localJpProxy": {
      "mode": "gost_chain",
      "runProbe": true,
      "requireJpExit": true,
      "probeUrl": "https://iplark.com/ipapi/public/ip",
      "requestTimeoutMs": 45000,
      "firstHopProxyUrl": "http://127.0.0.1:7890",
      "secondHopProxyUrl": "socks5://mqtz1176005-region-JP-asn-{ASN}-sid-{SID}-t-20:password@sg.cliproxy.io:443",
      "asnPools": {
        "JP": [
          "AS9605",
          "AS17676",
          "AS2516",
          "AS138384",
          "AS4713",
          "AS2518",
          "AS2527",
          "AS17511"
        ]
      }
    }
  },
  "roxy": {
    "api_base": "http://127.0.0.1:50000",
    "token": "",
    "workspace_id": 108438,
    "windowCount": 5,
    "api_rate_limit_per_min": 90,
    "headless": true,
    "open_args": [],
    "restore_focus_after_open": true,
    "restore_focus_app": "auto",
    "rotateProxyPerAccount": false,
    "rotateProxyEveryAccounts": 3,
    "rotateProxyOnFailure": true,
    "rotateProxyOnRiskErrors": true,
    "reuseWindowProfile": true,
    "reopenWindowOnProxyRotate": true,
    "closeWindowsOnExit": true,
    "deleteWindowsOnExit": false,
    "proxy": {
      "host": "us.cliproxy.io",
      "port": "3010",
      "password": "",
      "check_channel": "IPRust.io",
      "username_template": "mqtz1176005-region-US-asn-{ASN}-sid-{SID}-t-20",
      "asn_pools": {
        "US": [
          "AS7922",
          "AS20057",
          "AS20115",
          "AS22773",
          "AS7018",
          "AS21928",
          "AS6167",
          "AS5650"
        ],
        "JP": [
          "AS9605",
          "AS17676",
          "AS2516",
          "AS138384",
          "AS4713",
          "AS2518",
          "AS2527",
          "AS17511"
        ]
      },
      "proxy_method": "custom",
      "proxy_category": "SOCKS5",
      "protocol": "SOCKS5",
      "username": ""
    }
  },
  "billing": {
    "country": "US",
    "address": "303 UNAKA ST",
    "city": "CHATTANOOGA",
    "state": "TN",
    "postal_code": "37415"
  },
  "paypalPhone": {
    "leaseMinutes": 30,
    "maxUse": 5,
    "initialSmsDelayMs": 10000,
    "pollIntervalMs": 500,
    "pollTimeoutMs": 180000,
    "fillLocalUsNumber": true
  },
  "checkoutProfile": {
    "mode": "plugin-compatible",
    "addressProvider": "meiguodizhi",
    "addressEndpoint": "https://www.meiguodizhi.com/api/v1/dz",
    "hostedAddressPath": "/",
    "hostedAddressMethod": "address",
    "firstName": "James",
    "lastName": "Smith",
    "guestEmailDomain": "gmail.com",
    "cardMode": "generated-visa-luhn",
    "storeCardInDb": false,
    "fallbackAddress": {
      "street": "123 Main St",
      "city": "New York",
      "state": "New York",
      "zip": "10001",
      "countryCode": "US"
    },
    "billingAddress": {
      "preferSameAsHostedAddress": true,
      "paypalUsRandomUserFallback": true,
      "skipAutocompleteWhenDirectAddressAvailable": true
    }
  },
  "verification": {
    "openaiEmailProvider": "ms-oauth2api-next",
    "msOauth2ApiBaseUrl": "https://your-ms-oauth2api-next.example.com",
    "mailboxes": ["INBOX", "Junk"],
    "mailPollIntervalMs": 3000,
    "mailMaxAttempts": 60,
    "mailFetchMode": "mail_new",
    "mailLookbackMs": 600000,
    "paypalSmsProvider": "phone-pool-sms-url",
    "paypalSmsInitialDelayMs": 10000,
    "paypalSmsPollIntervalMs": 3000,
    "paypalSmsMaxAttempts": 60,
    "paypalSmsRequestTimeoutMs": 15000
  },
  "sub2api": {
    "baseUrl": "",
    "email": "",
    "password": "",
    "groupName": "codex"
  },
  "cpa": {
    "baseUrl": "",
    "authorizationBearer": ""
  },
  "output": {
    "dir": "output"
  }
}
```

### 8.2 命令行参数

```bash
npm run start -- --config config.json --windows 10 --limit 100
```

参数：

```text
--config        配置文件路径
--db            覆盖 database.path
--windows       覆盖 roxy.windowCount
--limit         本次最多处理多少个邮箱
--headless      覆盖 roxy.headless=true
--headed        覆盖 roxy.headless=false
--no-delete     退出时不删除 Roxy 窗口
--dry-run       只检查配置、数据库和 Roxy API，不执行注册
```

## 9. 项目结构

建议生成：

```text
paypal-plus-runner/
  package.json
  README.md
  config.example.json
  PayPalPlusRunnerPlan.md
  src/
    cli.js
    config.js
    logger.js
    runner.js
    worker.js
    workflow.js
    db/
      connection.js
      schema.js
      outlook-store.js
      paypal-phone-store.js
      plus-store.js
      run-history-store.js
    roxy/
      client.js
      dynamic-window.js
      proxy-asn.js
      proxy-probe.js
      window-pool.js
    checkout-conversion/
      index.js
      cloud-provider.js
      local-jp-provider.js
      gost-chain.js
      checkout-api.js
      result-normalizer.js
    browser/
      connect-cdp.js
      cleanup.js
      inject.js
      page-utils.js
      chrome-shim.js
    providers/
      ms-oauth2api-next-mail.js
      http-code-url.js
      paypal-phone-code.js
      checkout-profile.js
      address-provider.js
      session-json.js
      sub2api.js
      cpa.js
    steps/
      open-chatgpt.js
      submit-signup-email.js
      fill-password.js
      fetch-signup-code.js
      fill-profile.js
      create-plus-checkout.js
      fill-plus-checkout.js
      paypal-approve.js
      plus-return-confirm.js
      session-json-import.js
    utils/
      retry.js
      sleep.js
      ids.js
      errors.js
      paths.js
  vendor/
    plugin/
      content/
        activation-utils.js
        utils.js
        operation-delay.js
        auth-page-recovery.js
        phone-country-utils.js
        phone-auth.js
        signup-page.js
        plus-checkout.js
        paypal-flow.js
      shared/
        source-registry.js
      data/
        step-definitions.js
  data/
    .gitkeep
  output/
    .gitkeep
```

## 10. 模块设计

### 10.1 `src/runner.js`

职责：

- 初始化数据库。
- 初始化 Roxy 窗口池。
- 启动 worker。
- 等待所有 worker 完成。
- 捕获退出信号并清理窗口。

### 10.2 `src/worker.js`

职责：

- 绑定一个 Roxy 窗口。
- 循环领取邮箱。
- 执行完整流程。
- 成功写 Plus 表。
- 失败分类处理。
- 按策略轮换代理。

伪代码：

```text
worker.start()
  openRoxyWindow()
  connectPlaywright()
  probeExitIp()

  while not stopped:
    account = leaseNextOutlookEmail()
    if no account:
      break

    if shouldRotateBeforeRun():
      rotateProxyAndReconnect()

    cleanupBrowserData()
    runWorkflow(account)

    if success:
      insertPlusAccount(account)
      markOutlookPlusDone(account)
      successCountOnCurrentProxy += 1
    else:
      markFailure(account)
      if riskError:
        rotateProxyAndReconnect()
```

### 10.3 `src/roxy/client.js`

Node 版 RoxyClient。

迁移现有 Python 能力：

- `listWorkspaces`
- `listWindows`
- `createWindow`
- `openWindow`
- `closeWindow`
- `deleteWindow`
- `modifyWindowProxy`
- `createAndOpen`
- `buildProxyInfo`
- `buildProxyUsername`
- `buildLocalWindowProxyUrl`

### 10.4 `src/roxy/window-pool.js`

职责：

- 根据窗口数创建窗口。
- 每个窗口维护：

```js
{
  workerId,
  dirId,
  ws,
  sid,
  asn,
  region,
  proxyUserName,
  localProxyUrl,
  exitIp,
  successCountOnCurrentProxy
}
```

### 10.5 `src/browser/chrome-shim.js`

插件脚本原本依赖：

```text
chrome.runtime.onMessage
chrome.runtime.sendMessage
chrome.storage
```

非插件环境需要提供轻量 shim。

目标：

- 让 `content/signup-page.js`、`content/plus-checkout.js`、`content/paypal-flow.js` 可以被注入页面。
- runner 可以通过 `page.evaluate` 调用等价命令。

实现策略：

- 优先提取和复用函数。
- 如果函数耦合 `chrome.runtime.onMessage`，则在页面里模拟 message dispatcher。

### 10.6 `src/checkout-conversion/index.js`

职责：

- 根据 `config.checkoutConversion.provider` 选择支付转换 provider。
- 对外提供统一方法 `createCheckout({ accessToken, runContext })`。
- 标准化返回 `preferredCheckoutUrl`、`hostedCheckoutUrl`、`checkoutSessionId`、`country`、`currency`。
- 统一处理 `alreadyPaid`。
- 记录 provider、出口 IP、出口地区、SID、ASN 到 run history。

### 10.7 `src/checkout-conversion/cloud-provider.js`

职责：

- 复刻插件云端支付转换客户端逻辑。
- 请求 `checkoutConversion.cloud.apiUrl`。
- 请求头支持 `X-API-Key`。
- 请求体包含 `accessToken`、`paymentMethod`、`country`、`currency`、`processorEntity`、`useFreeTrialPromo`。
- 解析 `preferredCheckoutUrl`、`hostedCheckoutUrl`、`chatgptCheckoutUrl`。
- 把 `User is already paid` 标准化为 `alreadyPaid=true`。

### 10.8 `src/checkout-conversion/local-jp-provider.js`

职责：

- 使用本地 JP 动态代理完成 checkout 创建。
- 复用 `/Users/leviviya/Documents/gpt/playwright/modules/pay_url.py` 的设计思想，但实现为 runner 内部模块。
- 生成 JP `SID` / `ASN`。
- 通过 `gost-chain` 启动临时链式代理，或直接渲染一个可用 JP 代理 URL。
- 使用 JP 出口请求 `https://chatgpt.com/backend-api/payments/checkout`。
- PayPal 模式使用 `US / USD` 和 hosted checkout。
- 返回与 cloud provider 一致的标准结果。
- 转换结束后清理 GOST 进程或临时代理资源。

注意：

- 该 provider 只影响 checkout 创建请求。
- 不切换 Roxy 浏览器主窗口代理。
- PayPal 后续页面自动化继续在当前 worker 的 Roxy 窗口里执行。

### 10.9 `src/checkout-conversion/gost-chain.js`

职责：

- 管理本地 GOST 链式代理生命周期。
- 按 `firstHopProxyUrl` 和 `secondHopProxyUrl` 启动本地临时代理端口。
- 将 `{SID}` 和 `{ASN}` 渲染到第二跳代理 URL。
- 提供 `proxyUrl` 给 `local-jp-provider`。
- 支持进程退出、超时和异常清理。

如果第一版不想引入 GOST，也可以先做直接 JP 代理模式：

```text
mode = direct_proxy_url
proxyUrl = 渲染后的 secondHopProxyUrl
```

但现有项目已经验证过 GOST 链路，优先按 GOST 方案设计。

### 10.10 `src/checkout-conversion/checkout-api.js`

职责：

- 封装 ChatGPT checkout API 请求。
- 构造插件同款 payload。
- 构造浏览器风格请求头。
- 支持代理参数。
- 识别 Cloudflare challenge、403、429、`User is already paid`。
- 输出原始响应摘要，供失败排查。

### 10.11 `src/checkout-conversion/result-normalizer.js`

职责：

- 统一 cloud 和 local provider 的结果结构。
- 选择 `preferredCheckoutUrl` 的优先级：

```text
preferredCheckoutUrl > hostedCheckoutUrl > convertedCheckoutUrl > chatgptCheckoutUrl > checkoutUrl
```

- 如果缺少可用 URL，抛出标准错误。
- 如果 already paid，返回 `alreadyPaid=true`。

### 10.12 `src/providers/ms-oauth2api-next-mail.js`

职责：

- 调用用户部署的 `MS_OAuth2API_Next`。
- 用 Outlook 邮箱四字段读取 `INBOX` / `Junk`。
- 支持 `/api/mail_new` 和 `/api/mail_all`。
- 解析返回邮件列表。
- 按 OpenAI 邮件规则提取注册/登录验证码。
- 支持时间窗口、旧验证码排除和轮询。

### 10.13 `src/providers/http-code-url.js`

职责：

- 解析 URL 模板。
- 调用泛用验证码 URL。
- 提取 6 位验证码。
- 支持轮询。
- 支持排除旧验证码。

### 10.14 `src/providers/checkout-profile.js`

职责：

- 复刻插件 PayPal/Hosted Checkout 资料生成方式。
- 从当前 run 租到的 `paypal_phone_pool` 记录读取手机号和 `sms_url`。
- 把手机号规范成 PayPal 页面可填写的 US 10 位本地号码。
- 调用 `address-provider` 获取 Hosted Checkout 地址。
- 生成 guest email、guest password、姓名、Visa 风格 Luhn 卡号、有效期、CVV。
- 返回统一的 `checkoutProfile` 对象给步骤 6、步骤 7 和 PayPal 自动化使用。
- 日志只记录 `cardLast4`，不把完整卡号写入数据库。

### 10.15 `src/providers/address-provider.js`

职责：

- 调用 `https://www.meiguodizhi.com/api/v1/dz` 获取地址。
- 支持 Hosted Checkout 的 `{ path: "/", method: "address" }`。
- 支持步骤 7 的国家地址刷新逻辑 `{ city, path, method: "refresh" }`。
- 把 `Address/Trans_Address/City/State_Full/State/Zip_Code` 规范化为 runner 内部地址结构。
- 接口失败或字段不完整时返回配置里的兜底地址。

### 10.16 `src/providers/session-json.js`

职责：

- 从 ChatGPT 页面读取当前 session。
- 返回 session JSON。
- 调用 `sub2api` 或 `cpa` provider。
- 或保存本地 JSON。

## 11. 并发控制

并发单位是 Roxy 窗口。

```text
windowCount = workerCount
```

每个 worker 独立浏览器窗口，但共享数据库。

数据库通过 `BEGIN IMMEDIATE` 保证任务领取互斥。

所有 worker 都可以同时：

- 浏览网页。
- 轮询验证码 API。
- 执行 PayPal 流程。

只有领取邮箱和写成功结果需要短事务锁。

## 12. 错误分类与代理轮换

### 12.1 风控类错误

命中后立即换代理：

```text
OpenAI 403/429
OpenAI signup blocked
ChatGPT auth risk page
PayPal security challenge
PayPal account limited
Stripe checkout blocked
captcha cannot bypass
network tunnel/proxy failure
proxy auth failed
checkout page repeated timeout
```

### 12.2 普通可重试错误

可重试但不一定立即换代理：

```text
验证码暂未返回
页面选择器短暂没出现
单次 CDP 消息超时
临时导航超时
```

### 12.3 不可重试错误

邮箱标记 failed：

```text
Outlook 邮箱格式错误
OpenAI 明确提示账号已存在且不能继续
邮箱验证码接口长期返回无效
邮箱达到最大尝试次数
PayPal 明确拒绝该账号
```

## 13. 输出与排错

每个 run 输出目录：

```text
output/
  {run_id}/
    state.json
    log.txt
    roxy-window.json
    screenshots/
      failure.png
    html/
      failure.html
```

`state.json` 包含：

```json
{
  "runId": "",
  "workerId": "",
  "email": "",
  "currentStep": "",
  "completedSteps": [],
  "roxy": {
    "dirId": "",
    "exitIp": "",
    "sid": "",
    "asn": ""
  },
  "error": ""
}
```

## 14. 导入邮箱

导入文件格式兼容现有项目：

```text
email----password----client_id----refresh_token
```

命令：

```bash
npm run import-outlook -- --db data/paypal_plus_runner.db --file mail.txt
```

行为：

- 忽略空行。
- 校验必须有 4 段。
- `email` 和 `refresh_token` 不能为空。
- 已存在邮箱则更新四字段。
- 新邮箱状态为 `new`。

## 15. 启动命令

初始化数据库：

```bash
npm run db:init -- --db data/paypal_plus_runner.db
```

导入邮箱：

```bash
npm run import-outlook -- --db data/paypal_plus_runner.db --file mail.txt
```

导入 PayPal 接码手机号：

```bash
npm run import-paypal-phones -- --db data/paypal_plus_runner.db --file phone.txt
```

启动 runner：

```bash
npm run start -- --config config.json --windows 5
```

指定处理数量：

```bash
npm run start -- --config config.json --windows 10 --limit 100
```

只做连通性检查：

```bash
npm run start -- --config config.json --dry-run
```

## 16. 实施阶段

### 阶段 1：项目骨架

交付：

- `package.json`
- CLI
- 配置加载
- logger
- output 目录结构

### 阶段 2：数据库

交付：

- SQLite schema
- 初始化命令
- 邮箱导入命令
- PayPal 手机号导入命令
- 邮箱领取事务
- PayPal 手机号领取租约事务
- Plus 写入事务
- run history

### 阶段 3：Roxy Node Client

交付：

- Node 版 RoxyClient
- 动态代理用户名渲染
- ASN 池选择
- 创建/打开/关闭/删除/修改代理
- 本地代理端口解析
- 出口 IP 探测

### 阶段 4：窗口池与 worker

交付：

- 可配置窗口数。
- 每窗口一个 worker。
- 共享数据库领取邮箱。
- 代理轮换策略。
- Ctrl+C 清理窗口。
- workflow 状态机骨架。
- step 返回 `done/skipped/retry/failed`。
- run history 记录跳过原因。

### 阶段 5：Playwright CDP 接入

交付：

- 连接 Roxy `ws`。
- 获取页面。
- 清理 cookies/storage。
- 截图和 HTML 快照。

### 阶段 6：支付转换 Provider

交付：

- `checkoutConversion.provider` 配置。
- `cloud` provider，兼容插件 `services/checkout-converter` 协议。
- `local_jp_proxy` provider，使用本地 JP 动态代理创建 checkout URL。
- JP `SID` / `ASN` 渲染。
- JP 出口探测和 `requireJpExit` 校验。
- `User is already paid` 标准化处理。
- 支付转换结果结构统一。
- 只让 checkout 创建请求走 JP，不切换 PayPal 浏览器主窗口代理。

### 阶段 7：验证码 Provider

交付：

- `MS_OAuth2API_Next` 邮件验证码 provider。
- `/api/mail_new` / `/api/mail_all` 调用。
- OpenAI 邮件规则匹配。
- PayPal 手机 `phone-pool-sms-url` provider。
- `/Users/leviviya/Documents/gpt/playwright/phone.txt` 导入格式支持。
- `sms_url` 返回 `no` / `yes|短信内容` 解析。
- 6 位验证码提取。
- 触发 PayPal 短信后先等待 10 秒再轮询。
- 轮询与旧验证码排除。
- PayPal 手机号绑定 `sms_url` 取码。

### 阶段 8：PayPal/Hosted Checkout 资料生成

交付：

- `checkout-profile` provider。
- `meiguodizhi` 地址 provider。
- Hosted Checkout 地址字段映射。
- guest email/password 生成。
- `James Smith` 默认姓名，预留插件姓名池扩展。
- Visa 风格 Luhn 卡资料生成。
- PayPal 手机号规范化为 US 10 位本地号码。
- 配置化兜底地址。
- 日志只记录 `cardLast4`，不持久化完整卡号。

### 阶段 9：注册步骤 1-5

交付：

- 打开 ChatGPT。
- 输入邮箱。
- 固定 GPT 密码 `myPASSword!`。
- 获取注册验证码。
- 填写姓名生日。

### 阶段 10：Plus Checkout 步骤 6-7

交付：

- 创建 Plus Checkout。
- 读取 ChatGPT `accessToken`。
- 按 provider 创建 hosted checkout URL。
- 创建并传递 `checkoutProfile`。
- Hosted Checkout 验证码支持。
- Hosted Checkout guest form 填写 email、phone、card、password、姓名、地址。
- 填写账单。
- 账单地址使用 `checkoutProfile.address` 或插件兼容地址 seed。
- 提交 PayPal 支付链路。
- 支持 `alreadyPaid`、direct success、非免费试用、billing 页面缺失等跳过/终止分支。

### 阶段 11：PayPal 授权步骤 8-9

交付：

- PayPal 页面自动化。
- PayPal 验证码 API。
- 授权完成。
- 回跳确认。
- Plus 成功判断。
- 按 `pay_login/guest_checkout/verification/review_consent/approval/generic_error` stage 动态处理。
- 未出现的 PayPal 页面必须能跳过。

### 阶段 12：SESSION JSON 导入

交付：

- 读取 ChatGPT session。
- SUB2API 导入。
- CPA 导入。
- 本地 JSON 导出。
- 写入 `plus_accounts`。

### 阶段 13：稳定性与恢复

交付：

- 错误分类。
- 失败重试。
- 风控触发代理轮换。
- worker 崩溃后释放 leased 邮箱。
- run history 排查。

### 阶段 14：单窗口与多窗口验证

验证顺序：

1. `--windows 1 --limit 1`
2. `--windows 1 --limit 3`
3. `--windows 2 --limit 6`
4. `--windows 5 --limit 20`
5. 根据机器资源和 Roxy 限制提高窗口数。

## 17. 风险与注意事项

### 17.1 页面变化风险

OpenAI、Stripe、PayPal 页面可能改版。

应对：

- 尽量复用插件原 content script。
- 每次失败保存截图和 HTML。
- 步骤选择器集中封装。

### 17.2 Roxy 代理切换风险

修改代理后如果不重开窗口，连接可能不干净。

策略：

- 默认代理轮换时关闭并重开同一个窗口。
- 重新连接 CDP。
- 重新探测出口 IP。

### 17.3 数据库并发风险

SQLite 多写并发需要控制。

策略：

- 开启 WAL。
- 领取和写入使用短事务。
- worker 长时间运行流程时不持有事务。

### 17.4 SESSION JSON 目标差异

不同导入目标需要不同 API。

策略：

- `sessionJsonTarget` 配置化。
- `sub2api`、`cpa`、`local-cpa-json-no-rt` 分 provider。

## 18. 最终交付标准

项目完成后，应满足：

- 可以通过命令指定 Roxy 窗口数。
- 可以从数据库自动领取 Outlook 邮箱。
- 可以多个 Roxy 窗口并发跑完整 PayPal Plus。
- 可以按折中策略轮换动态代理。
- 可以在 `cloud` 云端支付转换和 `local_jp_proxy` 本地 JP 支付转换之间自由切换。
- 本地 JP 支付转换可以使用动态代理 JP 出口，并且只作用于 checkout 创建请求。
- 可以原生对接用户已部署的 `MS_OAuth2API_Next` 获取 OpenAI 邮箱验证码。
- 可以使用 `phone.txt` 导入的 PayPal 手机 `sms_url` 获取 PayPal/Hosted Checkout 验证码，并在触发短信后先等待 10 秒再解析。
- 可以从 `paypal_phone_pool` 原子租用 PayPal 接码手机号，保证多窗口不重复使用。
- 可以按插件方法生成 PayPal/Hosted Checkout 填写资料，包括 `meiguodizhi` 地址、guest profile、手机号、Visa 风格卡资料和兜底地址。
- 可以使用 `SESSION JSON导入`。
- 成功 Plus 邮箱写入 `plus_accounts`，并包含完整四字段。
- GPT 密码统一为 `myPASSword!`。
- 流程按页面状态机运行，可以跳过未出现或已完成的页面，不依赖固定线性页面顺序。
- 失败有截图、HTML、日志和数据库错误原因。

最终命令示例：

```bash
npm run start -- --config config.json --windows 5 --limit 50
```
