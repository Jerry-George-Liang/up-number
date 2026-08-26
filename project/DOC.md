# 实现文档

## 1. 实际效果

应用由一个只监听环回地址的 Fastify 服务和一个 Vue 操作界面组成。设置页接受后台登录邮箱和密码，并在后台要求时进入 TOTP 步骤；左侧将“添加账号”和“重新授权”作为独立流程。两者默认按账号邮箱从本机号池自动取得登录材料：完整密码 + 2FA 优先，否则使用邮箱 Token；材料不足时在浏览器启动前失败。页面保留显式“手动备用”入口，但不要求用户选择密码流程或邮箱验证码流程。重新授权只能选择后台已有的 OpenAI OAuth 账号，邮箱由账号详情锁定，成功时更新原账号 ID 而不创建新账号。任务记录页只显示脱敏状态、任务类型和后台账号结果。

任务页的“允许重复创建”默认开启，用户可以随时关闭。开启时跳过创建前后的两次精确查重，允许后台为同一规范化邮箱再次创建账号；关闭时保持原有拦截行为。接口调用方没有提交该字段时默认关闭，旧调用方和旧任务记录继续采用安全的拦截语义。

后台“添加账号”分为两个业务阶段。本地工具按相同边界直接调用接口：

1. 准备账号基础配置，包括固定的 OpenAI OAuth 类型以及用户选择的代理、并发数、供应商、分组和清空模型语义。
2. 调用后台生成授权链接，在无痕浏览器完成 OpenAI 登录；当主页面导航或导航请求变为 `http://localhost:<port>/auth/callback?code=...&state=...` 时，在内存中捕获完整回调地址并解析 `code/state`。这等价于后台页面“输入授权链接或 Code”的完整回调 URL 输入方式，但本地工具不自动化后台弹窗，也不把完整回调 URL 暴露给页面。解析结果与生成链接时返回的同一个 `session_id` 一起提交兑换接口，凭据成功后才创建账号并查询详情确认。

任务执行顺序（关闭重复创建时）：

```text
公共前段：输入校验 -> 后台选项 -> 第一次精确查重
邮箱验证码：邮箱基线 -> 代理解析 -> 生成授权链接 -> 无痕浏览器 -> 邮箱
             -> 第一轮等待 -> 必要时第一次重发 -> 第二轮等待
             -> 必要时第二次重发 -> 第三轮等待 -> 邮箱验证码
密码 + 2FA：代理解析 -> 生成授权链接 -> 无痕浏览器 -> 邮箱 -> 密码
              -> 认证器动态码（最多两个不同周期）
公共后段：Codex 授权同意 -> 捕获并校验回调 -> 后台兑换
          -> 第二次精确查重 -> 创建 -> 详情确认
```

开启重复创建时，流程中的两次查重直接跳过，其余步骤保持不变。如果创建响应因网络中断或超时而不确定，任务不会自动重放创建请求；关闭重复创建时可按规范化邮箱查询确认，开启重复创建时不会把既有同名账号误判为本次创建结果，而是提示用户到后台确认。

任务选项仍全部采用受控选择：自动/手动材料来源和代理使用分段按钮，并发数使用 `1/3/5/10/20` 分段按钮，供应商使用单选列表，分组使用带已选数量、全选/取消全选和清空操作的复选列表。“清除所有模型”保持固定必选。账号邮箱始终显示；自动模式不显示秘密输入，手动备用模式才显示邮箱取件信息或独立的账号密码与 2FA 密钥。

## 2. 主要模块

- `src/server/backend/`：后台登录、TOTP、会话续期、授权、选项、代理和账号接口的唯一协议边界。
- `src/server/session/`：TOTP 内存中间态、Refresh 会话、Keychain 凭据兼容和单飞续期。
- `src/server/mail/`：固定邮箱 URL、限流/超时、HTML/JSON 归一化、基线和唯一 OTP 选择。
- `src/server/account-pool/`：本机号池精确邮箱 bridge、严格响应校验和密码/2FA 优先选择。
- `src/server/browser/`：OpenAI 授权地址约束、页面分类、Google Chrome 无痕会话和回调捕获。
- `src/server/security/totp.ts`：服务端 Base32 TOTP 生成、临期等待和取消处理。
- `src/server/tasks/`：状态机、单任务锁、取消边界、两阶段查重和创建结果确认。
- `src/server/tasks/account-reauthorizer.ts`：已有账号三次身份核对、专用 OAuth 凭据写回和不确定结果确认。
- `src/server/storage/`：只保存 `PublicTask` 与非敏感设置的 SQLite。
- `src/server/routes/`：受本地 Cookie、Origin 和 CSRF 保护的会话、选项、任务和 SSE API。
- `src/web/`：添加账号、重新授权、任务进度、任务记录和账号密码/TOTP 设置界面。

## 3. 后台认证

固定基地址：

```text
https://coding.tu-zi.com/api/v1
```

| 用途 | 方法与路径 |
| --- | --- |
| 公开认证条件 | `GET /settings/public` |
| 账号密码登录 | `POST /auth/login` |
| TOTP 验证 | `POST /auth/login/2fa` |
| 会话续期 | `POST /auth/refresh` |
| 当前用户 | `GET /auth/me` |
| 后台退出 | `POST /auth/logout` |

账号密码登录只提交 `email` 和 `password`。普通成功必须返回 access token、refresh token、用户和可选过期时间；需要 TOTP 时必须返回 `requires_2fa: true` 和 `temp_token`。TOTP 请求只提交后台临时 Token 与六位验证码。

服务端为 TOTP 创建 256-bit 本地 attempt ID，五分钟过期且只保留一个。前端从不接收后台临时 Token。挑战被取消、过期、伪造或在请求等待期间被替换时，不会建立会话。

发送密码前先 allowlist 读取公开认证条件。Turnstile、腾讯验证码、阿里验证码或强制登录协议任一启用时，返回 `BACKEND_INTERACTIVE_LOGIN_REQUIRED`，不发送密码。账号密码错误、TOTP 错误、契约错误、网络错误、权限不足和管理员合规要求使用不同公开错误码。

登录和 TOTP POST 不自动重试。认证成功后，新会话只以 Refresh 模式保存；access token 只留在内存，临近过期时使用 Refresh Token 单飞续期。管理请求首次 `401` 只续期并重试一次；`403` 不刷新；`423` 转为管理员合规提示。

本地服务先监听并输出 bootstrap 入口，再等待已保存的 Keychain 会话恢复；`GET /local-api/session` 在恢复完成前保持等待，因此页面不会提前开放账号密码提交。所有后台请求单次最长 30 秒，超时返回 `BACKEND_TIMEOUT`；登录和其他非幂等 POST 仍不自动重试。服务日志只记录本地会话路由和错误码，不记录邮箱、密码、TOTP 或 Token。

SPA 首页和前端路由回退返回的 HTML 统一使用 `Cache-Control: no-store`，避免服务更新后已打开的标签页继续复用旧应用文档。带内容哈希的 JavaScript 和 CSS 资源仍按静态资源处理；每次重新载入 HTML 都会引用当前构建文件。

Keychain 服务名为 `up-icloud.coding-session`，account 为 `backend-user:<id>`，值为：

```json
{ "version": 1, "mode": "refresh", "token": "<backend refresh token>" }
```

旧邮箱键名的裸 Refresh Token 会在成功验证后迁移。升级前的结构化 Access Token 允许兼容恢复，失效后清理并回到账号密码登录，不提供新的手动 Access Token 入口。

## 4. 管理后台接口

| 用途 | 方法与路径 |
| --- | --- |
| 固定代理 | `GET /admin/proxies/all` |
| 动态订阅 | `GET /admin/proxies/subscriptions` |
| 代理解析 | `POST /admin/proxies/assignments/resolve` |
| 供应商 | `GET /admin/accounts/suppliers` |
| 分组 | `GET /admin/groups/all` |
| 生成 OAuth URL | `POST /admin/openai/generate-auth-url` |
| 兑换 OAuth code | `POST /admin/openai/exchange-code` |
| 账号查重/列表 | `GET /admin/accounts` |
| 创建账号 | `POST /admin/accounts` |
| 账号详情 | `GET /admin/accounts/{id}` |
| 重新授权写回 | `POST /admin/accounts/{id}/apply-oauth-credentials` |
| 标记封号 | `PUT /admin/accounts/{id}` |

认证管理请求带 Bearer access token 和 `X-Admin-UI-Request: 1`。幂等 GET 遇到连接级错误最多自动重试一次；POST、PUT、DELETE 不因网络错误自动重放。

随机固定代理和动态订阅通过代理解析接口取得本次任务固定使用的正整数 `proxy_id`。后台当前响应可能同时包含分配统计，但不保证返回 `proxy_name`；本地工具以 `proxy_id` 为解析成功条件，并从加载选项时取得的 `GET /admin/proxies/all` 响应建立服务端私有内存索引，从中读取显示名称和浏览器连接配置。缓存缺失时只重新请求一次 `/admin/proxies/all`；仍找不到该 ID 时按选项失效闭合失败，不调用要求 Operator 权限的 `GET /admin/proxies/{id}`，也不要求当前后台账号新增代理管理权限。

`/admin/proxies/all` 中的主机、端口、代理 URL、用户名和密码只进入 Node 服务端内存索引。公开 `OptionsSnapshot`、前端接口、任务记录、SQLite 和日志只保留代理 ID、名称、状态及非敏感关联信息。连接配置在启动浏览器前仍须通过协议、地址和端口校验；后台返回的 `socks5h` 只作为 SOCKS5 远端主机名解析别名，在传给 Chrome 前规范化为其支持的 `socks5`，其他未知协议继续拒绝。本地一次性 Chrome 使用该连接配置，解析出的同一个 `proxy_id` 同时传给 OAuth URL 生成、Code 兑换和账号创建，避免浏览器授权与后台兑换/创建使用不同代理选择。

