# CodeBuddy CN 协议规格（genie 3.10.0）

> 证据基线：2026-11-20，本机 CodeBuddy CN（`coding-copilot` 3.10.0，Electron 1.106.1），
> 扩展 bundle 静态还原 + 本机日志 + 代理实测（真实请求成功）。
> 标注：`【已知】` 有实测/代码证据；`【待验证】` 尚未确认；`【决策】` 本实现的选择。
> 本文是 codebuddy provider 的逐字规格；实现与本文冲突时，以实测为准并回写本文。

---

## 0. 最小可用调用

```http
POST https://copilot.tencent.com/v2/chat/completions
Content-Type: application/json
Content-Encoding: gzip
Accept: text/event-stream
Authorization: Bearer <accessToken>
X-User-Id: <uid>
X-Product: SaaS
X-Env-ID: production
X-IDE-Type: CodeBuddyIDE
X-IDE-Name: CodeBuddyIDE
X-IDE-Version: 1.106.1
X-Product-Version: 3.10.0
User-Agent: CodeBuddy/3.10.0
X-Trace-ID: <32hex>
X-Request-ID: <32hex>
X-Conversation-ID: <32hex>
X-Conversation-Request-ID: <32hex>
X-Conversation-Message-ID: <32hex>
X-Agent-Intent: chat
X-Model-ID: hy4flash-free
X-Domain: www.codebuddy.cn
```

Body（gzip 前）是标准 OpenAI Chat 请求；`stream` 必须为 `true`。实测：

- `stream:false` → HTTP 400，`code 11101`，`msg: "Non-stream chat request is currently not supported"`。
- `stream:true` → HTTP 200，`Content-Type: text/event-stream`，标准 `data:` 行，末尾 `[DONE]`。
- 不带 `X-Device-Token` 实测可成功（该账号/通道当前不强制）。

## 1. 端点

| 用途 | 方法与路径 | 证据 |
|---|---|---|
| 推理（agent） | `POST /v2/chat/completions` | 实测 200 |
| 代码补全 | `POST /v2/completions` | bundle |
| 向量 | `POST /v2/embeddings` | bundle |
| 云端产品配置 | `GET /v3/config?repos=` | 实测 200，返回 `enterpriseId/productFeatures/productFeaturesConfig`（不含 models） |
| Agent 列表 | `GET /v2/agents` | 实测 200，返回 craft/editAgent/tests/workspace 及其 commands |
| 消息中心 | `GET /v2/msg-center/message/summary` | 实测 200，`poll_interval:30` |
| 刷新 token | `POST /v2/plugin/auth/token/refresh` | bundle |
| 登录态 | `GET /v2/plugin/auth/token?state=`、`GET /v2/plugin/login/account?state=` | bundle |
| 排队 | `POST /v2/chat/queue/status`、`POST /v2/chat/queue/cancel` | bundle |
| 遥测 | `POST /v2/report`、`POST /llm/data/report`、`POST /v1/traces` | bundle |

`prefixPath` 只用于登录/刷新路径（`/v2/plugin/...`），不是 base path。

## 2. 鉴权与凭证

### 2.1 请求头

- `Authorization: Bearer <accessToken>`；`accessToken` 是 JWT（`eyJ...`）。
- `X-User-Id: <uid>`（uuid）。
- `X-Domain: <auth.domain>`（如 `www.codebuddy.cn`）。
- 企业账号额外：`X-Enterprise-Id`、`X-Tenant-Id`、`X-Department-Info`。

### 2.2 凭证存储（macOS）

- VSCode SecretStorage 密钥：`secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}`，存于
  `~/Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb` 的 `ItemTable`。
