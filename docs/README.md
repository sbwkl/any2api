# any2api 文档索引

需求管理约定见工作区根目录 [AGENTS.md](../../AGENTS.md)「需求管理」章节。四类文档分目录存放，ID 在文档首部。

## 功能卡（requirements）

| ID | 标题 | 状态 |
|---|---|---|
| [REQ-0001](requirements/REQ-0001-codebuddy-provider.md) | CodeBuddy provider（CodeBuddy CN → OpenAI 兼容 API） | 活跃 |

## 变更文档（changes）

| ID | 标题 | 状态 | 功能卡 |
|---|---|---|---|
| [CHG-0001](changes/CHG-0001-codebuddy-provider-initial.md) | CodeBuddy provider 初始实现（传输 + 信封仿真 + OpenAI Chat） | 开发中 | REQ-0001 |
| [CHG-0002](changes/CHG-0002-codebuddy-protocol-adapters.md) | CodeBuddy 协议适配层（Anthropic Messages + Responses）、旁路信号与模型目录 | 开发中 | REQ-0001 |
| [CHG-0003](changes/CHG-0003-provider-registry-protocols.md) | any2api provider 注册表与共享协议层 | 开发中 | REQ-0001 |
| [CHG-0004](changes/CHG-0004-codebuddy-queue.md) | CodeBuddy 排队协议与限流错误映射 | 开发中 | REQ-0001 |
| [CHG-0005](changes/CHG-0005-review-fixes.md) | 评审修复：错误边界、空流、类型校验、normalizeErrors、共享 SSE、前缀校验 | 开发中 | REQ-0001 |
| [CHG-0006](changes/CHG-0006-unify-prefixes.md) | 统一 provider 前缀为 `/<name>/v1` | 开发中 | REQ-0001 |

## RFC（rfcs）

| ID | 标题 | 状态 |
|---|---|---|
| [RFC-0001](rfcs/RFC-0001-codebuddy-agent-simulation.md) | CodeBuddy Agent 行为仿真与 API 化方案 | 草案 |

## ADR（adr）

暂无。