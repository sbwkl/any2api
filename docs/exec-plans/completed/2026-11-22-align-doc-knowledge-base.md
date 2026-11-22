# 对齐 usage-ledger 知识库文档结构（any2api）

| 项 | 内容 |
|---|---|
| 类型 | 变更文档 |
| 状态 | 已验证 |
| Owner | 工作区维护者 |
| 所属模块 / 入口 | `AGENTS.md`、`ARCHITECTURE.md`、`README.md`、`docs/` |
| 关联 | [产品规格索引](../../product-specs/index.md)、[设计知识库索引](../../design-docs/index.md)、[工作区根 AGENTS.md](../../../../AGENTS.md) |

## 1. 摘要

把 `any2api` 的文档结构对齐兄弟项目 `usage-ledger` 的最终知识库形态：新增项目地图与 As-Built 占位，建立五类 `docs/` 目录、领域宪章与索引，迁移既有文档并修正本地链接。无运行时代码改动。

## 2. 变更理由与证据

- 工作区根 `AGENTS.md` 已按 `../usage-ledger` git 历史改为知识库结构约定。
- 本项目原文档目录 / README 与统一结构不一致；CodeBuddy / CodeArts provider 与共享协议层；历史 REQ / CHG / RFC 文档已按目录语义迁移。

## 3. AC delta

- 新增：`AGENTS.md` 地图、`ARCHITECTURE.md`、README 文档地图、`docs/` 五类目录与领域宪章。
- 新增：历史编号冻结，新增文档用语义化主题路径；变更按状态放 `active/` / `completed/`。
- 不变：运行时代码、第三方技能资料、数据 / 输出文件；保护分支与合并审批流程。

## 4. 改动范围

- 新增 / 重写地图、架构占位、README 文档地图、设计知识库索引、产品规格索引、执行计划、生成物索引、参考证据索引。
- 迁移旧 `requirements/` / `changes/` / `rfcs/` 或散落报告到规范目录（按本项目实际情况）。
- 重写本地 Markdown 链接；外部链接不改。

## 5. 验证

- 命令：临时对齐脚本 `verify`（结构检查 + Markdown 本地链接检查）、`links`（仅链接检查）；`any2api` 额外执行 `bun test` 与 `bun build src/index.ts --target=bun`；git 子项目在 `tmp/integration-docs-knowledge-base` 临时分支复验。
- 环境：macOS，Asia/Shanghai，2026-11-22；Python 3（标准库），工作区 `/Users/wayne/workspace/playground`；`any2api` 使用本机 Bun。
- 结果：结构检查 0 issue；Markdown 本地链接 0 missing；`any2api` 的 `bun test` 118 pass / 0 fail / 400 expect() calls / 14 files，`bun build` 26 modules / 131.32 KB；`llm-local` 的 `python3 -m compileall -q .` 与 shell `-n` 通过；`wechat-miniprogram-group-research` 的 `node --check` 通过。无运行时代码改动，覆盖率与部署状态不适用。
- 通过 / 失败 / 跳过：文档检查 0 failed / 0 skipped；静态 / 语法检查 0 errors / 0 warnings；未配置项目级 lint / 类型检查的子项目写「未配置；待补」，没有用跳过规则压制告警。
- 证据限制：工作区根与非 git 子项目没有 commit；纯本地 git 仓库无远程，PR 跳过，变更保留在 `feat/docs-knowledge-base` 特性分支。未合并 `main`，未部署，状态保持「已验证」，不标「已发布」。

## 6. 回滚

按文件移动反向恢复并删除新增知识库文件；git 子项目回滚对应特性分支提交。无数据迁移，未合并 `main`。
