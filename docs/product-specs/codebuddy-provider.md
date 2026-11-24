# 产品规格：CodeBuddy provider（CodeBuddy CN → OpenAI 兼容 API）

类型：产品规格
状态：活跃
原需求卡：REQ-0001
Owner：wayne
关联：[RFC-0001](../design-docs/rfcs/codebuddy-agent-simulation.md)、[CHG-0001](../exec-plans/active/CHG-0001-codebuddy-provider-initial.md)

## 1. 摘要

为 any2api 增加 `codebuddy` provider，把腾讯 CodeBuddy CN（`copilot.tencent.com`）的模型通道封装为 OpenAI 兼容 API，使 Cherry Studio、Cline、OpenAI SDK 等客户端在不启动 IDE 的情况下也能使用 CodeBuddy 的模型。

与只做「协议直连」不同，本功能的核心目标是 **Agent 行为仿真**：上游看到的请求在传输层（头集合、gzip、ID 体系）、语义层（IDE 提示词、工具 schema、会话/步骤模型）和旁路信号层（遥测/轮询/心跳）尽量与真实 IDE 一致，降低被识别为代理流量的风险。技术方案见 RFC-0001。

## 2. 问题与证据

- **谁、什么场景**：本机用户希望在 IDE 之外（脚本、第三方客户端、自动化）使用 CodeBuddy 的模型额度；现有 any2api 只能接 codearts。
- **现在怎么做、代价是什么**：只能打开 CodeBuddy CN IDE 手动对话；无法接入 OpenAI 兼容客户端，也无法在脚本里复用同一份鉴权与模型池。
- **证据（2026-11-20，本机实测）**：
  - CodeBuddy CN 已安装：`CodeBuddy CN.app`，扩展 `genie` = `coding-copilot 3.10.0`；产品端点 `https://copilot.tencent.com`（`extensions/genie/product.json` 的 `endpoint`）。
  - 真实上游调用为 `POST https://copilot.tencent.com/v2/chat/completions`，请求体启用 gzip（`[CustomFetch] enableRequestBodyGzip: true`，实测 58,818 → 25,473 字节）。
  - 扩展日志（`~/Library/Application Support/CodeBuddyExtension/Logs/CodeBuddyIDE/2026-11-20/playground__*.log`）记录了完整的 Agent 循环：`onAgentStart: agent=craft ... conversationId=... requestId=...` → `onStepStart stepCount=1..N` → 每次 step 一个 `/v2/chat/completions` 请求 → `Step execution metrics: step=..., usage={...}`。
  - 凭证形态：`authentication` 配置为 bearer token（`Authorization`）+ `X-User-Id`，token 存于 VSCode SecretStorage（macOS Keychain `CodeBuddy CN Safe Storage`），storageKey `planning-genie.new.accessTokencn`。
  - 模型元数据由服务端下发（日志中的 `CraftInvokableAgent ... model: {...}` 含 `id/name/contextWindow/maxInputTokens/maxOutputTokens/temperature/top_p/toolMode/reasoning`）。
- **不做的后果**：CodeBuddy 只能作为 IDE 使用，无法与 any2api 已有的 codearts provider 统一接入；用户需要维护两套使用方式。

## 3. 用户与场景

- **主要用户**：本机开发者（wayne），以及任何使用 OpenAI 兼容客户端的用户。
- **触发情境（When）**：用户配置好 CodeBuddy 凭证后，把客户端 Base URL 指向 `http://127.0.0.1:8787/codebuddy/v1`，选择 CodeBuddy 模型发起对话。
- **期望结果（so I can）**：像使用 OpenAI 一样使用 CodeBuddy 模型，包括流式输出、工具调用往返、长上下文。
- **关键用例**：
  1. 普通聊天（单步问答，非流式/流式）。
  2. 工具调用循环（客户端执行工具，把结果发回，代理继续多步推理）。
  3. 长会话（多轮上下文、会话 ID 复用）。
  4. 凭证过期后的无感续期。

