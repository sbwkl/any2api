# CHG-0008 修复 Responses 并行 function_call 被拆成多条 assistant 导致 11148

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/protocols/responses.ts`
功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
关联：[CHG-0007](CHG-0007-responses-null-content.md)

## 1. 摘要

Codex 一个回合可能返回**多个连续 `function_call` 项**（并行工具调用）。共享 Responses 转换器为每个项生成一条独立的 assistant 消息，导致 OpenAI chat 历史里出现「assistant(tool_call A) → assistant(tool_call B) → tool(A) → tool(B)」。CodeBuddy 后端按 OpenAI chat 语义校验，认为 A 的 tool_call 没有紧跟结果，返回 `code 11148 Incomplete tool records. Please start a new task`。

修复：**连续的 `function_call` 合并为一条 assistant 消息的 `tool_calls` 数组**，遇到 message / function_call_output 时再 flush；reasoning/未知项不打断分组。

## 2. 变更理由与证据

- **触发原因**：Codex 使用 codebuddy provider + `deepseek-v4.1-flash` 执行 code review 任务；一次回合调用两个 `exec_command`（并行），后端返回 11148。
- **证据**：
  - Codex 会话 `~/.codex/sessions/2026/11/21/rollout-...01a1fddb....jsonl`：`function_call` ×2（`call_00_rcgpvb1joaE8...`、`call_01_DSuVned7maZU...`）+ `function_call_output` ×2。
  - 旧转换器输出：assistant(tool_call 1)、assistant(tool_call 2)、tool(1)、tool(2)。
  - 修复后：assistant(tool_calls [1,2])、tool(1)、tool(2)。
  - 真实上游 e2e：`deepseek-v4.1-flash`，两个并行 `get_weather` + 两个结果 → **200**，最终回答包含 Paris/Berlin 天气。
- **不做的后果**：Codex 并行工具调用在 codebuddy/codearts 上都会间歇 11148；多步 Agent 任务不可用。

## 3. 行为 / AC delta

- **新增 R26**：When Responses `input` 含连续 `function_call` 项, the system shall 将其合并为一条 assistant 消息的 `tool_calls` 数组，并在对应 `function_call_output` 前 flush；`reasoning`/未知项不得打断该分组。
- **修改**：`inputItemsToMessages` 由「每个 function_call 一条 assistant」改为「连续 function_call 合并」。
- **不改变**：单个 function_call 的输出形态；message/function_call_output 的顺序语义；Anthropic/OpenAI Chat 适配。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/responses.ts`：`inputItemsToMessages`。
- `src/protocols/protocols.test.ts`：并行 function_call、reasoning 间隔、原有单调用/空 content 用例。
- 文档：REQ R26、本 CHG、docs/README。

**本次明确不做**

- 不执行工具、不校验工具结果内容。
- 不改变单 function_call 的行为。
- 不处理 `custom_tool_call`/`custom_tool_call_output`（Codex 当前用 function_call；如后续出现再补）。

## 5. 验证与观测

- `bun test` → **91 pass / 0 fail / 323 expect() calls**（13 个测试文件）。
- 新增测试：
  - 连续 function_call ×2 + outputs ×2 → 一条 assistant（tool_calls 2）+ 两条 tool；
  - 单个 function_call + output → 一条 assistant（tool_calls 1）+ 一条 tool（回归）；
  - reasoning 间隔在 function_call 之间 → 不拆分；
  - 原有 null content / 单调用行为保持。
- `bun build src/index.ts --target=bun` → 成功。
- 真实上游 e2e：`deepseek-v4.1-flash` + 并行 `get_weather` → **200**。
- 临时集成分支 `tmp/integration-codebuddy`（main + fix）→ **91 pass / 0 fail**，build 通过，已删除。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：恢复 `inputItemsToMessages` 为每个 function_call 一条 assistant；回滚测试。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：并行调用重新 11148；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 两个不同回合的 function_call 连续出现 | 被合并为一条 assistant | 真实 Responses 历史在 message/output 处有边界；同一回合的并行调用本就应该合并 |
| `custom_tool_call` 未处理 | 若 Codex 改用 custom tool，仍可能丢记录 | 首版 Codex 用 function_call；后续按实际流量补 |
| 合并后 assistant 无 content 字段 | 后端是否要求 content | 实测 200；OpenAI 允许 tool_calls-only assistant |
| 单 function_call 行为 | 不变 | 回归测试覆盖 |

## 8. 关联与证据

- 用户会话：`~/.codex/sessions/2026/11/21/rollout-2026-11-21T19-26-04-01a1fddb-36a8-7883-9176-f83099f84ea0.jsonl`
- 功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
- 前置：[CHG-0007](CHG-0007-responses-null-content.md)
- 代码：`src/protocols/responses.ts`
- 测试：`src/protocols/protocols.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 连续 function_call 合并；91 tests；真实上游 e2e 200；临时集成分支通过；未部署 |
