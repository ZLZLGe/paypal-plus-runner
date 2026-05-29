# 实现状态

## 已完成

- 已建立项目骨架和 CLI。
- 已建立 SQLite schema，包含 `outlook_emails`、`plus_accounts`、`paypal_phone_pool`、`openai_phone_activations`、`run_events` 和 `run_history`。
- 已实现 Outlook 邮箱导入，格式为 `email----password----client_id----refresh_token`。
- 已实现 PayPal 手机号导入，兼容 `/Users/leviviya/Documents/gpt/playwright/phone.txt` 中的 `+1XXXXXXXXXX|sms_url` 和 `+1XXXXXXXXXX----sms_url`。
- 已实现 PayPal 手机号租用和释放，使用 SQLite `BEGIN IMMEDIATE` 保证并发安全。
- 已实现 PayPal SMS 响应解析，支持 `no` 和 `yes|message`。
- 已支持触发 PayPal SMS 后先等待 10 秒再开始轮询。
- 已实现兼容原插件行为的 checkout profile 生成：
  - 随机 guest email/password
  - 默认姓名 `James Smith`
  - PayPal 本地 10 位手机号
  - `meiguodizhi` 地址或 fallback 地址
  - 生成符合 Luhn 校验的 Visa-like 卡号
- 已实现 checkout conversion provider 接口：
  - 兼容插件服务的 cloud provider
  - 本地 JP provider，支持 `curl --proxy`
  - `direct_proxy_url` 和临时 `gost_chain` 两种模式
  - JP 出口探测和严格 JP 校验
  - Stripe hosted checkout init fallback
- 已实现 Roxy 多窗口运行时：
  - 创建、打开、恢复 Roxy 窗口
  - 通过 Playwright CDP 连接窗口
  - 可选出口 IP 探测
  - 退出时关闭或删除窗口
  - 按账号数量轮换代理
- 已实现带 dry-run 安全保护的 workflow 状态机。
- 已实现 `sms_oauth` workflow 分支基础链路：
  - 先手机号注册的步骤顺序
  - OAuth 登录前先从 CPA 获取 OAuth URL
  - 捕获 localhost callback 后上传到 CPA
  - 保存 callback 摘要 JSON
  - 每个步骤和每次页面观察都会写入 `run_events`
- 已实现 ChatGPT 注册步骤桥接：
  - 注入原插件 `content/signup-page.js` 依赖
  - Step 2 `submit-signup-email` 使用精确 ChatGPT/OpenAI auth selector，并拒绝第三方 OAuth detour
  - Step 3 `fill-password` 通过 `EXECUTE_NODE` 执行
  - Step 4 通过 MS_OAuth2API_Next 获取 Outlook 验证码，并用 `FILL_CODE` 提交
  - Step 5 `fill-profile` 通过 `EXECUTE_NODE` 执行
- 已实现 Stripe hosted checkout 强制策略：
  - 默认要求 `https://checkout.stripe.com/c/pay/...` 长链接
  - 要求 Stripe hosted URL 时拒绝短 `https://chatgpt.com/checkout/...` 链接
  - 当 checkout 页面显示非零 due-today 金额时，支持重新生成 hosted URL
- 已实现 PayPal Hosted Checkout 自动化框架：
  - 注入原插件 `content/utils.js`、`content/operation-delay.js` 和 `content/paypal-flow.js`
  - 支持 PayPal 阶段 `pay_login`、`guest_checkout`、`verification`、`review_consent`、`generic_error`
  - 使用 `paypal_phone_pool.sms_url` 获取 PayPal SMS，并在首次轮询前等待 10 秒
- 已实现 PayPal 风控检测，覆盖 `paypal.com/agreements/approve` 下的 DataDome/risk-block 页面。
- 已实现从 ChatGPT `/api/auth/session` 提取 session JSON，并带 storage fallback。
- 已在保存 CPA JSON 前校验 Plus session。
- 已支持可选 SUB2API session JSON 导入。
- 已实现 CPA OAuth 管理接口 provider：
  - `GET /v0/management/codex-auth-url`
  - `POST /v0/management/oauth-callback`
  - callback `state` 校验
  - 从配置读取 bearer/header，且不写入日志
- 已实现本地 `Runner Console` 监控页：
  - 命令：`node src/cli.js ui`
  - summary、runs、resources、artifacts API
  - 基于 `run_events` 的 SSE stream
  - 静态 dashboard 展示窗口、账号、步骤、CPA 状态、artifact 和 callback 摘要路径
- 已实现 PayPal 手机号双格式导入和租用唯一性测试。
- 失败时会写入 artifact 到 `output/<runId>/`，包含 `failure.json`、截图和 HTML snapshot。
- 已实现 CLI 诊断命令：
  - `db:stats`
  - `phones:list`
  - `checkout:probe`
  - `roxy:probe`
  - `ui`

## 尚未完成

- 新增的 `sms_oauth` 分支还没有针对真实 OpenAI 手机号注册/OAuth 页面做完整 E2E 验证。
- OpenAI SMS provider 当前先支持本地文件或手动 `phone/smsUrl`，还没有完整的 activation lease/release 生命周期。
- 对原插件脚本未覆盖的页面变体，还需要继续补恢复逻辑。

## 当前真实验证状态

现有邮箱优先流程已经跑过真实 Roxy/ChatGPT/Stripe/PayPal E2E，能推进到账号注册、Outlook 验证、Stripe hosted 长链接生成和 PayPal handoff。最近的 2026-05-28 单账号运行验证了精确 ChatGPT 邮箱 selector、`checkout.stripe.com/c/pay/...` 长链接，以及 100% one-month free-trial Stripe discount。

当前邮箱优先流程的真实 blocker 仍是 PayPal 在 `www.paypal.com/agreements/approve` 上的 DataDome/risk block。runner 会把它识别为 `PAYPAL_RISK_BLOCKED`，按可重试失败处理，不会保存 CPA JSON，也不会把账号标记为成功。

新的 `sms_oauth` 分支已通过本地语法、单元测试和 UI API 检查，但还需要执行真实 E2E 验证。