动态订阅公开选项额外保留启用状态、节点总数和健康节点数，页面显示“健康节点数/节点总数”。明确停用、状态为 `disabled`/`inactive` 或健康节点数为 0 的订阅会在下拉框中禁用，并由前端提交校验、服务端选项校验和代理解析三层再次拒绝；字段缺失时保持兼容，由后台解析接口作最终判断。

OpenAI 授权链接只能由后台原接口实时生成，本地工具不拼接、不缓存也不复用链接。请求体与线上账号页保持一致：存在正数 `proxy_id` 时只发送该字段；没有 `proxy_id` 且存在正数 `machine_id` 时发送 `machine_id`；`redirect_uri` 仅在调用方明确覆盖时发送。无代理时请求体为 `{}`。响应必须同时包含本次 `auth_url` 和 `session_id`，回调得到的 `code/state` 必须使用同一 `session_id` 调用兑换接口。

## 5. 固定创建语义

创建载荷由服务端构造，不接受页面输入账号名、平台、类型、优先级或费率倍率：

```ts
{
  name: normalizedEmail,
  platform: "openai",
  type: "oauth",
  credentials: allowlistedExchangeFields,
  proxy_id?: resolvedProxyId,
  concurrency: 1 | 3 | 5 | 10 | 20,
  priority: 1,
  rate_multiplier: 1,
  group_ids: validatedGroupIds,
  supplier?: validatedSupplier
}
```

OAuth 兑换结果只允许已知字段进入 `credentials`。`credentials.model_mapping` 始终缺失，这是当前后台“清除所有模型”的请求语义。

`allowDuplicateCreation` 只控制本地任务编排是否执行两次精确查重，不进入后台账号创建载荷。页面新建表单默认提交 `true`；本地任务 API 缺少该字段时按 `false` 解析。任务记录保存并显示本次选择，旧记录缺少该字段时按“拦截”展示。

## 6. 本地 API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/bootstrap?nonce=...` | 显示自动安全检查页，不消耗 nonce |
| `GET` | `/bootstrap.js` | 执行同源健康检查，成功后提交当前 bootstrap 表单 |
| `POST` | `/bootstrap?nonce=...` | 检查成功后一次性建立本地页面会话 |
| `GET` | `/local-api/session` | 公开会话状态和内存 CSRF |
| `POST` | `/local-api/session/login` | 提交后台邮箱和密码 |
| `POST` | `/local-api/session/login-2fa` | 提交本地 attempt ID 和 TOTP |
| `DELETE` | `/local-api/session/login-pending` | 取消 TOTP 中间态 |
| `DELETE` | `/local-api/session` | 后台退出并清理 Keychain |
| `GET` | `/local-api/settings/mailbox-trust` | 读取内置和自定义路径式邮箱 origin |
| `PUT` | `/local-api/settings/mailbox-trust` | 原子替换自定义路径式邮箱 origin |
| `GET/POST` | `/local-api/options[/refresh]` | 读取或刷新选项 |
| `POST/GET` | `/local-api/tasks...` | 启动、读取、取消和删除任务 |
| `GET` | `/local-api/reauthorization/accounts` | 读取符合状态和 7 天用量条件的脱敏 OpenAI OAuth 候选账号 |
| `GET` | `/local-api/reauthorization/accounts/{id}` | 再次读取并锁定目标公开摘要 |
| `POST` | `/local-api/reauthorization/tasks` | 启动已有账号重新授权任务 |
| `GET` | `/local-api/tasks/{id}/authorization-url` | 读取当前或最近一次任务的瞬时完整授权地址 |
| `GET` | `/local-api/tasks/{id}/events` | SSE 状态事件 |

除显式启用自动建会话入口的精确 `GET /local-api/session` 外，所有 `/local-api/` 请求必须有 HttpOnly 本地 cookie。该会话探测请求只在环回 HTTP 和显式 LAN HTTP 上自动签发当前入口的一年 cookie；它不接受写入，也不会放行其他未认证路由。写请求还必须携带精确入口 Origin 和内存 CSRF header。通过这些安全校验后，响应重新签发 `Max-Age=31536000` 的同一会话 cookie，使浏览器有效期从本次使用起延长一年；其他未认证请求、Cookie 错误、CSRF 失败或 Origin 错误的请求不会续期。账号密码请求严格限制邮箱、1 至 1024 字符密码且拒绝未知字段；TOTP 请求要求 43 字符 base64url attempt ID 和精确六位数字。旧 `/local-api/session/token` 已删除并返回 `404`。

创建和重新授权任务请求都使用互斥的 `loginMaterial`。邮箱验证码分支为 `{ kind: "email_otp", mailboxAccess }`；密码分支为 `{ kind: "password_totp", password, totpSecret }`。两种分支都拒绝未知字段和跨模式材料。重新授权请求只额外接受 `accountId` 与锁定邮箱快照，不接受任何创建配置。密码按输入原字符传递，不做 `trim` 或大小写转换；2FA 密钥只允许规范化展示用 ASCII 空格、连字符和大小写，随后必须通过 RFC 4648 Base32 校验。

公开响应不包含密码、TOTP、后台 `temp_token`、access token 或 refresh token。退出后台会话后保留当前页面的本地 CSRF，允许用户无需重新 bootstrap 直接再次登录。

本地页面以 `127.0.0.1` 为唯一规范 origin；误用 `localhost` 时前端会在请求本地 API 前自动切回 `127.0.0.1`。服务在 `<APP_DATA_DIR>/local-session-seed` 保存一个 32 字节随机种子，文件权限固定为 `0600`、父目录固定为 `0700`；本地 Cookie 会话和 CSRF 使用带用途分离标签的 HMAC 从该种子派生，普通服务重启后保持一致，bootstrap nonce 仍在每次启动时轮换。已有页面因此可以在重启后继续执行读写请求，不再清空后台连接、选项或任务。种子文件不包含后台账号、密码、Token、邮箱或 OAuth 数据；文件缺失时首次启动自动创建，内容畸形、路径不是普通文件或被替换为符号链接时服务闭合失败，不跟随或覆盖。

环回 HTTP 和显式 LAN HTTP 允许固定首页直接接入：前端首先读取精确的 `GET /local-api/session`，没有有效 Cookie 时由该请求自动建立当前入口会话。Bootstrap 链接继续作为 HTTPS 首次接入和诊断回退，nonce 仍然只能消费一次。GET 页面加载同源、无缓存的 `/bootstrap.js`；脚本先请求 `/healthz`，只有获得 `200` 且 JSON 状态为 `ok` 才提交当前 POST 表单。检查失败时不发送 POST、不消费 nonce，并恢复“检查并进入”按钮供用户确认当前地址后重试；禁用 JavaScript 时保留原生表单兜底。成功签发的 host-only cookie 使用 `Path=/`、`HttpOnly`、`SameSite=Strict` 和 `Max-Age=31536000`；仅 HTTPS 入口额外带 `Secure` 和 HSTS。环回、LAN HTTP 和 LAN HTTPS 使用不同的 Cookie 名或会话派生命名空间，不能互换。

## 7. 邮箱与浏览器约束

邮箱客户端为每种已确认来源使用独立 HTTPS 协议。原有来源包括固定 `mail.php` 查询接口、`/s/<访问凭据>/<邮箱>` 路径式收件页、`https://icloud-api.top/show/<访问凭据>/<邮箱>` 展示页、`https://icloud.olo.lat/p/<访问凭据>` Cloud Mailbox 分享链接，以及 Assurivo 的 `/console/open.php`、`/console/feed.php`。Assurivo 兼容 origin 现在同时包含 `https://assurivo.com` 和 `https://icloud.biubiu007.com`，两者都会在校验邮箱、查询码和参数后重建为同 origin 的固定 `/console/feed.php?...&limit=5` 请求。

新增专用来源为：`https://mail.ai1998.xyz/messages/<访问凭据>/<邮箱>` HTML 页面，可选且只能带 `recipient=<同一邮箱>`；`gptmail.wanmail.beer` 和 `li1329.asia` 的 `/api/v1/public/inboxes/<UUID>` 单条公开 inbox JSON，响应 `address` 必须匹配账号邮箱；`https://mailotp.xyhelper.ai/api/code?token=<访问凭据>` 最新验证码 JSON，只读取明确的 `success/code/count/error` 字段；`https://ai100.my/mail/code/<访问凭据>` 使用与 mail.com 接码入口一致的 JSON 协议，并核对响应邮箱；`https://mail.776867.xyz/icloud/p/<access_id>` 分享页，服务只把 `access_id` POST 到固定 `/api/pickup` 并核对响应邮箱；`https://flysms.xyz/icloud/pickup#email=<邮箱>&key=tok_<访问凭据>` 分享链接，fragment 只在本地解析，真实请求使用固定 latest API、Bearer Token 和精确邮箱请求头；`https://redeem.360desk.net/quick-mail/` 公共页面不携带邮箱或凭据，服务使用当前任务邮箱固定 POST 到 `/quick-mail/api/recent`，只查询最近 60 分钟并核对响应邮箱。所有来源都限制响应大小、禁止跨域重定向、校验明确字段契约；未知页面或任意 JSON 数字不会作为验证码兜底。

