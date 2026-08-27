# 30d.team 公开接口清单

> 调查日期：2026-08-26
>
> 基础地址：`https://30d.team`
>
> 调查范围：公开首页、前端静态资源、页面内置 API 文档、公开 Python SDK，以及使用无效占位值执行的只读错误响应验证。

## 1. 范围与结论

当前公开前端及官方 SDK 共引用 13 个接口。

本文中的“全部接口”是指公开客户端能够发现和调用的接口，不包括未被前端或 SDK 引用的后台接口、管理接口、内部服务路由及登录后才可能出现的动态接口。

站点当前没有公开 OpenAPI 或 Swagger 文档：`/openapi.json`、`/swagger.json`、`/api-docs`、`/docs` 和 `/swagger-ui` 均返回 404；`robots.txt`、`sitemap.xml` 和前端 source map 也未公开。

## 2. 通用约定

- POST 请求使用 `Content-Type: application/json`。
- 普通兑换、历史查询和找回接口不要求 API Key，使用 `card_code` 作为身份凭证。
- 订单状态接口使用订单下载令牌作为 Bearer 凭证。
- 文件下载接口通过 `token` 查询参数传递下载令牌。
- JSON 错误响应统一为：

```json
{
  "ok": false,
  "error": "错误信息"
}
```

- 前端请求超时为 180 秒。
- 前端订单轮询间隔为 2 秒，默认最多轮询 90 次。
- 找回进度自动刷新间隔为 12 秒。
- `card_code` 和 `download_token` 都属于敏感凭证，不应记录到日志或公开分享。

## 3. 接口总览

| #   | 方法 | 路径                                     | 用途                         | 凭证             |
| --- | ---- | ---------------------------------------- | ---------------------------- | ---------------- |
| 1   | GET  | `/api/redeem/theme`                      | 获取页面主题                 | 无               |
| 2   | GET  | `/api/redeem/inventory/summary`          | 获取库存汇总                 | 无               |
| 3   | POST | `/api/redeem/preview`                    | 检查卡密额度、绑定情况与库存 | `card_code`      |
| 4   | POST | `/api/redeem/orders`                     | 创建兑换或重新生成订单       | `card_code`      |
| 5   | GET  | `/api/redeem/orders/{order_no}`          | 查询订单处理状态             | Bearer 下载令牌  |
| 6   | GET  | `/api/redeem/orders/{order_no}/download` | 下载凭据文件                 | `token` 查询参数 |
| 7   | POST | `/api/redeem/history`                    | 查询单张卡密的历史订单       | `card_code`      |
| 8   | POST | `/api/redeem/history/batch`              | 批量查询卡密历史             | `card_codes`     |
| 9   | POST | `/api/redeem/history/download-token`     | 为历史订单补发下载令牌       | `card_code`      |
| 10  | POST | `/api/redeem/batch-download`             | 批量打包下载订单文件         | 订单下载令牌     |
| 11  | POST | `/api/redeem/reclaim/health-check`       | 只读检测账号凭据状态         | `card_codes`     |
| 12  | POST | `/api/redeem/reclaim/batch-cards`        | 提交找回任务或查询进度       | `card_codes`     |
| 13  | GET  | `/api/redeem/reclaim/sdk`                | 下载官方 Python SDK          | 无               |

## 4. 页面与库存接口

### 4.1 获取页面主题

```http
GET /api/redeem/theme
```

已验证响应：

```json
{
  "ok": true,
  "theme": "ticket"
}
```

前端识别的主题值：

- `ticket`
- `tech`
- `wind`
- `zongzhu`

### 4.2 获取库存汇总

```http
GET /api/redeem/inventory/summary
```

已验证响应结构：

```json
{
  "ok": true,
  "available_total": 0,
  "ok_total": 0,
  "unknown_total": 0
}
```

以上数值是调查时的实时结果，不代表后续库存。

## 5. 兑换接口

### 5.1 预检查卡密

```http
POST /api/redeem/preview
Content-Type: application/json
```

请求体：

```json
{
  "card_code": "CARD-CODE",
  "project": "k12",
  "format": "sub2api",
  "target_id": "TARGET-ID"
}
```

字段说明：

| 字段        | 必需     | 说明                               |
| ----------- | -------- | ---------------------------------- |
| `card_code` | 是       | 卡密，同时作为身份凭证             |
| `project`   | 是       | 已观察到 `k12`、`30d_team`         |
| `format`    | 是       | 已观察到 `sub2api`、`cpa`          |
| `target_id` | 条件必需 | 仅 `project=30d_team` 时由前端提交 |

成功响应使用 `preview` 包装：