## 4. 目标与非目标

**目标**

- **G1（可用性）**：提供与 codearts 对齐的 OpenAI 兼容端点（首版至少 `/codebuddy/v1/chat/completions` + `/codebuddy/v1/models`），支持流式与非流式、工具调用、reasoning 内容。
- **G2（拟真度）**：上游请求在头集合、请求体、ID 体系、步骤语义上与真实 IDE 一致；无法一致的部分（如 TLS 指纹）有明确的残余差异清单与缓解方案。
- **G3（凭证自治）**：凭证从本机 CodeBuddy 安装自动提取，IDE 不必在线；token 过期可自动续期。

**非目标**

- 不在代理侧执行工具（文件读写、终端命令等由客户端执行；代理只做透传）。
- 不实现 IDE 的完整能力（代码补全/NES、提交信息生成、内联聊天等）。
- 不绕过账号配额/计费，不伪造付费能力。
- 不承诺规避服务端的主动检测；目标只是「不主动暴露代理特征」，降低被动识别概率。
- 不改变 any2api 对外的 OpenAI 兼容契约；CodeBuddy 特有字段以扩展形式出现。

## 5. 成功指标

- **主指标**：OpenAI SDK / Cherry Studio 能完成「流式多轮对话 + 工具调用循环」；连续 7 天运行无非预期 401/403（凭证续期有效）。基线：尚无（新功能）；目标：0 次非预期鉴权失败。
- **护栏指标**：
  - 与真实 IDE 的请求差异：头集合、请求体字段集、ID 格式逐项 diff 为 0（RFC-0001 §5.2 的可配置项除外）。
  - 代理引入的额外延迟：p95 首字节延迟 ≤ 直连 + 50ms。
  - 不出现上游协议错误（400/415/422）导致的不可用。
- **验证方式**：本机抓包对比（代理 vs IDE）、本地集成测试、7 天运行日志与错误统计。

## 6. 方案概述

采用「**信封仿真 + 客户端驱动循环**」（agent envelope emulation）：

- 每个 OpenAI `/codebuddy/v1/chat/completions` 请求映射为 IDE 的一次 step（一次 `/v2/chat/completions`）。
- 代理按目标模型选择 IDE 的提示词模板（craft/ask/chat），填充运行时变量，并注入与 IDE 一致的工具 schema。
- 代理生成与 IDE 相同形态的 `conversationId` / `requestId` / `messageId` / trace，并维持会话内复用语义。
- 代理按 IDE 的节奏发送可离线实现的旁路信号（如消息中心轮询）；无法实现的（如 IDE 专属遥测）列入残余差异。
- 工具调用结果由客户端回传，代理原样映射，不在服务端执行。

详细设计、取舍与未决问题见 [RFC-0001](../design-docs/rfcs/codebuddy-agent-simulation.md)。

## 7. 当前需求与验收（EARS）