FlySMS latest API 的 HTTP `403` 只有在有界 JSON 错误体同时包含精确 `code=ACCOUNT_EXPIRED` 时才归类为邮箱接码账号过期。重新授权流程此时已经通过后台账号 ID 和规范化邮箱锁定目标，会在启动 OAuth Chrome 前重新读取目标、核对邮箱，并把当前账号名称改为 `<原名称>（邮箱接码过期）`。已有后缀时不再写入；普通鉴权失败、其他错误码、非 JSON、空邮箱或网络错误均不修改后台。名称更新只发送一次；响应不确定时只读回确认，不能确认则返回专用不确定错误，不重放写请求。添加账号流程尚无唯一后台目标，因此只报告邮箱过期，不按邮箱猜测或修改既有账号。

OpenAI 手机验证使用独立 `phone_verification` 页面分类。分类必须同时满足顶层 URL 为精确 HTTPS `auth.openai.com/add-phone`、页面只有一个语义电话输入框、可见文字明确说明手机号码必填或向该号码发送验证码，并存在精确“继续/Continue”控件。任一条件缺失时不标记；其他域名、OpenAI 其他路径、普通 MFA 和包含电话文字的未知页面均保持人工接管。识别成功时控制器抛出 `OPENAI_PHONE_VERIFICATION_REQUIRED`，重新授权流程关闭任务窗口并对已锁定账号追加“（手机接码）”。写入复用邮箱过期名称标记的 ID/邮箱复核、幂等后缀和单次 PUT/只读确认边界；已有其他后缀会保留。添加账号任务没有唯一后台目标，只报告错误而不猜测修改。

`191006.xyz/mailbox/<访问凭据>` 当前部署返回服务端渲染的单封“最新邮件”详情，不使用旧 `.mail-card` 列表：邮箱身份位于唯一 `.mailbox` 的 Cloudflare 编码元素，主题位于唯一 `.subject`，正文邮件模板位于唯一 `.content`。专用解析器先解码并核对邮箱，再要求主题明确包含 OpenAI 或 ChatGPT，只把 `.content` 内部 HTML作为一封邮件正文交给通用规范化；不扫描导航、脚本或页面其他六位数字。旧卡片布局和明确空邮箱页面继续兼容。该来源声明 `newest_first`，便于验证码重发后使用现有稳定最新邮件规则。

新增 `https://aigateway.online/api/v1/mail-pickup/<访问凭据>` 固定 GET 来源，以及动态 `https://*.trycloudflare.com/#otp=<访问凭据>` 来源。后者只在本地解析 fragment，并把 `link_token` POST 到同源固定 `/api/otp`。两者都禁止额外参数和跨域跳转，只读取有界的显式邮件字段；响应带邮箱身份时必须与任务账号一致，Token-only 响应则只保留能明确确认 OpenAI 或 ChatGPT 用途的邮件，不扫描未知字段或任意六位数字。真实访问凭据和独立邮箱地址不写入配置、测试、日志或文档。

可信 origin 设置使用现有 SQLite `settings` 表的版本化键，只保存规范化 origin 数组，不保存完整链接、路径、邮箱或访问凭据。设置输入接受域名或 HTTPS origin，拒绝 HTTP、用户信息、路径、查询、片段、通配符、本机名称、单标签主机和 IP 字面量；内置路径式 origin 固定显示且不可删除。读取到损坏配置时，自定义项闭合停用，设置页显示警告并保留内置来源；保存合法列表后即可恢复。设置 GET 需要本地 Cookie，PUT 还需要精确 Origin 和 CSRF。活动任务期间服务端返回 `MAILBOX_SETTINGS_BUSY`，任务开始时取得的不可变 origin 快照同时用于输入校验和全部邮箱轮询；任务结束后的设置变更对下一任务立即生效，不需要重启。

路径式输入会去除复制空白、解开一层完整引号或尖括号、处理 `&amp;`、折叠重复斜杠、去除末尾斜杠，并对邮箱路径只解码一次；访问凭据的字符和大小写保持原样。最终必须是受信任精确 origin 下的两个有效路径参数，无片段、用户信息或额外路径。路径邮箱必须与任务账号一致；可选 `email` 查询参数必须唯一、非空、无首尾空白，并与路径邮箱及任务账号一致。额外参数、重复 `email` 和邮箱不一致都会在请求前拒绝。路径式来源允许最多三次完全同源的手动重定向，每一跳重新校验路径、查询参数和邮箱；跨 origin、协议下降、畸形 Location 和第四次跳转全部停止。即使另一个 origin 也在可信列表中，也不会自动跨域发送访问路径。

所有路径页面和专用 JSON 来源先直连；DNS、连接或 TLS 层失败后，只在 macOS 当前 HTTPS 代理已启用、代理主机严格为 `127.0.0.1`、`localhost` 或 `::1` 且端口有效时通过 HTTP CONNECT 重试一次。进入代理路径后同一跳转链保持该路径；远程代理、代理认证和证书忽略继续禁止。DNS、TLS、连接、15 秒请求超时、代理回退失败、链接鉴权失败和未知网络错误使用独立错误码。公开消息不包含路径、访问凭据、代理地址或底层异常全文。固定 `mail.php` 仍使用原直连行为；Cloud Mailbox 与专用 JSON API 拒绝重定向，不受自定义 `/s/` 设置影响。

轮询单次邮箱请求超时 15 秒、常规间隔 3 秒；邮箱接口临时失败时仍会退避，但两次请求之间的额外等待最多 5 秒。验证码流程分成三个各自最多 60 秒的轮次：第一轮和第二轮没有取得可靠结果时先在任务页提醒，确认当前仍为 OpenAI 验证码页并在重发前刷新邮箱状态，然后分别点击一次精确匹配的“重新发送验证码 / 再次发送验证码 / 重新发送电子邮件 / Resend code / Resend email / Send again”控件，整个任务最多自动重发两次。后续轮次继续使用本次任务首次请求验证码时的邮件基线和请求时间；任务开始前的旧邮件仍被排除，但重发复用相同验证码、更新原邮件或第一轮末尾才展示邮件时，不会被重发前的刷新永久归类为旧邮件。若用户在自动点击前抢先操作，导致控件禁用、消失或发生 DOM/导航竞态，控制器会重新分类页面；页面仍是可信验证码页时继续下一轮，不立即接管。页面已进入严格识别的 Codex 同意页时直接接续该进度。第三轮仍没有可靠结果或页面无法安全识别时保留无痕窗口并进入人工接管。单次请求自身的网络耗时包含在对应轮次截止时间内，轮询保持串行以避免同一邮箱产生重叠请求。

`mail.php` HTML 按 `article.mail` 读取元信息并从 `iframe[srcdoc]` 提取可见正文；路径式来源只接受明确 JSON 邮件集合、结构化邮件容器或已确认邮箱外壳。AI1998 只读取 `.mail-card` 内的主题、元信息、日期和正文，并识别其专用空邮箱外壳。各 JSON 来源先通过对应 Zod 契约，再只映射已确认的邮件字段；HTML 正文转换为可见文本，未知字段不会参与验证码提取。任务先建立初始邮箱基线，并在邮箱提交、切换一次性验证码登录、邮箱提交重试和两次验证码重发等实际触发动作前再次刷新；各次基线取并集，最后一次触发时间作为验证码新鲜度起点，因此前面轮次已经出现的邮件不会在后续轮次被重新使用。

验证码始终优先使用可靠 `receivedAt` 选择唯一最新邮件。邮箱读取结果同时声明 `newest_first` 或 `unknown`：Cloud Mailbox、MailOTP 和 FlySMS 的接口语义能明确保证最新结果，其他来源保持 `unknown`。只有 `newest_first` 来源连续两次串行轮询的第一候选具有相同稳定身份和相同唯一验证码时，才允许列表顺序兜底。未知来源、两次首项变化、时间并列、首项自身多码或最新邮件无法区分时不自动猜测。基线前邮件、非 OpenAI 内容、旧时间和长数字不会自动填写。

OpenAI 授权浏览器为每个任务使用 `mkdtemp` 创建唯一的一次性 Chrome 配置目录，再通过 Playwright `launchPersistentContext(taskUserDataDir, ...)` 启动本机 Google Chrome，并固定传入 `--incognito`。Playwright 默认关闭 Chromium sandbox，并会因此给 Chrome 加上 `--no-sandbox`；该标记会触发 Chrome 顶部的“不受支持的命令行标记”警告。项目现在显式设置 `chromiumSandbox: true`，保留正常 Chrome sandbox，同时继续使用独立临时 Profile 和无痕窗口。启动顺序明确分成两步：先建立空白无痕窗口和自动化控制通道，再在同一标签页打开后台返回的完整授权 URL。浏览器初始导航使用后台返回的原始字符串，不重新拼接、排序或改写一次性 PKCE/OAuth 参数。

在启动 Chrome 前，授权 URL 必须满足当前 Codex OAuth 完整契约：标准 HTTPS `auth.openai.com/oauth/authorize`；`client_id`、`code_challenge`、`code_challenge_method`、`codex_cli_simplified_flow`、`id_token_add_organizations`、`redirect_uri`、`response_type`、`scope` 和 `state` 均为单一非空参数；PKCE 方法为 `S256`；响应类型为 `code`；scope 至少包含 `openid profile email offline_access`；回调为带端口、不含查询或片段的本机 HTTP 环回地址，且路径精确为 `/auth/callback`。缺参、旧路径、重复安全参数或错误值返回 `OAUTH_AUTH_URL_CONTRACT_INVALID`，不会打开浏览器。浏览器启动失败返回 `BROWSER_START_FAILED`；窗口已启动但 Chrome 连首条主导航请求都没有发出时返回可重试的 `BROWSER_NAVIGATION_FAILED`。无代理的本机 Chrome 由服务直接启动并持有独立进程组，不再通过已经退出的 LaunchServices `open` 子进程间接启动；任务结束时先关闭该 CDP 浏览器，再终止该精确进程组，必要时使用 `SIGKILL`，最后删除该精确临时目录。不读取、复用或删除用户日常 Chrome Profile，也不影响已经打开的普通 Chrome。