```json
{
  "preview": {
    "mode": "partial",
    "message": "可兑换",
    "can_fulfill": true,
    "can_redeem_remaining": true,
    "can_refresh_bound": true,
    "card_quota_total": 10,
    "card_quota_used": 2,
    "card_quota_remaining": 8,
    "bound_count": 2,
    "available_now": 8,
    "need_replenish": 0,
    "estimated_seconds": 30,
    "liveness_snapshot": {}
  }
}
```

示例仅用于描述前端读取的字段，不代表真实业务数据。已观察到的 `mode` 包括 `new`、`partial`、`refresh_only`。

### 5.2 创建兑换订单

```http
POST /api/redeem/orders
Content-Type: application/json
```

请求体在预检查字段基础上增加：

```json
{
  "card_code": "CARD-CODE",
  "project": "k12",
  "format": "sub2api",
  "action": "redeem_remaining",
  "client_request_id": "UUID"
}
```

`action` 已观察到以下值：

- `redeem_remaining`：兑换剩余额度。
- `refresh_bound`：重新生成已绑定账号的文件。

成功响应由前端直接作为订单对象使用，确认字段包括：

- `order_no`
- `download_token`
- `status`
- `message`
- `delivered_count`

订单状态包括 `pending`、`processing`、`completed`、`failed`。

该接口可能消耗兑换额度或触发文件生成，不能作为只读探测接口使用。

### 5.3 查询订单状态

```http
GET /api/redeem/orders/{order_no}
Authorization: Bearer {download_token}
```

前端至少读取：

```json
{
  "order": {
    "status": "completed"
  }
}
```

无效订单或令牌的已验证响应：

```json
{
  "ok": false,
  "error": "订单不存在或链接已过期"
}
```

### 5.4 下载订单文件

```http
GET /api/redeem/orders/{order_no}/download?token={download_token}
```

成功响应是凭据 JSON 或 ZIP 文件，具体格式取决于订单的 `format` 和导出方式。

无效链接的已验证响应：

```json
{
  "ok": false,
  "error": "下载链接无效或已过期"
}
```

## 6. 历史订单接口

### 6.1 查询单张卡密历史

```http
POST /api/redeem/history
Content-Type: application/json
```

```json
{
  "card_code": "CARD-CODE"
}
```

响应包含 `orders` 数组。前端读取的订单字段包括：

- `order_no`
- `status`
- `format`
- `quantity`
- `download_count`
- `max_downloads`
- `remaining_downloads`
- `completed_at`
- `downloadable`
- `can_issue_download_token`
- `refreshable`
- `project`
- `target_id`
- `credentials`

`credentials` 明细中读取 `resource_uid`、`email`、`liveness_status`、`probe_http_status`、`probed_at` 等字段。

### 6.2 批量查询历史

```http
POST /api/redeem/history/batch
Content-Type: application/json
```

```json
{
  "card_codes": ["CARD-CODE-1", "CARD-CODE-2"]
}
```

前端预期响应：

```json
{
  "ok": true,
  "cards": []
}
```

每个卡密结果可以包含 `card_code`、`orders` 和错误信息。

### 6.3 补发历史订单下载令牌

```http
POST /api/redeem/history/download-token
Content-Type: application/json
```

```json
{
  "card_code": "CARD-CODE",
  "order_no": "ORDER-NO"
}
```

成功响应至少包含 `order_no` 和 `download_token`，也可能包含 `status`。

## 7. 批量下载接口

```http
POST /api/redeem/batch-download
Content-Type: application/json
```

前端完整请求示例：

```json
{
  "export_mode": "combined_zip",
  "items": [
    {
      "order_no": "ORDER-NO",
      "download_token": "DOWNLOAD-TOKEN"
    }
  ],
  "summary": [
    {
      "card_code": "CARD-CODE",
      "order_no": "ORDER-NO",
      "status": "completed",
      "message": ""
    }
  ]
}
```

`export_mode` 支持：

| 值                        | 输出                                 |
| ------------------------- | ------------------------------------ |
| `combined_zip`            | sub2api 汇总、CPA 单账号文件和对照表 |
| `multi_account_json`      | 一份 sub2api 汇总 JSON               |
| `single_account_json_zip` | 多个 CPA 单账号文件组成的 ZIP        |

响应主体是 JSON 或 ZIP 文件。响应头 `X-Redeem-Batch-Summary` 是 Base64URL 编码的 JSON，前端读取以下字段：

- `requested_items`
- `successful_orders`
- `failed_orders`

公开 SDK 的简化调用只提交 `items`，因此 `export_mode` 和 `summary` 至少在部分服务端流程中可能是可选字段。

