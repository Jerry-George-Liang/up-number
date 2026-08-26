# OpenAI OAuth 自动建号工具技术开发文档

- 状态：后台账号密码登录、邮箱验证码模式、OpenAI 密码 + TOTP 模式、验证码两轮等待与单次自动重发、可配置可信路径式邮箱兼容均已实施并通过自动验证；真实有效账号登录和完整外部链路待用户验收
- 日期：初版 2026-08-11；最近更新 2026-08-14
- 工作目录：`/Users/lkj/Desktop/working/up-icould`
- 目标后台：`https://coding.tu-zi.com/admin/accounts`
- 已确认产品效果：本地网页单账号运行；设置页使用后台登录邮箱、密码及后台实际要求时的 TOTP；任务页始终填写账号邮箱，并在“邮箱验证码”模式填写一行邮箱取件信息，或在“密码 + 2FA”模式分别填写一行账号密码和一行 2FA 密钥；其他值只选择；调用后台现有接口完成 OpenAI OAuth 和账号创建；最终只显示后台账号结果，不返回或保存 OpenAI RT、Access Token、完整 OAuth 凭据

## 1. 目标

从零建设一个仅在本机运行的网页工具，按以下顺序完成一个账号任务：

1. 使用设置页中已经保存的后台登录会话读取代理、并发数、供应商和分组选项。
2. 接收任务页的账号邮箱和一组互斥登录材料：邮箱取件信息，或独立的账号密码与 2FA 密钥。
3. 解析用户选择的代理方式，调用 `coding.tu-zi.com` 当前后台接口生成 OpenAI OAuth 授权链接。
4. 启动可见、一次性、与用户日常浏览器资料隔离的浏览器，自动填写登录邮箱。
5. 邮箱验证码模式调用固定邮箱接口轮询本次新邮件并填写唯一可信六位码；密码 + 2FA 模式跳过邮箱接口，依次填写密码并由服务端生成认证器动态码。
6. 捕获 OAuth 回调中的 `code`，校验 `state` 后调用后台接口兑换 OAuth 凭据。
7. 使用兑换结果直接调用后台账号创建接口；账号名自动使用邮箱，平台固定为 OpenAI，类型固定为 OAuth，并强制应用“清除所有模型”的当前后台语义。
8. 创建后查询并展示后台账号 ID、名称、状态和本次所选配置。

该工具只编排用户有权使用的现有后台和账号登录流程，不绕过 CAPTCHA、MFA、密码挑战、风控或其他安全控制。

## 2. 范围

### 2.1 本次包含

- 本地网页的任务页、任务结果/历史页和设置页。
- 后台 Refresh Token/Access Token 双模式登录、Keychain 恢复、退出和过期处理。
- 后台代理、供应商、分组选项读取与刷新。
- 无代理、指定固定代理、随机固定代理和动态订阅四种任务选择。
- 单账号 OpenAI OAuth 授权、邮箱验证码轮询或密码 + TOTP 登录、可见浏览器自动填写和人工接管。
- OAuth 兑换结果到后台创建请求的内存内传递。
- 创建前查重、创建结果确认和不确定响应下的防重复处理。
- 只保留不含秘密的任务记录，不保留邮箱取件密码、验证码或 OAuth 凭据。

### 2.2 本次不包含

- XYHelper 或任何第三方 session 换取服务。
- 向用户返回、展示、复制或保存 RT、Access Token、ID Token 或完整 session。
- 批量账号、任务队列或多个账号并行授权。
- 在任务页创建、编辑或删除代理、动态订阅、供应商或分组。
- 自动解决 CAPTCHA、MFA、OpenAI 密码挑战、账号选择或风控。
- 自动删除已经创建的后台账号。
- 对 `coding.tu-zi.com/admin/accounts` 管理页面进行点击自动化。
- 修改 `coding.tu-zi.com` 服务端代码、数据库或接口。

## 3. 当前调研与代码审查

### 3.1 工作区现状

- 当前目录不是 Git 仓库。
- 除本文件外没有应用代码、依赖、测试、README 或项目内 `AGENTS.md` 可复用。
- 原文件描述的是 XYHelper 命令行授权工具，与已确认需求冲突，不能作为实现依据。
- 本机当前可用 Node.js `v24.15.0` 和 npm `11.18.0`。
- Node.js 当前运行时可直接使用 `node:sqlite`，任务记录无需引入额外数据库服务。

### 3.2 当前后台前端契约

2026-08-11 对部署页面及其当前静态资源进行了只读复核，得到以下事实：

- 当前前端 API 基地址为 `/api/v1`。
- 认证请求使用 `Authorization: Bearer <access-token>`。
- 管理端请求附带 `X-Admin-UI-Request: 1`。
- 登录接口为 `POST /api/v1/auth/login`，当前页面提交 `email` 和 `password`；登录可能返回需要 TOTP 的中间状态。
- 会话续期接口为 `POST /api/v1/auth/refresh`，请求使用 refresh token。
- 当前用户校验接口为 `GET /api/v1/auth/me`。
- OpenAI 授权链接接口为 `POST /api/v1/admin/openai/generate-auth-url`。
- OpenAI 授权码兑换接口为 `POST /api/v1/admin/openai/exchange-code`。
- 账号创建接口为 `POST /api/v1/admin/accounts`。
- 账号详情接口为 `GET /api/v1/admin/accounts/{id}`；账号列表接口支持分页和筛选，可用于查重及不确定结果确认。

当前授权链接请求可包含：

```json
{
  "proxy_id": 123,
  "machine_id": 456,
  "redirect_uri": "http://127.0.0.1/callback"
}
```

本工具第一版只按需要传递已经解析出的 `proxy_id`，不自行填写 `machine_id` 或覆盖 `redirect_uri`。接口响应至少包含 `auth_url` 和 `session_id`；工具从 `auth_url` 中提取 `state`。

当前授权码兑换请求为：

```json
{
  "session_id": "<generated-session-id>",
  "code": "<captured-code>",
  "state": "<state-from-auth-url>",
  "proxy_id": 123
}
```

`proxy_id` 可省略，但生成链接、打开登录、兑换授权码和创建账号必须使用同一项已经解析的代理选择，避免代理配置不一致。

### 3.3 当前选项接口

工具复用后台已有选项和解析能力：

| 用途 | 当前接口 | 本地工具行为 |
| --- | --- | --- |
| 固定代理 | `GET /api/v1/admin/proxies/all` | 只显示可选择记录 |
| 动态订阅 | `GET /api/v1/admin/proxies/subscriptions` | 只显示现有订阅 |
| 代理解析 | `POST /api/v1/admin/proxies/assignments/resolve` | 把随机固定或动态订阅解析成具体 `proxy_id` |
| 代理详情 | `GET /api/v1/admin/proxies/{id}` | 读取临时浏览器需要的连接配置，只在活动任务内存中使用 |
| 供应商 | `GET /api/v1/admin/accounts/suppliers` | 作为可选字符串列表 |
| 分组 | `GET /api/v1/admin/groups/all` | 作为可选多选列表 |

当前账号页已有三种代理分配模式：`manual`、`random_fixed` 和 `dynamic`。本地工具在此基础上增加清晰的“无代理”选项；无代理时不调用解析接口，也不在后续请求中发送 `proxy_id`。

任务页不允许键入代理 URL、订阅地址、供应商名称或分组 ID。所需选项不存在时，用户必须先到对应管理区添加，再回到本地工具刷新。

### 3.4 “清除所有模型”的真实语义

当前后台模型选择器的“清除所有模型”会把模型白名单设为 `[]`。当前映射构建函数对空白名单返回 `null`，创建请求因此不发送 `credentials.model_mapping`。

这在当前后台的含义是“不限制模型、支持所有模型”，不是“禁止所有模型”。本工具必须复制这一请求语义：

- 任务界面显示已经锁定的“清除所有模型（必选）”。
- 内部白名单固定为 `[]`，用户不能关闭或改成其他模式。
- 创建请求的 `credentials` 中不得出现 `model_mapping`。
- 测试必须断言字段是“缺失”而不是 `null`、`{}` 或 `[]`。

### 3.5 外部契约风险

上述结论来自当前部署前端，不是版本化的公开 API 文档。静态资源更新后，请求字段或响应结构可能变化。所有后台请求必须集中在适配器中，并以脱敏契约 fixture 固定当前行为，避免变化扩散到浏览器、邮箱或页面模块。

邮箱服务的成功响应结构仍未通过脱敏样例确认。用户提供过包含真实凭据的调用示例，但本次调研没有访问或保存其中的私人邮件数据。实现可以先完成客户端、标准化接口和模拟测试；真实邮箱验收前仍需脱敏成功响应样例，或在更换已经暴露的取件密码后由用户明确授权一次只读取件测试。

## 4. 技术方案与取舍

### 4.1 推荐方案：本地网页 + 本地编排服务 + 一次性浏览器

技术组合：

- Node.js 24 + TypeScript：本地服务、状态机、网络客户端和任务存储。
- Fastify：仅绑定环回地址的本地 HTTP 服务和 JSON API。
- Vue 3 + Vite：任务、历史和设置页面。
- Playwright：只用于启动本机 Google Chrome 的可见、一次性无痕浏览器上下文。
- Zod：任务输入、外部响应和本地 API 的运行时校验。
- `node:sqlite`：只存脱敏设置和任务状态。
- `@napi-rs/keyring`：将后台 refresh token 保存到 macOS Keychain。
- Vitest：单元和本地集成测试。

优点：

- 用户在本地网页中完成配置和查看进度，符合已经确认的操作效果。
- 后台调用、邮箱轮询和浏览器生命周期由一个本地进程协调，取消和异常清理边界明确。
- 浏览器上下文与用户日常 Chrome Profile 隔离，可在异常页面保留窗口供人工接管。
- OAuth 凭据和代理认证信息只在服务端活动任务内存中使用，不经过前端。
- 后台密码不落盘，长期会话保存到系统 Keychain，而不是普通配置文件。

成本和限制：

- Playwright 浏览器运行时体积较大。
- macOS Keychain 访问可能出现系统授权提示。
- OpenAI 页面变化仍可能使自动填写进入人工接管。
- 邮箱服务把密码放在 URL 查询参数中，这是外部接口固有风险，本地工具只能通过禁止日志和重定向降低泄露面。

### 4.2 未采用方案

直接自动点击后台管理页：无需理解创建接口，但依赖管理页面 DOM，容易受页面更新影响，也违背“直接调用页面里的接口”的已确认要求。

纯浏览器扩展：可复用当前登录页，但会把后台会话、邮箱密码和 OAuth 响应暴露给扩展上下文，安装和权限边界更复杂。

纯 HTTP 模拟 OpenAI 登录：无法可靠处理页面状态、安全挑战和人工接管，维护风险高，不采用。

## 5. 总体架构

```text
本地 Vue 网页
  -> 本地 Fastify API（仅 127.0.0.1）
       -> 后台会话服务
            -> coding.tu-zi.com 登录、续期、当前用户
            -> macOS Keychain（仅 refresh token）
       -> 后台选项服务
            -> 代理 / 动态订阅 / 供应商 / 分组
       -> 单任务编排器
            -> 代理解析器
            -> OpenAI OAuth 后台适配器
            -> 一次性 Playwright 浏览器
            -> 邮箱客户端与 OTP 识别器
            -> 后台账号创建与结果确认
       -> SQLite（仅脱敏任务状态和非敏感设置）
```

系统同一时间只允许一个活动任务。前端刷新不会启动第二份任务；服务端任务锁和状态机是唯一事实来源。

## 6. 目录与模块设计

计划新增：

```text
.
├── .gitignore
├── package.json
├── package-lock.json
├── tsconfig.json
├── vite.config.ts
├── README.md
├── DOC.md
├── QA.md
├── docs/
│   └── TECHNICAL_DESIGN.md
├── src/
│   ├── server/
│   │   ├── index.ts
│   │   ├── app.ts
│   │   ├── config.ts
│   │   ├── local-security.ts
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── options.ts
│   │   │   └── tasks.ts
│   │   ├── backend/
│   │   │   ├── client.ts
│   │   │   ├── auth.ts
│   │   │   ├── options.ts
│   │   │   └── accounts.ts
│   │   ├── browser/
│   │   │   ├── controller.ts
│   │   │   ├── page-classifier.ts
│   │   │   └── callback-capture.ts
│   │   ├── mail/
│   │   │   ├── client.ts
│   │   │   ├── normalize.ts
│   │   │   ├── otp.ts
│   │   │   └── poller.ts
│   │   ├── session/
│   │   │   ├── keychain.ts
│   │   │   └── manager.ts
│   │   ├── tasks/
│   │   │   ├── orchestrator.ts
│   │   │   ├── state-machine.ts
│   │   │   ├── proxy-resolver.ts
│   │   │   └── account-creator.ts
│   │   ├── storage/
│   │   │   ├── database.ts
│   │   │   └── migrations.ts
│   │   └── security/
│   │       ├── redact.ts
│   │       └── secret-scope.ts
│   ├── shared/
│   │   ├── contracts.ts
│   │   ├── task-state.ts
│   │   └── errors.ts
│   └── web/
│       ├── main.ts
│       ├── App.vue
│       ├── api.ts
│       ├── views/
│       │   ├── TaskView.vue
│       │   ├── HistoryView.vue
│       │   └── SettingsView.vue
│       └── components/
│           ├── TaskForm.vue
│           ├── TaskProgress.vue
│           ├── OptionSelect.vue
│           └── AccountResult.vue
└── tests/
    ├── fixtures/
    ├── integration/
    └── unit/
```

主要边界：

- `backend/*` 是 `coding.tu-zi.com` 的唯一协议边界，不包含页面或任务状态逻辑。
- `mail/*` 只负责取件、标准化、去重和 OTP 筛选，不知道后台账号创建。
- `browser/*` 只识别并操作 OpenAI 页面、捕获回调，不访问邮箱服务。
- `tasks/orchestrator.ts` 按状态机协调模块，不解析 HTML、不拼接后台请求。
- `security/*` 统一限制秘密生命周期和日志输出。
- `web/*` 永远接触不到后台 refresh token、OAuth 兑换结果或邮箱响应正文。

## 7. 本地网页与本地 API

### 7.1 任务页输入模型

任务创建请求只允许以下字段：

```ts
interface CreateTaskInput {
  accountEmail: string;
  loginMaterial:
    | { kind: "email_otp"; mailboxAccess: string }
    | { kind: "password_totp"; password: string; totpSecret: string };
  proxyChoice:
    | { mode: "none" }
    | { mode: "fixed"; proxyId: number }
    | { mode: "random_fixed" }
    | { mode: "dynamic"; subscriptionId: number };
  concurrency: 1 | 3 | 5 | 10 | 20;
  supplier: string | null;
  groupIds: number[];
  allowDuplicateCreation: boolean;
  confirmMixedChannelRisk: boolean;
}
```

约束：

- `accountEmail` 始终显示；`loginMaterial` 必须且只能选择一种模式。
- 邮箱前后空格会被去掉并按普通邮箱格式校验；保存和显示时使用规范化后的邮箱。
- 邮箱验证码模式只显示一行取件密码/接口链接；密码 + 2FA 模式只显示独立的账号密码与 2FA 密钥两行遮罩输入，不接受拼接行。
- 密码保持原字符；2FA 密钥只规范化展示空格、连字符和大小写，再执行严格 Base32 校验。
- 登录材料不得为空，不写入浏览器持久化存储、SQLite、任务历史或日志。
- 并发数使用预设下拉选项，默认 `10`，不提供数字输入框。
- 供应商只允许从后台返回列表中单选，可不选。
- 分组只允许从后台返回列表中多选，可为空。
- 平台、账号类型、账号名称、优先级和费率倍率不在页面提供输入。
- “清除所有模型”显示为锁定的必选项，不能取消。

### 7.2 本地 API

计划提供：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/bootstrap?nonce=...` | 校验启动 nonce 并显示无缓存自动检查页，不建立会话 |
| `GET` | `/bootstrap.js` | 同源检查 `/healthz`，成功后提交当前 bootstrap 表单 |
| `POST` | `/bootstrap?nonce=...` | 检查成功后一次性消耗 nonce 并签发本地会话 cookie |
| `GET` | `/local-api/session` | 返回后台会话是否有效及脱敏用户信息 |
| `POST` | `/local-api/session/token` | 按用户选择的模式验证并保存一个后台 Token |
| `DELETE` | `/local-api/session` | 后台退出并删除 Keychain 会话 |
| `GET` | `/local-api/options` | 读取并规范化任务选项 |
| `POST` | `/local-api/options/refresh` | 主动刷新选项缓存 |
| `POST` | `/local-api/tasks` | 创建并启动一个任务 |
| `GET` | `/local-api/tasks/active` | 获取当前活动任务状态 |
| `GET` | `/local-api/tasks/{id}` | 获取脱敏任务详情 |
| `POST` | `/local-api/tasks/{id}/cancel` | 取消尚未进入创建提交阶段的任务 |
| `GET` | `/local-api/tasks/{id}/events` | 通过 SSE 推送阶段变化 |

任务状态响应只包含阶段、脱敏提示、时间、选择项摘要和最终后台账号信息。任何响应都不得包含邮箱取件密码、验证码、OAuth `code`、`state`、`session_id`、RT、Access Token、ID Token 或后台 Bearer token。

### 7.3 本地服务安全

- 默认只监听 `127.0.0.1`；启用受限 LAN 模式时按 `LAN_PROTOCOL=http|https` 额外精确绑定配置的私有 IPv4 地址并校验客户端 CIDR，不监听 `0.0.0.0` 或公网地址。协议未设置时默认 HTTPS，当前持久配置由用户明确选择 HTTP。
- 当前 LAN HTTP 是用户在了解账号密码、验证码和会话会通过未加密局域网传输后接受的便利取舍；它不适合访客网络、公共 Wi-Fi 或不受信任网段。恢复 HTTPS 只需切换显式协议配置和保留的证书路径，不需要迁移数据库。
- 使用配置的固定端口；端口被占用时启动失败，不结束占用端口的其他进程。
- 环回 HTTP 和显式 LAN HTTP 允许固定首页直接接入。前端首先调用精确的 `GET /local-api/session`；当 Cookie 缺失或失效时，仅该只读探测请求可以签发当前入口的一年 Cookie 并返回 CSRF。其他读取与全部写入不会自动建立会话，写入仍要求有效 Cookie、精确 Origin 和 CSRF。LAN HTTPS 不启用该便利模式，继续使用 bootstrap 首次建立会话。
- 启动 URL 带一次性随机引导 nonce；GET 只显示自动检查页且不消耗 nonce，避免普通链接预览或预取使入口失效。同源外部脚本先读取 `/healthz`，只有获得 `200` 和 `status=ok` 才自动提交表单；失败时不发送 POST，并保留按钮重试及无脚本原生表单兜底。POST 成功后换成 `Path=/`、`HttpOnly`、`SameSite=Strict`、`Max-Age=31536000` 的 host-only 会话 cookie，并立即使 nonce 失效。LAN HTTPS cookie 额外带 `Secure` 和 HSTS；LAN HTTP 使用独立非 Secure Cookie 名及会话命名空间，避免与原 HTTPS Cookie 混用，但不提供传输加密。
- 通过本地会话验证的 `/local-api/` 请求重新签发同属性 cookie，将浏览器到期时间从本次使用起延长一年；写请求必须先通过 Origin 和 CSRF 才续期。除精确会话探测外，未认证、Cookie 错误、跨入口、CSRF 或 Origin 校验失败的请求不续期。
- 所有写请求校验 `Origin`、本地会话和 CSRF token，拒绝其他网页跨站调用本地服务。
- 设置严格 CSP，前端不加载第三方脚本、字体或分析服务。
- 开发模式和生产模式均不得把秘密放入 URL、SSE、浏览器控制台或前端状态持久化。

## 8. 后台 Token 登录与会话保存

### 8.1 登录

设置页显示固定后台地址、一个 Token 类型分段选择和一个“后台登录 Token”保密输入。默认选择 Refresh Token，用户也可明确选择 Access Token；工具不通过试错请求自动判断类型。

登录流程：

1. Refresh 模式调用 `POST /api/v1/auth/refresh`，使用返回的 access token 和可选轮换 refresh token；响应缺少用户信息时再调用 `GET /api/v1/auth/me`。
2. Access 模式只把用户提供的 Token 作为 Bearer 调用 `GET /api/v1/auth/me`，不解析 JWT 声明。
3. 验证成功后按 `backend-user:<id>` 写入带版本和模式的 Keychain 凭据，服务名固定为 `up-icloud.coding-session`。
4. Token 登录本地请求和公开响应都不包含后台账号、密码或 TOTP；提交成功或失败后页面都清空 Token 输入。

### 8.2 续期和过期

- Refresh 模式在 access token 临近过期时用内存中的 refresh token 续期；同一时刻只允许一个续期请求，其余请求等待同一结果，避免轮换竞态。
- Refresh 模式收到新 refresh token 时先更新 Keychain；`401` 时最多续期并重放原请求一次，再失败则清理会话。
- Access 模式不续期；管理请求返回 `401` 时清理 Keychain 和内存会话，提示重新粘贴，并且不重放原请求。
- `403` 或权限不足不当作会话过期，页面明确显示缺少账号管理权限。
- Refresh 模式主动退出时调用后台 logout，并在最终步骤删除本机 Keychain 项；Access 模式只执行本地清理，因为当前 logout 契约要求 refresh token。

旧版以后台邮箱为 Keychain account、值为裸 refresh token 的凭据仍可读取；只有刷新和用户验证成功后才迁移到 `backend-user:<id>` 结构，临时错误保留原凭据，无效凭据才删除。后台 Token 仅保存在 macOS Keychain 和运行内存，不进入 SQLite、前端响应或普通日志。

### 8.3 后台客户端安全

- 后台基地址固定为 `https://coding.tu-zi.com/api/v1`，任务页和设置页都不能修改。
- 所有管理请求附带当前 Bearer token 和 `X-Admin-UI-Request: 1`，但普通日志必须先删除这两个值。
- 不自动跟随到其他主机的重定向；响应必须通过状态码、Content-Type 和 Zod 结构校验。
- `423 ADMIN_COMPLIANCE_ACK_REQUIRED` 表示后台要求管理员先确认合规文档，本地工具不得代替用户自动确认；页面应引导用户去后台完成确认后再刷新会话。
- 网络错误、会话错误、权限错误、合规确认和业务校验错误使用不同公开错误码，不能统一显示为“登录失效”。

## 9. 选项加载与代理解析

### 9.1 选项快照

打开任务页时并发读取固定代理、动态订阅、供应商和分组，并生成带版本时间的 `OptionsSnapshot`。任务启动时必须引用当时快照中的真实选项，不能接受页面自行构造的 ID 或供应商字符串。

选项加载任一关键接口失败时：

- 禁用“开始任务”。
- 显示具体失败项和刷新按钮。
- 不沿用已经过期但无法确认的旧选项开始新任务。

### 9.2 代理解析

- `none`：解析结果为空，后续请求不发送 `proxy_id`。
- `fixed`：验证所选 ID 存在且可用，直接使用该 `proxy_id`。
- `random_fixed`：调用 `/admin/proxies/assignments/resolve`，请求模式为 `random_fixed`，使用后台当前可用固定代理集合，由后台返回具体 `proxy_id`。
- `dynamic`：调用同一解析接口，模式为 `dynamic` 并传 `subscription_id`，由后台返回具体 `proxy_id`。

有代理时，从后台代理配置读取 Playwright 所需的 server、username 和 password，规范化为只存在于活动任务内存的 `BrowserProxyConfig`。后台 `socks5h` 协议值只作为 SOCKS5 远端主机名解析别名，在交给仅接受 `socks5://` 的 Chromium 代理配置前规范化为 `socks5`；字段式连接配置和完整代理 URL 使用相同规则，其他未知协议继续闭合拒绝。代理密码不得进入 SQLite、前端响应或日志；缺少可用连接配置时任务必须在打开浏览器前失败，不能悄悄退回本机直连。