任务页显示简短授权诊断：后台授权链接是否已校验、无痕 Chrome 是否启动、Chrome 首条请求是否完整，以及 OpenAI 后续页面路径。控制器在调用 `page.goto` 前注册带超时清理的请求监听，捕获首条主框架导航并逐项核对协议、主机、路径以及包含重复项数量在内的全部查询参数；只有核验通过才记录“完整参数已核验”。若首条请求退化成 `/oauth`、缺少或改变任一参数，任务返回 `OAUTH_AUTH_URL_NAVIGATION_MISMATCH`，不会误报已经打开。如果 `page.goto` 因代理连接、页面切换或导航中断抛错，但监听器已经捕获并核验了完整首请求，控制器保留当前无痕窗口并继续现有页面分类；无法自动处理时进入人工接管，允许用户在同一窗口中继续，而不是立即关闭窗口。OpenAI 接收首条完整请求后正常跳转到 `/log-in` 或其他站内路径时，页面会单独显示为“OpenAI 页面”，不能把地址栏中的后续路径误认为后台只返回了该短地址。

为便于排查提供方错误，本地页面可展开“查看本次完整授权地址”。该地址只存在于服务进程内存中，只能由持有当前本地 HttpOnly 会话 Cookie 的页面通过专用读取接口获得；它不进入常规任务读取、历史记录、SSE、SQLite 或服务日志。服务重启、下一次任务开始或用户删除该任务时会清除地址。地址可用于人工核对，但一次性 OAuth 链接在失败后未必能够重放。OAuth `state`、PKCE、后台 `session_id` 和回调 code 仍不持久化、不写日志；旧任务和服务重启前的任务会显示“该授权链接已失效，请重新生成”。任务取消、失败或服务中断时还会保存取消/失败前的非终态阶段，避免最终记录丢失实际停止位置。

无痕模式只隔离本次授权数据，不绕过 Cloudflare、CAPTCHA、未知 MFA、安全密钥、账号选择或未知页面；这些状态仍进入人工接管。页面分类先保留 CAPTCHA、账号选择、提供方错误和明确凭据拒绝等高置信安全边界，再识别语义化邮箱、密码和验证码输入框；正常登录表单中附带的短信/手机验证等辅助说明不会单独把当前步骤误判为 MFA。人工接管只表示当前页面属于未定义流程或明确的安全边界，不再用于普通 DOM 失效、用户抢先点击、已知页面跳转或已捕获回调。提供方明确报错、账号密码或动态码被拒绝、已知表单在有限重试后仍不生效时返回对应失败，不伪装成“需接管”。

密码 + 2FA 模式在邮箱基线之前分流，不实例化邮箱轮询，也不点击邮箱验证码重发。控制器只在严格识别的唯一密码输入页自动填写；若点击时用户已推进页面或旧定位器失效，先重新识别当前页面，已进入认证器、同意页或合法回调时直接接续，仍在同一密码页时才使用当前输入框有限重试。认证器页面必须同时具有明确的 authenticator/认证器语义和唯一六位输入，不能仅凭 `autocomplete="one-time-code"` 判断。服务端使用锁定的 `otpauth@9.5.1` 按 SHA1、6 位、30 秒生成动态码。剩余有效期不足 10 秒时等待下一周期；首次提交后只有页面 origin/path 未变化且仍严格属于同一认证器用途时，才生成下一个周期的第二个动态码，总计最多两次。两个周期的动态码都被拒绝时返回 `OPENAI_CREDENTIALS_REJECTED`，不进入人工接管。邮箱验证码、短信、恢复码、Passkey、安全密钥、多输入或用途不明的页面均不读取 2FA 密钥并进入人工接管。

截图中的“不受支持”提示来自 Chrome 自身对 `--no-sandbox` 的启动参数警告，不是 OpenAI 对 OAuth URL 长度、参数或自动化浏览器的错误响应。完整 URL 仍由后台原接口生成并作为同一字符串传给 `page.goto`，首条主框架请求继续逐项校验全部查询参数。项目只恢复 Chrome 正常 sandbox，不隐藏自动化标记、不伪造浏览器属性，也不通过隐蔽配置绕过登录安全判断。

邮箱和六位验证码填写后，浏览器优先点击可见且可用的中文“继续”或英文“Continue”，再使用语义化提交控件作为兼容兜底。只有当前表单稳定消失、进入已知下一页面或收到合法回调后，任务才记录“已提交”；页面未变化时最多再通过当前输入框提交一次。提交控件暂不可用、用户抢先点击、旧定位器失效或导航期间 DOM 操作报错时，控制器在最多约 3 秒的窗口内重新读取页面：仍是原表单则用新定位器重试，进入密码、邮箱验证码、认证器、Codex 同意页或合法回调则从当前进度继续。两次已知表单提交仍不生效，或稳定落在安全挑战与无法识别的新页面时，统一进入人工接管并保留当前无痕 Chrome；用户完成当前步骤后，同一任务会自动从当前页面恢复。明确的邮箱接口错误、凭据被拒绝、任务取消、提供方错误或浏览器真实关闭继续按对应错误终止。

验证码提交后，控制器等待独立的 Codex 授权同意页。只有页面明确表述“使用 ChatGPT 登录 Codex”（或等价英文）且存在精确“继续/Continue”按钮时才自动点击；页面用途或按钮任一不匹配不会被模糊猜测。自动点击与用户点击发生竞态时，即使旧按钮定位器消失也先等待页面跳转；仍为同一严格识别的同意页时最多自动尝试三次，已进入合法回调时直接继续兑换。三次已知点击仍不生效、安全挑战、账号选择、未知 MFA 或未知页面都进入人工接管；提供方错误和凭据拒绝返回明确失败。人工接管期间任务保持在 `manual_intervention` 并保留无痕窗口；中央排队不会在接管期间上报终态或领取下一条。浏览器会话持续观察当前 Chrome 上下文的全部顶层页面：新标签页或弹窗出现时切换后续页面识别与自动操作，任一顶层页面的导航请求都先经过精确回调 origin/path/state 校验。只有真实按钮点击、表单提交、回车、主页面导航（即使导航前后 origin/path 相同），或页面进入与当前登录材料兼容的已知步骤后，才允许状态机从接管阶段回到授权自动化；页面内活动计数因整页重载丢失时，进程内的主框架导航计数仍保留进展证据。邮箱验证码模式只接回邮箱、一次性验证码和同意页；密码 + 2FA 模式只接回密码、认证器动态码和同意页，不会跨模式读取另一类秘密。合法回调到达时直接切换到等待/兑换阶段。邮箱三轮仍无可靠验证码和无法区分最新验证码继续沿用接管规则，但用户在同一验证码页精确点击重发后可以重新接回邮箱轮询。添加账号和重新授权共用该恢复控制流，最终仍分别调用创建接口和原账号写回接口。任务成功、取消、浏览器被手动关闭或发生其他明确终止错误时才清理临时 Chrome 上下文。

## 8. 数据与秘密

“添加账号”表单状态由应用根组件持有，邮箱取件凭据、OpenAI 账号密码和 2FA 密钥通过规范化邮箱键保存在当前文档内的 `Map` 中；“重新授权”使用另一份按目标账号 ID 隔离的内存映射。任务启动、成功、失败、登录模式切换以及页面内模块切换都不会重置当前账号；全新邮箱或目标账号没有记录时将三项秘密字段置空，避免跨账号误用。两份映射都不使用 `localStorage`、`sessionStorage`、IndexedDB、SQLite、Keychain、日志或文件持久化。单纯重启服务不会重新加载当前页面，因此当前文档内存继续保留；页面刷新、关闭或通过新入口重新载入后不会恢复。

允许落盘：规范化账号邮箱、脱敏任务状态、选择摘要、最终后台账号摘要、自定义可信邮箱 HTTPS origin、非敏感 Keychain account 引用，以及 macOS Keychain 中的后台会话凭据。可信邮箱设置不包含路径、访问凭据或邮箱地址。

禁止由服务端落盘或再次返回前端：后台密码、后台 TOTP、后台临时 Token、后台会话 Token、OpenAI 账号密码、2FA 密钥、生成的动态码、邮箱取件密码、邮件正文、邮箱验证码、代理密码、完整授权 URL、OAuth code/state/session 和 OpenAI 凭据。活动任务把当前模式的材料放入 `SecretScope`，成功、失败、取消、浏览器关闭或服务关闭时统一释放；`PublicTask`、SSE、SQLite 和任务历史不包含 `loginMaterial`。

应用数据目录权限为 `0700`，SQLite 为 `0600`。进程重启时遗留活动任务标记为 `interrupted`，不会恢复已丢失的 OAuth 秘密。

授权浏览器正常关闭或任务提前结束时，回调等待会以任务级错误收敛，不会形成未处理的 Promise 拒绝，也不会导致本地服务退出。任务运行记录的异步清理同时处理成功与失败分支，避免清理链产生新的未处理拒绝。因此连续添加账号时，本地服务和当前本地页面会话保持不变；即使服务重启或浏览器没有现成 Cookie，环回 HTTP 和 LAN HTTP 固定首页也会通过会话探测重新建立本地页面会话。

## 9. 运行与维护

