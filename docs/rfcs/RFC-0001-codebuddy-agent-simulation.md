# RFC-0001 CodeBuddy Agent 行为仿真与 API 化方案

类型：RFC
状态：草案
作者：wayne
评审人：（待）
关联：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)、[CHG-0001](../changes/CHG-0001-codebuddy-provider-initial.md)

> 本文是技术方案（Reference-level），不是实现细节的替代品。实现时以 `src/providers/codebuddy/protocol-spec.md` 为逐字规格；本文与 protocol-spec 冲突时，以 protocol-spec 的实测证据为准，并回写本文。
> 证据基线：CodeBuddy CN genie 3.10.0（`coding-copilot`），本机 macOS，2026-11-20 实测。
> **标注约定**：`【已知】`= 有本机证据；`【待验证】`= 需要抓包/研究报告确认，不得在实现中当作事实；`【决策】`= 本 RFC 做出的设计选择。

---

## 1. 摘要

CodeBuddy CN 的 Agent 通道是一个普通的 HTTPS 推理接口：`POST https://copilot.tencent.com/v2/chat/completions`，bearer 鉴权、gzip 请求体、SSE 风格流式响应。真正的「Agent」语义分布在客户端：系统提示词（按模型变化的 craft/ask/chat 模板）、工具 schema、多步循环、会话/步骤 ID、消息中心轮询与遥测。

因此本方案不实现「服务端 Agent 循环」，而是 **信封仿真（envelope emulation）+ 客户端驱动循环**：代理把每个 OpenAI 请求渲染成真实 IDE 的「一步（step）」——相同的 URL、头集合、gzip、提示词、工具 schema、ID 体系——把响应事件翻译回 OpenAI chunk。工具调用由客户端执行并回传，代理只做协议映射。这样既保持 any2api 的定位（LLM 通道 API 化），又把「不像 IDE」的面积压到最小。

残余差异（TLS 指纹、无工作区上下文、遥测缺失等）在 §7 与 §9 诚实列出，并给出缓解或接受理由。

---

## 2. 动机与证据

### 2.1 问题

- 用户希望在 IDE 之外使用 CodeBuddy 的模型（脚本、Cherry Studio、Cline、OpenAI SDK）。
- any2api 已有 codearts provider，验证了「协议直连 + 全头模拟」方法论（见 [codearts protocol-spec](../../src/providers/codearts/protocol-spec.md)），但 CodeBuddy 的协议、鉴权与 Agent 语义不同，需要独立 provider。
- 风险约束：用户明确要求「尽可能模拟 Agent 的行为，减少被识别的可能」。这不是 ToS 合规建议，而是技术约束：代理不能留下明显的「非 IDE」特征。

### 2.2 证据（本机实测，2026-11-20）