- **R1**：When 服务启动且凭证有效, the system shall 从 CodeBuddy 模型目录获取模型列表并暴露 `GET /codebuddy/v1/models`；获取失败时回退到内置观测池，并在日志中标注回退原因。
- **R2**：When 收到 `POST /codebuddy/v1/chat/completions`, the system shall 向 `POST {endpoint}/v2/chat/completions` 发送 gzip 压缩的 JSON 请求体，请求头集合与 RFC-0001 §5.2 定义的清单一致（该清单在研究报告/抓包确认后补全；补全前以 protocol-spec 的实测清单为准）。
- **R3**：The system shall 生成 32 位小写 hex 的 `conversationId` / `requestId` / `messageId` / trace，并按「会话内复用 conversationId、每轮用户消息新 requestId、每次上游调用新 messageId」的语义使用。
- **R4**：The system shall 按目标模型选择匹配的 IDE 提示词模板（craft/ask/chat 中适用者），填充运行时变量后作为 system 消息发送；客户端自带 system 消息时按 RFC-0001 §5.3 合并。
- **R5**：Where 客户端请求包含 `tools`, the system shall 将其转换为 CodeBuddy 工具 schema 随请求发送，且不改变工具语义；where 客户端未指定 tools, the system shall 不发送 tools（首版不包含内置默认工具集，profile 只影响系统提示词）。
- **R6**：When `stream=true`, the system shall 把上游事件流转换为 OpenAI chunk（content / reasoning / tool_calls / usage）；when `stream=false`, the system shall 聚合为单个 `chat.completion`。
- **R7**：If 上游返回 4xx/5xx, then the system shall 归一为 OpenAI 错误结构（状态码 + 可诊断的 code/message），且日志与响应中不得包含 token 明文。
- **R8**：If 上游返回 401, then the system shall 按 RFC-0001 §5.7 刷新 token 并重试一次；刷新失败时返回 401 与重新登录指引。
- **R9**：When 服务启动, the system shall 从本机 CodeBuddy 的 safeStorage/SecretStorage 提取 token 与 uid；提取失败时给出可操作的错误信息，不静默以空凭证启动。
- **R10**：The system shall 不执行任何客户端工具；tool_calls 原样返回给客户端，tool 结果消息原样转发给上游。
- **R11**：The system shall 默认只监听 `127.0.0.1`；日志不得记录 `Authorization` / token 明文。
- **R12**：When 收到 `POST /codebuddy/v1/messages`, the system shall 将 Anthropic Messages 请求转换为 OpenAI chat 请求（system、text/thinking/tool_use/tool_result 块、tools、tool_choice、max_tokens、stop_sequences），并把响应转换回 Anthropic message（非流式）或 Anthropic SSE（流式）。
- **R13**：When 收到 `POST /codebuddy/v1/responses`, the system shall 将 Responses 请求转换为 OpenAI chat 请求（instructions、input 的 message/function_call/function_call_output、tools、reasoning.effort、max_output_tokens），并把响应转换回 Responses object（非流式）或 Responses SSE（流式）。
- **R14**：Where `CODEBUDDY_MSG_CENTER=1`, the system shall 每 30s 调用 `/v2/msg-center/message/summary`，使用当前凭证；失败静默，不影响 chat。
- **R15**：Where `CODEBUDDY_AUTO_REFRESH=0`, the system shall 不在 401 时自动刷新 token（默认仍自动刷新并重试一次）。
- **R16**：When 服务启动, the system shall 通过注册表按 provider 前缀分发路由；匹配使用最长前缀 + 路径边界（`prefix` 或 `prefix + "/"`），未知路径返回 404，已知路径错误方法返回 405，可选 provider 不可用时其前缀返回 503，`required` provider 创建失败时进程退出。
- **R17**：The system shall 通过共享协议层（`src/protocols/`）提供 Anthropic Messages 与 Responses 路由；provider 差异通过 `ProtocolCapabilities`（`toolChoice`、`normalizeErrors`、`thinking`）表达，共享层不得按 provider 名称分支。
- **R18**：When 收到 `GET /healthz`, the system shall 返回聚合 JSON（`{ok, providers:[...]}`），其中每个 provider 报告 `ok` 与可选详情。
- **R19**：When 上游返回 `code 6020`, the system shall 读取 `retry_after`（或调用 `/v2/chat/queue/status` 获取），等待后重试一次；若等待超过 `CODEBUDDY_QUEUE_TIMEOUT_MS`（默认 120000）或重试仍为 6020，返回 429；`code 6021/6022/14003` 映射为 429 并保留上游 message。
- **R20**：When 上游请求或 SSE 聚合抛出异常, the system shall 返回 502 的 OpenAI 错误结构；注册表对未捕获的 provider 异常返回 JSON 500。错误 `type` 按状态对齐：401 → `authentication_error`，429 → `rate_limit_error`，其他 4xx → `invalid_request_error`，5xx → `upstream_error`。
- **R21**：When 非流式请求的上游 SSE 没有任何 choices（含只有错误帧的流）, the system shall 返回 502，不得返回成功空回答。**流式请求**的 HTTP 头在读到上游帧前已发出，无法再改状态码，改为发 Anthropic `error` 事件（见 R43）。
- **R22**：When Anthropic/Responses/OpenAI 请求体字段类型不合法（`messages`/`input`/`metadata.user_id`/`session_id`/`user`/`tools`，以及 message 项的 `input[].content`）, the system shall 返回 400 协议错误；非 message 项的 content 校验见 R25。
- **R23**：When provider prefix 重复、出现多个空 prefix、或格式不合法（不以 `/` 开头、以 `/` 结尾、为 `/`）, the system shall 启动失败并给出明确错误。
- **R24**：When 服务启动, the system shall 为每个 provider 使用 `/<name>/v1` 前缀（codearts `/codearts/v1`、codebuddy `/codebuddy/v1`）；不再保留无前缀的 `/v1`。
- **R25**：When Responses `input` 项不是 message（如 `reasoning`）, the system shall 不因 `content` 校验拒绝该请求；当 message 项的 `content` 存在且非 `null` 时，须为 string 或 array。
- **R26**：When Responses `input` 含连续 `function_call` 项, the system shall 将其合并为一条 assistant 消息的 `tool_calls` 数组，并在对应 `function_call_output` 前 flush；`reasoning`/未知项不得打断该分组。
- **R27**：When codebuddy 的 system/developer 消息包含已知竞品 preamble `You are Claude Code, Anthropic's official CLI for Claude.`（含多空格/制表符/换行等空白变体、ASCII/Unicode 撇号、可选句点）, the system shall 在发送上游前将其替换为 `You are an AI coding assistant.`，并保留其余系统内容。
- **R28**：When 客户端提供 OpenAI 可选字段（`frequency_penalty`、`presence_penalty`、`stop`、`seed`、`response_format`、`parallel_tool_calls`、`stream_options`、`metadata`、`store`、`user`、`service_tier`、`max_completion_tokens`）, the system shall 在模型支持范围内透传，不得静默丢弃。
- **R29**：When Anthropic 请求包含 `thinking`, the system shall 将其映射为 `reasoning_effort`（`budget_tokens` ≤2048 → minimal，≤8192 → medium，否则 high；`disabled/off` → 按模型 `reasoning.supportedEfforts` 钳制：无列表时 low，有列表时就近，可能 high）。
- **R30**：The system shall 始终保留 `role:"tool"` 或带 `tool_call_id` 的消息（空内容归一为 `""`）；其他消息在 `content` 为 `undefined`/`null`/空数组且无 `tool_calls` 时丢弃，空字符串 `content: ""` 保留。
- **R31**：When codebuddy 的**最长单段 system**（单段文本 ≥1024）或最后一条 user 消息（单段 ≥1024）没有显式 `cache_control`, the system shall 为该消息添加 `cache_control: {type:"ephemeral"}`；其他消息的显式 cache_control 不影响该判断。
- **R32**：When 请求的模型不在 codebuddy 模型目录中, the system shall 返回 404 `model_not_found`，不向上游发送请求。
- **R33**：When 客户端提供 `max_completion_tokens`, the system shall 不发送 `max_tokens`（二者互斥）；未提供时按模型类型选择 `max_tokens` 或 `max_completion_tokens`。
- **R34**：When codebuddy 的 system/developer 文本（字符串或 text 块）包含以 `x-anthropic-billing-header:` 开头的行, the system shall 在发送上游前删除该行；仅当该文本块或消息的文本因删除而变空时不再发送，清洗前已为空的文本块、`content: ""` 的消息以及其他 system 内容（含首尾空白）保持不变；`content` 为 `null` 或空数组的消息仍按 R30 丢弃。
- **R35**：When codebuddy 的 system/developer 文本包含 Codex CLI 自述首句 `You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.`, the system shall 将其替换为 `You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.`，其余内容保持不变。