```bash
npm run build
npm start
```

每次启动生成新 bootstrap nonce，但从受限种子稳定派生本地会话和 CSRF。后台认证或管理接口升级后优先修改 `src/server/backend/`；邮箱页面变化后用全合成样例更新 `src/server/mail/normalize.ts`。回滚本地工具不会删除已创建的后台账号；后台账号删除必须在管理后台另行确认。

运行中的 SQLite 使用 WAL。部署前后只读核对必须使用 `file:...tasks.sqlite?mode=ro` 并先执行 `PRAGMA query_only=ON`，这样会同时读取主数据库和 WAL；不得用 `immutable=1` 判断实时任务数量，因为它可能忽略尚未 checkpoint 的 WAL 行。重载前必须以该方式确认 `status='active'` 为 0。

## 10. 已有账号重新授权

重新授权页要求用户输入 `0-100` 的整数阈值，默认值为 `90`。通过 `GET /admin/accounts` 固定发送 `platform=openai&type=oauth&status=error&usage_window=7d&usage_operator=lte`，并把当前输入作为 `usage_percent`；只显示错误状态且 7 天窗口已用量不高于当前阈值的账号，并保留搜索和分页。页面同时提供按导入时间筛选的快捷选项：全部、24 小时内、3 天内、7 天内、15 天内和 30 天内。本地服务完整读取后台候选后，优先使用 `created_at`、缺失时退回 `updated_at` 计算导入时间；启用筛选时，时间缺失或无效的账号不会进入候选，也不会请求实时用量。阈值或导入时间变化都会清空已选账号并重新加载第一页；搜索、刷新、翻页和任务完成后的自动刷新保留当前时间条件。页面不再提供“全部账号”或其他状态入口。列表响应仍由本地服务按同一阈值逐条校验账号类型、状态、实时 7 天用量和邮箱一致性，后台忽略筛选或缺少用量字段时闭合失败，不把不符合条件的账号暴露为候选。列表与详情只向前端返回账号 ID、名称、规范化邮箱、状态、7 天用量、导入时间和错误更新时间；`credentials`、代理连接信息和后台错误详情不公开。

重新授权候选完整校验结果按“规范化搜索词 + 用量阈值 + 导入时间条件”在 `43123` 进程内缓存 60 秒，最多保留 20 组；页码和每页数量不进入缓存键，所以翻页和短时间页面重载只对同一候选数组重新切片。相同条件的并发请求共享同一个 Promise，避免重复风暴；加载失败立即移除缓存，过期条目按请求时清理，超过上限淘汰最早条目。缓存不持久化、不包含凭据，服务重启即清空。选择账号时的详情读取和任务启动前的实时资格校验不使用该列表缓存，因此缓存只改善候选浏览性能，不放宽重新授权安全边界。

重新授权桌面布局将筛选、账号表格和分页保留在左侧主区域；已选账号摘要、代理选择、登录材料和启动按钮组成的操作台移动到右侧栏顶部，任务进度排在操作台下方。右栏操作台使用单列字段、双列登录方式和满宽启动按钮，避免窄栏内容溢出。小于 `1040px` 时工作区恢复单列，顺序固定为账号列表、操作台、任务进度，不改变表单状态或任务事件关系。

用户选择后再次按 ID 读取详情，前端将邮箱设为只读；任务启动时以及 OAuth code 兑换完成、准备写回前，服务端都会重新验证响应 ID、OpenAI OAuth 类型、错误状态、7 天用量不高于任务保存的阈值、凭据邮箱与 extra 邮箱一致性以及锁定邮箱。账号在授权期间恢复为非错误状态、用量升到该任务阈值以上或用量字段消失时，任务在写回前停止，且不调用 `apply-oauth-credentials`。后台明确返回写回成功后，本地仍尝试读取最终详情；这次补充读取允许状态已经变为 `active`，并在响应可用时继续核对同一账号 ID、OpenAI OAuth 类型和邮箱，避免正常状态变化导致不必要的确认降级。最终详情查询不可用时沿用既有语义，以账号 ID 一致的成功写回响应收敛结果。

公共 OAuth 流程在兑换后按 `selection.operation` 分流。创建分支保持两次查重和 `POST /admin/accounts`；重新授权分支要求兑换结果包含与目标完全一致的邮箱，再次按相同 ID 读取目标，然后只调用：

```text
POST /admin/accounts/{id}/apply-oauth-credentials
```

写回载荷由服务端从兑换白名单重新构造，只含 `type: "oauth"`、允许的 OAuth credentials 和 `email/name/privacy_mode` extra；不夹带模型、分组、代理、并发、供应商、旧账号配置或未知兑换字段。响应账号 ID 必须等于目标 ID。明确 `4xx` 失败不重试；网络、30 秒超时、损坏响应和 `5xx` 只允许立即查询同一账号一次，并在服务端局部内存中常量时间比较完整 access token 与可用 refresh token。无法完整确认时返回 `ACCOUNT_REAUTHORIZATION_UNCERTAIN`，绝不重放写请求。

重新授权提供两个显式代理选项：`existing`（原账号代理，默认）和 `none`（无代理）。`existing` 下没有原代理时直连；存在固定代理或代理机时从当前后台选项精确解析，同一结果用于 OAuth URL 生成、本地无痕 Chrome 和 code 兑换；原代理不存在、不可用或缺少浏览器连接配置时在打开 Chrome 前失败。`none` 下跳过后台代理选项加载和代理解析，生成授权 URL、启动 Chrome 与兑换 code 都不携带 `proxy_id` 或 `machine_id`。两种模式都不修改后台账号保存的代理字段，也不会在失败后自动从一种模式切换为另一种。

任务历史通过 `selection.operation` 区分“添加账号”和“重新授权”，重新授权保存目标账号 ID、当次用量阈值、写回前状态和非敏感代理摘要。旧 SQLite 重新授权行缺少阈值时按 `90` 读取；旧行缺少 `operation` 时读取为 `create`。从 `applying_oauth_credentials` 开始禁止取消；此前仍可取消。成功写回后本地代码无法恢复旧 OAuth 凭据，因为工具从不保存旧 Token；需要回退账号凭据时只能再次重新授权。

## 11. 本机号池自动材料

`queue-management` 提供 `GET /internal/account-materials?email=<精确邮箱>`。该接口只接受环回连接、一个规范化邮箱和独立 Bearer capability token，只返回 `email` 及可选的 `password`、`totpSecret`、`mailboxAccess`。网页登录 Cookie、Session、XY、恢复邮箱、备注、状态和其他记录字段不会进入响应。现有账号池网页接口和数据库结构保持不变。

43123 也支持将纯号池网页作为远端材料源。设置页只提交远端 origin；服务使用 `~/Library/Application Support/up-icloud/account-pool-profile` 专用持久 Chrome Profile 打开该网页，并在页面内先请求 `/api/auth/config`，再以 `/api/me` 判断该网页自己的登录状态。用户无需向 43123 提交号池账号和密码；尚未登录时保留窗口供用户完成免密登录，随后重新检查。任务继续在同一页面 origin 内请求 `/api/records`，按邮箱精确匹配唯一记录，再分别请求 `/api/records/{id}/secret?field=password|verification|emailToken`。如果远端号池把 `https://2fa.kim/2fa=<Base32 密钥>` 放在邮箱 Token 字段且同一记录有密码，43123 会把它识别为密码登录用 2FA 密钥；没有密码时不会把该链接当作邮箱接码材料使用。号池 Cookie 不会从浏览器复制到 Node、Keychain、前端、SQLite 或日志。断开时关闭受控浏览器并删除保存的 origin，但不删除持久 Profile；远端材料源配置后优先于本机 bridge，未配置时保留原环回 bridge 行为。

两个服务默认读取同一权限为 `0600` 的本地 token 文件：

```text
~/Library/Application Support/up-icloud/account-pool-bridge-token
```

可以通过 `ACCOUNT_POOL_BRIDGE_TOKEN`、`ACCOUNT_POOL_BRIDGE_TOKEN_FILE`、`ACCOUNT_POOL_BASE_URL` 和 `ACCOUNT_POOL_TIMEOUT_MS` 覆盖。bridge URL 必须是环回 HTTP origin；客户端禁止重定向，默认 5 秒超时，响应最多 64 KiB，并拒绝未知字段、邮箱不一致和空材料。

自动任务在后台选项、代理、OAuth URL 和 Chrome 之前只查询一次号池。密码非空且 2FA 能规范化为有效 Base32 时使用现有密码 + TOTP 分支；否则存在邮箱 Token 时使用现有邮箱 OTP 分支；都不满足时返回 `ACCOUNT_POOL_MATERIALS_INCOMPLETE`。密码/2FA 被 OpenAI 明确拒绝后不会自动尝试邮箱 Token。

号池响应只在任务调用栈和 `SecretScope` 中存在。未选择的材料不会进入浏览器页面，bridge token、密码、2FA、邮箱 Token 和具体选择结果不会进入 SQLite、任务历史、SSE、公开错误或日志。公开选择摘要只记录 `loginMaterialSource: "account_pool" | "manual"`。

## 12. OpenAI 停用账号确认与封号写入

添加账号和重新授权共用精确停用处理。页面分类器只接受可见正文中边界完整的 `account_deactivated`，不会根据相似错误码、宽泛“停用”文案或隐藏脚本推断封号。第一次检测到该错误时，控制器要求当前页面仍是同一停用页，并且只有一个可见、可用、名称精确为“重试 / Retry / Try again”的按钮或链接；只点击一次。点击后必须先离开停用页并在 10 秒内回到严格识别的邮箱登录入口，否则任务失败且不修改后台状态。

