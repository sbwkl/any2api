# 生成物索引（any2api）

本目录只放可再生的快照或报表；不要手改内容，变更请改来源并重新生成。

| 生成物 | 来源 | 再生成命令 | 说明 |
|---|---|---|---|
| [e2e-baseline.html](e2e-baseline.html) | 实弹 e2e 相似度矩阵（人类可读） | `E2E_MAX_CALLS=60 E2E_RECORD=1 bun run e2e --baseline` | 2026-11-24 的 **28 场景快照**：32 pass / 17 fail / 4 not-supported / 4 skipped；早于 2026-11-25 新增的 `messages.usage.cache_semantics`（第 29 个场景），本次不重生成 |
| [e2e-baseline.json](e2e-baseline.json) | 实弹 e2e 相似度矩阵（机器可读） | 同上 | 同上，2026-11-24 的 28 场景快照；含入站请求、上游请求与响应原文（单条 ≤64KB）、判定元数据、`scenarioSet` 与 `coverage` |
| [e2e-baseline.md](e2e-baseline.md) | 基线入口 | 同上 | 同上，2026-11-24 的 28 场景快照；只含生成时间、预算、模型、场景集覆盖、汇总与 HTML/JSON 链接，不重复矩阵 |
