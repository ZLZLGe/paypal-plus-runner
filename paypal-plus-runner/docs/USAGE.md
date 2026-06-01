# PayPal Plus Roxy Runner 使用文档

这份文档用于把项目交给别人时快速交接。项目的核心能力是：通过 Roxy 多窗口浏览器、SQLite 资源租赁、HeroSMS/OpenAI 手机号、PayPal 日区手机号、Outlook 辅助邮箱和 CPA OAuth 接口，自动完成 ChatGPT 手机号注册、Plus 支付、辅助邮箱绑定、CPA callback 上传。

## 1. 项目目录

```text
paypal-plus-runner/
├── src/                  # runner、workflow、数据库、provider、step 实现
├── vendor/plugin/         # 复用的浏览器 content script
├── test/                 # 单元/流程测试
├── docs/                 # 项目文档
├── data/                 # SQLite 数据库和本地数据文件
├── output/               # 失败截图、HTML、failure.json
├── callback-json/         # CPA callback 上传摘要
├── cpa-json/              # CPA 本地 JSON 输出
├── config.example.json    # 配置模板，不含真实密钥
└── config.local.json      # 本机真实配置，默认不提交
```

不要把 `config.local.json`、`data/*.db`、`output/`、`callback-json/`、`cpa-json/` 里的真实数据交给不可信的人。这些文件通常包含邮箱 token、手机号、callback code、代理信息或账号数据。

## 2. 环境要求

- Node.js `>= 24`
- npm
- RoxyBrowser，并确保 Roxy API 可访问，例如 `http://127.0.0.1:50000`
- 可用的代理配置，Roxy 出口建议为 JP
- HeroSMS API Key，用于购买 OpenAI 注册手机号
- PayPal 日区手机号池，用于 PayPal checkout 验证
- Outlook OAuth2 邮箱池，用于 OpenAI 辅助邮箱绑定
- CPA 服务，需提供 OAuth URL 获取和 callback 上传接口
- 如果使用本地 JP checkout 转换：需要 Python 虚拟环境和 `curl_cffi`

首次安装：

```bash
cd /Users/leviviya/Desktop/重构插件/paypal-plus-runner
npm install
```

如果使用 `checkoutConversion.localJpProxy.checkoutTransport = "curl_cffi"`，还要准备 Python 依赖：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.local-checkout.txt
```

## 3. 配置文件

复制模板：

```bash
cp config.example.json config.local.json
```

至少需要检查这些配置：

- `database.path`：SQLite 数据库路径，默认 `data/paypal_plus_runner.db`
- `flow.plusAccountAccessStrategy`：完整手机号 OAuth 流程使用 `sms_oauth`
- `runner.gptPassword`：注册 GPT 账号时使用的统一密码
- `roxy.api_base`、`roxy.token`、`roxy.workspace_id`：Roxy API 配置
- `roxy.proxy`：Roxy 代理模板、密码、ASN 池
- `checkoutConversion.localJpProxy.firstHopProxyUrl`：第一跳代理
- `checkoutConversion.localJpProxy.secondHopProxyUrl`：第二跳 JP 代理模板
- `openaiPhone.enabled`：手机号注册流程需要设为 `true`
- `openaiPhone.provider`：HeroSMS 模式设为 `hero-sms`
- `openaiPhone.heroSmsApiKey`：HeroSMS API Key
- `paypalPhone.countryCodes`：PayPal 接码国家，通常为 `["JP"]`
- `verification.msOauth2ApiBaseUrl`：Outlook 邮件验证码 API
- `cpa.baseUrl`：CPA 服务地址，例如 `http://127.0.0.1:8317`
- `cpa.authorizationBearer`：CPA 接口授权 token，如服务不需要可留空

注意：DB-backed 流程不会再复用 `data/openai-phone-activation.json`。没有可复用 GPT 手机号账号时，会直接向 HeroSMS 购买新号。

## 4. 初始化数据库

```bash
npm run db:init -- --config config.local.json
```

查看资源状态：

```bash
npm run db:stats -- --config config.local.json
```

## 5. 导入资源

### 5.1 导入 Outlook 邮箱