回到邮箱入口后，编排器在同一无痕 Chrome 中重新执行一次完整的邮箱、密码或邮箱验证码、2FA、同意和回调流程。只有第二次完整流程再次抛出精确 `OPENAI_ACCOUNT_DEACTIVATED`，才进入封号阶段；首次报错、按钮缺失或不唯一、回到未知页面、CAPTCHA、安全挑战、浏览器关闭、回调意外完成以及第二次出现其他错误都不会封号，也不会继续兑换、创建或写回 OAuth 凭据。

重新授权任务直接使用开始时锁定且再次校验的账号 ID 和邮箱；不会按邮箱重新搜索。添加账号任务会读取完整搜索分页，只接受凭据邮箱或 extra 邮箱与任务邮箱规范化后完全一致、平台为 OpenAI、类型为 OAuth 的唯一账号。零条、两条以上、分页不完整、字段冲突或账号类型不符均停止写入。后台账号在写入前还会按 ID 重新读取并再次核对平台、类型和邮箱；原本已经是 `management_status=banned` 时不重复写。

实际写入固定为一次：

```json
{
  "management_status": "banned",
  "status_reason": "OpenAI OAuth 连续两次返回 account_deactivated"
}
```

请求使用 `PUT /admin/accounts/{id}`，不会因网络、超时、损坏响应或 `5xx` 重放。即使 `PUT` 返回成功且响应中带 `banned`，本地仍必须通过独立 `GET /admin/accounts/{id}` 读回同一 ID、同一邮箱和 `management_status=banned` 才报告“已封号”。读回无法确认时返回 `ACCOUNT_BAN_WRITE_UNCERTAIN`，要求人工到后台核对；明确 `4xx` 返回 `ACCOUNT_BAN_WRITE_REJECTED`。任务最终仍保持错误状态并记录停用检测次数、是否执行重试、确认结果、目标账号 ID 和封号结果，避免把“账号已封号”误显示成账号创建或重新授权成功。SQLite 通过新增可空 `deactivation_json` 保存这份非敏感进度，旧数据库由幂等迁移补列。

## 13. 受限局域网入口

服务继续固定创建 `127.0.0.1:<PORT>` 的 HTTP Fastify 实例。只有 `LAN_ACCESS_ENABLED=true` 且 LAN 配置完整时，才额外创建一个共享同一后台会话、数据库、任务编排器和号池客户端的 LAN Fastify 实例，并精确绑定 `LAN_HOST:<PORT>`。`LAN_PROTOCOL` 显式选择 `http` 或 `https`，未配置时默认 `https`；HTTP 模式不读取 TLS 文件，HTTPS 模式继续要求完整证书和私钥。两个实例都不使用 `0.0.0.0`，号池仍由独立服务只监听 `127.0.0.1:3001`。LAN IP 未分配到活动网卡、HTTPS 材料无效或第二个监听失败时，只记录非敏感错误码并停用 LAN 实例，已成功启动的环回实例继续提供服务。

LAN 配置要求 `LAN_HOST` 是 RFC 1918 私有 IPv4；`LAN_ALLOWED_CIDR` 必须使用规范网络地址、完整位于私有 IPv4 空间并包含该主机。每个 LAN 请求在路由处理前同时校验精确 `Host` 和 TCP socket 的真实远端地址，不读取或信任 `X-Forwarded-For`。因此健康检查、bootstrap、静态 SPA 和全部本地 API 都受同一访问策略保护。所有模式的 bootstrap Cookie 都带 `HttpOnly` 和 `SameSite=Strict`；HTTPS 模式额外使用 `Secure` 和 HSTS，HTTP 模式无法提供传输加密。

TLS 文件通过 `lstat` 读取，证书和私钥必须是 64 KiB 以内的普通文件，符号链接拒绝；私钥不得具有 group/other 权限。启动时验证服务器证书当前有效、IP SAN 精确包含 `LAN_HOST`，并比较证书与私钥的 SPKI 公钥。当前本地 CA 目录为：

```text
~/Library/Application Support/up-icloud/lan-tls/
  ca-cert.pem       # 可安装到局域网客户端的公开 CA
  ca-key.pem        # 仅主机持有，0600
  server-cert.pem   # LAN HTTPS 服务器证书
  server-key.pem    # 仅主机持有，0600
```

环回会话继续使用原有派生标签，升级不会使现有 `127.0.0.1` Cookie 失效。LAN HTTPS 会话保留 `lan:<host>:<port>` 命名空间和 `up_icloud_session` Cookie；LAN HTTP 使用 `lan-http:<host>:<port>` 命名空间和 `up_icloud_lan_http_session` Cookie，避免已有 Secure Cookie 阻止或混用 HTTP 会话。环回 HTTP 与 LAN HTTP 在精确会话探测请求上自动签发各自 Cookie，因此本机和局域网浏览器都可直接打开固定首页；LAN HTTPS 仍使用各入口独立的 bootstrap nonce。任一入口的 Cookie 在其他入口均返回 401。远端浏览器只访问页面和本地 API，Playwright/Chrome 控制器仍由主机进程启动本机无痕 Chrome，权限和授权自动化边界没有扩大。

当前 LaunchAgent 配置为 `LAN_PROTOCOL=http`、`LAN_HOST=192.168.50.218`、`LAN_ALLOWED_CIDR=192.168.50.0/24`。这是用户在了解明文传输账号密码、验证码和会话的风险后选择的本地网络便利取舍；仍应只用于信任的局域网。禁用时将 `LAN_ACCESS_ENABLED` 设为 `false` 并重新加载 LaunchAgent；环回入口和数据库无需迁移。恢复 HTTPS 时改为 `LAN_PROTOCOL=https` 并配置证书路径；IP 或网段变化时必须同时更新 LAN 配置并重新签发包含新 IP SAN 的服务器证书。

## 14. 重新授权搜索与阈值状态一致性

重新授权页面保留“输入草稿”和“最近一次已加载列表”两个概念，但搜索框中当前可见的文本必须是后续筛选操作的唯一搜索条件。旧实现只在点击搜索按钮后更新父级搜索状态；用户清空搜索框但没有再次点击搜索时，输入框显示为空，而修改用量阈值、翻页、全局刷新或任务完成后的自动刷新仍会使用上一次已提交的邮箱，导致后台实际有多条候选时页面只显示旧搜索命中的一条。

`ReauthorizationView` 现在在搜索输入变化时同步父级搜索状态，阈值事件同时携带当前可见搜索值。有效的 `0-100` 整数阈值在输入时立即生效，不要求输入框失焦；列表加载期间仍可继续修改阈值。`App` 在发起列表请求前统一去除搜索值首尾空格，并为每次请求分配递增编号。新的筛选请求不会因为旧请求仍在进行而被丢弃，只有最新请求可以更新列表、错误和加载状态；退出后台或本地会话失效时会使所有在途列表响应作废。阈值变化、分页、全局刷新和任务完成刷新均使用同一状态；点击搜索或按 Enter 的交互保持不变。

该调整只修复前端筛选状态，不放宽后台或服务端资格边界。候选请求仍固定发送 `platform=openai`、`type=oauth`、`status=error`、7 天窗口、`<=` 和用户阈值；列表、详情、任务开始以及 OAuth 写回前仍按 OpenAI OAuth、错误状态、用量上限和邮箱一致性进行校验。

## 15. 重新授权登录材料始终可见

重新授权页始终显示与添加账号共用的登录材料来源控件：`账号池自动获取` 和 `手动备用`。尚未从候选列表选择目标账号时，页面显示“请先从上方选择需要重新授权的账号”；材料来源、只读邮箱和开始按钮均保持禁用，避免在材料尚无明确归属时提前输入秘密。

选择账号后，页面显示目标账号名称、ID 和当前状态，账号邮箱由后台候选详情填充并锁定。材料来源默认保持 `account_pool`；切换到 `manual` 后可以继续选择 `email_otp` 或 `password_totp`，分别填写邮箱取件材料，或账号密码与 2FA 密钥。共享 `LoginMaterialFields` 通过可选 `disabled` 和 `emailPlaceholder` 属性复用现有控件；添加账号没有传入这些属性，因此继续使用原默认行为。

本次没有改变重新授权接口、账号池协议、OAuth 生成与兑换、SQLite 或写回逻辑。自动请求仍只携带目标账号、锁定邮箱、用量阈值和 `loginMaterialSource=account_pool`；手动请求只额外携带对应的 `loginMaterial`。服务端继续按目标账号 ID 重新校验并更新原记录，不调用创建账号接口。当前页面内的秘密材料仍由既有按账号 ID 的内存映射隔离，切换账号时不会把上一账号的材料带入新账号，也不会进入浏览器存储、SQLite 或任务历史。

## 16. 浏览器本地会话一年记忆与滑动续期

本地会话 cookie 从浏览器会话级改为一年持久化，固定使用 `Max-Age=31536000`。环回 HTTP 与 LAN HTTP 的精确 `GET /local-api/session` 会在 Cookie 缺失或失效时自动建立会话；首次 bootstrap、持有有效 cookie 再次打开 bootstrap，以及所有通过本地会话校验的 `/local-api/` 请求也会重新签发同一安全属性的 cookie。因此正常使用会把到期时间从当前请求起再延长一年，日常打开固定首页不需要用户取得或确认单次链接。