- **R36**：When codebuddy 的 system/developer 文本包含 Claude Code 反馈链接行（含 `github.com/anthropics/claude-code`）, the system shall 在发送上游前删除该行，并保留其余内容。
- **R37**：When provider 声明 `promptTokensIncludeCache`（当前仅 codebuddy，已实测上游 `prompt_tokens` 为总输入）, the system shall 在 Anthropic usage 中令 `input_tokens` 只表示未缓存输入（`max(0, prompt_tokens - cached_tokens - cache_creation_tokens)`），并保留 `cache_read_input_tokens` / `cache_creation_input_tokens` 为缓存分项；其他 provider 保持上游 `prompt_tokens` 原值。流式多帧 usage 应按字段合并，避免缺失字段把已采集值归零。
- **R38**：When OpenAI Chat SSE 被聚合为非流式 completion, the system shall 在 `usage.prompt_tokens_details` 中保留上游 `cache_creation_tokens`；上游多帧 usage 时按字段合并，缺失字段不覆盖先前值。
- **R39**：When Responses 流式响应创建时, the system shall 在初始 `usage` 中包含 `input_tokens_details.cached_tokens` 与 `output_tokens_details.reasoning_tokens`，并在终态事件中携带完整 usage；多帧 usage 按字段合并，缺失字段不覆盖先前值。
- **R40**：When Anthropic 消息含 `image` 块（顶层或 `tool_result` 内嵌）, the system shall 将其映射为 OpenAI `image_url` 随请求发送（base64 → `data:` URL），不得以文本占位符替代；仅当 `source` 缺失或类型未知时才写占位文本。
- **R41**：When 一条 Anthropic 消息同时含文本、`thinking` 与 `tool_use` 块, the system shall 产出同一条 assistant 消息，携带 `content`、`reasoning_content` 与 `tool_calls`；不得拆成多条 assistant 消息。
- **R42**：When 工具调用缺少对应 `tool_result`（含其后插入 assistant 消息的情形）, the system shall 在该调用之后补一条合成 tool 消息（内容说明结果缺失、按失败处理）；when `tool_result` 找不到对应 `tool_use`, the system shall 将其降级为 user 文本而非裸 tool 消息；when 末尾 user 轮翻译为空, the system shall 补 `(no content)` 占位，请求不得以 assistant 结尾被当作预填（末尾轮留下了工具结果时是工具循环的合法中间态，不补占位）。
- **R43**：When 上游 SSE 帧携带 `error_code`/`error_msg`（或 `error.code`/`error.message`）且无 choices，或整条流没有任何 choices, the system shall 发出 Anthropic `error` 事件，不得以 `message_delta{stop_reason:"end_turn"}` 收尾；`content_filter` 映射为 `refusal` 而非 `end_turn`。非流式聚合路径遇到同样的流按 R21 返回 502，并在错误信息里带上上游原话。