解析后的代理 ID、名称和选择模式写入不含秘密的任务快照。任务中途不重新随机选择，保证授权生成、浏览器登录、兑换和账号创建使用同一份已解析代理配置。动态或轮换代理仍可能由上游服务分配不同出口 IP，工具只能保证配置一致，不能承诺 IP 永远相同。

## 10. 邮箱取件与 OTP 识别

### 10.1 固定请求契约

邮箱客户端只请求固定主机和路径：

```text
GET https://icloud.thefindnet.xyz/api/mail.php
  ?mail=<URL-encoded-account-email>
  &pwd=<URL-encoded-mailbox-password>
  &limit=5
```

实现必须使用 `URL` 和 `URLSearchParams` 构造请求，`limit=5` 固定，不接受用户修改主机、路径或额外查询参数。

安全限制：

- 禁止把完整请求 URL 写入日志或错误对象。
- 禁止自动跟随重定向，尤其不能把查询参数带到其他主机。
- 设置连接、单次响应和总轮询超时。
- 限制响应体大小，拒绝异常大响应。
- 邮箱认证失败立即停止，不高频重试。
- 对 `429` 遵守 `Retry-After`；临时网络错误采用有上限退避。

### 10.2 新邮件基线

任务开始后、生成授权链接前先读取最近五封邮件，记录不含正文的消息 ID、时间和内容指纹基线。随后只接受：

1. 不在基线中的邮件；
2. 时间不早于任务启动时间（允许小范围服务端时钟偏差），或在缺失可靠时间时具有新的稳定指纹；
3. 发件人、主题或正文能够确认与 OpenAI/ChatGPT 当前登录有关；
4. 能提取出唯一可信的六位验证码。

旧邮件、无法确认来源的六位数字和多个冲突候选都不能自动填写。

### 10.3 轮询状态

```text
baseline -> waiting -> candidate_found -> otp_confirmed
                  -> transient_error -> waiting
                  -> authentication_failed
                  -> conflicting_candidates
                  -> timeout
```

默认每 3 秒轮询一次，连续临时错误时退避到最多 10 秒，总等待上限 10 分钟。上述值是内部固定配置，不增加任务页输入。

JSON 响应使用结构化 JSON 解析；HTML 响应使用 DOM 解析器。生产适配器必须根据脱敏成功样例固定字段映射，不能依靠遍历所有字段碰运气。邮件正文和验证码只存在于活动任务内存中，确认或失败后立即释放。

## 11. OAuth 浏览器自动化

### 11.1 生成授权链接

1. 调用后台 `generate-auth-url`，必要时传解析后的 `proxy_id`。
2. 校验响应是当前契约允许的 OpenAI HTTPS 授权主机、存在非空 `session_id`，并从 URL 读取非空 `state` 和预期 `redirect_uri`。
3. 预期回调必须是当前契约允许的本机环回地址和路径；授权主机或回调目标变化时安全失败并要求更新契约，不导航到任意第三方地址。
4. `auth_url`、`session_id`、`state` 和预期回调只放入活动任务的秘密上下文，不进入 SQLite、前端响应或普通日志。

### 11.2 一次性可见浏览器

- 每个任务调用 `launchPersistentContext('', ...)`，用 `channel: "chrome"` 和 `--incognito` 直接启动可见 Google Chrome 的初始无痕式窗口；空 `userDataDir` 让 Playwright 创建并在关闭后清理一次性临时配置。不得再先 `launch()` 后调用 `browser.newContext()`，因为后者虽然隔离存储，但不能保证 Chrome UI 显示为无痕式窗口。
- 选择代理时使用本任务的 `BrowserProxyConfig` 启动该无痕 Chrome；无代理时才使用本机直连。
- 不使用用户现有 Chrome Profile，不读取现有 cookie、密码、扩展或登录状态。
- 不启用 trace、HAR、视频或截图，避免保存登录页面和秘密。
- 关闭任务后同时关闭上下文和浏览器，清除临时目录。
- 浏览器由本地服务直接打开 `auth_url`；前端不会收到完整授权链接。

### 11.3 页面识别和自动填写

正常路径：

1. 识别邮箱输入页面，按语义属性填写任务邮箱并提交。
2. 识别 OTP 页面，等待邮箱轮询器返回验证码。
3. 只在明确的 OTP 输入框中填写唯一验证码并提交。
4. 监听页面导航和请求，等待包含 OAuth `code` 与 `state` 的回调。

选择器优先使用 `type=email`、输入名称、`autocomplete=email`、`autocomplete=one-time-code`、按钮 role 等稳定语义；中英文文本只作为受控后备，不依赖压缩 CSS 类名。

### 11.4 人工接管

检测到以下任一状态时，任务进入 `manual_intervention`，停止自动点击但保持同一浏览器：

- CAPTCHA 或其他人机验证；
- MFA、密码挑战或安全密钥；
- 账号选择、组织选择或风控页面；
- 邮箱验证码候选冲突；
- 页面结构未知或必要选择器失效。

用户可以在该浏览器中手动完成当前挑战。工具继续被动监听合法回调；一旦收到与本任务 `state` 匹配的 `code`，自动恢复后续兑换和创建。工具不会模拟破解、绕过或自动回答安全挑战。

### 11.5 回调捕获和校验

授权页可能导航到预期的本机回调地址，即使最终页面加载失败，Playwright 的请求/导航事件仍可捕获 URL。工具监听顶层导航；只有为了捕获加载失败的预期回调时才检查对应网络请求，并且只接受：

- URL 中存在非空 `code`；
- URL 中的 `state` 与授权链接提取值使用常量时间比较后完全一致；
- URL 的 origin 和 path 与授权链接中的预期 `redirect_uri` 完全一致；
- 回调属于当前浏览器上下文和当前任务；
- 本任务此前没有接受过其他 code。

完整回调 URL、code 和 state 不写日志。state 不匹配时立即失败并关闭浏览器，不调用兑换接口。

## 12. 兑换与创建账号

### 12.1 OAuth 兑换

使用当前任务的 `session_id`、`code`、`state` 和可选 `proxy_id` 调用：

```http
POST /api/v1/admin/openai/exchange-code
```

对成功响应做 allowlist 映射，仅保留当前后台创建 OpenAI OAuth 账号需要的已知字段，例如：

- `access_token`
- `refresh_token`
- `id_token`
- `expires_at`
- `email`
- `chatgpt_account_id`
- `chatgpt_user_id`
- `organization_id`
- `plan_type`
- `subscription_expires_at`
- `client_id`

未知字段不直接透传。兑换结果只保存在 `SecretScope` 内存对象中，不能序列化、记录、发送给前端或写入 SQLite。

### 12.2 两阶段查重

第一次查重在任务输入和选项校验完成后、读取邮箱和打开浏览器之前执行；使用规范化邮箱和自动账号名查询账号列表，并对返回记录进行精确匹配。若已经存在同名/同邮箱 OpenAI OAuth 账号：

- 不再次调用创建接口。
- 将任务结束为 `already_exists`。
- 返回现有后台账号 ID、名称和状态供用户确认。

第二次查重在 OAuth 兑换成功后、发送创建请求前执行，用于发现任务运行期间由其他操作新增的同一账号。若第二次查重命中，同样不创建，并立即销毁本次兑换凭据。

两次查重都是防误操作措施，不替代服务端唯一约束。

### 12.3 创建请求

创建载荷固定为：

```ts
interface OpenAIAccountCreatePayload {
  name: string;                 // 规范化邮箱
  platform: "openai";
  type: "oauth";
  credentials: OpenAICredentials; // 仅来自本次兑换结果
  proxy_id?: number;
  concurrency: 1 | 3 | 5 | 10 | 20;
  priority: 1;
  rate_multiplier: 1;
  group_ids: number[];
  supplier?: string;
}
```

额外规则：

- 不发送用户可编辑的账号名，`name` 始终是邮箱。
- 无代理时省略 `proxy_id`，不发送伪造的 `0`。
- 未选供应商时省略 `supplier`，不发送未经选项校验的值。
- `group_ids` 只包含启动快照中仍存在的选项。
- `credentials.model_mapping` 必须缺失，以等价执行“清除所有模型”。
- 不发送本次需求之外的高级账号设置，使用后台当前默认值。

### 12.4 不确定结果和最终确认

创建请求设置独立超时。处理分为三类：

- 明确成功：读取响应账号 ID，再调用账号详情接口确认。
- 明确 4xx 失败：不重试，显示后台返回的脱敏原因。
- 请求已经发出但响应超时/断开：标记 `create_result_uncertain`，先按邮箱精确查询后台。

只有查询明确证明账号不存在时，页面才允许用户重新开始一个新任务；当前任务不自动重放创建请求。若查询找到账号，则按成功处理，避免重复创建。

最终返回给前端的结果示例：

```json
{
  "taskId": "...",
  "status": "completed",
  "account": {
    "id": 123,
    "name": "account@example.invalid",
    "status": "active"
  },
  "selection": {
    "proxyMode": "dynamic",
    "proxyName": "subscription display name",
    "concurrency": 10,
    "supplier": null,
    "groups": []
  },
  "modelsCleared": true
}
```

结果中不包含任何 OAuth 凭据。

## 13. 任务状态机、取消与恢复

### 13.1 状态

```text
draft
  -> validating
  -> loading_options
  -> checking_existing
  -> mail_baseline
  -> resolving_proxy
  -> generating_auth_url
  -> browser_started
  -> email_submitted
  -> waiting_for_otp
  -> otp_submitted
  -> waiting_for_callback
  -> manual_intervention (可恢复到 waiting_for_callback)
  -> exchanging_code
  -> checking_duplicate
  -> creating_account
  -> confirming_account
  -> completed | already_exists

任意可失败阶段 -> failed
允许取消阶段 -> cancelled
创建响应不确定 -> create_result_uncertain -> completed | failed
```

### 13.2 取消边界

- `creating_account` 之前允许取消：停止轮询、关闭浏览器、清理秘密，不创建账号。
- 一旦创建请求开始发送，取消按钮禁用，避免用户误以为远端请求已经撤销。
- 创建成功后不自动删除账号；删除是独立的破坏性后台操作，不在本工具范围内。

### 13.3 进程中断

OAuth 的 session、state、code、验证码和兑换凭据都不持久化，因此本地服务重启后不能继续中断的授权。正常退出和可捕获信号必须先关闭本任务浏览器；异常崩溃后的下一次启动只把遗留活动任务标记为 `interrupted` 并清理本工具专属临时目录，不扫描或关闭用户的其他浏览器进程。

如果中断发生在 `creating_account` 之后，启动恢复先按邮箱查询后台并把结果归类为成功或不确定，不能直接重试创建。

## 14. 数据与秘密生命周期

### 14.1 SQLite 可保存内容

- 非敏感应用设置和选项刷新时间。
- 任务 ID、规范化邮箱、已选配置快照、状态、阶段时间和脱敏错误分类。
- 最终后台账号 ID、名称、状态。

邮箱属于个人信息，历史页按用户输入显示是产品需要；日志仍使用掩码。用户可在本地历史页清除任务记录，但不会删除后台账号。

### 14.2 禁止持久化内容

- 后台登录密码和 TOTP；
- 邮箱取件密码；
- 代理密码和完整代理连接 URL；
- 邮件正文和验证码；
- `auth_url`、OAuth `session_id`、`state`、`code`；
- RT、Access Token、ID Token 和完整兑换响应；
- 浏览器 cookie、localStorage、截图、trace、HAR 或视频。

后台 refresh token 是唯一允许长期保存的秘密，只进入 macOS Keychain，不进入 SQLite 或配置文件。后台 access token 只存在于进程内存。

### 14.3 日志脱敏

统一脱敏器至少覆盖：

- 邮箱密码查询参数 `pwd`；
- `Authorization` 和 cookie；
- JWT 形态字符串；
- OAuth code、state、session ID 和完整回调 URL；
- 六位验证码；
- 邮件正文；
- RT、Access Token、ID Token 及其常见字段名。

生产日志只记录任务 ID、阶段、耗时、HTTP 状态分类和可操作错误码，不记录外部响应体。

## 15. 错误模型和用户表现

统一错误结构：

```ts
interface PublicTaskError {
  stage: TaskStage;
  code: string;
  message: string;
  retryable: boolean;
  requiresLogin?: boolean;
  requiresManualIntervention?: boolean;
}
```

主要处理：

| 场景 | 行为 |
| --- | --- |
| 邮箱格式错误或取件密码为空 | 阻止启动，不创建任务 |
| 后台会话过期 | 停止任务并要求设置页重新登录 |
| 账号管理权限不足 | 禁止启动，显示权限原因 |
| 后台要求合规确认 | 引导用户在后台确认后刷新，不自动代签 |
| 选项加载失败或选择已失效 | 禁止启动，要求刷新 |
| 邮箱认证失败 | 停止轮询，清理浏览器和秘密 |
| 邮箱暂时网络失败 | 有上限退避，超过总时限失败 |
| 没有新验证码 | 等待至超时，不使用旧邮件 |
| 多个冲突验证码 | 不猜测，进入人工接管/明确失败 |
| OpenAI 未知页面 | 停止自动点击，保留浏览器供人工处理 |
| state 不匹配 | 安全失败，不兑换、不创建 |
| 兑换失败 | 不创建账号，销毁兑换上下文 |
| 创建明确失败 | 显示后台脱敏错误，不自动重试 |
| 创建结果不确定 | 先查询是否已经存在，禁止盲目重放 |

## 16. 测试方案

遵守默认不进行页面测试的约束。自动测试不登录真实后台、不读取真实邮箱、不访问真实 OpenAI 授权页，也不运行依赖真实页面交互的 Playwright E2E。

### 16.1 单元测试

- 任务输入只允许两个自由文本字段和受控选项。
- 邮箱规范化、并发数枚举、供应商和分组快照校验。
- 代理四种选择及 `assignments/resolve` 请求、响应校验。
- 邮箱 URL 编码、固定 `limit=5`、禁止重定向和响应体上限。
- 邮件基线、时间过滤、指纹去重、旧邮件排除。
- OpenAI 邮件筛选、唯一六位码提取和冲突拒绝。
- 页面分类器使用静态 DOM fixture 的识别逻辑，不启动浏览器。
- 回调 code/state 提取、state 不匹配和重复回调拒绝。
- OAuth 兑换响应 allowlist 映射。
- 创建载荷固定字段、可选字段省略和未知字段拒绝。
- `credentials.model_mapping` 始终缺失。
- 两阶段查重和不确定结果下禁止自动重放。
- 会话单飞续期、token 轮换和 401/403 区分。
- 日志脱敏和公开错误结构。
- 状态机合法迁移、取消边界、超时和清理。

### 16.2 本地集成测试

使用本地模拟后台、模拟邮箱服务和可替换的 `BrowserDriver` 覆盖：

```text
后台登录模拟 -> Keychain 测试替身 -> 选项读取
模拟邮箱基线 -> 生成授权链接 -> 模拟浏览器状态
延迟出现新验证码 -> 回调 state 校验 -> 模拟兑换
查重 -> 创建账号 -> 详情确认 -> 脱敏结果
```

额外覆盖：

- TOTP 登录中间状态和会话续期竞态。
- 邮箱认证失败、429、临时错误、超时和冲突验证码。
- 人工接管状态后收到合法回调并恢复。
- 取消时关闭轮询器和浏览器适配器。
- 创建响应断开但查询发现账号已存在。
- 创建响应断开且查询仍无法确认时保持不确定，不重试。
- SQLite 重启恢复时把未完成任务归类为 `interrupted`。
- 所有本地 API 响应的秘密字段扫描。

### 16.3 静态与构建验证

- TypeScript 类型检查。
- ESLint 静态检查。
- 单元和集成测试。
- 前后端生产构建。
- npm 依赖审计。
- 最终差异和敏感信息扫描。
- SQLite 文件和本地运行目录权限检查。

### 16.4 未默认执行的真实验收

- `coding.tu-zi.com` 真实后台登录。
- 真实邮箱接口取件。
- 真实 OpenAI 浏览器登录和验证码填写。
- 真实 OAuth 兑换和后台账号创建。
- 页面点击、浏览器自动化、视觉回归和截图对比。

这些项目必须由用户在实现完成后使用已经更换的凭据单独授权验收。未执行时，QA 必须如实记录，不能把模拟链路通过写成真实建号成功。

## 17. 开发步骤与依赖

1. 初始化 TypeScript、Fastify、Vue/Vite、Vitest 和构建配置。
2. 建立共享契约、错误类型、日志脱敏、本地安全和 SQLite 基础模块。
3. 实现后台客户端、登录/TOTP、Keychain 会话和单飞续期测试。
4. 实现选项适配器、快照校验和代理解析测试。
5. 实现邮箱客户端、标准化、基线、轮询和 OTP 筛选测试。
6. 根据脱敏邮箱成功响应样例固定生产适配器和 fixture。
7. 实现浏览器控制器、页面分类器、人工接管和回调捕获。
8. 实现任务状态机、秘密作用域、取消和中断恢复。
9. 实现 OAuth 兑换映射、查重、创建载荷和结果确认。
10. 实现设置页、任务页、历史页和 SSE 进度展示。
11. 完成本地模拟集成测试、类型检查、静态检查、构建和安全扫描。
12. 基于实际实现和测试结果编写 README、DOC 和 QA。

步骤 3、4、5 可在共享契约稳定后分别开发；浏览器和邮箱模块接口稳定后再接入步骤 8。步骤 6 需要脱敏响应样例，但不阻塞其他模拟实现。

## 18. 风险、取舍和回滚

### 18.1 主要风险

- 当前后台接口是部署前端使用的内部契约，升级后可能变化。
- OpenAI 页面、登录方式或回调形式变化可能触发人工接管。
- 邮箱成功响应结构尚未通过脱敏样例固定。
- 邮箱密码位于查询参数，外部邮箱服务及其代理日志可能记录秘密。
- OAuth 兑换响应必须短暂存在于内存，无法做到从进程内完全不可见。
- 后台创建接口当前未见通用幂等键，网络断开时只能通过查重降低重复风险。
- macOS Keychain 项由本机用户权限保护；同一系统账号下的恶意程序仍是本地威胁模型的一部分。

### 18.2 缓解措施

- 所有外部接口集中适配、运行时校验并用脱敏 fixture 固定。
- 页面未知时停止自动操作，不做猜测性点击。
- 邮箱请求固定主机、禁重定向、禁日志、限制响应。
- OAuth 凭据只在 `SecretScope` 内存中存在，创建结束立即释放引用。
- 创建前查重，结果不确定时先查询且不自动重放。
- 后台 refresh token 只进 Keychain，其他秘密不持久化。
- 普通任务记录和前端响应进行字段 allowlist，而不是事后删除秘密字段。

### 18.3 回滚

本地工具不执行数据库迁移到远端，也不修改后台服务代码。回滚方式：

1. 停止本地服务并关闭本工具启动的临时浏览器。
2. 在设置页退出或删除 Keychain 中 `up-icloud.coding-session` 项。
3. 备份后删除本地工具 SQLite 数据和缓存目录。
4. 回退到前一锁定依赖版本或删除本地工具目录。

已经成功创建的后台账号不会随本地回滚消失。若确需删除，必须由用户在后台账号管理中单独确认执行。

## 19. QA 与 DOC 计划

本功能从零建设且涉及登录会话、外部接口、权限和账号创建，最终需要同时生成：

- `QA.md`：记录实际环境、命令、单元/集成/类型/静态/构建/审计结果、异常覆盖、未执行真实页面测试和残留风险。
- `DOC.md`：记录安装、启动、设置页登录、任务操作、人工接管、会话退出、历史清理、接口边界、安全限制和维护方式。
- `README.md`：提供最短启动入口并链接到 DOC 和 QA。

三份文件只能描述最终实际实现，不得把本技术文档中的计划写成已完成。

## 20. 完成标准

只有满足以下条件才能报告开发完成：

1. 任务页始终有账号邮箱，并根据登录方式只显示邮箱取件信息，或独立的账号密码和 2FA 密钥；其他字段均为选择或固定值。
2. 后台登录密码不持久化，refresh token 只保存到 macOS Keychain，会话过期可重新登录。
3. 四种代理选择、并发数默认 10、可选供应商和多选分组均按后台现有选项工作。
4. 正常邮箱 OTP 路径、人工接管路径、取消路径和超时路径均已实现。
5. 授权链接、session、state、code 和 OAuth 兑换结果不进入前端、SQLite 或普通日志。
6. 创建请求固定为 OpenAI OAuth、账号名等于邮箱，并强制省略 `credentials.model_mapping`。
7. 两阶段查重和创建结果不确定时的防重复逻辑有自动测试。
8. 最终页面只显示后台账号 ID、名称、状态和已选配置，不显示任何令牌或完整凭据。
9. 类型检查、静态检查、单元测试、模拟集成测试、生产构建和敏感信息扫描通过。
10. README、DOC、QA 与最终实现一致，并明确真实后台/邮箱/OpenAI 页面是否完成用户验收。

## 21. 技术方案批准后的前置条件

批准本技术方案后才进入实施计划和编码。真实邮箱解析达到可验收状态前，还需要以下二选一：

- 提供脱敏后的邮箱成功响应样例，保留字段名、层级、消息 ID、时间、发件人、主题和正文结构；或
- 更换已经在聊天链接中暴露过的邮箱取件密码后，明确授权进行一次只读取件格式测试。

## 22. 设置页改用 Token 登录（已批准并实施）

本节记录 2026-08-11 提出并批准的认证流程变更。源码、自动测试、生产构建和当前 43123 运行服务均已切换到 Token 登录；真实 Token 表单提交不属于自动验证范围，现有 Keychain refresh token 已用于只读会话恢复和选项加载 smoke。

### 22.1 目标和现状

目标是让本地工具不再接收后台账号、密码或 TOTP，设置页改为一个“后台登录 Token”保密输入。任务页的两个输入和账号创建流程不变。

当前部署前端同时保存两种不同凭据：

- `auth_token`：后台 access token，可直接作为 Bearer 调用 `/auth/me` 和管理接口，但到期后不能单独续期。
- `refresh_token`：后台 refresh token，不能直接调用管理接口，但可通过 `POST /auth/refresh` 换取并轮换 access token。

因此不能把两者当成同一种 Token。只支持 `auth_token` 最接近“直接登录”，但会失去长期续期；只支持 `refresh_token` 最稳定，但用户必须明确复制正确的字段。

### 22.2 方案对比和推荐

| 方案 | 优点 | 缺点 | 结论 |
| --- | --- | --- | --- |
| 只接受 `auth_token` | 操作最直接；一次 `/auth/me` 即可验证 | Token 到期后必须重新粘贴；无法调用 refresh/logout 契约 | 不推荐作为唯一模式 |
| 只接受 `refresh_token` | 可长期恢复、轮换和续期；延续现有会话模型 | 不接受用户口中的 `auth_token`；复制错误时体验差 | 可用但范围偏窄 |
| 一个输入加 Token 类型选择 | 同时覆盖直接登录和长期会话；不需要用试错请求猜类型 | 设置页多一个受控选择项；会话管理需区分两种模式 | 推荐 |

推荐设置页保留一个自由输入，并增加 `Refresh Token（推荐）`、`Access Token` 两项分段选择。默认选择 Refresh Token。该选择不是新的账号信息输入，不影响任务页“只有两个自由输入”的约束。

不自动尝试两种 Token：将 refresh token 作为 Bearer 或将 access token 作为 refresh 请求正文虽然都发送到同一后台，但会扩大秘密进入非预期认证链路和服务端日志的风险。由用户明确选择类型更可审计。

### 22.3 用户流程和失效表现

Refresh Token 模式：