| # | 事实 | 证据 |
|---|---|---|
| E1 | 产品端点 `https://copilot.tencent.com`，API base `/v2` | `extensions/genie/product.json` 的 `endpoint`；日志 `CraftInvokableAgent ... endpoint: https://copilot.tencent.com/v2` |
| E2 | 推理接口 `POST /v2/chat/completions` | 扩展日志 233 次 `[CustomFetch] url: https://copilot.tencent.com/v2/chat/completions` |
| E3 | 请求体 gzip | 日志 `[CustomFetch] enableRequestBodyGzip: true`、`Request body gzipped: original 58818 bytes, compressed 25473 bytes`；product feature `RequestBodyGzip: true` |
| E4 | Bearer 鉴权 + 用户头 | `product.json.authentication`: `tokenHeader: Authorization`、`tokenType: bearerToken`、`usernameHeader: X-User-Id`、`storageKey: planning-genie.new.accessTokencn` |
| E5 | Agent 循环 = 多 step，每 step 一次 chat 请求 | 日志 `onAgentStart ... conversationId=... requestId=...` → `onStepStart ... stepCount=1..N` → `Step execution metrics: step=N, duration=..., usage={...}` |
| E6 | 一次 step 的 usage | `{"inputTokens":15142,"outputTokens":292,"totalTokens":15434,"cacheTokens":4096,"cachedWriteTokens":0,"cachedMissTokens":11046,"lastTokens":15434,"credit":0,"thinkingTokens":276}` |
| E7 | 模型元数据由服务端下发 | 日志 `model: {"id":"hy4flash-free","name":"Hy4 flash","contextWindow":{...},"maxInputTokens":960000,"maxOutputTokens":64000,"temperature":0.9,"top_p":1,"toolMode":"code_mode","reasoning":{"defaultEffort":"high","supportedEfforts":["high"]},"supportsToolCall":true,...}` |
| E8 | 提示词在客户端，按模型分变体 | `product.json.prompts` 含多个 `craft-agent-prompt`（tags: gpt-5.x / gemini-3.x / claude-4.5 / claude-opus-4.5）与 `ask-agent-prompt`；模板含 `{{ ModelNamePrompt }}`、`{{ ClawMemory_1..3 }}`、`{{ CodebaseSearchContext }}`、`{{ AgentsArtifactsPrompt }}`、`{{ ResultPresentationPrompt }}`、`{{ ToolResultPresentationPrompt }}`、`{{ subAgentPrompt }}` |
| E9 | 工具集按 agent 定义 | `product.json.agents`: craft（读写/搜索/终端/单测/MCP 等）、ask（只读 6 工具）、plan、chat（无工具） |
| E10 | 消息中心 30s 轮询 | 日志 `[MsgCenter] GET summary status=200 ... poll_interval=30s identity={"uid":"...","tenant_id":"personal","product_code":"codebuddy"}`；端点 `/v2/msg-center/message/summary` |
| E11 | 客户端运行时 Electron Node v22.20.0 | 日志 `[CustomFetch] Enterprise CA trust enabled: caCount=151, node=v22.20.0` |
| E12 | 工具调用 id 形态 `chatcmpl-tool-<hex>` | 日志 `[Tool:use_skill] [chatcmpl-tool-b1faf9090855f49f]` |
| E13 | 流式事件含 `tool-call-streaming-start` / `tool-call` | 日志 `[handleStreamChunk] tool-call-streaming-start`、`[handleStreamChunk] tool-call` |
| E14 | 单步上限与 token 上限 | `product.json.requestMaxStepLimit = 2000`；日志 `max_tokens resolved: maxTokens=64000 ... maxInputTokens=300000 ... room=288685` |
| E15 | 本地会话历史（IDE 侧） | `genie-history/<base64(cwd)>/{current.json,conversations,backups}`；`current.json = {conversationId,lastUpdated}` |

### 2.3 不做的后果

CodeBuddy 模型无法进入 any2api 的统一入口；用户只能在 IDE 内使用，无法脚本化或接入第三方客户端。

---

## 3. 目标与非目标

**目标**

- 定义一个可实现的协议规格，使代理请求在「URL / 方法 / 头集合 / gzip / 请求体字段 / ID 格式 / 步骤语义」上与真实 IDE 一致。
- 定义 OpenAI ↔ CodeBuddy 的双向映射（含流式、工具调用、usage、错误）。
- 定义凭证提取与续期策略；IDE 不必在线。
- 明确残余差异与分期，避免「为了拟真无限扩大范围」。

**非目标**

- 服务端 Agent 循环（工具在代理侧执行）。
- 代码补全 / NES / 提交信息 / 内联聊天等 IDE 专属能力。
- 绕过配额、计费或账号限制。
- 伪造 IDE 专属遥测（在拿到协议前不猜测、不上报）。
- 多账号池化、负载均衡（未来可能性，见 §11）。

---

## 4. 用户视角（Guide-level）

配置好凭证后，CodeBuddy 与 codearts 一样是一个 OpenAI 兼容端点；因为 any2api 单进程多 provider，CodeBuddy 使用路径前缀 `/codebuddy/v1`：

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/codebuddy/v1",
    api_key="anything",  # 本地服务不校验
)
resp = client.chat.completions.create(
    model="hy4flash-free",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,
)
for chunk in resp:
    print(chunk.choices[0].delta.content or "", end="")
```

- `GET /codebuddy/v1/models` 返回当前账号可用的模型（CodeBuddy 模型目录）。
- `POST /codebuddy/v1/chat/completions` 支持 `stream` 与 `tools`；工具调用以标准 OpenAI `tool_calls` 返回，客户端执行后把 `role: "tool"` 消息发回即可继续。
- 默认 profile 为 `chat`（无工具，通用问答）；需要 Agent 工具循环时，客户端用 `x-codebuddy-agent: craft`（或启动配置 `CODEBUDDY_AGENT=craft`）。
- 错误：上游 4xx/5xx 归一为 OpenAI 错误结构；401 且刷新失败时返回可读的「请重新登录 CodeBuddy」提示。
- 健康检查：`GET /healthz` 返回各 provider 的凭证/模型池状态。

---

## 5. 技术方案（Reference-level）

### 5.1 总体架构

```
OpenAI 兼容客户端（Cherry Studio / Cline / OpenAI SDK / curl）
        │  POST /codebuddy/v1/chat/completions