## 8. 401 找回接口

### 8.1 健康检查

```http
POST /api/redeem/reclaim/health-check
Content-Type: application/json
```

```json
{
  "card_codes": ["CARD-CODE-1", "CARD-CODE-2"]
}
```

该接口是只读操作。公开 SDK 定义的响应字段：

- `ok`
- `need_reclaim`
- `healthy`
- `cannot_reclaim`
- `unknown`
- `total`
- `not_loadable`
- `credentials`
- `error`

前端读取的凭据明细字段包括 `category`、`email`、`resource_uid`、`http_status`。`category` 可见值包括 `cannot_reclaim` 和 `unknown`；HTTP 402 表示工作区停用，403 表示账号停用，429 表示上游限流。

### 8.2 批量找回或刷新进度

```http
POST /api/redeem/reclaim/batch-cards
Content-Type: application/json
```

```json
{
  "card_codes": ["CARD-CODE-1", "CARD-CODE-2"],
  "mode": "401",
  "query_only": false
}
```

字段说明：

| 字段               | 说明                               |
| ------------------ | ---------------------------------- |
| `card_codes`       | 待处理的卡密数组                   |
| `mode=401`         | 只找回 401 失效凭据                |
| `mode=all`         | 处理全部凭据                       |
| `query_only=false` | 提交新任务，可能修改业务状态       |
| `query_only=true`  | 只读刷新已有任务进度，不提交新任务 |

公开 SDK 定义的汇总响应字段：

- `ok`
- `total`
- `requested_cards`
- `valid_cards`
- `queued`
- `already_running`
- `done`
- `unreclaimable`
- `not_owned`
- `skipped`
- `failed`
- `tracked_tasks`
- `scanned_resources`
- `distinct_resources`
- `skipped_not_401`
- `cards`
- `error`

每张卡的结果可以包含 `card_code`、`tasks`、`error`、`card_status`。SDK 定义的任务字段：

- `card_code`
- `order_no`
- `resource_uid`
- `status`
- `message`
- `tier_label`
- `no_action`
- `permanent`
- `error_code`
- `provider_status`
- `failure_class`
- `download_token`
- `download_error`

前端和 SDK 中观察到的任务状态包括：

- `pending`
- `running`
- `retrying`
- `done`
- `skipped`
- `unreclaimable`
- `not_owned`
- `exhausted`
- `failed`

完成且同时带有 `order_no` 和 `download_token` 的任务可以通过订单下载接口获取修复后的文件。

## 9. Python SDK

```http
GET /api/redeem/reclaim/sdk
```

已验证响应信息：

| 项目         | 值                             |
| ------------ | ------------------------------ |
| Content-Type | `text/x-python; charset=utf-8` |
| 文件名       | `redeem_api_sdk.py`            |
| SDK 版本     | `2026.08.13.2`                 |
| 发布时间     | `2026-08-13T00:00:00Z`         |

SDK 只依赖 `requests`，主要公开方法：

- `health_check(card_codes)`
- `batch_reclaim(card_codes, mode="401")`
- `refresh_progress(card_codes)`
- `poll_until_done(card_codes)`
- `download(order_no, token)`
- `batch_download(items, save_dir=".")`

## 10. 数量与并发限制

- 页面声明单次最多处理 2000 张卡密。
- 页面建议批量找回按每批 20 张提交。
- SDK 声明全局并发上限为 100。
- SDK 建议客户端并发控制在 30 以内。
- SDK 默认健康检查请求至少允许 90 秒超时。
- SDK 默认找回轮询间隔为 12 秒，最长等待 600 秒。

## 11. 验证记录与限制

本次实际执行了以下非破坏性检查：

- 获取首页和公开静态资源。
- 获取页面主题和库存汇总。
- 下载并检查公开 Python SDK。
- 使用空请求体或明确无效的占位值确认参数错误、订单不存在及下载链接过期的响应格式。
- 检查常见 OpenAPI、Swagger、站点地图和 source map 路径。

本次没有执行：

- 使用真实卡密兑换。
- 创建真实订单。
- 提交真实 401 找回任务。
- 使用真实订单号或下载令牌下载凭据。
- 登录绕过、目录爆破、漏洞扫描或高并发压力测试。
- 浏览器 HAR 抓取；当前环境没有可用的 `agent-browser` 命令。

因此，本文可以覆盖当前公开客户端引用的接口，但不能证明服务器不存在其他未公开路由。成功响应中的字段仅记录前端实际读取或官方 SDK 明确定义的部分，未对未公开字段作推测。
