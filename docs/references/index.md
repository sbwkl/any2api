# 参考证据索引（any2api）

本目录只放调研、实测、外部材料指针或证据快照；当前产品行为以 [`../product-specs/index.md`](../product-specs/index.md) 为准，当前实现以 [`../../ARCHITECTURE.md`](../../ARCHITECTURE.md) 为准。

| 文档 | 类型 | 说明 |
|---|---|---|
| [official-api/](official-api/README.md) | 官方规范条款 | OpenAI Chat Completions / Responses、Anthropic Messages 的 e2e 参照条款；来源为第一方源码仓库，2026-11-24 快照 |
| [2026-11-25-server-tool-competitor-survey.md](2026-11-25-server-tool-competitor-survey.md) | 竞品调研 | 20 个同类「AI 编程工具通道转 API」项目/网关在 Anthropic /v1/messages 翻译层对服务端工具（web_search_* 等）与 tool_choice 悬空的处理方式；2026-11-25 快照 |
| [2026-11-25-tool-choice-official-semantics.md](2026-11-25-tool-choice-official-semantics.md) | 官方语义调研 | Anthropic / OpenAI 的 tool_choice 官方语义、服务端工具限制与当前一代模型 400 条款；来源为官方 GitHub 仓库快照（官方文档站本机不可达），2026-11-25 |