┌───────▼──────────────────────────────────────────────────────────────┐
│ any2api（Bun 单进程）                                                 │
│  ┌────────────┐ 路由：/v1→codearts  /codebuddy/v1→codebuddy           │
│  │ 路由/注册表 │                                                     │
│  └─────┬──────┘                                                     │
│  ┌─────▼─────────────────────────────────────────────────────────┐   │
│  │ codebuddy/openai.ts（OpenAI 门面）                              │   │
│  │  - 模型解析（严格别名表）                                        │   │
│  │  - stream / 非 stream；SSE 聚合                                 │   │
│  └─────┬─────────────────────────────────────────────────────────┘   │
│  ┌─────▼──────────────┐  ┌──────────────────┐  ┌─────────────────┐   │
│  │ envelope.ts        │  │ ids.ts           │  │ client.ts       │   │
│  │ - profile 选择      │  │ - 32hex ID       │  │ - 头集合         │   │
│  │ - 提示词渲染        │  │ - 会话/轮次/step │  │ - gzip          │   │
│  │ - 工具 schema 映射  │  │                  │  │ - SSE 读取       │   │
│  └─────┬──────────────┘  └────────┬─────────┘  │ - 401 刷新重试   │   │
│  ┌─────▼──────────────────────────▼────────────┐  └───────┬─────────┘   │
│  │ config.ts：凭证（Keychain/env）+ 模型发现     │          │             │
│  └─────────────────────────────────────────────┘          │             │
└────────────────────────────────────────────────────────────┼─────────────┘
                                                             ▼
                            POST https://copilot.tencent.com/v2/chat/completions