每条 R 的验证位置见 CHG-0001 / CHG-0002 §5；新增 R40–R43 的验证位置见 [2026-11-24-anthropic-tool-assembly](../exec-plans/active/2026-11-24-anthropic-tool-assembly.md) §5，测试映射在 `src/protocols/anthropic-assembly.test.ts` 与 `src/shared/sse.test.ts`。

## 8. 风险与兔子洞

- **协议漂移**：CodeBuddy 升级可能改 endpoint、请求体字段、头集合或工具 schema。缓解：protocol-spec 版本化，记录对应扩展版本（当前 genie 3.10.0）；建立「真实 IDE vs 代理」抓包 diff 脚本。
- **检测风险**：
  - TLS/HTTP2 指纹：真实客户端是 Electron（Node v22.20.0），代理运行在 Bun，ClientHello/JA3 可能不同。缓解：优先 Bun 同源实现（与 codearts 相同策略），并在文档中保留诚实清单。
  - 行为节奏：真实 IDE 一个用户回合会连续跑多步（step 1..N），代理若每个 HTTP 请求只跑一步，节奏可能不同。缓解：客户端驱动循环 + 可选会话保持，见 RFC-0001 §5.4。
  - 旁路信号缺失：真实 IDE 有消息中心轮询、TracingService 等。缓解：实现可离线复现的部分，其余列入残余差异。
