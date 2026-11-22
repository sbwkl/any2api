# any2api 架构文档（As-Built）

## 0. 结论摘要

把各 AI 编程工具的私有 LLM 通道封装为 OpenAI 兼容 API。本文件是项目当前实现总图的事实源占位；已确认的入口为 `src/index.ts`。CodeBuddy / CodeArts provider 与共享协议层；历史 REQ / CHG / RFC 文档已按目录语义迁移。

## 1. 系统定位与边界

- 项目类型：活跃代码项目。
- 已知入口：`src/index.ts`。
- 当前产品规格：[`docs/product-specs/index.md`](docs/product-specs/index.md)。
- 设计理由与历史：[`docs/design-docs/index.md`](docs/design-docs/index.md)。
- 参考证据：[`docs/references/index.md`](docs/references/index.md)。

## 2. 已知事实

| 项 | 当前事实 | 证据 / 指针 |
|---|---|---|
| 项目定位 | 把各 AI 编程工具的私有 LLM 通道封装为 OpenAI 兼容 API | [`README.md`](README.md) |
| 文档结构 | 与 usage-ledger 最终知识库结构一致 | [`AGENTS.md`](AGENTS.md) |
| 测试 / 构建 | `bun test` / `bun build src/index.ts --target=bun` | [`README.md`](README.md) |

## 3. 待补与风险

- 运行时模块、数据流、外部依赖与部署拓扑尚未在本文件登记；发现后更新本文件并在独立变更文档写证据，不得臆造。
- 没有部署 / 监控证据，不宣称「已发布」。
- 需要跨团队、不可逆或影响公共接口的方案时，先在 [`docs/design-docs/rfcs/`](docs/design-docs/rfcs/) 建 RFC。

## 4. 变更追溯

- 本次结构对齐：[`docs/exec-plans/completed/2026-11-22-align-doc-knowledge-base.md`](docs/exec-plans/completed/2026-11-22-align-doc-knowledge-base.md)
