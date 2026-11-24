# 官方接口条款清单（e2e 一致性参照）

本目录是实弹 e2e 一致性测试的参照系：只收录矩阵实际断言用到的条款，不是完整规范。测试用例以降级 ID（`OAI-CHAT-*` / `OAI-RESP-*` / `ANT-MSG-*`）引用这里的条目。

## 证据来源

官方 API 文档站点在本机网络不可达（OpenAI 403、Anthropic TLS 失败），条款以第一方源码仓库的机器可读定义为准：

| 来源 | 版本快照 | 用途 |
|---|---|---|
| [openai/openai-openapi](https://github.com/openai/openai-openapi/blob/master/openapi.yaml) | 2026-11-24 拉取，4,334,991 B | OpenAI Chat Completions / Responses 的 schema、枚举、usage 与错误体 |
| [anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) | 2026-11-24 拉取，250,706 B | Anthropic Messages 的请求/响应/内容块/usage/stop_reason 类型 |
| 同仓库 `src/lib/MessageStream.ts`、`src/core/error.ts` | 27,352 B / 9,239 B | Anthropic 流式事件类型与 APIError 错误体解析 |
| [OpenAI Chat API 文档](https://platform.openai.com/docs/api-reference/chat) / [Responses 文档](https://platform.openai.com/docs/api-reference/responses) / [Anthropic Messages 文档](https://docs.claude.com/en/api/messages) | 人工阅读入口 | 上述仓库未覆盖的语义说明 |

以 `openapi.yaml` 的 schema/property 路径与 SDK 的 TS 类型作为「官方契约」证据；人工文档只作补充，不作为机器断言依据。

## 文档

- [openai-chat-completions.md](openai-chat-completions.md)
- [openai-responses.md](openai-responses.md)
- [anthropic-messages.md](anthropic-messages.md)

## 约定

- 条款 ID 只增不改；语义需要调整时新增条款并标注替代关系。
- 「必须」= 官方 schema 中的 required / 枚举 / 事件序列；「应当」= 官方描述要求但 schema 未强制的语义。
- 矩阵中的 `not-supported` 期望必须引用一条具体条款，说明官方行为是什么。