- **凭证**：token 存于 macOS Keychain（safeStorage），提取需要 Keychain 授权；token 续期机制尚未确认。缓解：先支持手动/半自动提取，续期作为 RFC-0001 未决问题跟踪。
- **合规**：使用行为受腾讯账号协议约束；与 codearts 先例一致，风险由用户承担并在文档中明确。
- **模型/工具差异**：CodeBuddy 的 `toolMode: "code_mode"` 与 OpenAI function calling 的映射可能不完全等价。缓解：在 RFC-0001 §5.5 定义映射与降级路径。

## 9. 关键决策

| 决策 | 结论 | 理由 | 记录 |
|---|---|---|---|
| 仿真架构 | 信封仿真 + 客户端驱动循环 | 工具执行必须在客户端；服务端 agent 循环无法访问用户工作区，且超出 any2api 定位 | RFC-0001 §6 |
| 默认 profile | `chat`（无工具）为默认；ask/craft 可选，只切换系统提示词 | 通用聊天客户端即插即用；内置工具 schema 尚未逐字还原，宁可少发也不发错误 schema | RFC-0001 §5.3 |
| 实现基线 | 复用 codearts provider 的目录结构与协议适配层，独立目录不共享凭证代码 | codearts 已在生产验证；独立目录隔离协议差异，避免相互影响 | CHG-0001 §4 |
| 首版范围 | 首版 OpenAI Chat + Models（CHG-0001），随后补 Anthropic Messages + Responses + 可选消息中心（CHG-0002） | 先验证传输与信封拟真，再补协议面；每个 CHG 独立可验收 | CHG-0001 / CHG-0002 |
| provider 边界 | 静态注册表 + 相对路由；codebuddy 与 codearts 均切共享协议层 | 架构评审建议；消除入口/provider/协议层耦合，新增 provider 只加一行注册 | CHG-0003 |

## 10. 变更索引