```

**【决策】单进程、路径前缀路由**：每个 provider 使用 `/<name>/v1` 前缀——codearts 为 `/codearts/v1/*`，CodeBuddy 为 `/codebuddy/v1/*`；不再保留无前缀的 `/v1`。理由：OpenAI SDK 的 `base_url` 支持路径；避免多端口/多进程；避免模型名冲突时路由歧义。

### 5.2 上游协议事实（v3.10.0）

#### 5.2.1 端点

| 用途 | 方法与路径 | 证据 |
|---|---|---|
| 推理 | `POST /v2/chat/completions` | E2 |
| 消息中心 | `GET /v2/msg-center/message/summary` | E10 |
| 活动 banner | `GET /v2/activity/banner` | 日志 |
| 模型目录 | **【待验证】** 日志未直接出现；可能在登录/配置同步接口中 | E7 说明模型对象由服务端下发，但具体 URL 未在扩展日志中 |
| Token 刷新 | **【待验证】** 未在日志中出现 | `authentication` 只有 token 头，无 refresh 端点 |

Base URL 由 `product.json.endpoint` + `/v2` 组成；`product.json` 的 `stagingEndpoint` 为 `https://staging.codebuddy.cn`；扩展设置 `codingcopilot.endpoint` 可覆盖（默认 null）。

#### 5.2.2 鉴权

【已知】`Authorization: Bearer <token>` + `X-User-Id: <uid>`（`authentication` 配置：`tokenType: bearerToken`、`usernameHeader: X-User-Id`、`usernameEncode: URLEncode`）。token 存于 VSCode SecretStorage（macOS Keychain `CodeBuddy CN Safe Storage`，storageKey `planning-genie.new.accessTokencn`）。

【待验证】是否存在 `X-Request-Id` / `X-Trace-Id` / 客户端版本头 / `User-Agent` 的具体值；研究报告应给出完整头集合。

#### 5.2.3 请求体

【已知】

- 请求体是 JSON，启用 gzip（`Content-Encoding: gzip`，具体头名待抓包确认）。
- 未压缩体积约 58KB（含系统提示词 + 工具 schema + 历史），说明提示词与工具定义由客户端发送，而非服务端注入。
- 一次 step 一个请求；多步循环由客户端驱动（E5）。
- 模型字段：`model`（模型 id）、`messages`、`tools`、`stream`、`max_tokens`/`max_completion_tokens`、`temperature`、`top_p`、`reasoning` 等 OpenAI 风格字段的存在性需要在 bundle 中逐字确认（研究报告 / protocol-spec 负责）。

【待验证】请求体是否包含 `agent`/`mode`/`conversationId`/`requestId` 等上下文字段；是否包含 `toolMode: "code_mode"` 对应的特殊结构。

#### 5.2.4 响应

【已知】

- 流式（日志中的 chunk 处理、`tool-call-streaming-start`、`tool-call`）。
- 工具调用 id 形如 `chatcmpl-tool-<14hex>`（E12）。
- 每 step 结束有 usage（E6），字段含 `inputTokens/outputTokens/totalTokens/cacheTokens/cachedWriteTokens/cachedMissTokens/lastTokens/credit/thinkingTokens`。
- 错误形态与重试头 **【待验证】**。

#### 5.2.5 旁路信号

| 信号 | 已知信息 | 代理策略 |
|---|---|---|
| 消息中心轮询 | `GET /v2/msg-center/message/summary`，30s，带 identity（uid/tenant_id/product_code） | **【决策】可选开启**（默认关，`CODEBUDDY_MSG_CENTER=1` 开）；开启时按 30s 轮询，模拟 IDE 在线 |
| TracingService / Aegis | 日志有 `Exported 1 spans, traceIds: ...`；product feature `Aegis: false` | **不伪造**；记录为残余差异 |
| 心跳 | 未见 | 不实现 |
| 模型目录刷新 | 登录/同步时拉取 | 启动时拉取；失败回退 product.json 静态列表 |

### 5.3 Agent 信封（envelope）

这是本方案的核心。**【决策】** 代理维护「profile」，每个 profile 对应 IDE 的一种 agent 形态：

| profile | 对应 IDE agent | 工具 | 适用客户端 | 默认 |
|---|---|---|---|---|
| `chat` | chat | 无 | 通用问答、OpenAI 兼容客户端 | ✅ |
| `ask` | ask | 只读 6 工具（read_file/list_dir/search_file/search_content/semantic_search/RAG_search） | 需要代码问答但不需要写 | |
| `craft` | craft | 全量工具（读写/终端/单测/MCP…） | 编码 Agent 客户端（Cline 等） | |

选择方式（优先级从高到低）：

1. 请求头 `x-codebuddy-agent: craft|ask|chat`；
2. 启动配置 `CODEBUDDY_AGENT`；
3. 默认 `chat`。

#### 5.3.1 系统提示词

【已知】提示词模板在 `product.json.prompts`，按模型 tags 选择（E8）：

- `craft-agent-prompt`：多个变体（默认 / gpt-5.x / gemini-3.x / claude-4.5 / claude-opus-4.5）；另有 `craft-agent-prompt-with-todo` 变体。
- `ask-agent-prompt`：只读问答。
- `chat` agent 在 `product.json.agents` 中没有 `instructions` 字段（只有 models），即 chat 无系统提示词或走默认空提示。

渲染流程：

1. 按目标模型 id 匹配 tags（如 `gpt-5.4` → gpt-5.x 变体；无匹配 → 默认变体）。
2. 读取模板，替换占位符：
   - `{{ ModelNamePrompt }}`：模型展示名（如 `Hy4 flash`）。
   - `{{ ClawMemory_1..3 }}`：用户记忆；代理侧为空。
   - `{{ CodebaseSearchContext }}`：工作区检索上下文；代理侧为空。
   - `{{ AgentsArtifactsPrompt }}`：子 Agent 产物；代理侧为空。
   - `{{ ResultPresentationPrompt }}` / `{{ ToolResultPresentationPrompt }}`：**【待验证】** 定义位置（product.json 未含值，可能在 bundle 常量中）。
   - `{{ subAgentPrompt }}`：顶层会话为空。
3. 作为 `messages[0]`（role=system）发送。

**残余差异**：真实 IDE 会注入打开的文件、光标、诊断、最近编辑等工作区状态；代理没有这些上下文，提示词会比真实 IDE 短。缓解：

- 允许客户端通过 `x-codebuddy-context`（JSON）注入等价上下文，代理按 IDE 的格式渲染；
- 不支持时接受差异，并在 protocol-spec 标注。

**【决策】提示词来源**：优先从本机 CodeBuddy 安装读取 `product.json`（只读，随 IDE 升级自动更新）；找不到时回退到仓库内快照（`src/providers/codebuddy/prompts/`，按 genie 版本记录）。仓库快照涉及厂商文本，是否入库由用户决定（默认不入库，只记录版本与校验和）。

#### 5.3.2 工具 schema

【已知】每个 agent 的工具名与用途在 `product.json.agents[].tools`；工具 JSON schema 的具体定义在 bundle 中（**【待验证】**，研究报告负责）。

映射规则：

- 客户端有 `tools`：逐个转换为 CodeBuddy 工具 schema；保留 `function.name/description/parameters`；不支持的字段（如 `strict`）丢弃并记录。
- 客户端无 `tools`：
  - `chat` profile：不发送 tools（与 IDE chat agent 一致）；
  - `ask`/`craft` profile：发送该 agent 的默认工具集。
- `tool_choice`：只支持 `auto`（与 codearts 相同；真实 IDE 也不用强制）。

**【决策】** 默认 `chat` profile 不带工具，保证通用客户端「即插即用」；需要工具的用户显式切 `craft`。

#### 5.3.3 消息展开（flatten）

【已知】日志有 `start flatten messages` / `end flatten messages`（E5 附近）。展开规则需在 bundle 中确认，初步：

- system（渲染后的 agent 提示词）
- 历史 user/assistant（assistant 含 tool_calls）
- tool 结果（role=tool，带 tool_call_id）
- 当前 user 消息（可能包裹 `<user_query>...</user_query>`，提示词中有「denoted by the <user_query> tag」）

**【待验证】** 是否对最后一条 user 消息做 `<user_query>` 包裹、是否对图片/附件做特殊编码。

### 5.4 ID 体系与会话语义

【已知】ID 形态与粒度（E5、E12、E15）：

| ID | 形态 | 粒度 | 代理生成规则 |
|---|---|---|---|
| `conversationId` | 32 位小写 hex | 一个会话 | 会话首次请求生成；会话内复用；空闲超时（如 2h）回收 |
| `requestId` | 32 位小写 hex | 一个用户回合（可含多 step） | 新 user 消息（最后一条 role=user 且与上一轮不同）→ 新 requestId；tool 结果续请求沿用 |
| `messageId` | 32 位小写 hex | 一条 assistant 消息 / 一个 step | 每次上游请求生成 |
| trace（TracingService） | 32 位 hex / uuid | 一次导出 | 每 step 生成；不对外暴露 |

会话键（代理侧）：优先 `x-codebuddy-session` 头；否则 `body.user`；否则按 API key/连接）→ 映射到 `conversationId`。这与 codearts 的 sessionKey 语义一致。

**【决策】** 代理不持久化会话到磁盘；重启后会话 ID 丢失（客户端重发全量历史即可，不影响语义）。

### 5.5 请求映射（OpenAI → CodeBuddy）

| OpenAI 字段 | 处理 |
|---|---|
| `model` | 严格别名表：`hy4flash-free` / 展示名 `Hy4 flash` / 模型 id；未知 → 404 `model_not_found`（不静默回退，避免计费到错误模型） |
| `messages` | 归一化 `developer`→`system`；system 合并规则：客户端 system 在前，agent 提示词在后？——**【决策】agent 提示词在 messages[0]，客户端 system 以 `<user_context>` 形式附加在其后**（避免两套 system 冲突；待抓包验证 IDE 的合并方式） |
| `tools` | 见 §5.3.2 |
| `tool_choice` | 仅 `auto`/`none`；其他 → 400 |
| `stream` | 代理始终向上游请求流式；客户端非流式时聚合（与 codearts 相同） |
| `max_tokens` | `min(客户端值, model.maxOutputTokens)`；缺省用模型默认（hy4flash-free = 64000） |
| `temperature` / `top_p` | 缺省用模型默认（0.9 / 1）；客户端显式给出则透传（在模型支持范围内） |
| `reasoning_effort` | 映射到模型 `reasoning` 配置；`hy4flash-free` 仅支持 `high`，其他值钳制为 `high` 或忽略并记录 |
| `stop` / `seed` / `presence_penalty` 等 | 透传（若 bundle 显示支持）；不支持的忽略并记录 |
| 图片/附件 | **【待验证】** OpenAI `image_url` → CodeBuddy 多模态格式；首版可返回 400 `images_unsupported` |

### 5.6 响应映射（CodeBuddy → OpenAI）

- 上游事件 → OpenAI chunk：
  - 文本增量 → `choices[0].delta.content`
  - 思考增量 → `choices[0].delta.reasoning_content`（OpenAI 兼容扩展；Cherry Studio/LobeChat 可识别）
  - 工具调用 → `choices[0].delta.tool_calls[]`（首帧给 `id`/`function.name`，后续帧给 `arguments` 分片；上游 id 形如 `chatcmpl-tool-*`，直接透传）
  - 结束 → `finish_reason`：`tool-calls` → `tool_calls`；`stop` → `stop`；`length` → `length`
  - usage → `usage`（prompt/completion/total + `prompt_tokens_details.cached_tokens` + `completion_tokens_details.reasoning_tokens`）
- 非流式：聚合为单个 `chat.completion`，保留 `tool_calls` 与 `usage`。
- 错误：`code`/`message` 归一为 OpenAI 错误结构；保留上游 HTTP 状态（502/429 等）与 `retry-after`（若有）。

### 5.7 凭证与续期

**提取（macOS）**：

1. `security find-generic-password -s "CodeBuddy CN Safe Storage" -w` 取 safeStorage 密钥（首次会触发 Keychain 授权）。
2. 读 `~/Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb`（SQLite `ItemTable`）中 key 为 `planning-genie.new.accessTokencn` 的值。
3. 按 Chromium safeStorage 规则解密（PBKDF2-SHA1，salt `saltysalt`，1003 轮，16 字节；AES-128-CBC，IV = 密文前 16 字节；具体参数需按本机 Electron 版本在实现时验证）。
4. 解析出 token；uid 从 token claims / 本地配置 / 环境变量获取。

**兜底**：环境变量 `CODEBUDDY_TOKEN` + `CODEBUDDY_UID`（或 `CODEBUDDY_REFRESH_TOKEN`，若续期机制确认）。

**续期**：**【待验证】**。首版行为：

- 401 → 尝试刷新（若实现续期端点）→ 重试一次；
- 无续期端点 → 返回 401 + 「请在 CodeBuddy CN 重新登录，或更新 CODEBUDDY_TOKEN」；
- 不打印 token 明文。

### 5.8 旁路信号与节奏

| 信号 | 是否实现 | 节奏 | 说明 |
|---|---|---|---|
| 消息中心轮询 | 可选（默认关） | 30s | `CODEBUDDY_MSG_CENTER=1`；使用同一 token/uid；失败静默 |
| TracingService | 否 | — | 缺协议；伪造反而增加不一致风险 |
| 心跳 | 否 | — | 未发现 |
| 模型目录刷新 | 是 | 启动时 + 401 后 | 失败回退静态列表 |

**【决策】** 旁路信号遵循「能精确复现就做，不能就不做」；不做猜测性上报。理由：错误的遥测比没有遥测更可疑。

### 5.9 传输与指纹

| 项 | 真实 IDE | 代理 | 处理 |
|---|---|---|---|
| 运行时 | Electron Node v22.20.0 | Bun | 残余差异；Bun 与 codearts 同源，工程上一致 |
| TLS | Node/OpenSSL | Bun/BoringSSL | JA3/JA4 可能不同；接受并记录（无实用伪造方案） |
| HTTP 版本 | 与腾讯云网关协商（h2 可用） | Bun fetch | 尽力；不承诺 h2 |
| 请求体压缩 | gzip | gzip | 必须一致（`Content-Encoding: gzip`） |
| 头顺序 | JS 对象插入序 | 代理可控 | 按 §5.2 清单顺序注入 |
| UA | **【待验证】** | 与 IDE 一致 | 研究报告给出 |

### 5.10 分期与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| CHG-0001 | 传输 + 信封 + OpenAI Chat/Models + 凭证 + 401 | §5.11 测试全绿；curl/OpenAI SDK 可用；抓包 diff 无未知差异 |
| CHG-0002 | Anthropic `/codebuddy/v1/messages` + Responses `/codebuddy/v1/responses` | 复用 codearts 适配层；Claude Code / Codex 直连可用 |
| CHG-0003 | 遥测/消息中心/指纹加固 + diff 工具 | 7 天稳定性；残余差异清单更新 |

### 5.11 测试与验证（设计）

- **契约测试**：mock 上游断言 URL、方法、头集合（快照）、gzip 可解压、body 字段集。
- **映射测试**：OpenAI → CodeBuddy → OpenAI 往返（文本/工具/usage/错误）。
- **拟真度 diff**：mitmproxy 抓真实 IDE 一次会话 + 代理一次会话，归一化（时间戳、随机 ID、token）后 diff；差异必须能解释。
- **端到端**：OpenAI SDK（Python/Node）、Cherry Studio、Cline；流式/非流式/工具循环。
- **凭证**：Keychain 提取、过期、401 刷新、环境变量兜底。
- **回归**：codearts 测试保持全绿。

---

## 6. 取舍与替代方案

### 方案 A（推荐）：信封仿真 + 客户端驱动循环

每个 OpenAI 请求 = IDE 的一个 step；代理负责「像 IDE」，客户端负责「像用户/Agent 驱动」。

- 优点：工具执行留在客户端（安全、可用）；协议面小；与 any2api 定位一致；拟真度高。
- 缺点：多步节奏取决于客户端；客户端若不回弹 tool 结果，行为与 IDE 不同（但这是客户端行为，不是代理伪造）。

### 方案 B：服务端 Agent 循环

代理接收用户消息后，自行执行 craft 循环（包括工具）。

- 缺点：工具需要访问用户工作区/终端，代理没有；执行任意工具是安全风险；超出 any2api 范围。**不选。**

### 方案 C：纯透传（不注入 agent 信封）

只转发 messages，不带 IDE 提示词/工具。

- 优点：实现最简单。
- 缺点：请求体小一个数量级、无工具 schema、无 agent 语义，最容易被识别。**不选。**

### 方案 D：驱动本地 IDE（ACP/IPC）

通过 IDE 的 ACP 接口发消息，复用 IDE 的完整 Agent。

- 优点：零协议逆向。
- 缺点：必须保持 IDE 运行；不是「API 化」；无法 headless。**不选。**

---

## 7. 缺点与风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| TLS/HTTP2 指纹（Bun vs Electron） | 服务端若采集 JA3/JA4，可见「Node UA + 非 Node 指纹」矛盾 | 接受并记录；优先 Bun 同源；如未来服务端封禁，再评估 curl-impersonate/Node 运行时 |
| 无工作区上下文 | 提示词比真实 IDE 短，token 画像不同 | `x-codebuddy-context` 注入；否则接受 |
| 无遥测 | 「有请求无 span」可能成为异常信号 | 记录残余差异；拿到协议后在 CHG-0003 补 |
| 协议漂移 | CodeBuddy 升级导致 4xx/协议错误 | protocol-spec 绑定 genie 版本；启动时校验 product.json 版本；diff 脚本 |
| Keychain 授权/无权限 | 服务启动失败 | 环境变量兜底；明确错误提示 |
| Token 续期未知 | 过期后不可用 | 首版手动更新；找到续期端点后补 CHG |
| 工具 schema 差异 | 部分客户端工具调用失败 | 映射表 + 降级；覆盖主流客户端测试 |
| 账号 ToS | 使用风险 | 与 codearts 先例一致；文档明确风险由用户承担 |
| 多 provider 路由 | 端口/模型冲突 | 路径前缀隔离；统一为 `/codearts/v1` 与 `/codebuddy/v1` |

---

## 8. 测试、上线与回滚

- **测试**：见 §5.11；TDD（先写失败测试）。
- **上线**：本地 launchd 服务；先以 `CODEBUDDY_AGENT=chat` 小流量验证，再开 craft。
- **观测**：启动日志（凭证来源、模型池、profile）、请求日志（不含 token）、`/healthz`、7 天错误统计。
- **回滚**：从 `src/index.ts` 摘除 CodeBuddy 注册；删除 provider 目录；codearts 不受影响。无持久化状态，回滚无数据迁移。

---

## 9. 未决问题

> 以下问题在用户提到的 CodeBuddy 研究报告（未随消息提供）与后续 bundle 实测中确认；确认前不得在实现中当作事实。

1. **完整请求头集合**：`Authorization` / `X-User-Id` 之外还有哪些头（客户端版本、UA、trace、会话、语言、平台）？各头的值来源？
2. **请求体 schema**：`model`/`messages`/`tools`/`stream` 之外的字段名与结构；是否携带 `agent`/`mode`/`conversationId`/`requestId`；`toolMode: "code_mode"` 如何表达？
3. **工具 JSON schema**：craft/ask 工具的完整定义与参数；工具结果消息的结构。
4. **系统提示词占位符**：`ResultPresentationPrompt` / `ToolResultPresentationPrompt` / `AgentsArtifactsPrompt` 的定义与取值；`{{ ModelNamePrompt }}` 的确切文案。
5. **`<user_query>` 包裹**：IDE 是否对用户消息做包裹；历史消息如何展开。
6. **Token 续期**：是否存在 refresh 端点；token 有效期；多端登录行为。
7. **模型目录 API**：获取当前账号可用模型的端点与响应；与 `product.json.models` 的关系。
8. **遥测**：TracingService/Aegis 的端点与 payload；是否值得仿真。
9. **错误与重试**：429/5xx 的响应体、`retry-after`、模型切换建议。
10. **并发**：同一账号并发请求的行为（排队/拒绝）；代理是否需要串行化。

---

## 10. 决策记录

| # | 决策 | 结论 | 理由 |
|---|---|---|---|
| D1 | 架构 | 信封仿真 + 客户端驱动循环 | 工具执行必须在客户端；保持 any2api 定位 |
| D2 | 路由 | 单进程 + 路径前缀 `/codebuddy/v1` | 向后兼容；避免端口/模型冲突 |
| D3 | 默认 profile | `chat`（无工具） | 通用客户端即插即用；避免模型对普通问题调用工具 |
| D4 | 上游流式 | 始终流式，非流式客户端由代理聚合 | 与 codearts 一致；上游真实形态是流式 |
| D5 | 旁路信号 | 只做可精确复现的（消息中心可选），不伪造遥测 | 错误遥测比缺失更可疑 |
| D6 | 凭证 | Keychain safeStorage 为主，环境变量兜底 | IDE 不必在线；无 Keychain 权限时可用 |
| D7 | 提示词来源 | 读本机 product.json 优先，仓库快照兜底 | 随 IDE 升级自动更新；避免硬编码漂移 |
| D8 | 首版范围 | 只 OpenAI Chat + Models | 先验证传输与信封；协议适配层后续 CHG |

---

## 11. 未来可能性

- 多账号池化与轮询（需用户显式配置多套凭证）。
- 模型路由（按客户端模型名映射到不同 CodeBuddy 模型）。
- 与 usage-ledger 打通（CodeBuddy 用量已在 usage-ledger 有采集源）。
- 遥测仿真（拿到协议后）。
- 企业版 / staging endpoint 支持（`staging.codebuddy.cn`）。

---

## 证据索引

| 证据 | 位置 |
|---|---|
| 产品端点/认证/agents/models/prompts | `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/product.json` |
| Agent 循环、CustomFetch、MsgCenter、usage | `~/Library/Application Support/CodeBuddyExtension/Logs/CodeBuddyIDE/2026-11-20/playground__*.log` |
| 扩展入口与实现 | `.../genie/out/extension/index.js`（21MB bundle，待逐字核对） |
| 凭证存储 | macOS Keychain `CodeBuddy CN Safe Storage`；`.../CodeBuddy CN/User/globalStorage/state.vscdb` |
| 方法论先例 | [codearts protocol-spec](../../src/providers/codearts/protocol-spec.md) |

---

## 12. 实现校验（2026-11-20）

首版实现后，对本方案的关键假设做了实测校验（逐字规格见 [protocol-spec](../../src/providers/codebuddy/protocol-spec.md)）。

### 12.1 已确认

- 推理端点 `POST {endpoint}/v2/chat/completions`，请求体 gzip，`Accept: text/event-stream`。
- **只支持流式**：`stream:false` → 400 `code 11101`；代理始终向上游请求 `stream:true`，非流式客户端由代理聚合。
- 鉴权：`Authorization: Bearer <JWT>` + `X-User-Id` + `X-Domain`；`POST /v2/plugin/auth/token/refresh` 可刷新。
- 头集合：`X-IDE-Type/Name/Version`、`X-Product-Version`、`X-Product`、`X-Env-ID`、`X-Trace-ID`、`X-Request-ID`、`X-Conversation-ID`、`X-Conversation-Request-ID`、`X-Conversation-Message-ID`、`X-Agent-Intent`、`X-Model-ID`。
- `User-Agent: CodeBuddy/<version>` 可接受；`/v3/config` 用它校验产品版本。
- 响应为标准 OpenAI chunk：`reasoning_content`、`tool_calls`、`finish_reason`、末帧 `usage`、`[DONE]`。
- `stream_options` 不发送；`max_tokens` 对 gpt-5*/o1/o3/o4/gpt-4.1 改为 `max_completion_tokens`。
- `X-Device-Token` 在当前通道**可省略**；首版不伪造 TuringShield。
- 凭证可从 Keychain + `state.vscdb` 提取（v10 safeStorage）；`auth.accessToken` 为裸 JWT。

