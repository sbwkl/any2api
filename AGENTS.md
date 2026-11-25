# AGENTS.md — any2api 项目工作区地图

本目录是 `any2api`——把各 AI 编程工具的私有 LLM 通道封装为 OpenAI 兼容 API。**本文件只是地图**：目录结构、硬性规则摘要、文档指针；跨项目规则见 [工作区根 AGENTS.md](../AGENTS.md)。当前实现见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，项目说明与开发约定见 [`README.md`](README.md)，产品行为事实源见 [`docs/product-specs/index.md`](docs/product-specs/index.md)，设计知识库见 [`docs/design-docs/index.md`](docs/design-docs/index.md)；聊天 / issue / PR 只做同步。

## 目录结构

- `AGENTS.md` — 本文件：地图与指针。
- `ARCHITECTURE.md` — As-Built 架构；暂无事实写「待补」。
- `README.md` — 项目定位、开发约定、测试与静态检查命令。
- `docs/design-docs/` — 索引化设计知识库：`index.md`、`core-beliefs.md`、`adr/`、`rfcs/`、`source-designs/`、`history/`。
- `docs/exec-plans/` — 变更与计划：`active/`、`completed/`、`tech-debt-tracker.md`。
- `docs/generated/` — 生成物快照或索引；不手改可再生内容。
- `docs/product-specs/` — 当前产品行为与验收事实源。
- `docs/references/` — 调研、实测、外部参考证据。
- `docs/agents/` — 工程技能配置：issue tracker、triage 标签、领域文档消费规则。
- 项目入口：`src/index.ts`。CodeBuddy / CodeArts provider 与共享协议层；历史 REQ / CHG / RFC 文档已按目录语义迁移。

## 硬性规则（永远生效）

1. 文档是事实源；`AGENTS.md` 只是地图。状态以文档首部为准，没有验证 / 部署证据不得标「已验证 / 已发布」。
2. `docs/` 顶层目录只允许 `design-docs`、`exec-plans`、`generated`、`product-specs`、`references`、`agents`；领域宪章放 `docs/*.md`。
3. 历史 `REQ-xxxx` / `CHG-xxxx` / `ADR-xxxx` / `RFC-xxxx` 编号冻结；新增文档使用语义化主题路径，不维护「下一批 ID」。
4. `main` 是保护分支；任何合并进 `main` 都必须先征得用户同意。新特性走 `feat/<特性名>`，脏工作区用 worktree，集成测试用临时分支。
5. 不臆造指标、证据、用户反馈或当前实现；没有数据写「待验证 / 待补」并列为风险。
6. 对话与文档用中文。

## 开发流程

按 [工作区根 AGENTS.md](../AGENTS.md) 的完整流程执行：从最新 `main` 切分支、TDD、提交前静态检查、临时集成分支、PR 或纯本地提交记录、合并前征求用户同意。文档结构变更同样先写失败的结构 / 链接检查。

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

- 测试：`bun test`
- 编译 / 构建 / 静态检查：`bun build src/index.ts --target=bun`
- 文档结构与本地链接检查：见工作区根变更文档中的验证命令；未配置项目级检查时写「未配置；待补」。

## Agent skills

### Issue tracker

GitHub Issues（`sbwkl/any2api`，`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个默认 triage 标签，字符串即角色名。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文：根目录 `GLOSSARY.md` + `docs/design-docs/adr/`（本项目约定的 ADR 目录）。见 `docs/agents/domain.md`。