| CHG ID | 标题 | 状态 | 链接 |
|---|---|---|---|
| CHG-0001 | CodeBuddy provider 初始实现（传输 + 信封仿真 + OpenAI Chat） | 已验证 | [CHG-0001](../exec-plans/active/CHG-0001-codebuddy-provider-initial.md) |
| CHG-0002 | CodeBuddy 协议适配层（Anthropic Messages + Responses）与旁路信号 | 已验证 | [CHG-0002](../exec-plans/active/CHG-0002-codebuddy-protocol-adapters.md) |
| CHG-0003 | any2api provider 注册表与共享协议层 | 已验证 | [CHG-0003](../exec-plans/active/CHG-0003-provider-registry-protocols.md) |
| CHG-0004 | CodeBuddy 排队协议与限流错误映射 | 已验证 | [CHG-0004](../exec-plans/active/CHG-0004-codebuddy-queue.md) |
| CHG-0005 | 评审修复：错误边界、空流、类型校验、normalizeErrors、共享 SSE、前缀校验 | 已验证 | [CHG-0005](../exec-plans/active/CHG-0005-review-fixes.md) |
| CHG-0006 | 统一 provider 前缀为 `/<name>/v1` | 已验证 | [CHG-0006](../exec-plans/active/CHG-0006-unify-prefixes.md) |
| CHG-0007 | 修复 Responses reasoning 项 `content: null` 导致 400 | 已验证 | [CHG-0007](../exec-plans/active/CHG-0007-responses-null-content.md) |
| CHG-0008 | 修复 Responses 并行 function_call 拆成多条 assistant 导致 11148 | 已验证 | [CHG-0008](../exec-plans/active/CHG-0008-responses-parallel-tool-calls.md) |
| CHG-0009 | 过滤竞品客户端 system preamble，修复 CodeBuddy 400 Request blocked | 已验证 | [CHG-0009](../exec-plans/active/CHG-0009-codebuddy-system-sanitize.md) |
| CHG-0010 | 对齐同类 CodeBuddy 2API 项目：字段透传、空消息过滤、thinking 映射 | 已验证 | [CHG-0010](../exec-plans/active/CHG-0010-codebuddy-peer-audit.md) |
| CHG-0011 | CodeBuddy prompt cache_control 与未知模型 404 | 已验证 | [CHG-0011](../exec-plans/active/CHG-0011-codebuddy-cache-and-model-404.md) |
| CHG-0012 | 评审修复：协议层作用域、max tokens 互斥、cache 策略、空值过滤 | 已验证 | [CHG-0012](../exec-plans/active/CHG-0012-review-fixes-2.md) |
| CHG-0013 | 剥离客户端计费指纹头 `x-anthropic-billing-header`，修复 Claude Code 400 | 已验证 | [CHG-0013](../exec-plans/active/CHG-0013-codebuddy-billing-header.md) |
| CHG-0014 | 评审修复：计费头清理范围最小化，不改变其他 system 内容 | 已验证 | [CHG-0014](../exec-plans/active/CHG-0014-codebuddy-billing-header-scope.md) |
| 2026-11-22-codex-cli-preamble | 替换 Codex CLI 自述首句，修复 Codex 会话 400（11128） | 进行中 | [2026-11-22-codex-cli-preamble](../exec-plans/active/2026-11-22-codex-cli-preamble.md) |
| 2026-11-22-codebuddy-sanitize-whitespace | 兼容 Claude Code preamble 的空白/撇号变体 | 进行中 | [2026-11-22-codebuddy-sanitize-whitespace](../exec-plans/active/2026-11-22-codebuddy-sanitize-whitespace.md) |
| 2026-11-22-codebuddy-claude-feedback-line | 清理 Claude Code 反馈链接行，修复 Claude Desktop 400 | 进行中 | [2026-11-22-codebuddy-claude-feedback-line](../exec-plans/active/2026-11-22-codebuddy-claude-feedback-line.md) |
| 2026-11-23-usage-field-semantics | 修复三协议 usage 字段语义（Anthropic / Chat / Responses） | 进行中 | [2026-11-23-usage-field-semantics](../exec-plans/active/2026-11-23-usage-field-semantics.md) |
| 2026-11-24-anthropic-tool-assembly | 修复 Anthropic 消息组装：图片丢失、工具调用拆分、静默空回答（R40–R43） | 进行中 | [2026-11-24-anthropic-tool-assembly](../exec-plans/active/2026-11-24-anthropic-tool-assembly.md) |
| 2026-11-24-e2e-conformance-suite | 实弹 e2e 相似度矩阵与基线（测试基础设施，暴露的缺口另开分支修复） | 已验证（未合并） | [2026-11-24-e2e-conformance-suite](../exec-plans/active/2026-11-24-e2e-conformance-suite.md) |

## 11. 链接

- 技术方案：[RFC-0001](../design-docs/rfcs/codebuddy-agent-simulation.md)
- 先例：[codearts protocol-spec](../../src/providers/codearts/protocol-spec.md)（同一套「协议直连 + 全头模拟」方法论）
- 本机证据：CodeBuddy CN 扩展日志 `~/Library/Application Support/CodeBuddyExtension/Logs/CodeBuddyIDE/2026-11-20/playground__*.log`；扩展 bundle `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/`（`product.json`、`out/extension/index.js`）
- 相关文档：any2api [README](../../README.md)