1. 设置页把 Token 通过受本地会话、Origin 和 CSRF 保护的 `POST /local-api/session/token` 发送给本地服务。
2. 本地服务调用 `POST /api/v1/auth/refresh`，接收 access token、可选轮换 refresh token 和过期时间。
3. 使用刷新响应中的用户信息；响应缺少用户时调用 `GET /api/v1/auth/me` 验证身份。
4. 把最终 refresh token 写入 macOS Keychain；access token 只留在内存。
5. 后续继续使用现有单飞续期、轮换、`401` 单次刷新和 Keychain 恢复机制。

Access Token 模式：

1. 本地服务只调用 `GET /api/v1/auth/me` 验证 Bearer Token 和权限。
2. Token 写入 macOS Keychain，进程内直接用于管理请求；不解析或信任 JWT 声明来判断身份和有效期。
3. 服务重启时从 Keychain 读取并再次调用 `/auth/me`，仍有效才恢复会话。
4. 任一管理请求返回 `401` 时清理本机会话并提示“Access Token 已失效，请重新粘贴”，不调用 refresh、不重放写请求。
5. Access Token 模式退出只清理本机 Keychain，无法通过当前 logout 契约撤销远端 access token；如需立即失效，用户必须在后台撤销会话。

两种模式验证成功后，设置页显示已连接用户和凭据模式，不显示 Token 内容。提交成功或失败后都立即清空输入引用。

### 22.4 本地接口和数据设计

新增本地请求：

```ts
POST /local-api/session/token
{
  tokenType: "refresh" | "access";
  token: string;
}
```

Token 长度限制为 1 到 16 KiB，只接受字符串，不接受 URL、JSON Token 包、`Bearer ` 前缀或多个 Token。公开响应继续只返回脱敏 `PublicSession`，新增非敏感字段 `credentialMode: "refresh" | "access" | null`。

设置页已经删除后台邮箱、密码和 TOTP 表单，不再调用 `/local-api/session/login` 与 `/local-api/session/login-2fa`；这两个本地路由、前端调用及后台账号密码/TOTP 适配器均已删除，避免保留未使用的密码接收面，不影响外部后台本身。

Keychain 值改为带版本的结构化凭据：

```ts
type StoredBackendCredential = {
  version: 1;
  mode: "refresh" | "access";
  token: string;
};
```

Keychain account 使用验证后的后台用户 ID，例如 `backend-user:<id>`；SQLite 只保存该非敏感 Keychain account 引用和公开身份摘要，不保存 Token。恢复时兼容现有以后台邮箱为 account、值为裸 refresh token 的旧项；只有旧凭据刷新和身份验证成功、且新凭据写入完成后才删除旧项。临时网络错误保留旧项并返回未认证状态，无效或已撤销的凭据才删除。

### 22.5 安全、错误和日志

- Token 输入保持 `type="password"`、`autocomplete="off"`，不提供明文持久化、复制回显或前端状态恢复。
- 请求正文、Authorization header、Keychain 值和后端响应 Token 全部经过现有脱敏边界，不进入普通日志、错误 details、SQLite、SSE 或任务历史。
- Refresh Token 无效返回 `BACKEND_REFRESH_TOKEN_INVALID`；Access Token 无效返回 `BACKEND_ACCESS_TOKEN_INVALID`；权限不足仍使用独立的 `BACKEND_FORBIDDEN`。
- 任何网络错误都不自动把同一个 Token 改按另一类型重试。
- Access Token 模式不在 `401` 后重放 POST、PUT 或 DELETE；Refresh Token 模式延续现有授权客户端语义，但写请求的网络错误仍不重放。

### 22.6 实际修改范围

- `src/web/views/SettingsView.vue`、`src/web/App.vue`、`src/web/api.ts`：单 Token 表单、类型选择、清空回调和会话模式显示。
- `src/shared/contracts.ts`：Token 登录请求与公开凭据模式。
- `src/server/routes/auth.ts`：Token 登录路由，删除账号密码/TOTP 本地路由。
- `src/server/session/manager.ts`、`src/server/session/keychain.ts`：双模式会话、结构化 Keychain 值和旧凭据迁移。
- `src/server/backend/auth.ts`：删除账号密码/TOTP 适配器，只保留 Access Token 验证、Refresh Token 换取和退出；现有授权客户端通过会话管理器实现 access-only 的 `401` 零重放。
- 认证、会话、本地 API、日志脱敏和前端状态测试；最终同步 `README.md`、`DOC.md`、`QA.md`。

### 22.7 测试、回滚和完成标准

自动测试已覆盖：两种 Token 成功路径、Token 类型和输入格式错误、无效/过期 Token、网络失败、refresh 轮换、access-only 的 `401` 零重放、结构化凭据恢复、旧 Keychain 项迁移、两种退出语义、本地接口安全及响应无 Token。前端单保密输入、默认模式、类型切换和失败后清空由隔离页面回归补充。

已通过类型检查、lint、134 项自动测试、生产构建和生产依赖审计；本地页面回归和真实旧 Keychain 恢复结果在 `QA.md` 记录。测试和文档未使用真实 Token，浏览器验证不展示 Token。

回滚时可恢复原账号密码登录代码；新版 Keychain 结构必须先由回滚版本识别或由用户在设置页退出清理，不能让旧版本把 JSON 凭据整体当成 refresh token 发送。Token 登录只有在上述兼容处理、测试和最终文档全部完成后才能报告完成。

任何方式都不得再把真实后台密码、邮箱密码、验证码、RT、Access Token 或完整 OAuth 响应写入聊天、代码、fixture、日志或文档。

## 23. 从当前 Chrome Dashboard 自动获取 Token（已取消，未实施）

本节对应原已确认的非技术效果说明 `docs/AUTO_TOKEN_PRODUCT_EFFECT.md`。2026-08-11 用户决定改回账号密码登录，因此本节方案取消，不进入开发。目标、权限、文件清单和测试内容仅保留为历史决策记录，不代表当前计划或已实现行为。

本节已经取消，不得新增扩展、桥接接口或自动读取逻辑，也不得把以下历史设计描述成已经上线。

### 23.1 现状与约束

现有行为：

- 本地服务启动时先从 macOS Keychain 恢复已经保存的后台 Token。
- 未保存或已失效时，设置页只能通过 `/local-api/session/token` 手动提交 Refresh Token 或 Access Token。
- 本地 API 依赖 HttpOnly Cookie、精确 Origin 和内存 CSRF，普通外部网页和 Chrome 扩展不能直接调用现有写接口。
- 本地页面不能跨源读取 `coding.tu-zi.com` 的 Web Storage；必须由有明确站点权限的 Chrome 扩展在目标页面内读取。
- 当前 43123 服务允许通过 `PORT` 修改端口，扩展不能假定所有安装永远使用默认端口。

本次新增约束：

- 自动获取只使用 `refresh_token`，不把 `auth_token` 当成长期凭据，也不自动猜测 Token 类型。
- 只有用户在设置页点击“从当前 Chrome 自动连接”后才执行；页面加载、后台轮询或普通刷新不得触发 Token 读取。
- Refresh Token 不能经过本地页面的 JavaScript 返回值、DOM、`window.postMessage`、剪贴板、通知、截图或扩展持久化。
- 扩展不能请求 Cookie、浏览历史、书签、下载、密码管理或 `<all_urls>` 权限。
- Dashboard 未登录、Token 缺失、扩展未安装或配对不一致时安全失败，不能退回读取其他页面或其他凭据。
- 手动 Token 登录保留为折叠备用路径，保证扩展故障时可以回滚。

### 23.2 Chrome 官方能力依据

本方案基于以下 Chrome 官方契约：

