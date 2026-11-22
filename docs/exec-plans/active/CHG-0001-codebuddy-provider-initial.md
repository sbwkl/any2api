# CHG-0001 CodeBuddy provider 初始实现（传输 + 信封仿真 + OpenAI Chat）

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/providers/codebuddy/`、`src/index.ts`
功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
关联：[RFC-0001](../../design-docs/rfcs/codebuddy-agent-simulation.md)

## 1. 摘要

新增 `codebuddy` provider：从本机 CodeBuddy CN 提取凭证，发现模型池，把 OpenAI Chat 请求映射为 `POST https://copilot.tencent.com/v2/chat/completions` 的 gzip 请求，并按 RFC-0001 的「信封仿真」规则注入 IDE 提示词、工具 schema、ID 体系与请求头。首版只交付 `/v1/chat/completions` + `/v1/models`（CodeBuddy 路径前缀），不改动 codearts provider。

## 2. 变更理由与证据

- **对应功能卡的问题/目标**：REQ-0001 G1/G2/G3；解决「只能在 IDE 内使用 CodeBuddy」的问题。
- **触发原因**：用户 2026-11-20 要求实现 CodeBuddy 的 API 化，并优先保证 Agent 行为拟真。
- **证据（本机实测，2026-11-20）**：
  - 上游：`POST https://copilot.tencent.com/v2/chat/completions`，请求体 gzip（扩展日志 `[CustomFetch] enableRequestBodyGzip: true`）。
  - Agent 循环：`onAgentStart: agent=craft mode=craft conversationId=<32hex> requestId=<32hex>` → `onStepStart stepCount=1..N` → 每 step 一次 chat 请求 → `Step execution metrics: step=..., usage={...}`。
  - 鉴权：`Authorization` bearer + `X-User-Id`；token 在 macOS Keychain `CodeBuddy CN Safe Storage`（storageKey `planning-genie.new.accessTokencn`）。
  - 模型元数据由服务端下发（`CraftInvokableAgent ... model: {...}`，含 `contextWindow`、`toolMode: "code_mode"`、`reasoning` 等）。
  - 扩展版本：genie 3.10.0（`coding-copilot`）。
- **不做的后果**：REQ-0001 的目标无法达成，CodeBuddy 仍被锁在 IDE 内。

## 3. 行为 / AC delta

- **新增**：REQ-0001 的 R1、R2、R3、R4、R5、R6、R7、R8、R9、R10、R11 的首版实现。
- **修改**：`src/index.ts` 由「只启动 codearts」改为「按开关/注册表启动多个 provider」；默认行为不变（codearts 仍占 `/v1`）。
- **删除**：无。
- **延后**（不在本 CHG）：`/v1/messages`（Anthropic）、`/v1/responses`（OpenAI Responses）、遥测/消息中心仿真、TLS 指纹专项加固；分别建后续 CHG。

预期行为补充（可观察结果）：

- `GET /codebuddy/v1/models` 返回 CodeBuddy 模型池；`POST /codebuddy/v1/chat/completions` 支持流式/非流式与工具调用。
- `GET /healthz` 增加 provider 级健康信息（凭证是否可用、模型池来源）。
- 启动日志打印：凭证来源（Keychain/环境变量）、token 有效期（不打印 token）、模型池与 endpoint、生效的 profile。
- 上游 401 时自动刷新并重试一次；失败时返回可读错误。
- 日志与错误响应中不出现 token / Authorization 明文。

## 4. 影响范围与非目标

**受影响**

- 新增目录 `src/providers/codebuddy/`，建议文件（最终以实现为准）：
  - `index.ts`：provider 装配、凭证引导、路由注册。
  - `config.ts`：凭证提取（Keychain safeStorage / 环境变量覆盖）、模型发现、endpoint/profile 配置。
  - `client.ts`：传输层（头集合、gzip、SSE 读取、401 刷新重试、错误映射）。
  - `envelope.ts`：Agent 信封（profile 选择、提示词渲染、工具 schema 转换、消息展开）。
  - `ids.ts`：32 位 hex ID 生成与会话语义（可复用 `src/shared/ids.ts` 的随机源）。
  - `openai.ts`：OpenAI 门面（chat + models + SSE 聚合）。
  - `protocol-spec.md`：本 provider 的协议权威规格与拟真度检查单（对应 codearts 的同名文档）。
- 修改 `src/index.ts`：注册新 provider；保持 codearts 为默认 `/v1`，CodeBuddy 走 `/codebuddy/v1` 前缀（见 RFC-0001 §5.1）。
- 修改 `README.md`：provider 列表、CodeBuddy 使用方式、凭证说明、已知限制。
- 测试：新增 `src/providers/codebuddy/*.test.ts`（bun test）与本地 mock 上游集成测试。

**本次明确不做**

- 不在代理侧执行工具；不解析/改写工具结果。
- 不为 ask/craft profile 发送内置默认工具 schema（首版工具仅来自客户端 `tools`；profile 只影响系统提示词）。
- 不实现 Anthropic Messages / Responses 协议。
- 不实现 IDE 专属遥测（TracingService/Aegis）与消息中心以外的旁路信号；这些先写入 protocol-spec 的残余差异清单。
- 不做 TLS 指纹伪装（先接受 Bun 与 Electron 的差异，记录在案）。
- 不改动 codearts 的任何行为；不引入数据库或持久化状态（会话仅内存）。

## 5. 验证与观测

**自动化测试（bun test，TDD）**