除上述精确会话探测外，续期发生在业务路由处理前且必须先通过本地会话验证；写请求还必须先通过精确 Origin 和 CSRF。其他无 Cookie 或错误 Cookie 请求、跨入口 Cookie、错误 Host/网段、缺少或错误 CSRF、错误 Origin 均不会收到 Cookie。环回、LAN HTTP 和 LAN HTTPS 从同一种子使用不同命名空间派生会话与 CSRF，cookie 仍为 host-only；LAN HTTPS 保留 `Secure` 和 HSTS，环回与显式 LAN HTTP 不使用 `Secure`。

一年有效期只作用于浏览器到本地工具的访问 cookie。后台 Refresh Token 仍只保存在 macOS Keychain，OpenAI 密码、2FA、邮箱 Token、验证码和 OAuth 凭据仍不进入 cookie 或浏览器持久存储。当前实现依赖浏览器执行 `Max-Age`；服务端会话值仍由种子稳定派生，删除 `<APP_DATA_DIR>/local-session-seed` 并重启是主动撤销全部既有本地页面会话的方式。

## 17. 中央号池与 macOS 执行助手

`queue-management` 作为中央多用户界面、号池材料所有者和任务调度器；每个操作者的 macOS 运行独立的 `up-icloud` 助手。新助手固定绑定 `127.0.0.1:43124`，独立项目位于兄弟目录 `../queue-management/helper`，入口为 `../queue-management/helper/src/helper/index.ts`，生产产物为 `../queue-management/helper/dist/helper/index.js`，LaunchAgent 为 `com.up-icloud.provisioning-helper`。它使用 `~/Library/Application Support/up-icloud-helper/` 下独立的 SQLite 和本地会话种子，不读取或修改原 `43123` 的数据目录、监听、LaunchAgent 或任务执行槽。中央服务不连接远端 Mac 的环回地址；`ProvisioningAgentClient` 使用设备 Bearer Token 主动发起最长 25 秒的出站长轮询，并以独立心跳上报设备在线状态和当前兔子后台的安全身份摘要。

一键连接由 `POST /api/provisioning/connect-intents` 创建五分钟有效、当前号池用户所有、单次使用并绑定当前请求 origin 的意图。中央把原始意图 secret 只返回给当前已登录页面，数据库仅保存哈希。页面预先打开命名顶层窗口，再把意图 ID、secret 和设备名以 HTML 表单正文 POST 到 `http://127.0.0.1:43124/connect`；secret 不进入 URL、浏览历史、referrer 或浏览器持久存储。助手同时校验安装时固定的中央 origin、`Origin` 请求头和顶层导航元数据，然后自行生成设备 Token，只把 SHA-256 哈希交给中央。中央数据库保存用户归属、设备名、Token 哈希、在线时间和后台身份摘要；原始 Token 只保存在该 Mac 的 `up-icloud-helper.provisioning-agent` Keychain 项。响应丢失时助手可以用待确认 Token 调用 `GET /api/provisioning/agent/self` 恢复设备 ID，避免重复创建设备。

连接窗口使用独立、可跨助手重启恢复的本地会话种子，Cookie 为 host-only、HttpOnly、SameSite Strict、最长一年。首次未认证时只显示兔子后台密码登录与必要的 TOTP；后台 Refresh Token 保存到 `up-icloud-helper.coding-session` Keychain 项。密码、TOTP、后台 Token 和连接 secret 不进入助手 SQLite 或日志。成功后助手通过严格目标 origin 的 `postMessage` 通知原号池窗口，号池再通过当前用户的设备列表验证归属、自动选中并按用户 ID 记住设备。旧手动配对 API 继续为 `43123` 备用入口服务，但不是新助手的主流程。

添加任务接受号池记录 ID、所选设备和非敏感后台选项。重新授权候选由所选 Mac 实时调用兔子后台账号接口取得，浏览器只提交后台账号 ID、后台邮箱、筛选阈值、代理模式和设备，不提交号池记录 ID；中央服务按规范化后台邮箱唯一匹配未删除的号池记录，找不到或不能唯一确定时在建任务前失败。默认的 `existing` 代理模式在中央规范化时省略字段，兼容仍在运行的旧助手；只有显式 `none` 才在任务输入中携带新字段。记录密码、2FA 和邮箱取件 Token 不进入中央任务行或浏览器响应；任务行只保存由现有加密密钥域分离派生的 `v1` keyed HMAC 材料指纹，用于领取前确认邮箱和实际登录材料未变。设备领取任务后只能调用一次材料接口；中央在同一事务内重查设备后台认证、指纹和取消状态，再将材料返回给该设备。`RoutedAccountPoolResolver` 通过中央任务 ID 绑定单任务材料作用域，继续由 `selectAccountPoolMaterial` 优先选择完整密码 + 2FA，否则选择邮箱取件 Token；任务结束或启动失败时清空该任务的远端材料。独立助手没有本地号池 bridge 回退路径。

中央任务 ID 与助手本地编排器任务 ID 分离。助手在自己的设置表保存活动映射，转发脱敏阶段和最终账号/错误摘要，并每两秒读取取消控制。中央任务启动前原子预约 `43124` 自己的 `TaskOrchestrator` 唯一执行槽，未消费预约会在取材失败时释放；`43123` 使用另一个进程、数据库和执行槽，两者不会互相抢占或串用材料。Mac 在任务轮询前等待助手自己的后台 Session 恢复，未认证时不领取；中央也在领取、取材和 `begin-write` 事务内重查设备最新后台认证。

中央 `provisioning_record_locks` 保证同一号池记录同一时间只有一个添加或重新授权任务。取消、撤权和写入使用数据库事务与明确 `begin-write` 门禁：`queued/claimed/running` 中从未领材且未写入的任务可安全终止并解锁；已领材但未写入的任务只设置取消请求，保留锁并由原设备上报；已记录写入的 `cancelled` 或 `interrupted` 会收敛为 `uncertain`。写入阶段事件在未通过门禁时被拒绝；封号门禁的明确取消/撤权错误在实际 `markBanned` 调用前原样返回，不会误标为写入不确定。断开配对时，Mac 只有在中央事务确认该设备无活动任务并停用设备后才删除 Keychain Token；中央不可达时失败闭合。

旧 `43123` 设置页允许已配对设备更换中央号池 origin。`PUT /local-api/provisioning-agent/origin` 只接受单一 HTTP/HTTPS 根地址；服务在写入 `provisioning_agent_origin` 前，先以现有 Keychain 设备 Token 请求新地址的 `/api/provisioning/agent/self`，并要求返回的设备 ID 与当前配置完全相同。验证成功后停止旧轮询、保存规范化 origin 并立即启动新轮询；验证失败或存在中央活动任务时保留旧地址和配对材料。

任务一旦取得材料就不会自动下发给其他设备或重做；本机或网络中断后，设备重启只根据本地历史上报 `interrupted`，中央已记录写入开始时将中断转为 `uncertain`，不会重放后台写请求。如果原 Mac 在取材后永久丢失，中央不会因超时自动解锁；任务与记录锁可能长期保留，需恢复原设备或人工核对结果。

中央查询型任务包括后台选项快照和重新授权账号搜索。查询只发送给当前号池用户所选的在线设备；设备未登录兔子后台、离线、不属于当前用户或响应超过 20 秒时闭合失败。添加账号和重新授权继续使用同一 `TaskOrchestrator`、浏览器控制器、OAuth URL 生成与兑换、邮箱轮询、代理解析、封号确认和后台写回实现。

中央服务保持 `127.0.0.1:<PORT>` 环回监听，并可额外精确绑定 `LAN_HOST:LAN_PORT`。LAN 请求同时校验 socket IPv4、`LAN_ALLOWED_CIDR` 和精确 Host，不信任转发头；`/internal/account-materials` 在 LAN 监听返回 404，也不会经由 43123 代理。当前用户选择 LAN HTTP 便利模式：中央链路上的配对码、号池登录 Cookie、长期设备 Bearer Token、账号密码、2FA 密钥、邮箱取件材料、后台身份摘要、任务数据与结果都可能以明文经过局域网。Host/CIDR 校验不等于加密；只能用于可信隔离网络，严禁访客网络或不可信 Wi-Fi，正式多机部署应升级 HTTPS。

安装脚本 `../queue-management/helper/scripts/helper/install-macos.sh <central-origin>` 要求 Node.js 24+ 和 Google Chrome，构建独立产物后创建版本化运行目录、`current`/`previous` 链接和 LaunchAgent。升级、`rollback-macos.sh` 与 `uninstall-macos.sh` 都先通过 `43124/healthz` 拒绝活动任务；回滚只切换新助手版本，卸载只移除新 LaunchAgent并保留数据、日志和 Keychain 项。三个脚本都不操作 `com.up-icloud.local`。回滚中央功能也不需要迁移或删除原 `43123` 数据；原添加账号、重新授权、Keychain 后台会话和环回 bridge 保持完整可用。中央新增表和用户权限列是幂等扩展，不影响原号池记录字段。

## 18. 本机 Chrome 代理连接预检

需要任务代理时，浏览器控制器在创建临时 Profile 和启动 Chrome 前，先从这台 macOS 对已解析代理的主机与端口执行一次最长 3 秒的 TCP 连接预检。预检只验证本机能否到达代理入口，不发送 OAuth URL、账号材料或代理认证信息。连接拒绝、超时或地址不可达统一返回可重试的 `BROWSER_PROXY_CONNECTION_FAILED`，公开消息不包含代理地址、端口、用户名、密码或底层网络错误。

