# 清理 Claude Code 反馈链接行，修复 Claude Desktop 400

| 项 | 内容 |
|---|---|
| 类型 | 变更文档 |
| 状态 | 进行中 |
| Owner | wayne |
| 所属模块 / 入口 | `src/shared/system.ts` |
| 关联 | [产品规格：CodeBuddy provider](../../product-specs/codebuddy-provider.md)、[CHG-0009](CHG-0009-codebuddy-system-sanitize.md)、[Claude preamble 空白修复](2026-11-22-codebuddy-sanitize-whitespace.md) |

## 1. 摘要

Claude Desktop 新会话的真实 system prompt（`prompt_snapshot.systemPrompt`，16 段）中，第 3 段最后一行是：

```
- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues
```

该行单独发送即被 CodeBuddy 后端拦截：`400 {"error":{"message":"Request blocked. Please send it again"}}`。其余 15 段单独发送均为 200。

修复：`sanitizeSystemText` 增加规则，删除包含 `github.com/anthropics/claude-code` 的整行；其余 system 内容保留。

## 2. 变更理由与证据

- **复现**（本机，2026-11-22，live service）：
  - 从失败会话 `878df841-0eec-485c-ae5c-4068dc830460` 的 `prompt_snapshot.systemPrompt` 提取 16 段；
  - 完整 16 段 → **400 Request blocked**；
  - 逐段：仅 **block 2**（`# Doing tasks` 段）单独 → 400，其余 15 段 → 200；
  - block 2 按行：仅 **L14** `- To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues` → 400，其余 14 行 → 200；
  - 清理该行后，完整 16 段 → **200**。
- **结论**：触发点是反馈链接行（竞品产品 URL），不是 Claude Code 自述句、模型、工具或用户内容。
- **不做的后果**：Claude Desktop 在 usage-ledger/any2api 的会话持续 400；用户无法在 IDE 外使用 CodeBuddy。

## 3. 行为 / AC delta

- **新增 R36**：When codebuddy 的 system/developer 文本包含 Claude Code 反馈链接行（含 `github.com/anthropics/claude-code`）, the system shall 在发送上游前删除该行，并保留其余内容。
- **修改**：`sanitizeSystemText` 增加 `CLAUDE_CODE_FEEDBACK_LINE` 规则。
- **不改变**：Claude/Codex preamble 过滤、计费头清理、其余 system 内容。

## 4. 影响范围与非目标

**受影响**

- `src/shared/system.ts`。
- `src/shared/system.test.ts`：新增反馈链接行清理用例。
- 文档：本变更文档、产品规格 R36 / 变更索引。

**本次明确不做**

- 不做通用 URL/竞品链接 denylist；只删除包含 `github.com/anthropics/claude-code` 的行。
- 不改 Claude Desktop；不改 codearts；不改 Codex preamble。

## 5. 验证与观测

- 单测：`bun test` → **126 pass / 0 fail / 422 expect() calls**（15 个测试文件）。
- 真实上游 e2e：完整 16 段 system + 真实 user 消息 → **200**（修复前 400）。
- `bun build src/index.ts --target=bun` → 通过。
- 服务已用该分支重启；live 完整 system 200。

## 6. 回滚方案

- **回滚方式**：移除 `CLAUDE_CODE_FEEDBACK_LINE` 规则与测试；其余 sanitizer 不变。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：block 2 单独请求重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 其他反馈/文档 URL 变体 | 仍可能 400 | 目前只覆盖 `github.com/anthropics/claude-code`；出现新链接时扩展规则 |
| 误删用户 system 中引用该 URL 的行 | 该行不发送 | 仅删除该行；若用户自定义 system 依赖该 URL，可能影响该提示 |
| 其他 system 段/工具/用户内容触发 | 仍可能 400 | 本次逐段/逐行复现已排除其他段；如出现再按同样方式定位 |

## 8. 关联与证据

- 失败会话：`/Users/wayne/.claude/projects/-Users-wayne-workspace-any2api/878df841-0eec-485c-ae5c-4068dc830460.jsonl`（`prompt_snapshot` + 400 记录）。
- 产品规格：[CodeBuddy provider](../../product-specs/codebuddy-provider.md)
- 代码：`src/shared/system.ts`
- 测试：`src/shared/system.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 进行中 | wayne | 逐段/逐行复现定位到反馈链接行；126 tests；真实完整 system e2e 200；服务已用该分支重启 |