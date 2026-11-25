# AGENTS.md

本目录是 `any2api`——把各 AI 编程工具的私有 LLM 通道封装为 OpenAI 兼容 API。

## 硬性规则

1. 历史 `REQ-xxxx` / `CHG-xxxx` / `ADR-xxxx` / `RFC-xxxx` 编号冻结；新增文档使用语义化主题路径，不维护「下一批 ID」。
1. `main` 是保护分支；任何合并进 `main` 都必须先征得用户同意。新特性走 `feat/<特性名>`，脏工作区用 worktree，集成测试用临时分支。
1. 不臆造指标、证据、用户反馈或当前实现；没有数据写「待验证 / 待补」并列为风险。
1. 对话与文档用中文。

## 文档地图

| 文档 | 内容 | 何时读 |
|---|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | 当前实现总图；暂无事实写「待补」 | 了解整体结构、排障、审计时 |
| [`README.md`](README.md) | 项目定位、开发约定与门禁 | 首次了解项目、开发前核对约定时 |
| [`docs/DESIGN.md`](docs/DESIGN.md) 及相邻领域宪章 | 设计、前端、计划、产品感知、质量、可靠性、安全 | 对应领域沉淀与评审时 |
| [`docs/design-docs/index.md`](docs/design-docs/index.md) | 设计知识库状态索引与当前事实源指针 | 理解设计理由、查 ADR / RFC、追溯历史时 |
| [`docs/product-specs/index.md`](docs/product-specs/index.md) | 产品行为规格索引 | 产品 / 需求、评审、开始新特性前 |
| [`docs/exec-plans/completed/`](docs/exec-plans/completed/) | 已验证变更记录 | 开发 / 评审时读本次变更 |
| [`docs/exec-plans/active/`](docs/exec-plans/active/) | 进行中变更 | 推进阶段实现时 |
| [`docs/references/index.md`](docs/references/index.md) | 调研与实测证据 | 查选型证据 / 数据边界时 |
| [`docs/generated/index.md`](docs/generated/index.md) | 生成物索引 | 查看 / 核对生成物时 |

## 常用命令

- 门禁：`bun run check` = `bun test` + `bun build src/index.ts --target=bun` + `tsc --noEmit` + `bun scripts/check-docs-links.ts`（单项可拆开跑）
- 本机 PATH 无 bun 时：`~/.bun/bin/bun`
- 文档结构与本地链接检查：已配置，`bun scripts/check-docs-links.ts`（已并入 `bun run check`）

## Agent skills

### Issue tracker

GitHub Issues（`sbwkl/any2api`，`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个默认 triage 标签，字符串即角色名。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/design-docs/adr/`（本项目约定的 ADR 目录）。见 `docs/agents/domain.md`。