邮箱文件每行格式：

```text
email----password----client_id----refresh_token
```

导入：

```bash
npm run import-outlook -- --config config.local.json --file outlook.txt
```

如果需要清空旧邮箱池再导入，先备份数据库，然后清空 `outlook_emails` 表再导入。不要直接删除已经交付中的生产 DB，除非明确知道会丢失所有邮箱租赁和绑定状态。

### 5.2 导入 PayPal 手机号

手机号文件支持两种格式：

```text
+817012345678|https://sms-api.example.com/get_sms?key=...
+817012345678----https://sms-api.example.com/get_sms?key=...
```

导入：

```bash
npm run import-paypal-phones -- --config config.local.json --file paypal-phones.txt
```

查看 PayPal 手机池：

```bash
npm run phones:list -- --config config.local.json --limit 20
```

## 6. 启动前检查

检查 CPA 服务：

```bash
curl -fsS http://127.0.0.1:8317/healthz
```

检查 Roxy：

```bash
npm run roxy:probe -- --config config.local.json
```

检查 JP checkout 转换：

```bash
npm run checkout:probe -- --config config.local.json
```

语法和测试：

```bash
npm run check:syntax
npm test
```

### 6.1 前端监控 UI（可选）

前端监控 UI 是一个本地 Node 服务，用来查看 SQLite 里的运行记录、窗口状态、资源池统计和 run events。它只负责监控，不会启动 E2E，也不会占用 Roxy 窗口。

在 VSCode 里开一个终端启动监控：

```bash
cd /Users/leviviya/Desktop/重构插件/paypal-plus-runner
npm run ui -- --config config.local.json
```

启动后打开：

```text
http://127.0.0.1:8787
```

如果要一边监控一边跑流程，再开第二个终端执行 E2E：

```bash
node src/cli.js start --config config.local.json --windows 1 --limit 3
```

UI 默认读取 `config.local.json` 里的 `database.path`，也可以临时指定 DB：

```bash
npm run ui -- --config config.local.json --db data/paypal_plus_runner.db
```

如果 `8787` 端口被占用，修改 `config.local.json` 里的 `ui.port` 后重新启动。启动 UI 不需要激活 Python 虚拟环境；只有运行 checkout 转换并使用 `curl_cffi` 时才可能需要 `.venv`。

## 7. 运行 E2E

单窗口跑 1 个账号：

```bash
node src/cli.js start --config config.local.json --windows 1 --limit 1
```

多窗口并发：

```bash
node src/cli.js start --config config.local.json --windows 3 --limit 6
```

Dry run：

```bash
npm run dry-run -- --config config.local.json --windows 1 --limit 1
```

常用参数：

- `--config config.local.json`：指定配置
- `--windows 3`：启动 3 个 Roxy 窗口并发
- `--limit 6`：总共跑 6 个 run
- `--headed`：显示浏览器窗口
- `--headless`：无头模式
- `--db data/xxx.db`：临时覆盖数据库路径

## 8. 当前手机号账号池流程

主表是 `gpt_phone_accounts`，一个手机号 GPT 账号只对应一行。

生命周期：

- `signup_pending`：刚购买手机号，注册还没完成
- `registered`：GPT 注册完成，但还不是 Plus
- `plus_done`：已经 Plus，等待 CPA OAuth/邮箱绑定/上传
- `email_bound`：已经绑定辅助邮箱，等待 CPA 上传
- `cpa_done`：CPA 上传完成，普通流程不再租用
- `hold_no_sms_access`：复用账号时遇到手机号 OTP，但没有可用原手机号接码能力
- `disabled`：不可用账号

租赁优先级：

```text
email_bound > plus_done > registered
```

如果没有可租的 `registered / plus_done / email_bound`，runner 会购买新的 HeroSMS/OpenAI 手机号并从注册开始跑。`cpa_done` 和 `disabled` 不会被普通流程租用。

不同阶段会跳过不同步骤：