- [Manifest V3](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3) 使用按需启动的 extension service worker，并禁止远程托管扩展代码。
- [Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) 运行在隔离世界中，可以通过扩展消息与 service worker 通信；页面和内容脚本共享 DOM，但不共享 JavaScript 变量。
- [Storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies) 明确指出内容脚本调用 Web Storage 时访问的是宿主页面存储，因此 Dashboard 内容脚本可以读取该页面自己的 `refresh_token`；service worker 本身不能直接读取 Dashboard Web Storage。
- [Message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) 要求把来自内容脚本的消息视为不可信输入，并限制它能够触发的特权操作和返回数据。
- [Cross-origin network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests) 允许 service worker 在声明精确 `host_permissions` 后向目标后台和本机服务发起请求。
- [chrome.storage](https://developer.chrome.com/docs/extensions/reference/api/storage) 可保存扩展配对状态；配对密钥必须限制为 trusted extension contexts，不暴露给内容脚本，也不使用会跨设备同步的存储区。
- [Match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) 对 `127.0.0.1` 的匹配默认覆盖所有端口，因此扩展代码还必须校验并固定首次配对的精确本地 origin。

### 23.3 方案对比

| 方案 | 优点 | 缺点与风险 | 结论 |
| --- | --- | --- | --- |
| Token 经本地内容脚本返回页面，再调用现有登录接口 | 实现最少 | Token 会进入 DOM 消息和前端内存；任何同源脚本都可能观察；不满足秘密边界 | 拒绝 |
| Extension service worker 明文 POST 到 43123 | Token 不进入页面 | 本地服务停止后，其他进程若占用同一端口并诱导扩展请求，可看到明文 Token | 拒绝 |
| 首次信任配对，后续 AES-GCM 加密 POST | Token 不进入页面；端口后来被其他进程占用也只能得到密文；安装步骤仍可自动化 | 首次配对要求真实服务正在运行并已完成本地 bootstrap；实现和测试较多 | 推荐 |
| Chrome Native Messaging | Chrome 会校验扩展 ID 和本机 Host，安全边界最强 | 需要额外注册系统级 Host、固定绝对可执行路径和安装器；当前 Node 源码项目维护与卸载成本过高 | 本次不采用 |

推荐第三种。首次配对采用 trust-on-first-use：只有已经通过一次性 bootstrap 建立本地会话的页面才能创建配对挑战；扩展和本地服务在这次明确点击中生成并保存共享桥接密钥。配对完成后所有后台 Token 只以认证加密密文穿过 loopback HTTP。

### 23.4 总体组件

```text
本地设置页
  -> 创建一次性桥接挑战（Cookie + Origin + CSRF）
  -> 仅把 requestId / challenge / localOrigin 交给本地内容脚本
  -> extension service worker
      -> 选择当前 Profile 中最近使用的精确 Dashboard 标签
      -> 请求 Dashboard 内容脚本读取 refresh_token
      -> 使用配对密钥在 service worker 内加密
      -> 将密文 POST 到本地 bridge 完成接口
  -> 本地服务解密并调用 SessionManager.loginWithToken("refresh", token)
  -> 设置页重新读取公开会话并加载选项
```

职责边界：

- `local-content.js`：只在顶层 `127.0.0.1` 页面运行；转发非敏感挑战和公开结果，不接收 Token。
- `dashboard-content.js`：只在顶层 `https://coding.tu-zi.com/admin/*` 运行；仅响应 service worker 的一次性请求，并只读取 `refresh_token`。
- `service-worker.js`：校验消息、选择标签、管理扩展侧配对密钥、加密 Token、请求本地 bridge；不持久化 Token。
- 本地 `ChromeBridgeManager`：生成/消费挑战、管理服务端配对密钥、解密、限时和防重放。
- `SessionManager`：继续作为后台凭据验证、轮换、Keychain 保存和公开会话的唯一入口。
- 设置页：显示扩展状态、触发一次请求和接收公开结果；不出现 Token 变量或字段。

### 23.5 首次自动配对

1. 用户必须先通过一次性 bootstrap 进入本地工具。
2. 设置页检测到扩展后，用户点击“从当前 Chrome 自动连接”。
3. 本地页面通过受保护的本地 API 创建 `pair_and_connect` 挑战；挑战为 256 bit 随机值，保存在服务内存中，60 秒过期且只能消费一次。
4. 本地内容脚本只接受 `event.source === window`、精确 `location.origin`、顶层页面和严格版本化消息，然后把非敏感挑战发给 service worker。
5. 如果扩展尚未配对，service worker 生成 256 bit 随机桥接密钥，并把密钥、挑战、扩展 ID 和精确本地 origin 发送到配对接口。
6. 本地服务验证挑战仍有效、当前没有已有配对、origin 为环回地址且端口与挑战一致后，把桥接密钥写入独立 macOS Keychain 项。
7. service worker 只在服务端确认保存成功后，把同一密钥写入 `chrome.storage.local`，并将该存储区的访问级别设为 `TRUSTED_CONTEXTS`。
8. 配对完成后在同一次用户操作中继续读取并加密 Token，不要求用户复制配对码或再次点击。

服务端 Keychain：

```text
service: up-icloud.chrome-bridge
account: pairing-v1
value: { version, key, extensionId, localOrigin }
```

扩展存储：

```text
chrome.storage.local
{ version, key, localOrigin }
```

扩展存储不使用 `chrome.storage.sync`。Refresh Token 绝不写入扩展存储。

首次配对的信任前提是：真实本地服务已占用该 origin，用户通过终端生成的一次性 bootstrap 链接进入，并主动点击连接。已有配对不得被页面自动覆盖；如果两侧配对状态不一致，必须显式执行“重置扩展配对”后重新建立，防止端口被替换时静默换钥。

### 23.6 自动获取与加密传输

service worker 从 Dashboard 内容脚本收到 Token 后执行：

1. 再次验证发送方 tab ID、精确 origin、顶层 frame、请求 ID 和消息版本。
2. 校验 Token 是 1 至 16 KiB 的单个非空字符串，不接受 URL、JSON、数组、内部空白或 `Bearer ` 前缀。
3. 生成 96 bit 随机 IV。
4. 使用 AES-256-GCM 加密 UTF-8 Token。
5. 认证附加数据固定包含：协议版本、request ID、challenge、extension ID、Dashboard origin 和精确 local origin。
6. 只把 `version`、`requestId`、`challenge`、`iv` 和 `ciphertext` POST 到本地完成接口。
7. 在 `finally` 中清除 service worker 和 Dashboard 内容脚本中的 Token 引用；不记录请求正文。

本地服务按相同附加数据解密，挑战在任何完成尝试时立即消费。解密成功后只调用：

```ts
session.loginWithToken('refresh', decryptedToken)
```

SessionManager 仍负责调用 `/auth/refresh`、使用轮换后的 refresh token、验证公开身份、写入现有 `up-icloud.coding-session` Keychain 项。bridge 路由不自行保存后台 Token。

### 23.7 本地接口设计

受现有本地 Cookie、Origin 和 CSRF 保护：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/local-api/chrome-bridge` | 返回是否配对，不返回扩展 ID、密钥或 Token |
| `POST` | `/local-api/chrome-bridge/requests` | 用户点击后创建一次性 pair/connect 挑战 |
| `DELETE` | `/local-api/chrome-bridge` | 显式清理服务端配对，用于重新配对 |

只供扩展 service worker 使用，不依赖浏览器 Cookie：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/chrome-bridge/pair` | 首次挑战内提交桥接密钥并绑定 extension ID/local origin |
| `POST` | `/chrome-bridge/complete` | 提交 AES-GCM 密文，解密并验证 Refresh Token |

扩展接口必须：

- 只监听当前 `127.0.0.1` 服务，不开放到其他网卡。
- 严格限制 JSON schema、字段数量和编码后长度；全局 64 KiB 上限之外，密文单独限制 24 KiB。
- 校验 `Content-Type: application/json`、挑战、协议版本、配对 extension ID 和精确 local origin。
- 设置 `Cache-Control: no-store`、现有安全响应头和不含秘密的错误码。
- 不把请求 body、IV、密文、挑战、配对密钥或解密错误 details 写入日志。
- 配对挑战和连接挑战一次性消费；过期、重复、并发第二个请求和重放都返回统一公开错误。
- 每个本地会话同时最多一个活动 bridge 请求；创建频率限制为每分钟 5 次。

公开错误码：

```text
CHROME_EXTENSION_NOT_FOUND
CHROME_BRIDGE_NOT_PAIRED
CHROME_BRIDGE_PAIRING_MISMATCH
CHROME_BRIDGE_CHALLENGE_INVALID
CHROME_BRIDGE_REQUEST_EXPIRED
CHROME_DASHBOARD_NOT_FOUND
CHROME_DASHBOARD_NOT_AUTHENTICATED
CHROME_REFRESH_TOKEN_MISSING
CHROME_BRIDGE_PAYLOAD_INVALID
CHROME_BRIDGE_DECRYPT_FAILED
```

后台 Token 无效继续使用现有 `BACKEND_REFRESH_TOKEN_INVALID`，不混同为扩展错误。

### 23.8 Manifest V3 权限

扩展目录使用纯本地静态代码，不加载 CDN、远程脚本、远程字体或分析服务。

计划权限：

```json
{
  "manifest_version": 3,
  "permissions": ["storage"],
  "host_permissions": [
    "https://coding.tu-zi.com/*",
    "http://127.0.0.1/*"
  ]
}
```

不申请：

```text
cookies
history
bookmarks
downloads
clipboardRead
clipboardWrite
passwordsPrivate
nativeMessaging
<all_urls>
```

`https://coding.tu-zi.com/*` 的 host permission 允许查询并向匹配标签发送扩展消息；内容脚本的静态 match 进一步限制为 `/admin/*`。`http://127.0.0.1/*` 因 Chrome match pattern 会覆盖所有端口，local 内容脚本必须在运行时要求：

- 顶层页面；
- `hostname === "127.0.0.1"`；
- 当前 origin 与首次配对保存的 `localOrigin` 完全相同；
- 页面消息声明的 origin 与 `location.origin` 完全相同。

扩展不支持 `localhost`、`0.0.0.0`、局域网 IP 或任意用户输入域名。

### 23.9 Dashboard 选择与登录判断

- service worker 只查询 `https://coding.tu-zi.com/admin/*` 标签。
- 优先选择当前活动且匹配的标签；没有活动匹配时选择 `lastAccessed` 最新的匹配标签。
- 多个匹配标签属于同一 Chrome Profile，通常共享同一 origin 的 Web Storage；仍只读取选中的一个标签。
- 内容脚本只读取 `refresh_token`，不读取 `auth_token`、`auth_user`、Cookie、DOM 表单、密码框或页面正文。
- Token 缺失时只返回 `CHROME_REFRESH_TOKEN_MISSING`；不会把 access token 当成替代值。
- 后台实际有效性只由本地 SessionManager 调用 `/auth/refresh` 决定，不信任 Dashboard DOM 是否看起来已登录。

### 23.10 设置页状态与交互

未连接设置页分为三块，不嵌套卡片：

1. 扩展状态行：`检测中`、`扩展未安装`、`扩展已就绪`、`需要重新配对`。
2. 主命令：`从当前 Chrome 自动连接`；未找到 Dashboard 时显示 `打开后台 Dashboard` 和 `重新检测`。
3. 折叠备用：现有 Refresh/Access 类型选择、Token 密码输入和手动连接按钮。

前端桥接模块只接收公开状态：

```ts
type ChromeBridgeResult =
  | { ok: true }
  | { ok: false; code: ChromeBridgePublicErrorCode }
```

成功后前端重新调用 `/local-api/session`，再并发加载选项、任务历史和活动任务。扩展消息不得携带 `token`、`refreshToken`、`accessToken` 或任意未列入协议的字段；前端状态模型继续禁止这些字段。

### 23.11 文件范围

新增：

- `extension/manifest.json`
- `extension/service-worker.js`
- `extension/dashboard-content.js`
- `extension/local-content.js`
- `extension/popup.html`、`extension/popup.js`、`extension/popup.css`
- `extension/shared/protocol.js`
- `extension/icons/`：本地打包的扩展图标
- `scripts/build-extension.mjs`
- `src/server/chrome-bridge/manager.ts`
- `src/server/chrome-bridge/crypto.ts`
- `src/server/routes/chrome-bridge.ts`
- `src/web/chrome-bridge.ts`
- 对应 unit/integration tests

修改：

- `src/server/index.ts`：装配独立 bridge Keychain store 和 manager。
- `src/server/app.ts`：注册受保护的本地 bridge 路由和两个显式扩展端点；不放宽其他 `/local-api/` hook。
- `src/shared/contracts.ts`：公开 bridge 状态和严格请求 schema。
- `src/web/api.ts`、`src/web/App.vue`、`src/web/views/SettingsView.vue`、`src/web/styles.css`：自动连接和备用手动路径。
- `package.json`：生产构建加入扩展复制/校验，不新增运行时第三方依赖。
- `README.md`、`DOC.md`、`QA.md`：安装、权限、使用、验证和限制。

不修改后台、数据库 schema、任务编排、OpenAI OAuth、邮箱轮询或账号创建载荷。

### 23.12 测试方案

自动测试必须覆盖：

- 挑战随机性、60 秒过期、一次性消费、并发限制、频率限制和重放拒绝。
- 首次配对成功、已有配对拒绝覆盖、两侧不一致安全失败和显式重置。
- AES-GCM 正常解密；错误 key、IV、附加数据、密文篡改和超长载荷全部失败。
- 扩展完成接口没有本地 Cookie 时只能凭有效挑战和密文成功；普通网页、错误 Origin、错误 extension ID 和未知字段被拒绝。
- Dashboard 精确标签选择、无标签、无 refresh token、多个标签和非顶层 frame。
- Token 不进入 local 内容脚本消息、前端 API、公开响应、日志、SQLite、扩展 storage 或构建产物。
- 自动连接使用 Refresh 模式；后台无效 Token 不保存；轮换、重启恢复和退出行为保持现有语义。
- 手动 Refresh/Access Token 备用流程不回归。
- 扩展 manifest 权限精确，不含禁止权限或远程代码。

验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
```

页面和扩展验收：

- 页面测试是本功能的必测完成条件，不得只以单元测试、接口测试、构建通过或代码检查代替。
- 使用 Browser 插件验证本地设置页的扩展状态、自动连接按钮、备用折叠区、错误状态和移动端布局。
- 使用隔离 Chrome Profile 加载 unpacked extension 和合成 Dashboard fixture，验证消息、配对和密文路径；不使用真实 Token 作为自动测试 fixture。
- 页面测试至少覆盖桌面端和移动端视口、扩展未安装/已就绪、Dashboard 未找到、配对失败、自动连接成功、手动备用区展开和页面控制台无未处理错误；检查文字不裁切、控件不重叠且页面无水平溢出。
- 最后在用户明确安装扩展后，从真实已登录 Dashboard 执行一次受控页面 smoke，实际点击“从当前 Chrome 自动连接”，只观察公开“已连接”和选项加载结果，不读取、打印、截图或返回 Token。
- 页面截图只能覆盖不含真实身份和敏感信息的状态；真实连接页面如果无法可靠隐藏身份信息，则仅记录文字验收结果，不保留截图。

### 23.13 构建、安装与运行

`npm run build` 生成：

```text
dist/web
dist/server
dist/chrome-extension
```

`scripts/build-extension.mjs` 只复制 allowlist 文件并校验 manifest、禁止权限、远程脚本引用和所需资源存在。扩展安装采用 Chrome `chrome://extensions` 的“加载已解压的扩展程序”，选择 `dist/chrome-extension`。本次不自动发布 Chrome Web Store，也不自动修改 Chrome Profile 或企业策略。

安装后：

1. 用户刷新已打开的 Dashboard 和本地工具标签，使内容脚本生效。
2. 通过一次性 bootstrap 进入本地工具。
3. 点击“从当前 Chrome 自动连接”，首次自动配对并连接。
4. 后续启动优先从 Keychain 恢复；仅在凭据失效时再次使用扩展。

### 23.14 回滚与清理

- 扩展不可用时展开现有手动 Token 入口，不影响任务功能。
- 回滚 UI 和 bridge 路由前先在设置页执行“重置扩展配对”，删除 `up-icloud.chrome-bridge` Keychain 项。
- 扩展 popup 提供“清除本机配对”；卸载扩展会删除其 `chrome.storage.local`。
- 删除 bridge 配对不删除现有后台登录 Keychain，会话退出仍通过原设置页单独执行。
- 不需要数据库迁移或数据回滚。
- 即使只卸载扩展，现有手动 Token 和已经保存的后台会话仍可继续使用。

### 23.15 风险和完成标准

已缓解风险：

- 外部网页不能创建挑战，因为仍需本地 Cookie、精确 Origin 和 CSRF。
- Token 不返回本地页面，降低页面脚本或 DOM 消息泄露面。
- 首次配对后，即使另一个进程后来占用同一 loopback 端口，也只能收到无法解密的密文。
- 内容脚本消息、密文和 challenge 均严格校验并一次性使用。
- 扩展权限限制在目标后台和环回地址。

残留风险：

- 首次配对是 trust-on-first-use；如果用户首次配对时运行的并非真实本地工具，扩展可能与错误进程建立信任。一次性终端 bootstrap 和显式用户点击是当前项目形态下的确认边界。
- 有权调试扩展 service worker、修改本地源代码或读取当前 macOS 用户 Keychain 的本机攻击者不在本工具可防御范围内。
- 后台前端可能更改 Web Storage key、登录流程或管理路径；扩展必须安全失败并更新契约，不能猜测其他字段。
- unpacked extension 更新后需要在 Chrome 扩展页重新加载，并刷新现有标签。

完成标准：

1. 用户在已登录 Dashboard 的同一 Chrome Profile 中点击一次即可连接，无需查看、复制或粘贴 Token。
2. Token 只在 Dashboard 内容脚本、extension service worker 和本地服务解密内存中短暂存在。
3. 页面、扩展 popup、日志、错误、SQLite、任务历史、截图和构建扫描都不出现 Token。
4. 扩展缺失、Dashboard 缺失、未登录、配对错误、密文篡改和后台 Token 无效都有可区分的安全失败。
5. 手动 Token 登录、Keychain 恢复、任务流程和现有 134 项测试保持通过，并新增 bridge/extension 覆盖。
6. 完成类型检查、lint、全量测试、生产构建、生产依赖审计、扩展权限扫描、隔离扩展 E2E，以及桌面端、移动端和真实自动连接的最终页面回归；页面测试未通过时不得报告功能完成。
7. 更新 README、DOC、QA，并在最终构建通过后重启 43123 服务；未安装或未通过真实 smoke 前不得报告“当前 Chrome 自动获取已完成”。

## 24. 设置页恢复账号密码登录（已批准并实施）

本节对应已确认的非技术效果说明 `docs/ACCOUNT_PASSWORD_LOGIN_PRODUCT_EFFECT.md`。目标是用后台登录邮箱和密码替换当前手动 Refresh/Access Token 输入，并兼容后台按账号返回的 TOTP 中间状态。Chrome 自动取 Token 方案已经取消，不在本节范围内。

本节于 2026-08-12 获用户批准并完成实施。自动测试、生产构建、依赖审计以及桌面/移动端合成页面回归已经通过；真实有效后台账号密码和账号级 TOTP 尚未提交，仍需用户在本地页面验收。

### 24.1 现状和外部契约复核

2026-08-12 对 `https://coding.tu-zi.com/admin/` 当前公开 HTML 和静态资源进行了只读复核，没有发送账号、密码、验证码或登录请求。确认：

- 登录接口为 `POST /api/v1/auth/login`；当前登录页提交 `email`、`password`，并只在站点启用交互验证码时追加对应验证码字段。
- 普通登录成功返回 `access_token`、可选 `refresh_token`、可选 `expires_in` 和 `user`。
- 需要 TOTP 时返回 `requires_2fa: true`、`temp_token` 和可选 `user_email_masked`，此时不应建立已认证会话。
- TOTP 接口为 `POST /api/v1/auth/login/2fa`，请求字段为 `temp_token` 和 `totp_code`；成功响应与普通登录成功响应一致。
- 当前公开配置中 `turnstile_enabled`、`tencent_captcha_enabled`、`aliyun_captcha_enabled`、`login_agreement_enabled` 和全局 `totp_enabled` 均为 `false`。这些是当前部署事实，不作为永久假设；账号级响应仍按 `requires_2fa` 处理。
- 会话续期、当前用户和退出接口仍分别为 `/auth/refresh`、`/auth/me`、`/auth/logout`，现有会话管理和管理接口客户端可以复用。

当前源码已经删除账号密码/TOTP 适配器和本地路由，只保留：

- `POST /local-api/session/token`；
- `SessionManager.loginWithToken()`；
- 设置页 Token 类型选择和一个 Token 保密输入；
- Keychain 中 `{ version: 1, mode: "refresh" | "access", token }` 结构化凭据。

因此本次不是只改界面，必须同步恢复后台认证适配器、本地契约、SessionManager 中间态、前端状态和测试，同时移除 Token 输入面。

### 24.2 方案对比和选择

| 方案 | 优点 | 缺点与风险 | 结论 |
| --- | --- | --- | --- |
| 本地服务直接调用后台账号密码/TOTP API | 复用现有接口；不依赖页面 DOM；成功后继续使用 Refresh Token 续期 | 本地服务在请求期间接触密码；交互验证码启用后不能自行完成 | 推荐 |
| 自动控制后台登录页面并读取结果 | 可承载 CAPTCHA/登录协议页面 | 需要持久浏览器状态或读取 Token，重新引入浏览器权限和页面脆弱性 | 不采用 |
| 保留手动 Token 作为备用 | 外部认证变化时可绕过本地登录适配器 | 与用户明确要求改回账号密码冲突，继续暴露 Token 输入面 | 不采用 |

采用第一种。前提是当前站点未启用交互验证码；如果以后启用，工具必须安全失败并提示用户当前版本不支持该交互登录条件，不能伪造验证码字段、自动同意协议或回退读取 Chrome Token。

### 24.3 用户流程和状态模型

未认证设置页状态：

```text
credentials -> submitting_credentials -> authenticated
                                  |----> totp_required
totp_required -> submitting_totp -> authenticated
       |                 |-------> totp_required（验证码错误，可重试）
       |-------------------------> credentials（取消或挑战过期）
```

流程：

1. 设置页提交登录邮箱和密码。
2. 本地服务先读取后台公开认证配置。发现 Turnstile、腾讯验证码、阿里验证码或必须先确认的登录协议时，不发送密码，返回固定的交互登录不支持错误。
3. 配置允许后调用 `/auth/login`。该 POST 网络失败不自动重放，避免重复登录尝试和账号锁定风险。
4. 普通成功时验证用户信息和 Refresh Token，保存会话并返回脱敏公开用户。
5. 需要 TOTP 时，服务端生成一次性本地 `attemptId`，只把 `attemptId`、脱敏邮箱和 5 分钟到期时间返回页面；后台 `temp_token` 仅留在 SessionManager 内存。
6. 页面提交 `attemptId` 和六位数字 TOTP；服务端用内存中的 `temp_token` 调用 `/auth/login/2fa`。
7. 成功后销毁 TOTP 中间态，保存 Refresh Token，加载任务选项并进入“添加账号”。
8. 用户取消、挑战超时、开始新的账号密码登录、登录成功或服务退出时，都销毁旧 TOTP 中间态。

同时只允许一个认证提交。并发账号密码或 TOTP 请求返回 `LOGIN_IN_PROGRESS`，不能让较晚返回的旧请求覆盖新会话。

### 24.4 本地接口和公开契约

新增严格 schema：

```ts
type PasswordLoginInput = {
  email: string       // trim + lowercase，标准邮箱，最大 320
  password: string    // 不 trim，1..1024
}

type TotpLoginInput = {
  attemptId: string   // 服务端生成的 256-bit base64url 值
  code: string        // 精确 6 位数字
}

type PasswordLoginResult =
  | { state: 'authenticated'; session: PublicSession }
  | {
      state: 'totp_required'
      attemptId: string
      maskedEmail: string | null
      expiresAt: string
    }
```

本地路由：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/local-api/session/login` | 提交后台邮箱和密码 |
| `POST` | `/local-api/session/login-2fa` | 提交本地 attempt ID 和 TOTP |
| `DELETE` | `/local-api/session/login-pending` | 取消当前 TOTP 中间态 |
| `DELETE` | `/local-api/session` | 退出已经建立的后台会话 |

删除 `/local-api/session/token`，前端也不再保留调用代码。所有写接口继续要求一次性 bootstrap 建立的 HttpOnly Cookie、精确 loopback Origin 和内存 CSRF header。

公开响应不包含 `password`、`totp_code`、后台 `temp_token`、access token 或 refresh token。`PublicSession` 去掉仅服务于 Token 输入界面的 `credentialMode`；页面只显示认证状态和脱敏用户摘要。

### 24.5 后台适配器设计

`BackendAuthApi` 新增：

```ts
getPublicAuthRequirements(): Promise<PublicAuthRequirements>
login(email: string, password: string): Promise<BackendLoginResult>
login2FA(tempToken: string, code: string): Promise<BackendTokens>
```

后台响应使用互斥 Zod union：

- `requires_2fa === true` 时必须有非空 `temp_token`，不得同时当作成功 Token 响应；
- 成功时必须有非空 `access_token`、`refresh_token` 和合法 `user`，`expires_in` 可选；
- 缺 Refresh Token 时不建立不可恢复的半会话，返回 `BACKEND_LOGIN_RESPONSE_INVALID`；
- 未知字段不向其他模块透传；
- `401` 账号密码错误映射为固定 `BACKEND_LOGIN_INVALID`，不返回后台原始消息；
- TOTP 失败映射为固定 `BACKEND_TOTP_INVALID_OR_EXPIRED`，避免回显服务端敏感细节；
- 登录成功但后续管理接口返回 `403` 时保留会话并明确显示权限不足，不误报密码错误。

公共认证配置只 allowlist 读取交互验证码和登录协议开关。任一交互条件启用时返回 `BACKEND_INTERACTIVE_LOGIN_REQUIRED`，不提交空验证码或尝试绕过。

### 24.6 SessionManager 和 Keychain 兼容

SessionManager 新增内存态：

```ts
type PendingTotpLogin = {
  attemptId: string
  tempToken: string
  maskedEmail: string | null
  expiresAt: number
}
```

密码只作为 `login(email, password)` 的局部参数传给后台适配器，不保存为类字段。JavaScript 字符串无法保证物理内存清零，因此安全边界是：不持久化、不记录、不返回、请求结束后不再持有引用；前端在请求结束的 `finally` 中清空输入。

Keychain 服务名保持 `up-icloud.coding-session`，结构版本保持 v1，避免数据迁移：

```json
{ "version": 1, "mode": "refresh", "token": "<backend refresh token>" }
```

兼容策略：

- 新的账号密码/TOTP 登录只保存 Refresh 模式；不再产生 Access 模式凭据。
- 已有 Refresh 模式和旧邮箱键名的裸 Refresh Token 继续按现有逻辑恢复和迁移。
- 已有 Access 模式结构化凭据允许只读兼容恢复，避免升级后立即退出；Access Token 失效后清理并回到账号密码登录，不再提供手动 Access Token 入口。
- 新登录成功后用 `backend-user:<id>` 写入轮换后的 Refresh Token，并删除旧账号项；保存前后都不把后台邮箱当作密码存储值。
- 主动退出继续调用 `/auth/logout` 并最终清理 Keychain；即使远端网络失败，本地清理仍完成。

### 24.7 前端实现

`SettingsView.vue`：

- credentials 状态显示后台登录邮箱和密码；密码使用 `autocomplete="current-password"`，提供眼睛图标显示/隐藏。
- totp_required 状态显示脱敏邮箱（若后台提供）、单个六位数字输入、验证按钮和“返回账号密码登录”。
- 已认证状态只显示用户摘要和退出按钮，不显示凭据模式。
- 密码和 TOTP 的 ref 在成功、失败、取消和组件卸载时全部清空；不写 localStorage/sessionStorage。
- actionBusy 时锁定当前提交，控件尺寸保持稳定，不因加载文案改变布局。

`App.vue` 管理公开认证步骤，不保存后台 `temp_token`。账号密码成功或 TOTP 成功后统一调用 `loadAuthenticatedData()`；选项加载失败时保留已认证状态并显示真实分类后的公开错误。

### 24.8 安全、异常和兼容边界

- Fastify 继续关闭普通请求日志；未预期错误日志只记录路由、错误类型和固定错误码，不记录请求体。
- 密码/TOTP 路由请求体不进入数据库、任务状态、SSE、浏览器控制器或任何错误 details。
- 登录和 TOTP POST 都只发送一次，不做网络级自动重试。
- TOTP 中间态 5 分钟过期且一次只保留一个；attempt ID 使用 256-bit 随机值并用恒定时间比较，消费成功后立即删除。
- 后台返回无效 schema、HTML、重定向或跨主机响应时安全失败。
- 当前本地 bootstrap、Cookie、Origin、CSRF、CSP 和环回监听保护不放宽。
- 不处理或绕过 CAPTCHA、其他 MFA、密码重置、登录协议、管理员合规确认或账号权限配置。
- 不修改 `coding.tu-zi.com`，也不读取 Chrome 登录状态。

### 24.9 修改范围

修改：

- `src/shared/contracts.ts`：账号密码、TOTP 和公开登录结果 schema；删除 Token 登录公开契约。
- `src/server/backend/auth.ts`：恢复账号密码/TOTP 适配器和公开认证条件预检。
- `src/server/session/manager.ts`：登录、TOTP 中间态、Refresh-only 新凭据保存和旧 Access 凭据兼容。
- `src/server/routes/auth.ts`：恢复三个本地认证路由并删除 Token 路由。
- `src/web/api.ts`、`src/web/App.vue`、`src/web/views/SettingsView.vue`、`src/web/styles.css`：账号密码/TOTP 页面流程。
- `tests/unit/contracts.test.ts`、`tests/unit/session-manager.test.ts`、`tests/integration/backend-auth.test.ts`、`tests/integration/local-api.test.ts`、`tests/unit/web-state.test.ts`：契约和回归。
- `README.md`、`DOC.md`、`QA.md`、本技术文档和效果说明：最终实际行为与验证记录。

不新增 Chrome 扩展、数据库迁移、运行时依赖或后台配置；不修改任务编排、邮箱轮询、OpenAI OAuth、代理解析和账号创建载荷。

### 24.10 开发顺序和测试

开发顺序：

1. 先写合成契约、后台认证和 SessionManager 失败测试。
2. 实现后台响应 union、交互条件预检、登录/TOTP 和 Keychain 兼容。
3. 写本地 API 安全与秘密不回显测试，再替换路由。
4. 替换前端状态和设置页，删除全部 Token 输入及调用引用。
5. 运行聚焦测试，扫描生产源码和构建产物中的旧路由、敏感字段和 Chrome 扩展残留。
6. 运行全量类型检查、lint、测试、生产构建和生产依赖审计。
7. 使用隔离数据目录执行桌面端和移动端页面测试；模拟成功、TOTP、错误密码、错误验证码、网络错误和权限错误。
8. 在用户提供凭据但不向聊天输出的前提下执行一次真实页面登录 smoke，只观察已连接状态和后台选项加载；测试过程不截图或记录真实账号、密码、TOTP 或 Token。
9. 最终更新 README、DOC、QA，重建并重启 43123，生成新的 bootstrap 链接。

验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm audit --omit=dev
```

页面测试是必测完成条件，至少覆盖：

- 桌面 1280x720 和移动 390x844；
- 账号密码表单、密码显隐、提交锁定和错误后清空；
- TOTP 步骤、六位输入、错误重试、取消和超时；
- 已连接和退出状态；
- 无水平溢出、文字不裁切、控件不重叠、控制台无未处理错误；
- 页面、网络响应可见内容、控制台和截图不包含密码、TOTP、后台临时 Token 或会话 Token。

### 24.11 回滚、风险和完成标准

回滚：恢复 Token 登录源码时，现有 v1 Keychain 格式仍可被旧实现识别，不需要数据库回滚。账号密码版本没有保存密码或 TOTP，不存在秘密数据清理迁移。回滚前停止新服务，重建旧产物并重新生成 bootstrap nonce。

主要残留风险：

- 后台认证接口不是公开版本化契约，字段或错误码更新后适配器会安全失败，需要重新复核静态资源。
- 后台以后启用 CAPTCHA 或强制登录协议时，直接 API 登录会被明确阻止，不能继续使用，除非另行确认新的产品流程。
- JavaScript 内存无法保证字符串物理擦除；本方案通过最短引用生命周期和禁止持久化/日志降低风险。
- 真实页面测试需要用户在本地页面自行输入真实凭据；自动测试只使用 `.invalid` 域名和合成秘密。

完成标准：

1. 最终设置页只有后台登录邮箱、密码，以及后台要求时出现的 TOTP；没有 Token 类型或 Token 输入。
2. 普通登录和 TOTP 登录都能建立 Refresh 会话、加载后台选项并在重启后恢复。
3. 密码、TOTP、后台 `temp_token`、access token 和 refresh token不进入公开响应、日志、SQLite、任务历史或截图。
4. 旧 Refresh 凭据继续恢复；已有 Access 凭据仅兼容恢复，失效后回到账号密码登录。
5. 交互验证码/协议启用、错误凭据、TOTP 错误或过期、网络失败、权限不足和合规要求均安全失败且提示可区分。
6. Token 路由和前端 Token 输入完全移除，Chrome 扩展和自动取 Token 保持未实施。
7. 聚焦测试、全量测试、类型检查、lint、生产构建、依赖审计、敏感信息扫描和页面测试全部通过。
8. README、DOC、QA 与最终实现一致；未完成真实页面 smoke 时必须明确标记未验收，不得报告真实登录已经完成。

## 25. 验证码两轮等待与单次自动重发（已批准并实施）

本节对应已经确认的产品效果：第一轮最多等待 30 秒；仍未取得可安全使用的验证码时在任务页提醒，并在确认浏览器仍处于 OpenAI 验证码页后自动点击一次“重新发送验证码”；随后第二轮最多再等待 30 秒。第二轮成功则继续自动填写，第二轮仍无可靠结果或页面不满足安全条件时保留本次无痕 Chrome 并进入人工接管。

“两轮”固定指总共两轮，自动重发最多一次。本节不扩大浏览器权限，不绕过 CAPTCHA、密码、MFA、账号选择、风控或未知页面，也不增加真实邮箱、真实 OAuth 或页面测试作为默认开发动作。

本节已经覆盖第 10.3 节原有的单轮 10 分钟总等待参数；其他邮箱请求、基线、新鲜度和秘密生命周期约束继续有效。

### 25.1 当前实现事实与问题边界

当前运行代码已经具备：

- 邮件常规轮询间隔 3 秒，临时错误额外等待上限 5 秒，单次邮箱请求超时 15 秒；
- 初始邮箱基线，以及在实际触发验证码发送前刷新并合并基线；
- 按可靠 `receivedAt` 选择唯一最新验证码；时间缺失、最新时间并列或最新邮件自身包含多个验证码时停止猜测；
- OpenAI 验证码页识别、验证码填写、回调捕获和人工接管；
- CAPTCHA、密码、MFA、账号选择、提供方错误和未知页面的闭合失败或接管边界。

实施前缺口（现已解决）：

- `MailOtpPoller.waitForOtp()` 是最长 10 分钟的单轮等待，超时只抛出 `MAIL_OTP_TIMEOUT`；
- 多候选冲突立即抛出 `MAIL_OTP_CONFLICT`，无法由编排器区分“本轮暂时没有邮件”和“本轮已有但仍不可靠”；
- `OAuthBrowserSession` 没有受限的重发操作；
- 任务状态只有 `waiting_for_otp`，不能向页面准确表示重发中和第二轮等待；
- `MailboxSource` 只返回 `MailMessage[]`，没有声明来源是否保证最新邮件排在第一条；
- 当前 OpenAI OTP 合成 fixture 没有重发按钮，缺少重发按钮存在、缺失、禁用和页面变化测试。

事实与推断必须分开：Cloud Mailbox 适配器会在本地按经过 schema 校验的 `receivedAt` 降序排序，这是代码可以保证的事实；`mail.php`、Assurivo 和路径式收件页的原始列表顺序没有版本化契约，不能仅凭一次或两次返回顺序相同就推断“第一条一定最新”。

### 25.2 方案对比与选择

| 方案 | 优点 | 缺点与风险 | 结论 |
| --- | --- | --- | --- |
| 继续单轮等待，冲突立即接管 | 改动最小，误填风险低 | 慢邮件只能长期等待；用户必须手动重发；不能满足已确认效果 | 不采用 |
| 遇到超时或冲突后无限自动重发 | 自动化率高 | 可能触发提供方频控、产生多封有效邮件并扩大验证码歧义 | 不采用 |
| 两个 30 秒轮次，轮间最多重发一次 | 等待上限明确；能覆盖常见邮件延迟；自动点击次数可审计 | 需要新增状态、重发控件识别和第二轮新鲜度边界 | 推荐并采用 |

推荐方案仍然以可靠时间优先。列表顺序只作为受限兜底，并且同时满足以下条件时才允许使用：

1. 邮箱适配器在代码中明确声明该来源为 `newest_first`，声明必须来自已验证契约或本地确定性排序，不能由运行时观察临时升级；
2. 候选邮件属于当前轮次，未出现在该轮基线中，且正文上下文明确属于 OpenAI/ChatGPT；
3. 连续两次串行轮询的第一封候选邮件具有相同的稳定标识和相同验证码；
4. 两次轮询至少相隔一个正常轮询周期，不能对同一响应对象重复判断；
5. 第一封邮件自身只包含一个六位验证码。

来源未声明为 `newest_first`、首项身份无法稳定确认、两次首项变化、第一封自身多码或页面已经离开验证码页时，都不得自动填写。连续两次稳定只是已验证来源上的附加防护，不足以把未知来源升级成已验证来源。

### 25.3 邮箱来源能力与轮询结果

将邮箱读取结果从裸数组改成带来源能力的内部快照：

```ts
type MailboxOrdering = 'newest_first' | 'unknown'

interface MailboxSnapshot {
  messages: MailMessage[]
  ordering: MailboxOrdering
}

interface MailboxSource {
  listMessages(
    email: string,
    mailboxPassword: string,
    signal?: AbortSignal,
  ): Promise<MailboxSnapshot>
}
```

初始能力分配：

| 来源 | 初始能力 | 依据与处理 |
| --- | --- | --- |
| Cloud Mailbox | `newest_first` | 适配器校验时间字段后在本地确定性降序排序；即便如此仍先走可靠时间选择 |
| `mail.php` | `unknown` | 当前 HTML 契约没有正式声明列表排序语义 |
| Assurivo | `unknown` | 当前 JSON 字段契约不等于最新优先排序契约 |
| 路径式收件页 | `unknown` | 通常标准化为单个聚合消息，不借此推断列表顺序 |

以后只有新增脱敏契约 fixture、适配器断言和对应测试后，才能把其他来源改成 `newest_first`。不能根据生产运行时连续两次顺序相同自动记忆或持久化能力。

每轮轮询返回结构化内部结果，不再用超时和候选歧义控制正常分支：

```ts
type MailOtpRoundResult =
  | { kind: 'found'; code: string }
  | { kind: 'timed_out'; observedCandidates: boolean }
  | {
      kind: 'ambiguous'
      reason: 'missing_time' | 'latest_tied' | 'multiple_codes' | 'order_changed'
    }
```

验证码仍是秘密，只能在任务活动内存和 `SecretScope` 中短暂存在；上述结果不得整体写入任务记录、SSE、SQLite 或日志。公开任务只显示固定、无候选内容的阶段消息。

每轮固定最多 30 秒：

- 正常间隔保持 3 秒，临时失败退避仍不得超过 5 秒；
- 邮箱认证失败、链接失效、契约变化和非重试错误立即终止，不消耗完 30 秒，也不点击重发；
- 临时网络错误可在本轮剩余时间内继续；到达本轮截止时间后按 `timed_out` 收敛；
- 发现冲突时继续观察到本轮截止时间，为可靠时间或允许的顺序兜底保留收敛机会；截止时仍冲突才返回 `ambiguous`；
- 任务取消使用同一个 `AbortSignal` 立即中止邮箱请求、等待和后续浏览器动作。

### 25.4 浏览器重发操作

`OAuthBrowserSession` 新增一次性重发能力：

```ts
interface OAuthBrowserSession {
  // 现有方法省略
  resendOtp(beforeOtpRequest?: () => Promise<void>): Promise<OtpResendResult>
}

type OtpResendResult =
  | BrowserActionResult
  | { kind: 'callback_captured' }
```

控制器执行顺序：

1. 再次分类当前顶层页面；合法回调、安全挑战、密码、MFA、账号选择和提供方错误优先于重发逻辑处理。
2. 只有分类结果仍是 OpenAI OTP 输入页时才查找重发控件。
3. 控件只接受精确的可见文本：`重新发送验证码`、`再次发送验证码`、`Resend code`、`Send again`；按钮或链接必须唯一、可见且可用。
4. 点击前调用 `beforeOtpRequest` 刷新邮箱基线。刷新失败时不点击，按邮箱错误收敛。
5. 基线刷新成功后记录第二轮新鲜度起点，并只执行一次 click。控制器保存本会话的已点击标记，任何调用重入都不得第二次点击。
6. 点击已发出但页面没有导航不视为失败，因为验证码页通常原地显示倒计时或提示；不因缺少页面变化再次点击。
7. 点击前 DOM 失效、控件缺失/禁用/不唯一或点击结果不确定时进入人工接管，保留当前无痕窗口。

该方法不寻找任意包含“发送”或 `resend` 子串的元素，不执行 JavaScript 强制点击，不绕过禁用状态，也不自动操作 OpenAI 页面之外的控件。

### 25.5 编排与状态机

新增两个任务阶段：

- `resending_otp`：第一轮未取得可靠验证码，正在重新确认页面、刷新基线并单次点击重发；
- `waiting_for_otp_retry`：重发已经触发，正在执行第二个 30 秒轮次。

状态转换调整为：

```text
email_submitted
  -> waiting_for_otp
       -> otp_submitted
       -> resending_otp
       -> manual_intervention
  -> resending_otp
       -> waiting_for_otp_retry
       -> waiting_for_callback（重发前已捕获合法回调）
       -> manual_intervention
  -> waiting_for_otp_retry
       -> otp_submitted
       -> manual_intervention
```

第一轮流程：

1. 邮箱提交动作完成后进入 `waiting_for_otp`，以提交前已经刷新的基线和实际触发时间开始第一轮。
2. 30 秒内取得可靠验证码则直接提交，绝不点击重发。
3. 截止时无验证码或仍歧义，更新任务消息为固定提醒，并进入 `resending_otp`。
4. 进入重发前重新检查取消状态和合法回调，避免在用户已经完成或任务已经结束后继续点击。

第二轮流程：

1. `resendOtp()` 在点击前建立新的基线；第二轮基线与先前基线取并集，因此第一轮出现过的验证码不能在重发后被误用。
2. 单次点击成功后进入 `waiting_for_otp_retry`，以本次重发触发时间开始新的 30 秒轮次。
3. 第二轮取得可靠验证码则进入现有 `otp_submitted`、同意页和回调流程。
4. 第二轮超时、仍歧义、顺序变化或无法确认重发控件时进入 `manual_intervention`，任务消息说明自动两轮已经结束；无痕窗口保持打开并继续被动等待合法回调。

任务页提醒只通过现有任务消息和 SSE 展示，不增加 macOS 系统通知、邮件、短信或其他外部消息。前端进度条把三个阶段都归入“登录与授权”，不新增用户可配置的轮次、超时或重发次数选项。

### 25.6 错误、安全与竞态

- 邮箱认证失败、访问码缺失、邮箱不匹配和响应契约变化是明确错误，不触发重发。
- 第一轮 `timed_out`/`ambiguous` 是受控分支；第二轮同类结果转人工接管，不将其伪装成任务成功。
- CAPTCHA、密码、MFA、账号选择、提供方错误和未知页面的优先级高于 OTP 重发；检测到后不点击任何重发控件。
- 合法 OAuth 回调一旦被捕获，禁止重发和验证码提交，直接进入既有兑换流程。
- 浏览器被用户关闭时终止任务；浏览器仍存在但自动动作不确定时保留窗口接管。
- 重发点击和任务取消竞态通过共享 `AbortSignal`、单次点击标记及状态机校验收敛；点击已经发出后即使取消，也不能通过再次点击来“补偿”。
- 任务阶段和固定消息可以写入 SQLite；邮箱快照、候选身份、验证码、正文、取件凭据和页面文本不得写入 SQLite、日志、SSE 或公开错误 details。
- 不改变本地 Cookie、CSRF、CSP、环回监听、临时 Chrome Profile、Chrome sandbox 或代理权限边界。

### 25.7 修改范围与开发顺序

实际修改：

- `src/server/mail/client.ts`：返回带 `ordering` 的邮箱快照，并为各来源显式声明能力；
- `src/server/mail/otp.ts`：保留可靠时间优先，增加受限首项稳定兜底和歧义原因；
- `src/server/mail/poller.ts`：改成单轮 30 秒结构化结果，维持 3 秒轮询和最多 5 秒退避；
- `src/server/browser/types.ts`、`src/server/browser/controller.ts`、`src/server/browser/page-classifier.ts`：增加严格的一次性 `resendOtp()`；
- `src/shared/task-state.ts`、`src/server/tasks/state-machine.ts`、`src/server/tasks/orchestrator.ts`：增加两个阶段和两轮编排；
- `src/web/components/TaskProgress.vue`：把新阶段归入现有授权进度并显示固定提醒；
- `tests/fixtures/openai-otp.html` 及相关单元、集成测试：补充重发控件和边界覆盖；
- `README.md`、`DOC.md`、`QA.md`：开发完成后按最终行为和真实验证结果更新。

不修改后台 API、账号创建载荷、代理解析、登录与 Keychain、SQLite 表结构、OAuth URL 生成/兑换契约或 Chrome 权限；不新增运行时依赖。

开发顺序：

1. 先补邮箱快照、选择器和 30 秒轮次的失败测试，再实现来源能力与结构化轮询结果。
2. 补验证码页重发按钮 fixture 和控制器测试，再实现只允许一次的 `resendOtp()`。
3. 增加任务阶段与转换测试，再接入第一轮、重发和第二轮编排。
4. 更新前端进度映射和公开消息契约，执行秘密字段扫描。
5. 运行聚焦测试和全量验证，审查最终差异后更新已有 QA、DOC 和 README。
6. 构建完成后确认 SQLite 活动任务数为 0，再重载 `com.up-icloud.local`；重载后只报告实际可访问地址和健康结果。

### 25.8 测试方案与完成标准

必须新增或更新的自动测试：

1. 第一轮 30 秒内收到唯一可靠验证码，不调用重发。
2. 第一轮到期后任务显示提醒，并且只调用一次重发。
3. 重发点击前刷新并合并基线，第二轮不使用第一轮已经出现的旧验证码。
4. 第二轮 30 秒内收到可靠验证码后自动提交并继续同意/回调流程。
5. 第二轮超时或仍歧义时进入 `manual_intervention`，浏览器保持打开。
6. `newest_first` 来源连续两次第一候选身份和验证码稳定时允许顺序兜底。
7. 未验证来源、两次顺序变化、首项身份不稳定、首项自身多码均不得按列表顺序自动选择。
8. 重发控件缺失、禁用、不唯一、非 OTP 页和 DOM 竞态均不得点击。
9. CAPTCHA、密码、MFA、账号选择、提供方错误和合法回调继续优先于重发。
10. 邮箱认证失败立即失败；临时错误只在本轮剩余时间内重试；取消和浏览器关闭正确收敛。
11. 任务、SQLite、SSE、日志和公开响应不包含验证码、邮件正文、候选身份或取件凭据。
12. 既有账号查重、OAuth URL、同意页、回调、兑换和创建账号测试保持通过。

最终验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
npm run build
```

按照当前项目规则，本次默认不执行页面测试、真实邮箱读取、真实验证码、真实 OAuth 或后台账号创建。自动测试使用合成 HTML/JSON 和 `.invalid` 邮箱；未执行的真实链路必须在 QA 和最终交付中明确保留为残余风险。

完成标准：

1. 第一轮和第二轮各自最多 30 秒，自动重发总次数严格不超过一次。
2. 第一轮成功时零次重发；第一轮失败时任务页在重发前显示明确提醒。
3. 第二轮只接受新基线之后的验证码，可靠时间选择优先，列表顺序兜底仅对明确的 `newest_first` 来源生效。
4. 两次顺序不稳定或任何安全条件不满足时不猜测、不继续点击，并保留无痕窗口接管。
5. 新阶段在状态机、前端进度、SQLite 恢复、取消和错误处理中一致，旧历史任务仍可读取。
6. 不扩大浏览器、本地服务或邮箱来源权限，不新增敏感信息持久化或公开回显。
7. 聚焦测试、全量测试、类型检查、lint、生产依赖审计和生产构建全部通过。
8. 既有 README、DOC 和 QA 与最终实现及实际验证一致；确认无活动任务后才允许重载服务。

### 25.9 实施结果

2026-08-14 已按本节完成实现。与批准方案相比只有一项不改变产品效果的竞态细化：`resendOtp()` 使用专用 `callback_captured` 结果表示重发前已经捕获合法 OAuth 回调，状态机允许从 `resending_otp` 直接进入 `waiting_for_callback`，从而避免继续刷新邮箱、点击重发或启动第二轮。

实现未增加运行时依赖、SQLite 迁移、后台接口、浏览器权限或页面输入。自动验证结果记录在 `QA.md`；真实邮箱、真实 OpenAI OAuth、真实验证码提交和后台账号创建仍未由开发过程执行。

## 26. 可配置可信路径式邮箱兼容技术方案（已实施）

### 26.1 状态、目标与已确认取舍

- 状态：技术方案已经用户批准，并于 2026-08-14 完成实施和自动验证。
- 已确认产品效果：设置页允许手动添加可信邮箱域名；可信服务的常见复制、编码、末尾斜杠和同源规范跳转自动兼容；页面无法确认时停止，不从任意页面猜测六位数字。
- 核心目标：把固定的 `https://icloud-api.top/s/<访问凭据>/<邮箱>` 适配能力扩展为一组由用户明确维护的可信 HTTPS origin，同时保持访问凭据、账号邮箱和验证码的现有秘密边界。
- 关键取舍：不承诺兼容任意邮箱网站。自定义可信 origin 只启用通用 `/s/<访问凭据>/<邮箱>` 适配器；路径、接口或页面协议完全不同的新服务仍需新增经过样例验证的专用适配器。

本节使用“origin”表示协议、域名和可选端口的精确组合，例如 `https://mail.example.invalid`。信任项不使用通配符，不自动信任子域名，也不把 `http://` 与 `https://` 视为同一来源。

### 26.2 当前代码分析

当前邮箱链路集中在以下位置：

- `src/server/mail/client.ts`：解析四种内置来源、执行请求、固定拒绝重定向，并且只为 `icloud-api.top` 的路径式来源启用本机回环 HTTPS 代理回退；
- `src/server/mail/normalize.ts`：归一化固定 JSON/HTML 邮件结构，路径式页面目前依赖已确认的页面外壳；
- `src/server/mail/otp.ts`、`src/server/mail/poller.ts`：基线、新鲜度、可信 OpenAI/ChatGPT 上下文、唯一六位验证码和两轮轮询；
- `src/server/tasks/orchestrator.ts`：在创建任务记录前调用邮箱输入规范化函数，随后只把取件凭据保留在活动任务内存；
- `src/server/storage/database.ts`：已有通用 `settings` 键值表，可保存非敏感配置，不需要新增表或迁移；
- `src/server/app.ts`、`src/web/api.ts`、`src/web/views/SettingsView.vue`：已有本地 Cookie、Origin 和 CSRF 保护的设置页调用边界，但当前设置页只管理后台登录会话。

现状的主要限制不是 `/s/` 链接长度，而是三处固定判断共同造成的：路径式 origin 写死为一个值、路径式代理回退只对该值生效、HTML 页面只接受一个已确认外壳。单纯放宽域名字符串无法解决后两项，也会把访问凭据发送给未知站点，因此必须同时处理信任配置、请求路径和响应识别。

### 26.3 范围

本次包含：

1. 在设置页查看内置路径式 origin，并添加、删除最多 20 个自定义可信 HTTPS origin。
2. 不重启服务即可让后续新任务使用更新后的可信列表。
3. 对所有可信路径式来源统一执行复制文本清理、路径规范化、邮箱精确匹配、有限同源跳转和本机回环代理回退。
4. 支持路径式来源返回现有受支持 JSON 邮件集合、结构化 HTML 邮件列表或已确认的路径式收件页。
5. 把链接、信任、跳转、网络、鉴权、响应类型和页面结构问题收敛为可区分的公开错误。
6. 保持现有邮箱基线、验证码新鲜度、可信上下文、唯一性和两轮重发规则。

本次不包含：

- 自动信任首次遇到的域名、通配符域名或全部 `/s/` 网站；
- 从网页正文中自动发现另一个邮箱接口链接；
- 支持 HTTP、忽略 TLS 证书错误、远程系统代理或带账号密码的代理；
- 从用途不明的页面扫描任意六位数字；
- 自动学习生产页面结构，或把现场邮件正文保存为训练样例；
- 改变当时任务页的邮箱验证码输入、后台 OAuth、账号创建、浏览器权限或验证码重发次数；
- 为 `/p/`、查询参数或其他未知协议自动套用 `/s/` 规则。

### 26.4 总体设计

新增一个邮箱信任设置服务，作为设置页和邮箱客户端共享的唯一配置来源：

```text
设置页
  -> 受本地 Cookie + Origin + CSRF 保护的设置接口
  -> 校验并保存自定义 HTTPS origin
  -> SQLite settings（只保存 origin，不保存链接或访问凭据）

创建任务
  -> 取得不可变的可信 origin 快照
  -> 规范化邮箱接口输入并选择适配器
  -> 创建内存 SecretScope
  -> 邮箱请求：直连 -> 必要时本机回环代理回退
  -> 最多三次同源跳转，每一跳重新校验
  -> JSON/HTML 有限模板归一化
  -> 现有基线、可信上下文和唯一 OTP 选择
```

内置四种来源继续保留各自的协议规则。`icloud-api.top` 作为内置路径式 origin 固定启用且不能删除；其他三个内置来源继续由现有专用适配器处理，不出现在自定义 `/s/` 信任列表中。自定义 origin 不得覆盖或改变任一内置适配器的分派优先级。

### 26.5 设置模型与持久化

共享契约新增：

```ts
interface MailboxTrustSettings {
  builtInPathOrigins: string[]
  customPathOrigins: string[]
  configurationValid: boolean
}

interface UpdateMailboxTrustSettingsInput {
  customPathOrigins: string[]
}
```

服务端使用严格 schema 校验请求，规则如下：

- 最多 20 个自定义项；去重后按规范 origin 排序保存；
- 输入可以是裸域名或完整 HTTPS origin，保存时统一为精确 origin；
- 必须使用 HTTPS，不允许用户名、密码、路径、查询参数、片段或通配符；
- 拒绝 `localhost`、`.local`、单标签主机和 IP 字面量，避免把通用取件适配器指向明显的本机或局域网目标；
- 国际化域名使用标准 URL 规则转换为规范 ASCII hostname；默认端口不重复保存，显式非默认端口作为 origin 的一部分精确匹配；
- 与内置来源重复或试图覆盖内置专用适配器时拒绝并显示不含凭据的原因。

SQLite 复用现有 `settings` 表，使用版本化键 `mailbox.trusted_path_origins.v1`，值只包含自定义 origin 数组。完整邮箱链接、路径、访问凭据、邮箱地址、正文和验证码不得进入该值。

读取到损坏或旧版本配置时闭合失败：自定义列表不生效，内置 origin 仍可用，设置接口返回 `configurationValid: false`，日志只记录固定错误码，不记录损坏原文。用户保存一份合法列表后覆盖该配置。因为不新增表和列，本次不需要数据库迁移。

### 26.6 本地接口与设置页

新增本地接口：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/local-api/settings/mailbox-trust` | 返回内置、自定义 origin 和配置有效状态 |
| `PUT` | `/local-api/settings/mailbox-trust` | 原子替换自定义 origin 列表 |

接口继续由现有 `/local-api/` 安全钩子保护：读取需要本地 HttpOnly Cookie，写入还需要精确 `127.0.0.1` Origin 和内存 CSRF。请求体拒绝未知字段，响应不返回 SQLite 原始值。

设置页在现有后台会话区域下增加独立的“可信邮箱服务”区域：

- 内置 origin 以锁定行显示，不能编辑或删除；
- 自定义 origin 以紧凑列表显示，删除使用垃圾桶图标并带 tooltip；
- 新增输入接受域名或 HTTPS origin，提交前显示规范化结果或具体校验错误；
- 添加和删除均通过一次完整列表 PUT 原子保存，成功后立即重新读取服务端结果；
- 活动任务期间禁用修改并返回 `MAILBOX_SETTINGS_BUSY`，避免任务轮询期间信任边界变化；
- 邮箱验证码模式仍然只有账号邮箱和邮箱取件密码/接口链接，不新增域名输入或“自动信任”开关；第 27 节新增的密码 + 2FA 模式不使用可信邮箱来源设置。

### 26.7 链接规范化与适配器选择

链接处理分成“无秘密的 origin 选择”和“包含秘密的路径校验”，并在创建任务记录之前完成。

允许的复制兼容：

1. 去除首尾 ASCII 和 Unicode 空白；
2. 解码复制网页时产生的 `&amp;`；
3. 只解开一层完整匹配的引号或尖括号，不从混合文本中搜索 URL；
4. 由标准 URL 解析器规范协议和 hostname；
5. 折叠路径中的重复 `/`，去除末尾 `/`；
6. 对邮箱路径段执行一次严格百分号解码，并与任务账号邮箱按现有规范化规则精确匹配。

不会改写的内容：

- 访问凭据大小写和字符序列保持原样；
- 不二次解码访问凭据或邮箱；
- 不删除未知查询参数后继续请求；
- 不从文本中选择“看起来最像”的链接；
- 不把一个账号邮箱自动替换成链接中的另一个邮箱。

通用路径式链接必须最终符合：

```text
<受信任的精确 HTTPS origin>/s/<16 至 1024 字符的 URL-safe 访问凭据>/<与任务一致的邮箱>
```

路径只能有这三个语义段；拒绝用户信息、非空查询参数、非空片段、额外路径、空段、解码后的斜杠/NUL 和不合法邮箱。先匹配内置专用适配器，再匹配有效的路径式 origin 集合；未知 origin 返回独立的 `MAIL_ORIGIN_UNTRUSTED`，并只公开 hostname，不公开完整 URL。

### 26.8 重定向与请求边界

路径式请求继续使用 `redirect: 'manual'`，由本地代码显式处理 Location：

- 最多跟随 3 次；超过后返回 `MAIL_REDIRECT_LIMIT_EXCEEDED`；
- 每次 Location 使用当前 URL 解析相对地址，但结果必须保持完全相同的 HTTPS origin；
- 每一跳重新执行 `/s/` 路径、凭据形状和账号邮箱匹配；
- 跳转到另一个自定义可信 origin 也不自动跟随。新 origin 必须由用户直接粘贴其链接后开始新任务；
- 不转发 Cookie、Authorization、Referer 或其他站点身份信息；
- 跳转后的访问凭据可以由同源服务更新，但邮箱仍必须与任务完全一致；
- 任何 Location 解析失败、协议下降、跨 origin、路径变化或邮箱变化均在发出下一跳请求前停止。

固定 `mail.php`、Cloud Mailbox 和 Assurivo 适配器仍保持当前跳转拒绝规则；本次只为通用路径式来源增加有限同源跳转。

### 26.9 网络路径与错误分类

所有有效路径式 origin 使用一致网络策略：

1. 先通过系统默认网络直连，保留系统 TLS 证书校验；
2. 只有直连出现 DNS、连接或 TLS 层错误时才读取 macOS 当前 HTTPS 代理设置；
3. 仅当代理已启用、主机严格为 `127.0.0.1`、`localhost` 或 `::1` 且端口有效时，通过现有 `undici` HTTP CONNECT 重试一次；
4. 一旦某次请求进入代理路径，同一重定向链后续请求保持该路径，避免一条链在直连和代理之间反复切换；
5. 远程代理、代理认证、HTTP 降级和忽略证书错误继续禁止。

保留每次请求 15 秒截止、1 MiB 响应上限和任务取消信号。网络异常递归检查 Node/Undici 的标准 cause code，只映射已知类型：

| 错误码 | 公开含义 |
| --- | --- |
| `MAIL_DNS_ERROR` | 邮箱域名当前无法解析 |
| `MAIL_TLS_ERROR` | TLS 握手或证书校验失败 |
| `MAIL_CONNECTION_ERROR` | 连接被拒绝、重置或不可达 |
| `MAIL_REQUEST_TIMEOUT` | 单次请求超过截止时间 |
| `MAIL_PROXY_FALLBACK_FAILED` | 直连失败，本机回环代理重试也失败 |
| `MAIL_NETWORK_ERROR` | 无法安全归类的其他网络错误 |

公开消息可以包含已信任 hostname，但不得包含端口后的路径、查询参数、访问凭据、代理地址或底层异常全文。未知底层错误不猜测分类，继续使用通用网络错误。

### 26.10 响应识别与验证码规则

可信 origin 只决定“允许向哪里发送请求”，不等于“相信页面上的任意数字”。响应按有限模板分层识别：

1. `application/json`：继续只接受现有明确邮件数组字段和已知邮件字段类型；
2. 结构化 HTML：复用 `article.mail`、显式邮件项和带邮件 ID 的已支持结构；
3. 路径式收件页：支持当前已确认外壳，并补充经过合成 fixture 固定的中英文标签、空列表和轻微容器变化；
4. 以上均不匹配时返回 `MAIL_PAGE_UNRECOGNIZED`，不对整页执行六位数字扫描。

HTML 必须先移除 script、style、template 和不可见内容，只读取邮件容器中的发件人、主题、正文和可验证时间。识别为空邮箱时返回空列表并继续轮询；页面含内容但缺少足够邮件语义时视为结构变化，不伪装成“尚未收到验证码”。

现有 OTP 约束全部保持：

- 只处理基线之后的新邮件；
- 内容必须具有 OpenAI 或 ChatGPT 可信上下文；
- 只接受独立六位数字；
- 可靠收件时间优先；
- 路径式来源默认仍声明 `ordering: 'unknown'`，不得仅因页面第一项看似最新而开启顺序兜底；
- 多个候选、时间缺失或并列、旧邮件和页面其他数字均不自动填写；
- 邮件正文、候选内容和验证码只存在于活动任务内存，不进入错误、日志、SSE 或 SQLite。

页面结构发生实质变化时，需要使用不含真实地址、凭据、正文和验证码的合成 fixture 更新有限模板及测试；运行时不自动学习或保存现场页面。

### 26.11 配置一致性与任务并发

设置服务为每次新任务提供不可变的有效 origin 快照。任务创建前的输入规范化和后续邮箱轮询使用同一快照，避免“创建时受信任、轮询时被删除”或反向情况。

因为当前应用只允许一个活动任务，设置接口在存在活动任务时拒绝 PUT，前端同时禁用编辑。任务成功、失败、取消或中断后可以立即修改，后续任务无需重启服务即可读取新列表。服务重启仍只中断活动任务，不改变已保存的非敏感可信 origin。

### 26.12 错误收敛

新增或细化的错误至少包括：

| 分类 | 错误码 | 处理 |
| --- | --- | --- |
| 信任 | `MAIL_ORIGIN_UNTRUSTED` | 引导到设置页添加可信 origin，不发请求 |
| 链接 | `MAIL_ACCESS_URL_INVALID` | 显示协议、路径或编码的安全原因，不发请求 |
| 邮箱 | `MAIL_ACCESS_URL_EMAIL_MISMATCH` | 账号与链接邮箱不一致，不发请求 |
| 设置读取 | 非错误响应：`configurationValid: false` | 自定义配置损坏时返回空自定义列表和仍可用的内置来源，保存合法列表后恢复 |
| 设置 | `MAILBOX_SETTINGS_BUSY` | 活动任务结束后再修改 |
| 跳转 | `MAIL_REDIRECT_REJECTED` | 跨 origin、协议下降或目标形状不合法 |
| 跳转 | `MAIL_REDIRECT_LIMIT_EXCEEDED` | 同源跳转超过三次 |
| 网络 | 第 26.9 节错误码 | 只对标记为临时的错误按现有轮询退避 |
| 鉴权 | `MAIL_AUTHENTICATION_FAILED` | 凭据无效或失效，立即停止 |
| 内容 | `MAIL_RESPONSE_INVALID` | JSON/字段/内容类型不符合契约 |
| 页面 | `MAIL_PAGE_UNRECOGNIZED` | 页面用途或邮件结构无法确认，立即停止 |

`toPublicError` 继续只输出固定 code/message/retryable；底层 cause 不序列化。任务在输入校验前失败时不创建 SQLite 记录，也不清空当前账号的页面取件字段。

### 26.13 文件范围

计划新增：

- `src/server/mail/settings.ts`：可信 origin 规范化、版本化读取、原子保存和不可变快照；
- `src/server/routes/mail-settings.ts`：本地 GET/PUT 设置接口；
- `tests/unit/mail-settings.test.ts`：设置规范化、损坏配置和持久化测试。

计划修改：

- `src/shared/contracts.ts`：邮箱信任设置请求和公开响应 schema/type；
- `src/server/app.ts`、`src/server/index.ts`：注册设置服务、路由和邮箱客户端共享依赖；
- `src/server/mail/client.ts`：动态路径式 origin、有限同源跳转、统一代理回退和网络错误分类；
- `src/server/mail/normalize.ts`：路径式 JSON/HTML 有限模板和独立页面结构错误；
- `src/server/tasks/orchestrator.ts`：任务开始时取得并贯穿同一信任快照；
- `src/web/api.ts`、`src/web/App.vue`、`src/web/views/SettingsView.vue`、`src/web/styles.css`：设置读取、原子保存和紧凑列表；
- `tests/unit/mail-normalize.test.ts`：链接变化、跳转、网络、解析和秘密边界；
- `tests/integration/local-api.test.ts`：Cookie、Origin、CSRF、严格请求体和活动任务锁；
- `tests/integration/orchestrator.test.ts`：任务前校验、快照一致性和不落盘；
- `README.md`、`DOC.md`、`QA.md`：开发完成后依据实际实现和验证结果更新。

不计划修改 SQLite 表结构、后台接口、OAuth 协议、账号创建载荷、Keychain、Chrome 启动参数或任务状态机阶段；不新增运行时依赖。

### 26.14 开发顺序

1. 先为设置 schema、origin 规范化、版本化存储和损坏配置补失败测试，再实现设置服务。
2. 增加本地 GET/PUT 路由和安全/活动任务测试，再接入设置页；此阶段不改变邮箱请求。
3. 把路径式 origin 判断改为任务快照，并补内置适配器优先级、未知域名和凭据不泄露测试。
4. 实现复制噪声、路径和邮箱规范化，再补同源三跳与拒绝跨 origin 的测试。
5. 将现有回环代理回退扩展到全部有效路径式 origin，并实现已知网络 cause 分类。
6. 扩展有限 JSON/HTML 模板，保持 OTP 选择器不变并补未知页面闭合失败测试。
7. 执行聚焦测试和全量验证，审查秘密字段与最终差异后更新 README、DOC 和 QA。
8. 构建完成后确认没有活动任务，再按现有 LaunchAgent 流程重载服务并验证健康接口；设置列表本身的日常变更不需要重启。

### 26.15 测试方案

必须新增或更新的自动测试：

1. 内置路径式 origin 始终存在、不可删除，自定义列表保存后无需重启即可供下一任务使用。
2. 域名与 HTTPS origin 规范化、去重、排序、上限、IDN、显式端口及非法协议/路径/用户信息/通配符/IP 拒绝。
3. 损坏设置只禁用自定义项，不影响内置来源，也不把原始 SQLite 值回显或写入日志。
4. 设置 GET 需要本地 Cookie；PUT 还需要正确 Origin 和 CSRF；未知字段、活动任务和超限列表被拒绝。
5. 空白、成对包装、`&amp;`、重复斜杠、末尾斜杠、邮箱大小写和单次百分号编码被安全规范化。
6. 访问凭据保持字节序列和大小写；混合文本、二次编码、额外路径、查询/片段、邮箱不匹配在请求前拒绝。
7. 自定义可信 `/s/` origin 可以请求；未知 origin、内置专用 origin 的错误路径和试图覆盖适配器均不请求。
8. 同源相对/绝对跳转成功，第四跳、跨 origin、HTTPS 降级、畸形 Location、目标邮箱变化全部停止。
9. 每一跳保持 15 秒单次截止、1 MiB 总响应限制、取消信号和无 Cookie/Authorization/Referer。
10. 自定义路径式来源直连失败后只使用有效本机回环 HTTPS 代理一次；远程或带认证代理不使用。
11. DNS、TLS、连接、超时、代理回退失败和未知网络异常映射正确，错误序列化不包含 URL、凭据或代理地址。
12. 受支持 JSON、结构化 HTML、当前路径页、轻微容器变化和空列表正确归一化；未知页面、错误内容类型和字段变化闭合失败。
13. 页面内无关六位数字、旧邮件、多候选、非 OpenAI/ChatGPT 内容和 `ordering: 'unknown'` 均不自动选择。
14. 修改设置时没有活动任务；任务开始后使用不可变快照，凭据仍不进入 PublicTask、SSE、SQLite 或日志。
15. 现有四种邮箱来源、两轮验证码、浏览器授权、回调兑换和账号创建测试保持通过。

最终验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
npm run build
```

按照项目规则，本次默认不执行浏览器页面点击、视觉回归、真实邮箱读取、真实验证码、真实 OAuth 或后台账号创建。设置页通过组件逻辑和本地接口测试验证；真实新域名只能在用户另行明确授权、凭据已经更换或可使用无敏感测试链接时做单次只读取件验证。

### 26.16 风险、回滚与完成标准

主要风险与处理：

- 用户错误信任域名：采用精确 HTTPS origin、显式保存、无通配符、无自动信任，并在未知 origin 时先停止；
- 同源页面恶意或变化：信任不替代有限页面识别，未知结构不提取验证码；
- 网络错误误分类：只识别明确底层 code，其他情况保留通用错误；
- 设置与活动任务竞态：PUT 在活动任务期间拒绝，任务使用不可变快照；
- 兼容范围被误解：设置只覆盖 `/s/<访问凭据>/<邮箱>`，不同协议仍需专用适配器。

回滚时可先在设置页删除全部自定义 origin，立即恢复只有内置路径式来源的行为。代码回滚不需要数据库迁移；旧版本会忽略通用 `settings` 表中的版本化键。回滚不删除任务历史或已经创建的后台账号。

完成标准：

1. 设置页可以安全维护自定义可信 origin，保存后后续任务立即生效且无需重启。
2. 同一可信 `/s/` 服务的常见复制、编码、斜杠和最多三次同源规范跳转可自动处理。
3. 新域名、路径、邮箱、跳转、DNS、TLS、连接、鉴权、内容类型和页面结构问题具有可区分且不泄密的错误。
4. 未知 origin 不发请求，未知页面不扫描验证码，访问凭据不写入设置、任务、SQLite、日志或公开响应。
5. 现有四种邮箱来源、验证码新鲜度和唯一性规则不回归。
6. 聚焦测试、全量测试、类型检查、lint、生产依赖审计和生产构建全部通过。
7. README、DOC 和 QA 只记录最终实际实现及真实执行过的验证；未执行的页面和真实外部链路明确列为残余风险。

### 26.17 实施结果

2026-08-14 已按本节完成实现。设置页现在显示不可删除的内置路径式 origin，并可以原子保存、删除最多 20 个自定义精确 HTTPS origin；设置变更对后续任务立即生效，活动任务期间由前端和服务端共同锁定。任务开始时取得不可变 origin 快照，输入校验、初始基线、各次基线刷新和两轮验证码轮询均使用同一快照。

路径式客户端已经统一支持复制包装和斜杠规范化、邮箱单次解码、访问凭据原样保留、最多三次同源跳转、全部有效路径式 origin 的本机回环 HTTPS 代理回退，以及 DNS、TLS、连接、底层超时、代理回退和通用网络错误分类。页面归一化增加结构化邮件卡片和有限中英文邮箱外壳；未知页面返回 `MAIL_PAGE_UNRECOGNIZED`，不扫描整页六位数字。现有 `mail.php`、Cloud Mailbox、Assurivo、OTP 新鲜度和列表顺序能力保持原规则。

与批准方案相比只有一项不改变产品效果的可恢复性细化：SQLite 中的自定义 origin 配置损坏时，`GET /local-api/settings/mailbox-trust` 不以 `MAILBOX_SETTINGS_INVALID` 整体失败，而是返回 `configurationValid: false`、空自定义列表和仍可用的内置来源。设置页据此显示固定警告，用户保存合法列表即可覆盖恢复；损坏原文不会回显或记录。活动任务写入仍使用独立 `MAILBOX_SETTINGS_BUSY`。

实现没有新增运行时依赖、SQLite 表迁移、后台接口、OAuth 字段、浏览器权限或任务页输入。自动验证和部署结果记录在 `QA.md`；遵照项目规则没有执行页面点击、视觉回归、真实新域名取件、真实验证码、真实 OAuth 或后台账号创建。

## 27. OpenAI 密码 + TOTP 登录材料（已实施）

### 27.1 状态、目标与已确认效果

本节技术开发方案已获批准。实施开始前，用户进一步确认输入效果：保留现有账号邮箱框，在“密码 + 2FA”模式下新增两个独立遮罩框“账号密码”和“2FA 密钥”，不再使用 `邮箱----密码----2FA密钥` 拼接行。工具在现有隔离的本机无痕 Chrome 中依次处理邮箱、密码、认证器动态码、Codex 授权确认、OAuth 回调兑换和后台账号创建。

本次目标：

1. 两种登录模式共享现有后台会话、选项、代理、授权链接生成、回调校验、凭据兑换和账号创建流程。
2. “邮箱验证码”模式的邮箱基线、两轮轮询、单次重发和人工接管行为保持不变。
3. “密码 + 2FA”模式完全跳过邮箱接口、邮箱基线、邮件轮询和重新发送邮件验证码。
4. 密码、TOTP 密钥和生成的六位动态码只存在于当前页面内存和活动任务的服务端秘密作用域，不进入公开任务、SSE、历史记录、SQLite、日志或构建产物。
5. 只有严格识别为密码页、认证器动态码页和 Codex 授权确认页时才自动填写；不确定页面保持浏览器并进入人工接管。

不在本次范围：

- 不做批量导入，一次任务仍只处理一个账号；
- 不自动查询旧账号池，也不修改账号池服务；
- 不自动处理 CAPTCHA、Passkey、安全密钥、短信、恢复码、账号选择、风险验证、未知 MFA 或未知页面；
- “密码 + 2FA”模式遇到邮箱验证码时不调用邮箱接口，改为人工接管；
- 不改变后台生成授权链接、兑换凭据和创建账号的接口契约；
- 不扩大 Chrome 权限，不改用普通 Chrome 配置，不保存可复用的 OpenAI 登录态。

用户提供的 93 秒操作视频已用于确认操作顺序：视频展示了登录材料、生成 OpenAI OAuth 链接、打开无痕 Chrome，并停在 `auth.openai.com/log-in/password`。视频没有展示实际认证器动态码页面，也没有展示完整授权和账号创建结果。因此开发阶段只能先用不含真实信息的合成页面 fixture 固定页面契约；在用户另行明确授权前，不执行真实账号页面验收，也不能把合成测试结果表述为真实 OAuth 端到端通过。

### 27.2 当前代码分析

当前实现是单一邮箱验证码路径：

- `src/shared/contracts.ts` 的 `CreateTaskInputSchema` 强制要求 `accountEmail` 和 `mailboxPassword`，没有互斥的登录材料类型；
- `src/web/components/TaskForm.vue` 和 `src/web/state.ts` 只管理账号邮箱与邮箱取件密码/链接，取件字段仅保留在当前 Vue 页面内存；
- `src/server/tasks/orchestrator.ts` 在解析输入后始终建立邮箱基线，再解析代理、生成授权链接和轮询邮件验证码；
- `src/server/browser/page-classifier.ts` 会把密码页和带认证器语义的 MFA 页面归为人工接管，通用六位码输入目前没有区分“邮箱验证码”和“认证器动态码”；
- `src/server/browser/controller.ts` 只公开 `submitEmail`、`resendOtp`、`submitOtp` 和 `submitConsent`，其中 `submitOtp` 对验证码用途没有类型区分；
- `src/shared/task-state.ts` 和 `src/server/tasks/state-machine.ts` 只有邮箱验证码阶段；
- `src/server/tasks/secret-scope.ts` 已提供进程内秘密作用域，并在任务 `finally` 中统一清空，可直接复用；
- `PublicTask`、SSE 和 SQLite 当前只保存公开任务字段，可继续保持不包含登录材料。

主要技术问题不是“生成一个六位码”，而是必须先可靠区分页面用途，再按模式调用正确材料。若继续复用泛化的 `otp` 分类，可能把认证器动态码填入邮箱验证码页，或把邮件验证码填入认证器页，所以页面类型与控制器方法必须显式拆分。

### 27.3 方案对比与推荐

| 方案 | 优点 | 缺点与风险 | 结论 |
| --- | --- | --- | --- |
| 三个互不相关的可选字段：邮箱取件、密码、TOTP 密钥 | 表面改动少 | 容易出现互相冲突、部分缺失和错误组合；编排器需要猜测模式 | 不采用 |
| 带 `kind` 的互斥登录材料 | 请求在类型和运行时校验上都只有一种合法模式；编排分支清晰 | 需要调整共享契约和现有测试输入 | 推荐 |
| 手写 RFC 6238/Base32/HMAC | 无新增依赖 | 密钥解码、时间窗口、填充和算法细节容易出错，维护成本高 | 不采用 |
| 使用维护中的 `otpauth` | 提供 TypeScript 声明、Base32 密钥和 `TOTP.generate()`/`remaining()`；接口与标准明确 | 增加一个运行时依赖，需要生产依赖审计 | 推荐 |
| 自动查询旧账号池获取密码/TOTP | 用户输入更少 | 超出已确认的一账号一任务范围，并重新引入账号池会话和敏感接口边界 | 不采用 |

实现使用并由 lockfile 固定 `otpauth@9.5.1`。该库提供 TOTP 生成与剩余有效时间计算；依赖只从服务端 Node 代码导入，前端构建不包含 TOTP 生成实现。

### 27.4 请求契约与独立字段校验

共享请求改为互斥结构：

```ts
type LoginMaterial =
  | {
      kind: 'email_otp'
      mailboxAccess: string
    }
  | {
      kind: 'password_totp'
      password: string
      totpSecret: string
    }

interface CreateTaskInput {
  accountEmail: string
  loginMaterial: LoginMaterial
  // 现有代理、并发、供应商、分组和风险选项保持不变
}
```

`accountEmail` 继续放在任务顶层，作为公开任务身份、查重和账号创建名称；`loginMaterial` 不复制到 `PublicTask` 或选择快照。Zod 使用 `z.discriminatedUnion('kind', ...)` 且各分支 `.strict()`，拒绝未知字段和跨模式材料。邮箱验证码分支把现有 `mailboxPassword` 重命名为只在秘密作用域中使用的 `mailboxAccess`；这是本地请求契约变化，不改变邮箱客户端和后台接口语义。

三个输入字段规则固定如下：

1. 账号邮箱继续使用现有输入，只做首尾空白去除、标准邮箱校验和小写规范化；
2. 账号密码不能为空，不执行 `trim`、大小写转换、Unicode 规范化或字符替换，字符序列按用户输入原样传递；
3. 2FA 密钥允许去除用于展示的 ASCII 空格和单连字符并转为大写，然后严格校验 RFC 4648 Base32 字母表、长度和末尾填充；禁止混入其他空白、URI、恢复码或任意文本；
4. 前端只在三个字段完整有效时生成结构化 `password_totp` 分支；邮箱验证码模式只生成 `email_otp` 分支；
5. 服务端独立执行同等邮箱、密码长度和 TOTP Base32 校验，不能信任前端结果；
6. 校验失败只显示固定字段错误，不回显密码或密钥。

### 27.5 表单状态与当前页面内存

任务页在账号材料区域增加两项分段选择：`邮箱验证码`、`密码 + 2FA`，默认仍为 `邮箱验证码`。

账号邮箱在两种模式中始终显示。邮箱验证码模式继续显示邮箱取件密码/接口链接；密码 + 2FA 模式改为显示两个独立的密码型输入“账号密码”和“2FA 密钥”，不增加明文切换或复制按钮。其他账号配置选项保持原值。

两种模式各自保留当前页面内的输入状态，切换模式、任务失败或任务完成时不自动清空，方便同一页面重试；输入控件保持遮罩。页面刷新、标签关闭或本地服务重启后不从 `localStorage`、`sessionStorage`、IndexedDB、SQLite、Keychain 或后端接口恢复密码/TOTP 材料。该取舍满足“当前页面记住、重新打开不长期保存”，但用户应理解当前页面进程内仍持有秘密直到刷新或关闭。

提交前只允许当前模式的完整有效材料影响 `canStartTask`。现有代理、并发、供应商、分组全选、允许重复创建、混合渠道确认和“清除所有模型”行为不变。

### 27.6 服务端秘密生命周期

任务创建时先完成无副作用的请求校验；校验失败不创建任务记录。活动任务开始后：

1. 根据 `loginMaterial.kind` 将 `mailboxAccess` 或 `password`、`totpSecret` 写入当前任务的 `SecretScope`；
2. 传给状态机、数据库和事件订阅者的对象只包含 `accountEmail`、公开选项、阶段和固定消息；
3. 密码只在严格识别的密码页提交时读取；TOTP 密钥只在严格识别的认证器页生成动态码时读取；
4. 生成的动态码只在提交调用期间短暂放入局部变量，不放入任务对象，不返回前端；
5. 成功、失败、取消、浏览器关闭、回调结束和服务关闭都通过现有 `finally` 关闭临时浏览器并 `dispose()` 秘密作用域；
6. 日志脱敏规则补充 `totpSecret`、`loginMaterial` 和动态码相关键；Zod 错误与底层浏览器错误转换为固定公开错误，不序列化原始请求或输入值。

不得给 `InternalTask`、`TaskSelection`、OAuth 诊断、SSE 事件或 SQLite 表新增密码/TOTP 字段。生产构建后对 `dist` 和数据库 schema 做秘密字段审查。

### 27.7 TOTP 生成与临期策略

新增服务端 `TotpGenerator` 小模块封装 `otpauth`，便于使用固定时钟单元测试。普通密钥模式使用 OpenAI 账号常见的标准参数：

- 算法：`SHA1`；
- 位数：6；
- 周期：30 秒；
- 时间来源：本机系统时间，毫秒时间戳只在服务端读取。

若未来输入扩展为完整 `otpauth://` URI，算法、位数和周期必须经过新的产品与技术审批；本次纯密钥输入不允许用户覆盖这些参数。

提交策略：

1. 严格识别认证器动态码页后读取当前剩余有效期；
2. 剩余时间少于 10 秒时不提交当前码，等待到下一个周期并额外留出短暂边界余量，再用新时间戳生成；
3. 第一次提交后若已经进入同意页或回调，立即停止生成；
4. 只有 URL 的 origin/path 未变化、页面仍被严格识别为同一认证器动态码用途、且时间已经进入后续周期时，才允许生成并提交第二个码；
5. 最多提交两个不同周期的动态码，不允许循环重试，也不在同一周期重复提交；
6. 页面显示密码错误、动态码错误、频率限制、提供方错误或无法确认的状态时停止自动化，避免账号锁定。

本机时间明显异常会导致合法密钥也生成错误动态码。应用不自动修改系统时间；第二次仍未通过时进入人工接管并提示检查密码、2FA 密钥和系统时间，不区分或泄露具体哪一项秘密错误。

### 27.8 页面分类与浏览器控制器

`PageClassification` 将当前泛化类型拆为有用途的页面：

- `email`：账号邮箱输入页；
- `password`：唯一可见且可用的密码输入，配合明确登录/继续语义；
- `email_otp`：页面明确表示验证码已发送到邮箱，并有匹配的六位码输入；
- `authenticator_totp`：页面明确要求 authenticator app/认证器生成的动态码，并有匹配的六位码输入；
- `consent`：现有 Codex 授权确认；
- `manual_intervention`：挑战、账号选择、Passkey、安全密钥、短信、恢复码、风险控制、提供方错误或未知页面。

分类顺序先检查挑战和高风险语义，再检查输入用途，最后检查普通邮箱与同意页。仅有 `autocomplete="one-time-code"`、`name*=code` 或六位数字输入不足以判断验证码来源；邮箱码与认证器码缺少明确用途证据时闭合失败。密码页和认证器页使用不含真实材料的中英文合成 fixture 固定允许的标签、控件数量和提交按钮语义。

浏览器会话新增用途明确的方法：

```ts
submitPassword(password: string): Promise<BrowserActionResult>
submitEmailOtp(code: string): Promise<BrowserActionResult>
submitAuthenticatorTotp(code: string): Promise<BrowserActionResult>
classifyCurrentPage(): Promise<PageClassification>
```

邮箱验证码模式不读取密码/TOTP，密码 + TOTP 模式不调用 `resendOtp` 或 `submitEmailOtp`。控制器在填写前和点击前各确认一次页面类型、输入唯一可见可用、填入值与内存值一致、提交控件唯一且语义匹配。回调捕获、初始授权 URL 完整性校验、代理配置和临时无痕 Chrome profile 保持现有实现。

### 27.9 编排分支与任务状态机

编排器在查重后、邮箱基线之前按登录模式分流：

```text
公共前段
  校验 -> 选项 -> 预查重
    email_otp     -> 邮箱基线 -> 代理 -> 授权链接 -> 无痕浏览器
    password_totp ->             代理 -> 授权链接 -> 无痕浏览器

浏览器登录
    email_otp     -> 邮箱 -> 等邮件码/单次重发 -> 邮箱码 -> 同意
    password_totp -> 邮箱 -> 密码 -> 认证器动态码（最多两个周期）-> 同意

公共后段
  回调 -> 兑换 -> 二次查重 -> 创建 -> 确认
```

新增最小且可读的阶段：

- `waiting_for_password`；
- `password_submitted`；
- `waiting_for_totp`；
- `totp_submitted`。

现有 `email_submitted` 在两种模式中复用；它可以进入 `waiting_for_otp` 或 `waiting_for_password`。`checking_existing` 可以按模式进入 `mail_baseline` 或直接进入 `resolving_proxy`。`password_submitted -> waiting_for_totp -> totp_submitted -> waiting_for_consent` 构成新分支，其余公共阶段不变。

人工接管继续保留无痕窗口并等待有效 OAuth 回调。用户手动完成未知挑战并产生正确回调后，任务仍可进入公共兑换流程；没有回调时不会绕过页面创建账号。单活动任务限制保持不变，新模式不引入并行浏览器或后台重试任务。

### 27.10 公开错误与人工接管规则

新增或细化的固定公开错误：

| 错误码 | 场景 | 结果 |
| --- | --- | --- |
| `LOGIN_MATERIAL_INVALID` | 请求模式、邮箱或字段组合不合法 | 不创建任务，不回显原值 |
| `TOTP_SECRET_INVALID` | Base32 字母表、长度或填充不合法 | 不创建任务，不生成动态码 |
| `TOTP_GENERATION_FAILED` | 合法输入在服务端仍无法生成 | 任务失败，清空秘密作用域 |
| `OPENAI_CREDENTIAL_REJECTED` | 页面明确拒绝密码或两轮动态码 | 保留浏览器并进入人工接管，不猜测是哪一项错误 |
| `OPENAI_EMAIL_OTP_REQUIRED` | 密码 + TOTP 模式出现邮箱验证码页 | 人工接管，不调用邮箱接口 |
| `OPENAI_LOGIN_PAGE_UNRECOGNIZED` | 登录页面用途无法严格判断 | 人工接管，不自动填值 |

CAPTCHA、人机验证、异常活动、Passkey、安全密钥、短信、恢复码、账号/组织选择和未知 MFA 均直接人工接管。提供方明确错误、浏览器关闭、OAuth state 不匹配和回调超时继续复用现有错误模型。所有公开消息使用固定文本，不包含页面 HTML、URL 查询参数、邮箱取件链接、密码、TOTP 密钥或生成的动态码。

### 27.11 文件范围

实际新增：

- `src/shared/login-material.ts`：TOTP 密钥规范化和纯函数校验；
- `src/server/security/totp.ts`：`otpauth` 服务端封装、临期等待和固定时钟接口；
- `tests/unit/login-material.test.ts`：密码原样保留、Base32 和脱敏测试；
- `tests/unit/totp.test.ts`：标准向量、剩余时间、临期等待和跨周期测试；
- 合成的 OpenAI 密码页、邮箱码页、认证器页和挑战页 fixture，不包含真实账号或秘密。

实际修改：

- `package.json`、`package-lock.json`：增加并锁定 `otpauth` 运行时依赖；
- `src/shared/contracts.ts`：互斥 `loginMaterial` schema/type，保持公开任务无秘密；
- `src/shared/task-state.ts`、`src/server/tasks/state-machine.ts`：新增密码/TOTP 分支阶段与合法转换；
- `src/web/components/TaskForm.vue`、`src/web/state.ts` 及相关样式：模式选择、密码与 2FA 独立遮罩输入和当前页面记忆；
- `src/server/browser/types.ts`、`src/server/browser/page-classifier.ts`、`src/server/browser/controller.ts`：按用途拆分页面和提交方法；
- `src/server/tasks/orchestrator.ts`：邮箱基线前分流、密码提交、TOTP 临期等待及一次后续周期重试；
- `src/server/security/redact.ts`：补充新字段键脱敏；
- `tests/unit/page-classifier.test.ts`、`tests/unit/browser-controller.test.ts`：严格页面识别和动作边界；
- `tests/integration/orchestrator.test.ts`、`tests/integration/local-api.test.ts`、`tests/unit/state-machine.test.ts`、`tests/unit/web-state.test.ts`：两种模式、状态转换、API 严格校验和不落盘；
- `README.md`、`DOC.md`、`QA.md`：开发完成后只根据最终实现和实际测试结果更新。

实施没有修改 SQLite 表结构、后台 OAuth/账号创建接口、邮箱适配器、可信邮箱来源设置、代理解析协议映射、Chrome 权限或并发任务限制。

### 27.12 开发顺序

1. 为独立字段校验、互斥请求 schema 和 TOTP 标准向量补失败测试，再增加并锁定 `otpauth`。
2. 实现服务端 TOTP 封装和秘密字段脱敏，验证临期等待、取消和最多两周期约束。
3. 用合成 fixture 拆分密码、邮箱码、认证器码和人工挑战分类，再扩展浏览器控制器。
4. 扩展状态机，先保持邮箱验证码原路径全量测试通过，再在邮箱基线之前接入新编排分支。
5. 接入任务表单模式、密码与 2FA 独立遮罩输入和当前页面内存；确认刷新后不恢复。
6. 执行聚焦单元/集成测试、全量测试、类型检查、lint、生产依赖审计和生产构建。
7. 审查构建产物、公开任务、SSE、SQLite schema 和测试日志，确认不存在真实或合成秘密泄漏。
8. 根据实际结果更新 README、DOC 和 QA；确认没有活动任务后重载现有 LaunchAgent 并验证健康接口。

### 27.13 测试方案

必须覆盖的自动测试：

1. 默认仍为邮箱验证码模式，现有两输入、基线、两轮等待和单次重发路径不回归。
2. 邮箱为空或不合法、密码为空或超长、密钥为空或超长时闭合失败，跨模式字段和未知字段被拒绝。
3. 密码中的首尾空格、标点、Unicode 和连字符保持原样。
4. TOTP 密钥只规范展示空格/单连字符和大小写；非法 Base32 字符、错误填充、无效长度、URI 和混合文本被拒绝。
5. 使用 RFC 6238/库官方兼容的固定时间向量验证 SHA1、6 位、30 秒生成，测试不输出密钥或动态码到失败消息。
6. 剩余不足 10 秒时等待下一周期；取消信号能中断等待；首个周期通过时不生成第二个码。
7. 只有相同 URL 用途和严格认证器页面仍存在时提交后续周期码，且最多一次；错误页、页面切换或回调后不重试。
8. 密码页、邮箱验证码页、认证器页、同意页、Passkey、安全密钥、短信、恢复码、账号选择、风险页和未知页分类互斥。
9. 仅有通用六位码输入而没有用途证据时人工接管，不自动选择登录材料。
10. 密码 + TOTP 模式不调用邮箱客户端的基线、轮询和重发；邮箱模式不读取密码或 TOTP 密钥。
11. 两种模式都能复用固定/随机固定/动态订阅代理、授权链接、回调校验、兑换、查重和创建分支。
12. 任务成功、失败、取消、浏览器关闭和服务关闭后 `SecretScope` 均已释放。
13. `PublicTask`、任务列表、详情、SSE、错误、SQLite、日志和构建产物不包含 `mailboxAccess`、密码、TOTP 密钥或动态码。
14. 模式切换和任务结束不清空当前页面输入，页面刷新后不从任何持久化位置恢复。
15. 单活动任务、允许重复创建、混合渠道确认、分组全选、“清除所有模型”和动态代理 `socks5h` 兼容保持通过。

最终验证命令：

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
npm run build
```

按照项目规则，本次默认不执行浏览器页面点击、视觉回归、真实邮箱、真实验证码、真实密码、真实 TOTP、真实 OAuth 或后台账号创建。合成 HTML fixture 和控制器纯逻辑测试属于代码级契约验证，不等于页面测试。真实认证器页面未被现有视频捕获，后续真实单账号验收必须由用户另行明确授权，并在测试前更换此前通过聊天发送过的密码和 2FA 密钥。

### 27.14 风险、回滚与完成标准

主要风险与处理：

- OpenAI 页面文案或 DOM 变化：只对严格合成契约自动填写，未知结构人工接管，不扩大选择器猜测范围；
- TOTP 系统时间偏差：临期等待并只跨一个后续周期，失败后提示检查系统时间，不自动改时钟；
- 密码错误造成锁定：不循环重试，明确拒绝时立即停止自动化；
- 前端当前页面持有秘密：控件遮罩、不持久化、不回传公开接口，刷新/关闭即可释放；
- 模式分支回归邮箱流程：邮箱路径先保持原测试全通过，并对邮箱客户端“新模式零调用”做集成断言；
- 新依赖供应链：固定 lockfile、执行生产依赖审计，并确认 TOTP 模块未打入前端 bundle。

回滚时移除“密码 + 2FA”选项及其请求分支，恢复 `CreateTaskInputSchema` 的邮箱验证码字段和原状态转换，再移除 `otpauth` 依赖。没有 SQLite 迁移、长期秘密或后台数据需要回滚；已经创建的后台账号不自动删除。若上线后页面契约变化，可先在前端隐藏新模式并保留邮箱验证码路径，避免影响现有功能。

完成标准：

1. 用户可在密码 + 2FA 模式填写账号邮箱、账号密码和 2FA 密钥，后两项始终遮罩，一次任务处理一个账号。
2. 新模式不触发任何邮箱请求，能在严格识别页面按邮箱、密码、最多两个 TOTP 周期、同意和回调顺序运行。
3. 临期动态码不会提交，未知验证码用途和所有未支持挑战不会自动填值。
4. 密码、TOTP 密钥和动态码不进入公开任务、SSE、历史、SQLite、日志或构建产物，并在任务结束时释放服务端秘密作用域。
5. 原邮箱验证码模式、代理选择、后台 OAuth 和账号创建流程不回归。
6. 聚焦测试、全量测试、类型检查、lint、生产依赖审计和生产构建全部通过。
7. README、DOC 和 QA 只记录最终实现与真实执行结果；未执行的页面和真实链路明确保留为残余风险。
8. 构建部署后本地健康接口正常；真实密码 + TOTP 端到端状态仍须经过另行授权的单账号验收才能确认。

### 27.15 实施结果

最终实现与本节批准方案一致，并吸收了实施前的最后一项产品调整：不再接受 `邮箱----密码----2FA密钥` 拼接行，账号邮箱沿用原输入框，账号密码和 2FA 密钥各占一行且均为遮罩输入。共享契约已改为互斥 `loginMaterial`；密码模式在邮箱基线之前分流；页面分类、控制器方法和任务状态已按邮箱码与认证器码用途拆分；TOTP 只在服务端生成并最多跨两个周期提交。

已完成聚焦测试、全量测试、类型检查、lint、生产依赖审计、生产构建和构建产物秘密扫描。真实账号密码、真实 2FA、真实 OpenAI OAuth 和页面点击验收未执行，不能将合成测试结果解释为真实外部页面已经端到端通过。具体命令与结果记录在 `QA.md` 第 40 节。

## 28. 独立的 OpenAI 已有账号重新授权（已批准并实施）

### 28.1 状态、目标与已确认效果

本节技术方案已由用户批准并完成实施。产品效果是：左侧新增独立“重新授权”入口；“添加账号”继续创建新账号；“重新授权”只能选择后台已有的 OpenAI OAuth 账号，并把新 OAuth 凭据写回同一个账号 ID，任何分支都不得创建同邮箱的新账号。

后续生效规则：重新授权候选已收紧为后台 `error`、OpenAI OAuth 且 7 天用量不高于 90% 的账号，不再提供“全部账号”入口；登录材料输入已由第 29 节的账号池自动解析替代为默认流程，原手动输入仅作为显式备用。下文保留最初批准方案，用于说明实施演进，不代表当前页面仍提供旧入口。

重新授权继续支持两种互斥登录材料：

- 邮箱验证码：目标账号邮箱由后台账号自动取得并锁定，用户只填写邮箱取件密码或接口链接；
- 密码 + 2FA：目标账号邮箱同样锁定，用户分别填写账号密码和 2FA 密钥；
- 账号材料不从号池自动读取，不连接号池服务；
- 代理、并发、供应商、分组、允许重复创建、混合渠道确认和清除模型等创建配置不出现在重新授权页。

账号选择默认显示后台 `status=error` 的 OpenAI OAuth 账号，并提供“异常账号 / 全部账号”分段选择和名称/邮箱搜索。用户负责最终页面和真实账号验收；开发交付不执行浏览器点击、真实邮箱、真实密码、真实 2FA、真实 OAuth 或真实凭据写回，只执行不触碰真实账号的自动测试、类型检查、lint、依赖审计和生产构建。

### 28.2 当前代码与线上契约复核

当前本地实现只有创建任务：

- `src/shared/contracts.ts` 只有 `CreateTaskInputSchema`，`TaskSelection` 也全部是创建选项；
- `src/server/routes/tasks.ts` 的 `POST /local-api/tasks` 只能启动创建任务；
- `src/server/tasks/orchestrator.ts` 在 OAuth 兑换后固定执行二次查重、`POST /admin/accounts` 和创建确认；
- `src/server/backend/accounts.ts` 已有账号列表、详情、生成授权地址和兑换 code，但没有已有账号 OAuth 凭据写回方法；
- `src/web/App.vue` 只有添加账号、任务记录和设置三个入口；
- SQLite 的任务表没有任务类型列，创建选项存放在 `selection_json`。

2026-08-14 对当前线上部署前端资源进行了第二次只读复核。当前 OpenAI 重新授权分支使用：

```text
GET  /api/v1/admin/accounts
GET  /api/v1/admin/accounts/{accountId}
POST /api/v1/admin/openai/generate-auth-url
POST /api/v1/admin/openai/exchange-code
POST /api/v1/admin/accounts/{accountId}/apply-oauth-credentials
GET  /api/v1/admin/accounts/{accountId}
```

部署资源中的 OpenAI 分支调用 `apply-oauth-credentials` 后直接使用返回账号，不额外调用 `clear-error`。本地实现应遵循该已部署契约，不调用 `POST /admin/accounts`，也不自行追加 `clear-error`。后台契约以后若变化，必须重新核对，不能把普通账号更新接口或创建接口猜作等价替代。

### 28.3 方案对比与推荐

| 方案 | 优点 | 缺点与风险 | 结论 |
| --- | --- | --- | --- |
| 在“添加账号”增加“重新授权”开关 | 表面文件改动少 | 创建选项和重新授权目标混在一起，容易误走创建分支，用户已明确要求独立入口 | 不采用 |
| 独立页面和独立本地启动接口，底层复用 OAuth 浏览器流程 | 用户流程清楚；请求契约可在服务端强制区分；已有登录自动化可复用 | 需要扩展任务类型、状态机、历史和账号适配器 | 推荐 |
| OAuth 兑换后调用通用账号 `PUT` | 接口看似通用 | 需要正确合并旧凭据和其他账号配置，容易覆盖模型或调度字段；不是当前 OpenAI 重新授权分支 | 不采用 |
| 调用专用 `apply-oauth-credentials` | 与当前部署前端一致，只更新目标账号 OAuth 凭据 | 写操作没有已验证的幂等键，网络不确定时不能重放 | 推荐 |
| 把旧 OAuth 凭据保存到本地用于自动回滚 | 可尝试恢复旧凭据 | 扩大秘密持久化面，违反当前不保存 Token 的边界 | 不采用 |

最终方案使用独立页面、独立请求 schema 和专用后台写回接口，但继续使用同一个 `TaskOrchestrator`、单活动任务锁、无痕 Chrome、邮箱轮询、TOTP、回调捕获、OAuth 兑换、SSE 和任务历史基础设施。

### 28.4 本地公开契约与账号选择

新增无秘密的账号查询类型：

```ts
interface ReauthorizationAccountSummary {
  id: number
  name: string
  email: string
  status: string
}

interface ReauthorizationAccountPage {
  items: ReauthorizationAccountSummary[]
  page: number
  pageSize: number
  total: number
  pages: number
}
```

新增本地接口：

```text
GET  /local-api/reauthorization/accounts?scope=error|all&search=&page=&pageSize=
GET  /local-api/reauthorization/accounts/{accountId}
POST /local-api/reauthorization/tasks
```

列表接口固定向后台增加 `platform=openai&type=oauth`；`scope=error` 时再增加 `status=error`。`search` 首尾去空格且限制长度，页码和每页数量设置上限。服务端只返回 ID、名称、规范化邮箱和状态，不返回 `credentials`、`extra`、代理连接信息、错误详情或任何 Token。详情接口再次读取指定 ID，并只返回同一份公开摘要。

重新授权请求使用独立严格 schema：

```ts
interface ReauthorizeTaskInput {
  accountId: number
  accountEmail: string
  loginMaterial: LoginMaterial
}
```

`accountEmail` 是前端对当前选择的公开快照，不是写回定位条件。真正的写回目标只能是正整数 `accountId`。任务执行开始后必须重新读取该 ID，并验证：

1. 返回 ID 与请求 ID 完全一致；
2. `platform === 'openai'` 且 `type === 'oauth'`；
3. `credentials.email` 与 `extra.email` 如果同时存在必须一致；
4. 至少有一个可信邮箱字段，且规范化后等于请求中的锁定邮箱；
5. 缺失、删除、类型变化或邮箱变化均在打开浏览器前失败。

不使用账号名称推断邮箱。列表加载后到任务启动之间发生后台变化时，以任务开始时的详情复核为准。

### 28.5 后台账号适配器与凭据白名单

`BackendAccountsApi` 扩展专用方法：

```ts
listReauthorizationAccounts(query): Promise<ReauthorizationAccountPage>
getReauthorizationTarget(accountId): Promise<InternalReauthorizationTarget>
applyOAuthCredentials(accountId, payload): Promise<BackendAccount>
confirmAppliedCredentials(accountId, expected): Promise<CredentialConfirmation>
```

内部目标允许读取但不得公开以下非秘密字段：`proxy_id`、`machine_id`、`updated_at`。账号详情的其他未知字段通过 Zod `.passthrough()` 接受但不向前端传播。目标的 `credentials` 只允许在服务端适配器内部读取邮箱，以及在不确定写回后的立即确认过程中短暂比较 Token；原始对象不进入任务、日志或错误。

兑换结果沿用现有 OpenAI allowlist。写回载荷严格重建为：

```ts
{
  type: 'oauth',
  credentials: {
    access_token,
    expires_at?,
    refresh_token?,
    id_token?,
    email?,
    chatgpt_account_id?,
    chatgpt_user_id?,
    organization_id?,
    plan_type?,
    subscription_expires_at?,
    client_id?
  },
  extra?: {
    email?: string,
    name?: string,
    privacy_mode?: string
  }
}
```

不得把 OAuth 返回的未知字段、旧账号的模型映射、调度配置、分组或代理配置夹带进写回载荷。专用接口负责保留账号的非 OAuth 配置，本地工具不对旧账号执行通用覆盖更新。

### 28.6 三次目标核对与邮箱防串号

重新授权设置三次独立核对：

1. 浏览器启动前：按 ID 读取目标，确认平台、类型和锁定邮箱；
2. OAuth code 兑换后：要求兑换结果提供合法邮箱，且规范化后与目标邮箱完全一致；
3. 写回前：再次按相同 ID 读取目标，确认账号仍存在、仍为 OpenAI OAuth、邮箱仍未变化。

第二步不允许用账号名称、`chatgpt_account_id` 或用户手工确认替代。若 OAuth 返回邮箱缺失或用户在无痕 Chrome 中改用了另一个 OpenAI 账号，任务以 `OAUTH_ACCOUNT_EMAIL_MISMATCH` 失败，保留后台原账号不变，不调用写回接口。

第三步与第一次相比只允许状态等普通运行字段变化。ID、平台、类型或邮箱变化表示选择已经失效，任务停止。这样可以防止页面选择后账号被其他管理员删除、替换或修改身份时仍写入旧目标。

### 28.7 代理继承规则

重新授权页不提供代理选项，也不会修改账号代理。服务端从目标账号读取现有 `proxy_id`，没有时才读取 `machine_id`：

- 两者都没有：授权 URL、兑换和无痕 Chrome 均使用直连；
- 有 `proxy_id`：从当前后台选项中精确解析同一代理，并同时用于授权 URL、兑换和 Chrome；
- 只有 `machine_id`：从代理机选项精确匹配并解析连接配置，授权 URL 使用同一 `machine_id`，兑换仅在解析出实际 `proxy_id` 时携带该值；
- 账号现有代理已删除、不可用或缺少浏览器连接配置：在生成授权 URL 前失败，不自动换成另一个代理，也不为动态订阅重新分配节点。

该策略保证重新授权不会暗中改变账号配置，也避免浏览器登录与后台兑换使用不同网络路径。若后台以后为重新授权提供明确的动态订阅解析契约，再单独扩展；本次不猜测。

### 28.8 任务类型、公开状态与 SQLite 兼容

`TaskSelection` 改为带 `operation` 的联合类型：

```ts
type TaskSelection =
  | ({ operation: 'create' } & ExistingCreateSelection)
  | {
      operation: 'reauthorize'
      targetAccountId: number
      targetAccountName: string | null
      statusBefore: string | null
      proxyMode: 'existing' | 'none'
      proxyId?: number
      machineId?: number
      proxyName?: string
    }
```

现有任务行的 `selection_json` 没有 `operation`，读取时统一补为 `create`。新任务类型直接保存在已有 `selection_json`，因此不新增 SQLite 列、不执行表迁移，也不修改已有历史记录。公开任务仍只有邮箱、操作类型、无秘密选择摘要、授权诊断、账号结果和固定错误。

状态机增加：

- `loading_target_account`；
- `applying_oauth_credentials`；
- `confirming_reauthorization`；
- `reauthorization_result_uncertain`。

公共流程如下：

```text
重新授权
  校验请求 -> 读取并锁定目标 -> 读取代理选项
  -> 邮箱基线（仅邮箱验证码模式）-> 解析目标现有代理
  -> 生成授权地址 -> 无痕 Chrome 登录 -> 回调 -> 兑换
  -> 核对兑换邮箱 -> 再次核对目标
  -> apply-oauth-credentials -> 确认同一账号 ID -> 完成

添加账号
  保持现有校验 -> 查重 -> OAuth -> 二次查重 -> 创建 -> 确认
```

`exchanging_code` 根据 `selection.operation` 进入创建的 `checking_duplicate` 或重新授权的 `applying_oauth_credentials`。从 `applying_oauth_credentials` 开始禁止取消；此前仍允许取消。前端不再硬编码不可取消阶段，由共享任务状态辅助函数同时供服务端和界面使用。

### 28.9 写回不确定性与禁止重放

`apply-oauth-credentials` 是有外部副作用的写请求，当前后台没有已验证的幂等键。传输层对普通 POST 本来只发送一次；只有后台明确返回 `401` 时，授权客户端刷新后台会话后可重新发送，因为未授权请求没有执行写操作。

下列情况视为写回结果不确定：网络断开、30 秒超时、响应体损坏，以及后台 `5xx`。处理规则固定为：

1. 进入 `reauthorization_result_uncertain`；
2. 不再次调用 `apply-oauth-credentials`；
3. 立即按同一账号 ID 查询详情；
4. 若后台返回完整凭据，只在服务端内存中与本次兑换的 access token 和可用 refresh token 做常量时间比较；完全一致时确认成功；
5. 后台返回掩码、缺失凭据、凭据不一致或详情查询失败时，返回 `ACCOUNT_REAUTHORIZATION_UNCERTAIN`，提示用户到后台人工核对；
6. 不使用 `updated_at` 或状态变化单独判定成功，因为这些字段可能由其他后台动作改变。

凭据比较封装在后台适配器内部，比较完成后立即释放引用，不生成摘要、不落盘、不进入异常详情。明确的 `4xx` 作为失败返回；成功 `2xx` 必须解析出与 URL 中相同的账号 ID，再查询最新公开状态并完成任务。

### 28.10 页面、表单与当前页面秘密内存

`App.vue` 的视图类型新增 `reauthorization`，导航使用与现有图标库一致的刷新授权图标。新增页面使用紧凑账号表格而不是卡片堆叠：顶部是“异常账号 / 全部账号”分段选择和搜索，列表显示名称、邮箱、状态和账号 ID；选择后在表单上方显示锁定目标摘要。

登录材料控件从现有 `TaskForm.vue` 提取为共享 `LoginMaterialFields.vue`：

- 添加账号继续显示可编辑账号邮箱和原创建选项；
- 重新授权显示只读邮箱，不渲染代理、并发、供应商、分组、重复创建、混合渠道或模型选项；
- 两个页面各自拥有独立的秘密内存，重新授权材料按目标账号 ID 保存在当前 Vue 页面内存；
- 页面切换、任务成功或失败不自动清空当前目标的输入，便于用户修正后重试；
- 刷新、关闭页面或重启服务后不从浏览器存储、SQLite、Keychain 或后端恢复任何取件密码、账号密码或 2FA 密钥；
- 从账号 A 切换到账号 B 不继承 A 的材料，切回 A 时仅恢复当前页面会话内为 A 输入过的内容。

重新授权页面复用 `TaskProgress` 和取消动作。活动任务属于添加账号时，重新授权页只显示该活动任务并禁用开始；反向同理，保持全应用单活动任务。

### 28.11 历史记录与错误模型

任务记录增加“任务类型”列：`添加账号` 或 `重新授权`。创建任务继续显示代理、并发、供应商、分组和重复创建；重新授权任务显示目标账号 ID、写回前状态和“沿用原账号代理”，创建专属列显示 `—`。结果账号必须与重新授权目标 ID 相同，否则任务失败。

新增固定错误：

| 错误码 | 场景 | 行为 |
| --- | --- | --- |
| `REAUTHORIZATION_TARGET_INVALID` | ID 不存在、平台/类型不符或目标缺少可靠邮箱 | 浏览器启动前失败 |
| `REAUTHORIZATION_TARGET_CHANGED` | 启动后到写回前 ID 身份字段发生变化 | 不写回 |
| `OAUTH_ACCOUNT_EMAIL_MISMATCH` | OAuth 返回邮箱缺失或与目标不一致 | 不写回 |
| `REAUTHORIZATION_PROXY_INVALID` | 目标现有代理无法按同一路径解析 | 不自动换代理 |
| `ACCOUNT_REAUTHORIZATION_FAILED` | 后台明确拒绝写回 | 失败，不重试 |
| `ACCOUNT_REAUTHORIZATION_UNCERTAIN` | 写回可能已执行但无法安全确认 | 不重放，提示后台核对 |

现有邮箱、密码、TOTP、页面分类、人工接管、回调 state、后台会话和取消错误保持原语义。所有新错误只包含固定文本，不包含目标账号原始凭据、OAuth URL 查询、code、Token、邮箱取件链接、密码、2FA 密钥或验证码。

### 28.12 文件范围

计划新增：

- `src/server/routes/reauthorization.ts`：候选账号列表、详情和重新授权任务启动接口；
- `src/server/tasks/account-reauthorizer.ts`：写回载荷、同 ID 确认和不确定结果确认；
- `src/web/views/ReauthorizationView.vue`：账号搜索、选择、锁定摘要、登录材料和任务进度；
- `src/web/components/LoginMaterialFields.vue`：添加账号和重新授权共享的互斥登录材料控件；
- `tests/unit/account-reauthorizer.test.ts`：凭据 allowlist、ID 校验和不重放规则。

计划修改：

- `src/shared/contracts.ts`：候选账号、重新授权输入和带操作类型的选择联合；
- `src/shared/task-state.ts`、`src/server/tasks/state-machine.ts`：重新授权阶段、共享取消判断和合法转换；
- `src/server/backend/accounts.ts`：列表分页、目标详情、专用写回和内存确认；
- `src/server/tasks/orchestrator.ts`：两种启动入口、公共授权流程和创建/写回后段分支；
- `src/server/storage/database.ts`：旧选择补 `operation: 'create'`，不改表结构；
- `src/server/app.ts`、`src/server/index.ts`：注册重新授权适配器和本地路由；
- `src/web/api.ts`、`src/web/state.ts`、`src/web/App.vue`、`src/web/components/TaskForm.vue`、`src/web/views/HistoryView.vue`、`src/web/styles.css`：独立入口、账号选择、表单状态和历史展示；
- 现有契约、账号 API、状态机、编排、本地 API、存储和前端状态测试；
- `README.md`、`DOC.md`、`QA.md`：实施后按最终代码和实际自动验证结果更新。

不增加运行时依赖，不修改邮箱适配器、TOTP 算法、Chrome 权限、后台会话保存方式或单任务并发限制。

### 28.13 开发顺序与依赖

1. 先为重新授权请求、公开账号摘要和任务选择联合补失败测试，确保创建请求与重新授权请求不能互相解析。
2. 扩展后台账号 schema、分页查询、目标详情、写回载荷和不确定结果确认，并用完全合成 Token 测试秘密不公开。
3. 实现 `AccountReauthorizer`，固定三次目标核对、邮箱一致性和同 ID 结果约束。
4. 扩展状态机和数据库旧行兼容，再把编排器改为公共授权前段加创建/重新授权后段；先保持现有创建集成测试通过。
5. 增加本地候选账号路由和启动接口，验证会话、Origin、CSRF、严格参数、单活动任务和秘密不落盘。
6. 提取共享登录材料控件，增加重新授权视图和独立页面内存，再更新历史任务类型显示。
7. 执行聚焦测试、全量测试、类型检查、lint、生产依赖审计和生产构建，检查公开响应、SQLite 和 `dist` 不含合成秘密。
8. 根据实际实现更新 README、DOC 和 QA；只读确认没有活动任务后重新构建并安全重载现有 LaunchAgent，验证健康接口。

实施不能并行修改 `contracts.ts`、状态机和编排器，因为三者共享任务联合和阶段契约；应先稳定契约，再顺序接入。前端视图可在本地接口契约稳定后实施。

### 28.14 自动测试与用户验收边界

必须完成的非页面自动验证：

1. 候选列表固定过滤 OpenAI OAuth；异常/全部范围、搜索、分页和畸形响应正确处理，秘密字段不进入公开结果。
2. 目标详情缺失邮箱、邮箱冲突、ID 不符、非 OpenAI 或非 OAuth 时闭合失败。
3. 重新授权请求不能包含代理、并发、供应商、分组、重复创建或模型字段；创建请求也不能伪装为重新授权。
4. 两种登录材料严格互斥，并复用现有邮箱轮询、密码/TOTP、页面分类和秘密释放测试。
5. 目标账号邮箱在浏览器启动前、兑换后和写回前三次核对；任意不一致都不调用写回。
6. 重新授权只调用 `apply-oauth-credentials`，断言整个分支从不调用 `createAccount`、通用账号更新或 `clearError`。
7. 写回载荷只包含已批准凭据与 extra 白名单，不包含旧模型、分组、代理、并发或未知兑换字段。
8. 目标现有直连、固定代理和代理机场景使用一致网络路径；失效代理不自动替换。
9. 网络、超时、损坏响应和 `5xx` 后只查询一次确认，不重放写回；完整凭据匹配才确认成功，掩码或缺失返回不确定。
10. 成功结果、写回响应和最终详情的账号 ID 必须等于目标 ID；不相等时失败。
11. 创建与重新授权共用单活动任务；写回开始后不能取消，之前可以取消。
12. 旧 SQLite 任务缺少 `operation` 时显示为添加账号；新任务重启后仍显示重新授权和目标 ID。
13. 历史、详情、SSE、错误、SQLite、日志和构建产物不含邮箱取件凭据、密码、TOTP 密钥、验证码、OAuth code 或 Token。
14. 现有添加账号的邮箱验证码、密码 + 2FA、查重、允许重复创建、代理、分组、混合渠道、模型清除、创建和确认测试全部保持通过。

最终命令：

```bash
npm run typecheck
npm run lint
npm test
npm audit --omit=dev
npm run build
```

遵照用户要求，最终页面和真实账号验收由用户自行执行。开发方不运行浏览器点击、视觉回归、真实账号查询选择后的真实授权、真实邮箱取件、真实密码/TOTP 或真实 `apply-oauth-credentials`。因此自动测试通过只能证明本地契约、合成控制流、秘密边界、构建和服务加载正确，不能声称真实 OpenAI 页面或真实后台写回已经端到端通过。

### 28.15 风险、回滚与完成标准

主要风险：

- 写错已有账号：以账号 ID 为唯一目标，并设置开始前、兑换后、写回前三次身份核对；
- 用户在无痕窗口登录另一账号：兑换邮箱必须与锁定邮箱完全一致；
- 后台写回已执行但响应丢失：不重放，只在完整凭据可比较时确认，否则人工核对；
- 账号详情返回 Token：只在服务端适配器局部内存比较，不进入公开类型、日志、错误、SQLite 或摘要；
- 后台接口变化：专用 endpoint 或响应 schema 不匹配时闭合失败，不回退到通用更新或创建；
- 共用编排器引起创建回归：使用带操作类型的联合和分支测试，创建路径禁止访问写回方法，重新授权路径禁止访问创建方法；
- 现有代理变化：不自动替换，避免授权和兑换网络路径漂移；
- 成功写回不可由本地代码回滚：工具不保存旧 OAuth Token，代码回滚不会恢复后台旧凭据，只能再次重新授权。

代码回滚时移除重新授权导航、视图、路由、任务分支和 `AccountReauthorizer`，并把 `TaskSelection` 读取兼容保留到旧重新授权历史不再需要为止。因为没有 SQLite 表迁移和本地长期秘密，代码回滚不需要数据库恢复；已经成功写回后台的 OAuth 凭据不会被自动撤销或恢复。

完成标准：

1. 添加账号和重新授权是两个独立入口，创建路径行为不变。
2. 重新授权只能使用后台返回的 OpenAI OAuth 账号 ID 和锁定邮箱。
3. 两种登录方式互斥，秘密只存在于当前页面和活动任务内存。
4. OAuth 兑换邮箱与目标不一致时绝不写回。
5. 成功写回和确认结果始终是原账号 ID，重新授权分支不存在创建调用。
6. 不确定写回不重放，并给出明确的后台人工核对状态。
7. 历史可区分两种任务，旧创建历史保持兼容。
8. 聚焦测试、全量测试、类型检查、lint、生产依赖审计和构建通过，README、DOC、QA 与最终实现一致。
9. 确认无活动任务后安全重载服务并通过健康检查；真实页面和真实账号验收明确留给用户执行。

### 28.16 实施结果

最终实现采用独立页面、独立本地路由和带 `operation` 的共享任务编排。候选账号固定筛选 OpenAI OAuth，邮箱由账号详情读取并锁定；邮箱验证码与密码 + 2FA 两种登录材料复用现有 Chrome、验证码、TOTP、同意页、回调和兑换流程。OAuth 兑换后，创建分支保持原有查重与创建逻辑，重新授权分支只调用 `POST /admin/accounts/{id}/apply-oauth-credentials`，并记录原账号 ID 与写回前状态。

实施期审查额外补强了详情响应 ID 校验：即使请求 URL 使用正确账号 ID，只要后台响应体返回不同 ID，也会在浏览器启动或写回确认前闭合失败。目标邮箱在浏览器前、兑换后和写回前三次核对；成功响应、最终结果和不确定写回确认也都必须指向同一个账号 ID。明确 `4xx` 不查询确认、不重试；网络、超时、损坏响应或 `5xx` 最多查询一次完整凭据并进行内存比较，绝不重放写请求。

页面秘密按目标账号 ID 隔离在当前 Vue 文档内存，公开候选、任务、SSE、SQLite 和历史均不包含凭据。SQLite 没有新增列，旧任务缺少 `operation` 时继续读取为添加账号。重新授权沿用目标账号原代理，原代理不能精确解析时停止，不自动换代理。实现未增加运行时依赖，也未扩大 Chrome、后台账号或本地文件权限。

自动验证结果记录在 `QA.md` 第 41 节。开发过程没有执行页面点击、真实账号选择后的真实授权、真实邮箱取件、真实密码/2FA、OAuth code 兑换或真实 `apply-oauth-credentials`；这些外部流程继续由用户按验收标准自行确认。

## 29. 账号池自动材料解析（已批准并实施）

### 29.1 已确认效果

添加账号和重新授权都不再要求用户手动选择“密码 + 2FA”或“邮箱验证码”，也不要求用户在本地工具再次录入账号密码、2FA 密钥或邮箱取件 Token。任务只使用账号邮箱作为查找键，从本机 `queue-management` 账号池取得该邮箱的全部可用登录材料，并按以下固定规则选择：

1. 精确邮箱记录同时存在非空账号密码和通过 Base32 校验的 2FA 密钥时，自动使用“密码 + 2FA”流程。
2. 密码或 2FA 任一缺失/格式无效时，如果存在非空邮箱取件 Token，自动使用“邮箱验证码”流程。
3. 两种材料都存在时仍固定优先“密码 + 2FA”，不访问邮箱接口，减少等待和旧验证码风险。
4. 只有邮箱地址、只有不完整的密码/2FA、没有邮箱 Token、邮箱未找到、邮箱匹配不唯一、账号池不可用或响应无法严格校验时，在打开 OpenAI 页面前终止任务；不猜测模式、不使用其他记录、不进入人工接管来补交秘密。
5. 密码/2FA 登录被 OpenAI 明确拒绝后不自动切换邮箱验证码；如需切换，必须由用户重新发起任务并在账号池修正材料，避免同一账号连续尝试两种凭据。

本次不改变后台账号创建、重新授权、代理、并发、供应商、分组、清除模型、查重、回调校验或浏览器权限语义。现有手动 `loginMaterial` 请求仅作为兼容接口保留，自动账号池模式由服务端根据邮箱解析，秘密不回传页面。

### 29.2 现有账号池事实与限制

`queue-management` 使用自己的登录会话、SQLite 和静态加密密钥保存记录。现有 `GET /api/records?q=...` 面向后台网页，会在认证后返回解密的 `password`、`verification` 和 `emailToken`，因此不能让 `up-icloud` 复用网页 Cookie，也不能把该宽接口的完整响应直接穿过本地 API。恢复邮箱地址本身不能读取验证码，必须有对应的邮箱 Token 或完整取件链接。

本地测试数据的覆盖应至少包含：

- 只有完整密码 + 2FA；
- 只有邮箱 Token；
- 两种材料同时存在；
- 密码存在但 2FA 缺失/格式错误；
- 2FA 存在但密码为空；
- 找不到记录、重复匹配、记录已删除；
- 账号池服务不可达或返回畸形 JSON。

测试只使用合成邮箱和合成秘密，不读取、复制或写入真实账号材料。

### 29.3 推荐桥接边界

新增一个由 `queue-management` 提供的专用本地只读桥接接口，绑定在 `127.0.0.1`，不修改其现有网页接口语义。桥接接口使用独立的 capability token，与账号池网页登录 Cookie 分离；token 通过本机环境配置或受限文件注入，不能从网页表单输入，也不能在响应中回显。

建议接口：

```text
GET http://127.0.0.1:3001/internal/account-materials?email=<exact-normalized-email>
Authorization: Bearer <ACCOUNT_POOL_BRIDGE_TOKEN>
Accept: application/json
```

约束：

- 只接受一个规范化后的精确邮箱，不接受通配符、模糊搜索、分页、记录 ID 或批量邮箱；邮箱必须与响应中的 `email` 完全相等（大小写按规范化结果比较）。
- 只返回临时任务所需的 allowlist 字段：`email`、`password`（可选）、`totpSecret`（可选）、`mailboxAccess`（可选）。不返回 Session、XY、恢复邮箱、备注、状态、审计内容、展示字段或其他记录。
- 响应使用 `Cache-Control: no-store`、严格 JSON schema 和小体积上限；未知字段、重复记录、邮箱不一致、材料类型错误或同时为空均视为协议错误。
- 每次成功或失败查询写入不含秘密的审计事件（规范化邮箱指纹、结果类别、请求来源和耗时），不得写入密码、2FA、Token、响应正文或 Authorization 头。
- 桥接服务不创建账号、不修改记录、不代替网页登录，也不暴露给非环回网卡。`up-icloud` 不读取账号池 SQLite 或 `.encryption-key`。
- `up-icloud` 不把桥接 token 放入 Vue、任务请求、SQLite、任务历史、SSE、日志或错误详情；仅由服务端启动配置读取。

桥接认证失败、账号池不可达、超时、返回 401/403、响应 schema 不匹配、精确邮箱未找到或多条命中时，统一转为可诊断但不含秘密的本地错误；任务在 `resolve_login_material` 阶段结束，不打开浏览器、不生成 OAuth 链接、不兑换 code、不创建或写回后台账号。

### 29.4 `up-icloud` 自动解析流程

任务请求新增一个服务端可识别的材料来源标记，例如 `loginMaterialSource: "account_pool"`；自动模式请求只提交 `accountEmail` 及现有账号配置，不能携带手工秘密字段。为兼容旧调用方，现有 `loginMaterial` 与自动模式采用严格互斥联合，不能同时出现。

编排器在任何代理解析、OAuth URL 生成或浏览器启动之前执行：

```text
规范化 accountEmail
  -> queue bridge 精确查找
  -> 校验响应 email 与材料 schema
  -> password 非空且 totpSecret 通过 Base32 校验？
       是 -> SecretScope(password, totpSecret)，preferredLogin = password
       否 -> mailboxAccess 非空？
                是 -> SecretScope(mailboxAccess)，preferredLogin = email_otp
                否 -> 缺少登录材料错误
  -> 仅将 preferredLogin 和秘密作用域交给现有浏览器/邮箱控制器
```

材料选择器必须是无副作用的纯函数，单独测试所有组合。密码按原字符传递；2FA 继续复用现有 `normalizeTotpSecret`；邮箱 Token 继续复用现有 URL provider allowlist 和两轮 OTP 轮询。选择结果只进入不含秘密的内部枚举/状态摘要，例如 `password_totp` 或 `email_otp`，不进入公开任务详情。

自动模式下前端：

- 只显示账号邮箱和“从本地账号池自动获取”状态；不渲染密码、2FA、邮箱 Token 输入框，也不提供登录模式切换。
- 添加账号和重新授权均可使用自动模式；重新授权仍以后台账号锁定邮箱为查找键，不能修改邮箱。
- 在账号池查询失败或材料缺失时显示固定错误原因和下一步提示，但不显示账号池响应、密码、Token、验证码或 OAuth 数据。
- 现有手动模式页面和 API 保留，便于账号池不可用时明确切换到旧流程；自动模式不得隐式回退到手工字段或旧页面缓存。

### 29.5 数据流与秘密生命周期

```text
本地页面（仅邮箱与选项）
  -> up-icloud 服务端
       -> queue-management 专用桥接（短请求）
       -> SecretScope（仅活动任务）
       -> 现有密码/TOTP 或邮箱 OTP 控制器
       -> OAuth 兑换/后台创建或原账号写回
       -> finally 释放桥接返回值与 SecretScope
```

桥接响应在解析后立即拆分为当前模式所需字段；未选择的材料和原始响应引用立即释放。任务取消、失败、成功、浏览器关闭、服务关闭和超时均执行同一清理路径。不得把自动解析出的材料复制到 `InternalTask`、SQLite、Keychain、浏览器页面、前端状态、SSE、异常 `cause` 或调试日志。

### 29.6 文件与接口变更

计划修改 `queue-management/server.mjs`：

- 增加环回专用 bridge token 配置、严格请求/响应校验、精确邮箱查询和非敏感审计；不改变网页 `/api/records`、`/api/records/:id/secret` 或取码接口。

计划新增或修改 `up-icloud`：

- `src/server/account-pool/bridge-client.ts`：桥接 HTTP 客户端、超时、token 注入和响应 schema。
- `src/server/account-pool/material-selector.ts`：完整性判定与固定优先级纯函数。
- `src/server/config.ts`：桥接地址、token 和超时配置，仅服务端读取。
- `src/shared/contracts.ts`：自动材料来源联合、公开状态摘要和固定错误码；拒绝秘密字段混入自动请求。
- `src/server/tasks/orchestrator.ts`：在公共前段最早阶段解析材料，并把选择结果接入现有控制器；保留手动模式分支。
- `src/server/security/secret-scope.ts`：必要时增加批量释放/原始响应清理辅助，不改变现有公开边界。
- `src/server/routes/tasks.ts`、`src/web/state.ts`、`src/web/components/TaskForm.vue`、`src/web/components/LoginMaterialFields.vue`：自动模式输入和状态显示；不把桥接材料暴露到浏览器。
- `tests/unit/account-pool-material-selector.test.ts`、`tests/unit/account-pool-bridge-client.test.ts`、`tests/integration/orchestrator.test.ts`：合成数据下覆盖选择、协议、错误、秘密边界和现有手动流程回归。
- `README.md`、`DOC.md`、`QA.md`：实施完成后依据最终配置、测试结果和实际限制更新，不写入 token 或真实账号数据。

### 29.7 测试、回滚与完成标准

必须完成的非页面自动验证：

1. 精确邮箱命中、未命中、多命中、大小写/空白规范化和已删除记录处理正确。
2. 完整密码 + 有效 2FA 优先于邮箱 Token；密码或 2FA 任一缺失/无效时才选择邮箱 Token；两者都不完整时在浏览器启动前失败。
3. 桥接 token 缺失、错误、过期、非环回来源、超时、非 JSON、未知字段、邮箱不一致和秘密字段类型错误均闭合失败，不调用 OAuth 或后台写接口。
4. 自动任务请求和公开任务、SSE、SQLite、日志、错误详情及构建产物不包含任何合成密码、2FA、邮箱 Token、验证码或 OAuth 值。
5. 选择 `password_totp` 时不实例化邮箱客户端、不建立邮箱基线、不触发重发；选择 `email_otp` 时不读取密码或生成 TOTP。
6. 添加账号和重新授权都只执行一次材料解析；取消、异常和重试不会重复提交账号创建或重新授权写回。
7. 现有手动邮箱验证码、手动密码 + 2FA、添加账号、重新授权和重复创建行为保持通过。

回滚只需关闭自动材料来源配置并恢复前端默认手动模式；桥接接口可独立停用或撤销 capability token，不删除账号池记录，不回滚或覆盖已经成功创建/写回的后台账号。完成标准是以上测试、类型检查、lint、依赖审计和构建全部通过，且不进行真实账号登录、真实邮箱取件或真实后台写操作验收。

### 29.8 已确认安全边界

用户已批准以下安全边界：

- 使用 `queue-management` 的独立本地只读 bridge，而不是复用网页登录 Cookie、直接读取其 SQLite，或把账号池完整记录返回给前端；
- 自动模式只显示邮箱和状态，手动模式继续作为显式兼容入口；
- 密码/2FA 被明确拒绝时不自动切换邮箱验证码，需重新发起任务。

密码/2FA 被明确拒绝后不自动回退邮箱验证码；账号池只通过独立环回 bridge 返回最小字段；页面默认自动获取，旧手动材料作为显式备用模式保留。

### 29.9 实施结果

`queue-management` 已新增 `GET /internal/account-materials`。接口只接受一个精确邮箱和独立 Bearer capability token，只监听现有环回地址，返回 `email` 及可选 `password`、`totpSecret`、`mailboxAccess`，并用邮箱哈希记录不含秘密的查询结果。网页登录 Cookie、Session、XY、备注和其他账号字段不会进入响应，现有 `/api/records` 与数据库结构未改变。

两个服务默认从权限为 `0600` 的 `/Users/lkj/Library/Application Support/up-icloud/account-pool-bridge-token` 读取同一随机 token；环境变量 `ACCOUNT_POOL_BRIDGE_TOKEN` 或 `ACCOUNT_POOL_BRIDGE_TOKEN_FILE` 可以覆盖。`up-icloud` 的 bridge 客户端限制为环回 HTTP origin、5 秒超时、64 KiB 响应上限、禁止重定向和严格响应 schema。

添加账号与重新授权页面默认选择“账号池自动获取”，请求只携带邮箱和原有业务选项。编排器在读取后台选项、生成 OAuth URL 或启动 Chrome 之前精确查询一次账号池：完整密码 + 有效 Base32 2FA 优先；否则使用邮箱 Token；材料不完整或桥接异常时在 `validating` 阶段失败。所选材料只进入现有 `SecretScope`，成功、失败、取消或服务关闭后释放；公开任务只记录 `loginMaterialSource`，不记录具体模式或任何秘密。

实际自动验证：

- `npm test`：26 个测试文件、424 项测试全部通过；
- `npm run typecheck`、`npm run lint`、`npm audit --omit=dev`、`npm run build` 全部通过，生产依赖 0 个已知漏洞；
- `queue-management` 执行 `npm run check` 通过；
- 临时端口验证错误 token、精确邮箱未命中、额外查询参数分别返回 `401`、`404`、`400`；
- 持久服务重载后，`127.0.0.1:3001` 的 bridge 返回新的固定未命中响应，`127.0.0.1:43123/healthz` 返回 `200`；
- 构建产物扫描未发现测试中的合成密码、2FA、邮箱 Token 或 bridge token。

遵照默认测试边界，没有执行浏览器页面点击、真实账号池成功材料读取、真实 OpenAI 登录、真实邮箱取码、OAuth 兑换或后台账号创建/重新授权写回。