首条授权导航仍保留既有完整 URL 参数核对。代理在预检后失效并使 Playwright 返回 `ERR_PROXY_CONNECTION_FAILED`、`ERR_SOCKS_CONNECTION_FAILED` 或 `ERR_TUNNEL_CONNECTION_FAILED` 时，即使 Chrome 已发出完整首请求，也会关闭本次临时窗口并返回同一专用代理错误，不再把 Chrome 网络错误页归类为未知页面或“需接管”。非代理任务的相同异常文本仍使用通用 `BROWSER_NAVIGATION_FAILED`，完整授权参数缺失或变化仍优先返回 `OAUTH_AUTH_URL_NAVIGATION_MISMATCH`。

该处理不自动改为直连、不替换代理 ID、不重新生成授权链接，也不执行 code 兑换、账号创建、重新授权写回或封号写入。Playwright 对 SOCKS5 自动追加的 `--host-resolver-rules` 与代理端点不可达是两个独立问题；本次保留 SOCKS 远端解析语义，没有为隐藏 Chrome 警告删除该规则。若后台代理地址只在后台服务器自身的回环网络有效，本机预检会明确拒绝；要让该代理真正可用于本机 Chrome，仍需为执行 Mac 提供可到达的代理入口或受控转发服务。

## 19. 号池连接模式切换与登录状态

`pool_connection_mode` 只负责决定 43123 当前启用“纯号池数据”还是“中央执行助手”，不代表对应远端会话一定有效。两种模式继续互斥：切换到纯号池会等待中央执行助手停止；切换到中央执行助手会恢复其轮询。纯号池连接、中央助手配对/更换地址以及任务材料解析仍分别调用 `assertActive()`，不能在非活动模式执行。

切换到纯号池时会停止中央执行助手，并使用已保存的 origin 打开专用持久 Chrome，再通过网页内的 `/api/me` 检查现有登录状态；检查结果不作为切换前置条件。地址已配置但网页尚未登录、登录失效或号池暂时不可达时，模式仍保存为 `account_pool`，中央执行助手保持停止，设置页显示“等待号池网页登录”或具体连接错误。用户在打开的号池窗口完成登录并重新检查前，材料解析会返回登录失效错误，不会自动使用中央执行助手，也不会绕过会话校验。

该顺序避免形成“必须先切换才能看到登录表单、又必须先登录才能切换”的状态死锁。它也与反向切换保持一致：中央助手恢复后可以先进入该模式，再通过其状态显示配对、连接或认证错误。模式切换不删除任何一方的保存地址或配对信息，因此用户仍可在两个来源之间来回切换；任一时刻只有当前模式可以接受连接配置写入和执行相关操作。

## 20. 重新授权自动托管

重新授权操作台支持按当前搜索词、7 天用量阈值、导入时间和代理模式锁定候选账号 ID 队列，并严格串行调用现有重新授权编排器。每个账号启动前重新读取详情和校验资格，材料继续由号池按账号邮箱即时取得；无法启动的账号记为跳过，任务明确成功或失败后继续下一项。进入 `manual_intervention` 或人工接管时托管显示暂停且不会启动下一账号，当前任务恢复并终止后才继续。

托管状态使用 SQLite `settings` 中的 `reauthorization.hosting.v1` 保存，只包含筛选条件、账号 ID 队列、当前任务 ID、跳过请求标记和计数，不保存邮箱、密码、2FA、验证码、邮箱 Token 或 OAuth 材料。页面刷新可继续显示进度；服务重启会把原活动任务按既有规则标为中断，托管记录该项失败后继续下一个。“跳过当前”先持久化跳过标记，再调用既有任务取消入口；取消终态计入跳过而不是失败，然后继续下一账号。进入 OAuth 写回等不可取消阶段时沿用既有安全门禁并拒绝跳过。停止托管只清空后续队列，当前任务自然结束后停止，不调用取消接口。

托管结果分为成功、失败、封号和跳过四类互斥计数。只有任务错误码明确为 `OPENAI_ACCOUNT_DEACTIVATED_BANNED` 才计入封号，普通错误仍计入失败。持久状态额外保存最近账号 ID 和结果枚举；前端显示运行状态、已处理进度、四类统计，并在托管任务 ID 与当前公开任务精确匹配时显示当前任务邮箱，匹配不到才回退账号 ID。持久状态不保存账号邮箱和登录材料。旧版持久状态恢复时为新增字段补零或空值。重新授权候选表不再显示信息重复且不能代表独立错误发生时间的“错误更新时间”列，保留导入时间。

## 21. 任务无痕窗口后台层级

任务启动时先记录当前前台应用。无代理以及不含代理认证信息的任务不再直接执行 Chrome 二进制，而是通过 macOS Launch Services 的非激活语义创建全新 Chrome 实例，从窗口创建源头避免夺取键盘焦点。Chrome 仍为可见窗口，Playwright 通过本机随机调试端口连接并在后台完成页面操作，不要求窗口位于前台。

Launch Services 返回的启动器 PID 不是 Chrome PID，因此关闭边界不能依赖启动器。控制器同时使用本任务唯一临时 `user-data-dir` 和随机 `remote-debugging-port` 从进程表精确解析真实 Chrome 主进程；两个条件必须同时匹配，日常 Chrome、其他 Profile 或其他任务任一条件不符都不会被选中。任务结束时先关闭 CDP，再只向该 PID 发送终止信号，避免恢复旧版后台启动遗留无痕窗口的问题。

无需认证的 HTTP/SOCKS5 代理也使用该后台启动路径；SOCKS5 保留 Playwright 原有的远程 DNS host resolver 规则。带用户名或密码的代理继续由 Playwright 启动，以保留浏览器代理认证处理，不把凭据放进命令行；该兼容路径仍以任务 Chrome 的精确进程 ID 恢复原前台应用。所有路径都保留短时恢复监视作为兜底，检查间隔为 50ms，且只有任务 Chrome 本身成为前台时才恢复；用户日常 Chrome 不受处理。人工接管不会由服务强行激活窗口，用户主动切入即可。

## 23. 任务记录精简

43123 的任务记录表只显示开始时间、任务类型、账号邮箱、重复创建、授权、状态、结果和删除操作。账号 ID、用量上限、代理类型、并发数、供应商和分组不在日志列表中展示；底层既有任务记录结构保持不变，避免为了展示调整破坏历史兼容。

任务记录的状态列优先识别明确封号终态：错误码为 `OPENAI_ACCOUNT_DEACTIVATED_BANNED`，或停用进度结果为 `banned` / `already_banned` 时显示“封号”，结果列继续显示“已封号”或“原本已封号”。普通错误仍显示“失败”，不会根据账号名称、邮件或普通停用提示猜测封号。

## 22. blog.tx.sb FirstMail 取件链接

`blog.tx.sb` 在原有 `/s/<访问凭据>/<邮箱>` 页面之外，支持固定的 `/fx.php?mail=<邮箱>&pwd=<取件密码>&limit=<数量>` FirstMail 查看页。专用适配器只接受 HTTPS、精确 origin 和路径，以及唯一非空的 `mail`、`pwd` 与可选 `1-50` 整数 `limit`；请求前核对链接邮箱与任务邮箱，并重建为固定 `limit=1`。该页面只取最新一封，避免整页 HTML 同时出现多个旧验证码而触发安全冲突；其单次网络请求上限为 30 秒，其他邮箱来源仍使用全局上限。密码只存在当前任务秘密作用域，不写入 SQLite、日志或公开错误。

响应必须为 HTML，页面标题中的邮箱必须与任务邮箱一致。明确的邮箱认证失败会映射为 `MAIL_AUTHENTICATION_FAILED`，明确空收件箱返回空列表。FirstMail 将邮件正文放在 `iframe[srcdoc]` 时，适配器只在外层邮件标题或发件人明确属于 OpenAI/ChatGPT 后解析这一个嵌入预览；不会扫描页面表单、时间或其他任意六位数字。无法确认页面身份或结构时闭合失败。原 `/s/...` 适配器保持不变。

Assurivo 的 `/console/open.php` 页面链接继续转换为固定同源 `/console/feed.php` JSON 接口，但请求数量固定为最新 1 封，并将该有限结果标记为服务端最新优先。这样重发验证码后只处理当前最新邮件，不会把多封历史验证码合并成不确定候选。

第一轮邮箱轮询仍严格排除任务基线中已经存在的邮件。只有浏览器明确执行过“重新发送电子邮件”后，且邮箱适配器保证结果为服务端最新优先时，轮询器才允许对基线中的最新邮件执行受控复用；同一邮件身份和同一验证码必须连续两次轮询保持一致。未知排序、多个邮件、单封多个验证码或连续结果变化时均不复用，并继续进入下一轮或人工接管。该规则处理上游复用验证码或原地更新同一邮箱记录的情况，不允许第一轮直接使用任意旧邮件。

邮箱速度采用平衡优化：任务开始时保留一次基线请求，点击首次继续前只记录发送时间，不再重复读取并合并同一邮箱；每次重发前同样只记录准确时间，不再执行随后会被恢复旧边界而丢弃的邮箱请求。正常轮询间隔从 3 秒缩短为 1 秒，临时网络错误和服务端限流仍执行退避。重发后最新邮件有可解析收件时间且不早于重发时间 10 秒容差时可首次命中；时间缺失或较早时仍要求连续两次身份和验证码一致。

## 24. api798 HTML 结果页兼容

`api798.com/latest` 通常返回纯文本或 JSON，但部分邮箱记录会返回 HTML 包装页。专用适配器现在按“最新结果页”处理 HTML：转换可见文本后优先读取验证码/登录码上下文后的六位数字，没有上下文时读取该结果页中的六位数字集合；只将代码片段构造成 OpenAI 邮件消息，不把动态页面导航和时间信息写入基线指纹。没有邮件或没有六位候选时返回空列表；多个候选仍由现有 OTP 冲突规则阻止盲目提交。