- 值是 `{"type":"Buffer","data":[...]}`；字节格式：`v10` + 16B IV + AES-128-CBC(PKCS7) 密文。
- key = `PBKDF2(Keychain 密码, "saltysalt", 1003, 16, SHA1)`；Keychain 条目 `CodeBuddy CN Safe Storage`（账户 `CodeBuddy CN Key`）。
- 明文包含会话 JSON（`account.uid`、`auth.accessToken`、`auth.refreshToken`、`auth.expiresAt`、`auth.domain`），
  并带有一段二进制信封；本实现用容错字段提取（见 `config.ts` 的 `extractSessionFields`），不依赖整体 JSON 解析。
- `auth.accessToken` 是裸 JWT；旧版顶层 `accessToken` 可能是 `<uid>+<jwt>`，提取时需过滤含 `+` 的值。

### 2.3 刷新

`POST {endpoint}/v2/plugin/auth/token/refresh`，头：

```
Content-Type: application/json
X-Refresh-Token: <refreshToken>
X-Auth-Refresh-Source: plugin
X-Domain: <domain>
```

响应 `data` 为新的 `{accessToken, refreshToken, expiresAt, ...}`。客户端侧限流 30s；`expiresAt` 前 300s 内可刷新。

### 2.4 设备令牌（TuringShield）

- 非企业账号会调用 `@tencent/turing-shield-sdk` 的 `fetchRiskDetect(true, false)`，把结果放入
  `X-Device-Token`（失败时 `X-Device-Token-Error`）。
- 【已知】本代理未带该头，实测 `/v2/chat/completions` 仍返回 200；因此首版不强制。
- 【决策】支持 `CODEBUDDY_DEVICE_TOKEN` 环境变量注入；不尝试复刻/伪造 TuringShield。

## 3. 请求头集合（实测/代码确认）

| 头 | 值 | 说明 |
|---|---|---|
| `Content-Type` | `application/json` | 固定 |
| `Content-Encoding` | `gzip` | 启用 gzip 时固定；body 始终压缩（小 body 同步、≥65536 异步） |
| `Accept` | `text/event-stream` | chat 路径 |
| `Authorization` | `Bearer <token>` | 鉴权 |
| `X-User-Id` | `<uid>` | 鉴权 |
| `X-Product` | `SaaS` / `enterprise` | deploymentType |
| `X-Env-ID` | `production` | 环境路由 |
| `X-IDE-Type` | `CodeBuddyIDE` | 由 platform 推导 |
| `X-IDE-Name` | `CodeBuddyIDE` | platform |
| `X-IDE-Version` | `1.106.1` | IDE 版本 |
| `X-Product-Version` | `3.10.0` | 扩展版本 |
| `User-Agent` | `CodeBuddy/3.10.0` | `/v3/config` 会校验 UA 中的产品版本；`CodeBuddy/<v>` 与 `CodeBuddyIDE/<v>` 实测均 200 |
| `X-Trace-ID` | 32hex | 每次请求 |
| `X-Request-ID` | 32hex | 用户回合 |
| `X-Conversation-ID` | 32hex | 会话 |
| `X-Conversation-Request-ID` | 32hex | 同 requestId |
| `X-Conversation-Message-ID` | 32hex | 每条消息/step |
| `X-Agent-Intent` | `chat` / `ask` / `craft` / 自定义 | agent 名 |
| `X-Model-ID` | 模型 id | 直接透传 |
| `X-Domain` | `<domain>` | 有值时 |
| `X-Device-Token` | `<token>` | 可选 |
| `X-Agent-Type` / `X-Root-Request-ID` / `X-Parent-Conversation-ID` | 子 agent 才用 | 顶层不发 |
| `X-Session-ID` | 补全路径用 | agent 路径不发 |
| `X-Private-Data` | 非国内端点 | 本端点不发 |

`X-IDE-Type`、`X-IDE-Name`、`X-IDE-Version`、`X-Product-Version` 由 `CustomHeadersHttpProxyInterceptor` 注入；
`X-Request-Trace-Id` 是另一个每请求 uuid（axios 拦截器），与 `X-Trace-ID` 不同。

