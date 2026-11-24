# 生成物索引（any2api）

本目录只放可再生的快照或报表；不要手改内容，变更请改来源并重新生成。

| 生成物 | 来源 | 再生成命令 | 说明 |
|---|---|---|---|
| [e2e-baseline.md](e2e-baseline.md) | 实弹 e2e 相似度矩阵 | `E2E_MAX_CALLS=60 bun run e2e --baseline` | 2026-11-24 基线：32 pass / 17 fail / 4 not-supported / 4 skipped；缺陷清单见 [exec-plan](../exec-plans/active/2026-11-24-e2e-conformance-suite.md) |
