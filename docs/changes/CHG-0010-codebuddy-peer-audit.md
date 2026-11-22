# CHG-0010 对齐同类 CodeBuddy 2API 项目：字段透传、空消息过滤、thinking 映射

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/providers/codebuddy/envelope.ts`、`src/providers/codebuddy/config.ts`、`src/providers/codebuddy/openai.ts`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0009](CHG-0009-codebuddy-system-sanitize.md)

## 1. 摘要

对照同类 CodeBuddy 2API 项目（主要参考 `orangeboyChen/codebuddy2api`，其 README 自述是 `Sliverkiss/CodeBuddy2api` 的重构；另读了 `Sliverkiss/CodeBuddy2api` 的 proxy 结构），修复三个可确定的差距：

1. **OpenAI 可选字段未透传**：`frequency_penalty`、`presence_penalty`、`stop`、`seed`、`response_format`、`parallel_tool_calls`、`stream_options`、`metadata`、`store`、`user`、`service_tier`、`max_completion_tokens` 之前被丢弃。
2. **Anthropic `thinking` 未映射**：Claude Desktop 的 `thinking.budget_tokens` 之前被忽略，未转成 `reasoning_effort`。
3. **空消息未过滤**：既无 `content` 也无 `tool_calls` 的消息会原样发给上游，可能触发 400。

同时把模型 `reasoning.supportedEfforts` 纳入 `ModelInfo`，对 `reasoning_effort` 做就近钳制（避免给只支持 `high` 的模型发送 `low`）。

## 2. 同类项目对照

**参考项目**

- `orangeboyChen/codebuddy2api`（Next.js + TypeScript）：`lib/server/proxy/codebuddy/upstream.ts` 的 `buildUpstreamBody` 透传 OpenAI 字段；`lib/server/shared/thinking-effort.ts` 把 Anthropic/Chat/Responses 的 thinking 词表归一到 `reasoning_effort`；`lib/server/proxy/codebuddy/upstream.ts` 的 `normalizeMessages` 过滤空消息。
- `Sliverkiss/CodeBuddy2api`：Next.js 结构，`app/v1/*/route.ts` 的协议路由；用于确认协议面与路由组织，不直接复用代码。
- 其他检索到的项目（`XuanBoWu/codebuddy2api`、`koazy0/codebuddy2api`）因克隆/时间与相关性只做了目录级确认，未逐行读取。

**对照结论**

| 项 | 同类项目 | 我们（修复前） | 处理 |
|---|---|---|---|
| OpenAI 可选字段 | 透传 | 丢弃 | **已修复**（R28） |
| Anthropic thinking | 归一为 reasoning_effort | 忽略 | **已修复**（R29） |
| 空消息 | 过滤 | 保留 | **已修复**（R30） |
| 模型 supportedEfforts | 用于钳制 effort | 未保存 | **已修复** |
| prompt cache_control | 自动给 system/最后一条 user 加 `cache_control` | Anthropic 适配器丢弃 | **已实现（CHG-0011）** |
| 请求头 | CLI 身份 + `X-Requested-With`/`Origin`/`Referer`/`x-stainless-*` | IDE 身份，无 stainless | **待审核** |
| Token 刷新 | 未看到 refresh 端点（登录态为主） | `/v2/plugin/auth/token/refresh` | **待审核**（写回 IDE Keychain 未实现） |
| 模型校验 | 按 credential supported models 校验 | 未知模型透传上游 | **已实现（CHG-0011）** |
| 排队/遥测/图片 | 部分支持 | 未实现/透传 | 非本轮范围 |

## 3. 行为 / AC delta

- **新增 R28**：When 客户端提供 OpenAI 可选字段（`frequency_penalty`、`presence_penalty`、`stop`、`seed`、`response_format`、`parallel_tool_calls`、`stream_options`、`metadata`、`store`、`user`、`service_tier`、`max_completion_tokens`）, the system shall 在模型支持范围内透传，不得静默丢弃。
- **新增 R29**：When Anthropic 请求包含 `thinking`, the system shall 将其映射为 `reasoning_effort`（`budget_tokens` ≤2048 → minimal，≤8192 → medium，否则 high；`disabled/off` → off），并按模型 `reasoning.supportedEfforts` 就近钳制。
- **新增 R30**：The system shall 丢弃既无 `content` 也无 `tool_calls` 的空消息，避免上游把它当成损坏的 tool_calls/tool-result 序列。
- **修改**：`ModelInfo` 增加 `supportedEfforts`；`buildRequestBody` 增加字段透传与 effort 钳制；`normalizeMessages` 过滤空消息。

## 4. 影响范围与非目标

**受影响**

- `src/providers/codebuddy/envelope.ts`：字段透传、effort 钳制、空消息过滤。
- `src/providers/codebuddy/config.ts`：模型 `supportedEfforts`。
- `src/providers/codebuddy/openai.ts`：从入参读取新字段并传给 `buildRequestBody`。
- `src/protocols/anthropic.ts`：`thinking` → `reasoning_effort`。
- `src/protocols/responses.ts`：`parallel_tool_calls` / `metadata` 透传。
- 测试：`envelope.test.ts`、`anthropic.test.ts`、`responses.test.ts`。
- 文档：REQ R28-R30、本 CHG、docs/README。

**本次明确不做**

- prompt `cache_control` 自动注入（待审核）。
- 请求头扩展（`X-Requested-With`/`Origin`/`Referer`/`x-stainless-*`，待审核）。
- Token 刷新写回 IDE Keychain（待审核）。
- 模型预校验、排队、遥测、图片、内置工具 schema。

## 5. 验证与观测

- `bun test` → **98 pass / 0 fail / 352 expect() calls**（13 个测试文件）。
- 新增测试：
  - `buildRequestBody` 透传 12 个 OpenAI 字段；
  - `reasoning_effort` 按 `supportedEfforts` 钳制（minimal → high；off → low）；
  - `normalizeMessages` 丢弃空消息；
  - Anthropic thinking 分档（1024→minimal、4096→medium、10000→high、disabled→off）；
  - Responses `parallel_tool_calls` / `metadata` 透传。
- `bun build src/index.ts --target=bun` → 成功。
- 临时集成分支全量测试：见 §9。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：`git revert` 本变更；恢复字段丢弃、空消息保留、thinking 忽略。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：98 tests 回退；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 透传字段可能触发上游不支持的参数 | 400 | 只透传客户端显式提供的字段；未知字段由上游校验；错误可诊断 |
| effort 钳制可能改变客户端意图 | 模型只支持 high 时 low 被提升 | 与 IDE 行为一致；客户端可看到实际 effort |
| 空消息过滤可能丢弃合法空 assistant | 上下文变化 | 只丢弃既无 content 也无 tool_calls 的消息；空字符串 content 保留 |
| 同类项目未逐行读完 | 可能遗漏其他可借鉴点 | 本轮只修可确定项；剩余列在 §2 待审核 |

## 8. 关联与证据

- 参考项目：`orangeboyChen/codebuddy2api`（`lib/server/proxy/codebuddy/upstream.ts`、`lib/server/shared/thinking-effort.ts`）、`Sliverkiss/CodeBuddy2api`。
- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 代码：`src/providers/codebuddy/envelope.ts`、`config.ts`、`openai.ts`、`src/protocols/anthropic.ts`、`responses.ts`
- 测试：`envelope.test.ts`、`anthropic.test.ts`、`responses.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 字段透传 + effort 钳制 + 空消息过滤；98 tests 全绿；未部署 |