## 4. 请求体

- 标准 OpenAI `ChatCompletionRequest`：`model`、`messages`、`tools`、`tool_choice`、`stream`、`max_tokens` /
  `max_completion_tokens`、`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、`seed`、`stop`、
  `response_format`、`reasoning_effort`、`parallel_tool_calls`、`user`、`metadata`、`store`、`extra` 等。
- `messages`：`system` / `user` / `assistant` / `tool`；assistant 可带 `tool_calls`；tool 带 `tool_call_id`、`name`。
- `stream` 恒为 `true`；`stream_options` 不发送（客户端 `includeUsage` 未配置）。
- `max_tokens` 对 `gpt-5*`、`o1/o3/o4`、`gpt-4.1` 改为 `max_completion_tokens`。
- `temperature`：模型有 `temperature` 时透传（如 `hy4flash-free` 0.9）；纯推理模型无值时不发送。
- 不发送 conversationId / requestId / messageId / agent / 工作区信息；这些只在头里。
- gzip：`enableRequestBodyGzip` 为真时始终压缩，头 `Content-Encoding: gzip`；阈值 65536 只影响同步/异步实现。

示例（gzip 前）：

```json
{
  "model": "hy4flash-free",
  "messages": [
    {"role": "system", "content": "<system_prompt>...</system_prompt>"},
    {"role": "user", "content": "hello"}
  ],
  "stream": true,
  "max_tokens": 4096,
  "temperature": 0.9,
  "tools": [{"type": "function", "function": {"name": "read_file", "description": "...", "parameters": {"type": "object"}}}],
  "tool_choice": "auto"
}
```

## 5. 响应（SSE）

标准 OpenAI chunk：

```json
data: {"id":"gen-...","model":"hy4-flash-free","object":"chat.completion.chunk","created":1795185090,"choices":[{"index":0,"delta":{"role":"assistant","content":"","reasoning_content":"...","function_call":null,"refusal":"","tool_calls":[],"extra_fields":null},"logprobs":null,"finish_reason":""}],"usage":null}

data: {"id":"gen-...","model":"hy4-flash-free","object":"chat.completion.chunk","created":1795185090,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"chatcmpl-tool-...","type":"function","function":{"name":"get_weather","arguments":""}}]},"finish_reason":""}],"usage":null}