### 12.2 与原设计的差异

- 原 §5.3 的「ask/craft profile 默认工具集」首版未实现：profile 只切换系统提示词，工具仅来自客户端 `tools`。理由：内置工具 JSON schema 尚未逐字还原，宁可少发也不发错误 schema。
- 原 §5.8 的「旁路信号」首版只做模型发现；消息中心轮询、遥测未做。
- 原 §5.2.1 的「模型目录 API」：`/v3/config` 只返回 features、`/v2/agents` 不含 models；最终从本机 `state.vscdb` 的 `cloud_product_config_cache` 读取（24 个，按 uid 匹配），缺失时回退 product.json + agent models + 观测模型。

### 12.3 实现状态

- CHG-0001 状态：开发中；`bun test src/providers/codebuddy/` → 29 pass / 0 fail。
- 真实上游非流式/流式/工具调用/craft 实测成功；codearts 回归通过。
- 未做：7 天稳定性、真实 401 演练、抓包 diff、Anthropic/Responses 适配。
- CHG-0002 状态：开发中；新增 `/codebuddy/v1/messages`（Anthropic）与 `/codebuddy/v1/responses`（Responses），可选消息中心轮询（`CODEBUDDY_MSG_CENTER=1`），`CODEBUDDY_AUTO_REFRESH=0` 可关闭自动刷新；模型目录从本机云端产品缓存读取（24 个，缺失回退）；`bun test` → 47 pass / 0 fail；真实上游 Anthropic/Responses 非流式与流式、`hy4std` 均实测通过。
- 仍未部署、未重启服务（用户要求保持当前服务运行）。

### 12.4 仍未决

- 23 个模型的真实下发接口。
- `X-Device-Token` 的长期必要性。
- `ResultPresentationPrompt` 等占位符的取值。
- 排队协议与 429 细节。