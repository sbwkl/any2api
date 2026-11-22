# CHG-0009 过滤竞品客户端 system preamble，修复 CodeBuddy 400 Request blocked

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/shared/system.ts`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`、`src/providers/codebuddy/envelope.ts`
功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
关联：[CHG-0008](CHG-0008-responses-parallel-tool-calls.md)

## 1. 摘要

CodeBuddy 后端会拦截包含竞品客户端标识的 system 提示词。实测 system 为
`You are Claude Code, Anthropic's official CLI for Claude.` 时返回
`400 {"error":{"message":"Request blocked. Please send it again"}}`。
Claude Desktop 的 system 提示词以这句话开头，因此经代理接入 CodeBuddy 时长会话直接被 400。

修复：代理在发送上游前，把这段已知 preamble 替换为中性句 `You are an AI coding assistant.`，保留其余系统内容。覆盖 Anthropic Messages、Responses 的 `instructions`、OpenAI Chat 的 system/developer 消息（codebuddy provider）。

## 2. 变更理由与证据

- **触发原因**：用户把 Claude Desktop 切到 CodeBuddy + DeepSeek，在 usage-ledger 项目报 `Request blocked. Please send it again`（400）。
- **实测对照**（本机，2026-11-21）：
  - system = `You are Claude Code, Anthropic's official CLI for Claude.` → **400 Request blocked**；
  - system = `You are Claude Code.` → 200；
  - system = `You are an AI assistant made by Anthropic.` → 200；
  - system = `You are a helpful assistant.` + tools → 200；
  - 无 system + tools → 200；
  - 原句替换为 `You are an AI coding assistant.` + tools → **200**。
- **结论**：触发点是这句完整的竞品客户端标识，不是工具、模型或用户内容。
- **不做的后果**：Claude Desktop 无法通过 codebuddy provider 使用；任何带该 preamble 的 system 都会被 400。

## 3. 行为 / AC delta

- **新增 R27**：When codebuddy 的 system/developer 消息包含已知竞品 preamble `You are Claude Code, Anthropic's official CLI for Claude.`, the system shall 在发送上游前将其替换为 `You are an AI coding assistant.`，并保留其余系统内容。
- **修改**：codebuddy 的 Anthropic/Responses/OpenAI Chat 三条入口都经过该过滤；codearts 不受影响。
- **不改变**：用户消息、工具调用、模型映射、流式/非流式行为。

## 4. 影响范围与非目标

**受影响**

- 新增 `src/shared/system.ts`。
- 修改 `src/providers/codebuddy/envelope.ts`（system/developer 消息）；共享协议层不做 provider 专属 sanitize（见 [CHG-0012](CHG-0012-review-fixes-2.md)）。
- 测试：`protocols.test.ts`、`envelope.test.ts`。
- 文档：REQ R27、本 CHG、README 已知限制。

**本次明确不做**

- 不做通用竞品提示词 denylist（只覆盖已实测的这句）；后续如出现新的拦截句，按需扩展。
- 不改 codearts；不改用户消息内容。
- 不尝试绕过其他风控（设备令牌、TLS 指纹等）。

## 5. 验证与观测

- 单元测试：
  - Anthropic system / Responses instructions 的 preamble 被替换；
  - codebuddy `normalizeMessages` 的 system 消息被替换；
  - 不含该 preamble 的 system 不受影响。
- `bun test` → **93 pass / 0 fail / 329 expect() calls**（13 个测试文件）。
- 真实上游 e2e：用被拦截的原始 system + tools 通过 facade 调用 → **200**，返回 `OK`。
- `bun build src/index.ts --target=bun` → 成功。
- 临时集成分支全量测试：见 §9。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：移除 `src/shared/system.ts` 及三处调用；恢复 system 原文透传。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：被拦截请求重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 后端可能拦截其他竞品/敏感 preamble | 仍可能 400 | 当前只覆盖实测句；出现新拦截时扩展正则（或改为整体替换 system） |
| 用户故意发送该句 | 被替换 | 代理面向 CodeBuddy；保留其余系统内容，语义影响很小 |
| 其他 provider（codearts） | 不受影响 | 只在 codebuddy 路径过滤 |
| 非 system 消息包含该句 | 不处理 | 实测触发点是 system；如出现再扩展 |

## 8. 关联与证据

- 用户报告：Claude Desktop + CodeBuddy + DeepSeek，`Request blocked. Please send it again`（400）。
- 实测对照：见 §2。
- 功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
- 代码：`src/shared/system.ts`
- 测试：`src/protocols/protocols.test.ts`、`src/providers/codebuddy/envelope.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | system preamble 过滤；93 tests；真实上游 e2e 200；未部署 |