- `ids.test.ts`：32 位小写 hex；会话内 conversationId 复用；每轮 requestId 新；每 step messageId 新。
- `envelope.test.ts`：按模型选择 craft/ask/chat 模板；占位符渲染；system 合并规则；OpenAI tools → CodeBuddy tools 映射与降级。
- `client.test.ts`：头集合快照；gzip 请求体可被解压还原；endpoint 拼接；401 → 刷新 → 重试一次；4xx/5xx 归一。
- `openai.test.ts`：SSE → OpenAI chunk（content/reasoning/tool_calls/usage）；非流式聚合；空流/坏帧处理。
- `config.test.ts`：模型发现成功/失败回退；凭证缺失时的错误信息；环境变量覆盖。
- `index.test.ts`（如可测）：`/codebuddy/v1/models`、`/healthz` 路由。

**集成/手工验证**

- 本地 mock 上游（bun 起一个 http server）回放一段真实 SSE，断言代理输出的 OpenAI chunk 与预期一致。
- `curl` 流式/非流式各一次；OpenAI SDK（Python/Node）各一次；工具调用往返一次。
- 拟真度 diff：代理请求 vs 真实 IDE 请求（头集合、body 字段、ID 格式）——用本地抓包（mitmproxy）或 mock 上游记录；结果写入 protocol-spec。
- 401 演练：人为让 token 过期（或 mock 401），确认刷新与重试路径。
- 稳定性：连续运行 7 天，记录非预期 401/403、协议错误、延迟。

**观测**

- 启动日志、每请求日志（不含 token）：provider、model、profile、step、上游状态码、耗时、usage。
- `/healthz`：凭证状态、模型池来源、上游可达性（可选）。
- 证据链接：测试结果、抓包 diff、7 天运行记录（实现后补）。
- 结果与证据（2026-11-20，本机）：
  - `bun test src/providers/codebuddy/` → **29 pass / 0 fail / 142 expect() calls**（6 个测试文件）。
  - `bun build src/index.ts --target=bun` → 成功（19 modules）。
  - 真实上游：非流式 → 200（content `OK`，含 usage）；流式 → 200 `text/event-stream`；工具调用 → `finish_reason: tool_calls`；craft profile → `prompt_tokens≈1550`。
  - 服务端：`/healthz` ok；`/codebuddy/healthz` ok（17 models，credentialSource=keychain）；`/codebuddy/v1/models` 返回 17 个；`/codebuddy/v1/chat/completions` 非流式/流式成功；codearts `/v1/chat/completions` 回归成功（`glm-5.3-flash`）。
  - 未做：7 天稳定性、真实 401 刷新演练、抓包 diff、Anthropic/Responses 适配。

## 6. 回滚方案

- **回滚方式**：从 `src/index.ts` 移除 CodeBuddy provider 注册，删除 `src/providers/codebuddy/`；codearts 与其他 provider 不受影响。
- **数据/配置兼容**：无数据库、无持久化会话；回滚不清理任何用户数据。
- **回滚验证**：`GET /v1/models` 仍返回 codearts 模型池；`/codebuddy/v1/*` 返回 404；服务正常启动。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 研究报告未随需求提供（见 §8） | 头集合、body schema、token 续期、模型目录 API 可能存在未确认项 | 以本机 bundle/日志实测为准；未确认项在 protocol-spec 标注「待验证」，不写入实现假设 |
| Keychain 授权 | 提取 token 可能弹出 Keychain 授权；无权限时服务不可用 | 支持环境变量注入 token/uid 作为兜底；启动时给出明确指引 |
| Token 续期机制未知 | 过期后可能无法自动续期 | 首版至少支持手动更新 Keychain/环境变量；续期流程作为未决问题，找到后补 CHG |
| 工具 schema 与 OpenAI 不完全等价（`code_mode`） | 部分客户端工具调用失败 | RFC-0001 §5.5 定义映射与降级；测试覆盖常见客户端（Cline/Cherry Studio） |
| 多 provider 端口/路由冲突 | codearts 与 codebuddy 不能同时占 `/v1` | 采用路径前缀隔离（`/codebuddy/v1`），codearts 保持 `/v1` |
| 协议漂移 | CodeBuddy 升级导致请求被拒 | protocol-spec 记录扩展版本；建立 diff 脚本；升级后按需新 CHG |
| X-Device-Token（TuringShield） | 服务端未来可能强制校验 | 实测当前可省略；保留 `CODEBUDDY_DEVICE_TOKEN` 注入位；不伪造 SDK |
| 模型目录 | 云端模型列表来源 | 已从 `state.vscdb` 的 `cloud_product_config_cache` 读取（24 个，CHG-0002）；缺失时回退 product.json + agent models + 观测模型 |

## 8. 关联与证据

- 功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
- 技术方案：[RFC-0001](../../design-docs/rfcs/codebuddy-agent-simulation.md)
- 本机证据：扩展 bundle `/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie/`（`product.json`、`out/extension/index.js`）；日志 `~/Library/Application Support/CodeBuddyExtension/Logs/CodeBuddyIDE/2026-11-20/playground__*.log`。
- 待补：用户提到但未随消息提供的 CodeBuddy 研究报告——收到后与 RFC-0001 §9 的未决问题逐条对齐。
- issue / PR：暂无（本地仓库，无远程）。

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 提议 | wayne | 本 CHG + 本机实测证据（2026-11-20）；待用户审核 RFC-0001 后转「就绪」 |
| 开发中 | wayne | 首版实现：`config/ids/envelope/client/sse/openai/index` + 6 个测试文件；29 tests 全绿；真实上游非流式/流式/工具调用/craft 实测成功；codearts 回归通过 |
