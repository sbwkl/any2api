# any2api 升级为正式项目

| 项 | 内容 |
|---|---|
| 类型 | 变更文档 |
| 状态 | 已验证 |
| Owner | 工作区维护者 |
| 所属模块 / 入口 | `AGENTS.md`、`README.md`、`docs/`、`scripts/verify-doc-links.py` |
| 关联 | 无长期产品规格；仓库位置与文档地图调整 |

## 1. 摘要

把 `any2api` 从探索性工作区迁到上层目录并转为正式项目；修正项目文档中依赖 playground 根 `AGENTS.md` 的链接，使仓库可独立维护。

## 2. 变更理由与证据

- 用户要求把项目移动到上层目录，因为它已经升级为正式项目。
- 迁移前仓库位于 `playground/any2api`，文档多处引用工作区根 `AGENTS.md`；迁移到 `/Users/wayne/workspace/any2api` 后这些相对链接会失效。
- 失败检查：新增 `scripts/verify-doc-links.py` 首次运行发现 `docs/exec-plans/completed/2026-11-22-align-doc-knowledge-base.md` 的工作区根链接缺失。

## 3. AC delta

- 新增：正式项目当前路径为 `/Users/wayne/workspace/any2api`；项目开发流程以自身 `AGENTS.md` 与 `README.md` 为准。
- 新增：项目级可重复检查 `scripts/verify-doc-links.py`，验证 `docs/` 顶层结构与本地 Markdown 链接。
- 修改：历史变更文档中的工作区根链接改为项目内 `AGENTS.md`。
- 不变：运行时行为、公开接口、数据格式与既有产品验收标准。

## 4. 改动范围

- `AGENTS.md` / `README.md`：移除对工作区根 `AGENTS.md` 的开发流程依赖。
- `docs/exec-plans/completed/2026-11-22-align-doc-knowledge-base.md`：修正失效关联链接。
- `scripts/verify-doc-links.py`：新增结构与链接检查。
- 非目标：不新增产品规格，不发布版本，不合并 `main`，不修改运行时代码。

## 5. 验证

- 命令：`scripts/verify-doc-links.py`、`bun test`、`bun build src/index.ts --target=bun`。
- 环境：macOS，Asia/Shanghai，2026-11-22；Bun 与本机仓库 `/Users/wayne/workspace/any2api`。
- 结果：结构检查 0 issue，Markdown 本地链接 0 missing；`bun test` 120 pass / 0 fail / 402 expect() calls / 14 files；`bun build src/index.ts --target=bun --outdir .arts/build` 成功，26 modules / 131.75 KB。
- 通过 / 失败 / 跳过：测试 120 pass / 0 fail / 0 skip；构建 0 errors / 0 warnings；文档检查 0 failed / 0 skipped。
- 证据限制：变更在 `feat/promote-to-standalone` 分支验证，未合并 `main`，未部署，不标「已发布」。

## 6. 回滚

把仓库移回 `/Users/wayne/workspace/playground/any2api`，恢复三份文档的工作区根指针并删除检查脚本；无数据迁移。
