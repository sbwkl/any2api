# 设计文档索引（any2api）

本目录是 `any2api` 的**设计知识库**：收录当前仍有效的设计、架构决策、RFC、历史与核心工程信念。它服务于 agent 的渐进披露：[`AGENTS.md`](../../AGENTS.md) 是地图，[`ARCHITECTURE.md`](../../ARCHITECTURE.md) 是当前实现总图，[`docs/product-specs/index.md`](../product-specs/index.md) 是产品行为事实源；本索引说明「为什么这样设计、哪些结论仍有效、哪些已被替代」。

## 状态说明

| 状态 | 含义 |
|---|---|
| current | 当前有效，已与产品规格 / 架构 / 代码核对 |
| partial | 部分有效；头部必须同时包含 `superseded_by` 与「当前事实源」指针 |
| historical | 历史记录，不作为当前事实或验收标准 |
| proposed | 提案 / RFC，尚未接受 |

## 当前事实源

| 文档 | 领域 | 状态 | 当前事实源 / 代码入口 |
|---|---|---|---|
| [`../product-specs/index.md`](../product-specs/index.md) | 产品行为 | current | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) |
| [`../references/index.md`](../references/index.md) | 调研 / 实测 | current | 仅作证据，不替代当前 AC |
| [`../exec-plans/completed/`](../exec-plans/completed) | 变更追溯 | historical | [`2026-11-22-align-doc-knowledge-base.md`](../exec-plans/completed/2026-11-22-align-doc-knowledge-base.md) |

## 架构决策 ADR

- [`adr/codearts-l3-decrypted-plaintext.md`](adr/codearts-l3-decrypted-plaintext.md) — CodeArts L3 默认记录解密后的明文响应（accepted）。
- [`adr/codebuddy-credential-lazy-reload.md`](adr/codebuddy-credential-lazy-reload.md) — CodeBuddy 凭证按需惰性回源、免重启自愈（accepted）。
- [`adr/`](adr/) — 难回退决策按主题新建，不分配顺序编号。

## RFC

- [`rfcs/README.md`](rfcs/README.md) — RFC 触发条件与模板。
- [`rfcs/codebuddy-agent-simulation.md`](rfcs/codebuddy-agent-simulation.md) — CodeBuddy Agent 行为仿真与 API 化方案（proposed；原 RFC-0001）。

## 源设计与历史

- [`source-designs/`](source-designs/) — 当前源设计仍保留在代码附近的 `../../../src/providers/*/protocol-spec.md`；本目录暂无独立副本。
- [`history/`](history/) — 暂无已登记历史设计稿。

## 更新规则

- 新增设计文档必须在本索引登记状态、领域、当前事实源与代码入口。
- `partial` 文档头部同时写 `superseded_by` 与「当前事实源」；`historical` 文档不得作为验收标准。
- 当前产品行为以产品规格为准，当前实现以 [`ARCHITECTURE.md`](../../ARCHITECTURE.md) 为准。