data: {"id":"gen-...","model":"hy4-flash-free","object":"chat.completion.chunk","created":1795185090,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":198,"completion_tokens":56,"total_tokens":254,"prompt_tokens_details":{"cached_tokens":0},"completion_tokens_details":{"reasoning_tokens":41}}}

data: [DONE]
```

- `reasoning_content`：思考增量（`hy4flash-free` 只有 reasoning + content 两段）。
- `tool_calls`：首帧给 `id` + `function.name`，后续帧给 `arguments` 分片；`finish_reason:"tool_calls"`。
- `usage`：最后一帧；`prompt_tokens_details.cached_tokens`、`completion_tokens_details.reasoning_tokens`。
- 模型名会被服务端归一化（请求 `hy4flash-free` → 响应 `hy4-flash-free`），属正常。

## 6. ID 与会话

| ID | 生成 | 粒度 | 复用 |
|---|---|---|---|
| `conversationId` | 32hex（uuid v4 去连字符） | 一个本地会话 | 会话内复用 |
| `requestId` | 32hex | 一个用户回合（可含多 step） | 同回合内复用 |
| `messageId` | 32hex | 一条 assistant 消息 / 一次 step | 每次请求新生成 |
| `X-Trace-ID` | 32hex | 每次请求 | 新生成 |

- 会话历史本地保存（`genie-history`），服务端无 conversation API；代理无需同步会话。
- 代理用 `x-codebuddy-session`（或 `body.user`）映射到 `conversationId`；新 user 消息 → 新 `requestId`。

## 7. Agent 提示词

- 模板在 `product.json.prompts`，按 `tags` 选模型变体；`craft-agent-prompt` / `craft-agent-prompt-with-todo` / `ask-agent-prompt`。
- 模板只含 `{# 注释 #}` 与 `{{ 变量 }}`，无 `{% if %}`；渲染时去注释、替换变量。
- 变量：`ModelNamePrompt`（` powered by <name> model`）、`ClawMemory_1..3`、`CodebaseSearchContext`、
  `AgentsArtifactsPrompt`、`ResultPresentationPrompt`、`ToolResultPresentationPrompt`、`subAgentPrompt` 等。
- 发送前包一层：`<system_prompt>\n...\n</system_prompt>`（可选 `<special_instructions>`）。
- `chat` agent 无 `instructions`；代理的 `chat` profile 不注入系统提示词。
- 实测 craft profile：`hy4flash-free` + 默认 craft 模板 → `prompt_tokens≈1550`，请求成功。

## 8. 模型目录

- 本地 `product.json.models` 是基础池；`agents[].models` 会补充 agent 绑定模型。
- 本机产品.json 未包含 `hy4flash-free`；它来自云端/账号配置（日志 `Preparing model` 可观测）。
- `/v3/config` 实测只返回 `enterpriseId/productFeatures/productFeaturesConfig`；`/v2/agents` 返回 4 个 agent 配置，不含 models。
- 【待验证】23 个模型的真实下发端点（可能在 webview 的 ACP 通道或另一个产品配置接口）。
- 首版模型池 = product.json models + agent models + 观测模型 `hy4flash-free`（17 个）；未知模型名透传给上游，由上游校验。

## 9. 错误与重试

| 场景 | 上游 | 代理行为 |
|---|---|---|
| 非流式请求 | 400 `code 11101` | 归一为 400 + 原文 message |
| 401 | 401 / body code 401 | 刷新 token 重试一次；失败返回 401 + 重新登录提示 |
| 429 | 429 / `code 14003` 等 | 归一为 429；首版不自动退避 |
| 排队 | `code 6020/6021/6022` | 首版返回错误；后续可接 `/v2/chat/queue/status` |
| 5xx | 5xx | 归一为 502 |

错误体常见字段：`code`、`msg`、`displayMsg.{en,zh,zh-hant}`、`requestId`、`retry_policy`、`actions`。

## 10. 拟真度检查单

- [x] URL `/v2/chat/completions`、gzip body、`Content-Type/Accept`
- [x] Bearer + `X-User-Id` + `X-Domain`
- [x] `X-IDE-*`、`X-Product-Version`、`X-Product`、`X-Env-ID`
- [x] `User-Agent: CodeBuddy/<version>`
- [x] `X-Trace-ID`/`X-Request-ID`/`X-Conversation-ID`/`X-Conversation-Request-ID`/`X-Conversation-Message-ID`
- [x] `X-Agent-Intent` + `X-Model-ID`
- [x] 32hex ID 格式与会话复用
- [x] craft/ask 系统提示词信封
- [ ] `X-Device-Token`（实测可省略；可选注入）
- [ ] TLS/JA3 指纹（Bun vs Electron，残余）
- [ ] 遥测/消息中心轮询（首版未做）

## 11. 未决问题

1. 模型目录（23 个）的真实下发接口；`/v3/config` 不含 models。
2. `X-Device-Token` 的生成与是否长期必需；TuringShield 原生 SDK 无法在 Bun 直接复用。
3. `ResultPresentationPrompt` / `ToolResultPresentationPrompt` / `AgentsArtifactsPrompt` 的取值。
4. 请求头完整顺序与 `X-Request-Trace-Id` 的关系（HTTP/2 hpack 层不可见）。
5. 多账号/企业账号的差异化头（`X-Enterprise-Id` 等）。
6. 排队协议的 `retry_after` / `queue_position` 结构。