- `signup_pending` 或无账号：注册手机号、开 Plus、CPA OAuth、绑定邮箱、上传 CPA
- `registered`：手机号登录、开 Plus、CPA OAuth、绑定邮箱、上传 CPA
- `plus_done`：跳过 Plus 支付，直接进入 `fetch-cpa-oauth-url`
- `email_bound`：直接进入 CPA OAuth，优先复用已绑定邮箱
- `cpa_done`：不会再被租用

PayPal 日区手机号只会在进入 `plus-checkout-billing` 前租用；已 Plus 账号不会占用 PayPal 手机池。Outlook 邮箱只会在 OAuth 需要 `bind-email` 时租用。

## 9. 数据库表速览

- `gpt_phone_accounts`：GPT 手机号账号主表，记录注册手机号、密码、生命周期、绑定邮箱、CPA 状态
- `openai_phone_activations`：HeroSMS/OpenAI 注册手机号 activation 记录
- `outlook_emails`：Outlook 辅助邮箱池，支持租赁、绑定、失败释放
- `paypal_phone_pool`：PayPal checkout 用的日区手机号池
- `paypal_phone_sms_codes`：PayPal checkout 已见过的短信验证码，用于过滤旧码
- `plus_accounts`：兼容/导出表，记录已 Plus 账号和 CPA 结果
- `run_history`：每次 run 的状态、步骤、错误、资源 id
- `run_events`：更细的运行事件和页面观测

常用排查 SQL：

```bash
sqlite3 data/paypal_plus_runner.db \
  "SELECT id, signup_phone_number, lifecycle_status, lease_status, bound_email, cpa_upload_status FROM gpt_phone_accounts ORDER BY id;"

sqlite3 data/paypal_plus_runner.db \
  "SELECT status, COUNT(*) FROM outlook_emails GROUP BY status ORDER BY status;"

sqlite3 data/paypal_plus_runner.db \
  "SELECT status, COUNT(*) FROM paypal_phone_pool GROUP BY status ORDER BY status;"

sqlite3 data/paypal_plus_runner.db \
  "SELECT run_id, status, current_step, error FROM run_history ORDER BY id DESC LIMIT 10;"
```

## 10. 失败产物和排查

失败时会写入：

```text
output/<runId>/
├── failure.json
├── <step>.png
└── <step>.html
```

优先看：

- `failure.json`：错误、当前 URL、步骤、runId、资源 id
- `<step>.png`：页面实际卡在哪里
- `run_history.error`：数据库里的错误摘要

常见情况：

- `no_outlook_emails`：邮箱池没有 `new` 邮箱，或都超过最大尝试次数
- `paypal_phone_pool has no available phone`：PayPal 手机池没有可用号码
- `hold_no_sms_access`：复用 GPT 手机号账号时遇到手机号 OTP，但没有该手机号 activation
- `chrome-error://chromewebdata/` 出现在 OAuth callback 后：通常是本地 callback 端口无服务，但 runner 会从浏览器导航历史里提取 `localhost` callback
- PayPal risk/DataDome：会按配置重试、换窗口或旋转代理
- Plus 成功但 CPA 失败：账号会保留为 `plus_done` 或 `email_bound`，下次可继续

## 11. 交付给别人前的清理清单

建议保留：

- `src/`
- `vendor/`
- `test/`
- `docs/`
- `scripts/`
- `README.md`
- `package.json`
- `package-lock.json`
- `config.example.json`
- `.gitignore`

不要直接交付真实敏感文件，除非对方就是接手生产环境：

- `config.local.json`
- `data/paypal_plus_runner.db`
- `data/*.db.backup*`
- `callback-json/`
- `cpa-json/`
- `output/`
- `logs/`
- 各类邮箱/手机号原始导入文件

如果对方要接手生产环境，可以单独安全传输：

- `config.local.json`
- 当前 SQLite DB
- Outlook 邮箱池
- PayPal 手机池
- HeroSMS、CPA、Roxy、代理等密钥

交接后建议让对方先跑：

```bash
npm install
npm run check:syntax
npm run db:init -- --config config.local.json
npm run db:stats -- --config config.local.json
npm run roxy:probe -- --config config.local.json
npm run checkout:probe -- --config config.local.json
node src/cli.js start --config config.local.json --windows 1 --limit 1
```
