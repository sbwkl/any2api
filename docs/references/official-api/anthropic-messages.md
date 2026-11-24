# Anthropic Messages 条款清单

端点：`POST /v1/messages`；请求类型：`MessageCreateParamsBase`；响应：`Message`；流式：`RawMessageStreamEvent`。

| ID | 等级 | 条款 | 证据 |
|---|---|---|---|
| ANT-MSG-01 | 必须 | 请求体必含 `model`、`max_tokens`、`messages`；`system` 可为字符串或 text block 数组 | `MessageCreateParamsBase`（`messages.ts:7635`，`max_tokens` 非可选） |
| ANT-MSG-02 | 必须 | 内容块支持 `text`、`image`、`tool_use`、`tool_result`、`thinking` 等；`image.source` 三选一：`{type:"base64", media_type:"image/jpeg\|png\|gif\|webp", data}`、`{type:"url", url}`、`FileImageSource` | `ContentBlockParam`（`messages.ts:4799`）、`ImageBlockParam`（`:4945`）、`Base64ImageSource`（`:522`）、`URLImageSource`（`:6523`） |
| ANT-MSG-03 | 必须 | `tool_result.content` 可为字符串或块数组（含 text / image / document 等），并带 `tool_use_id`；`is_error` 表失败结果 | `ToolResultBlockParam`（`messages.ts:6202`） |
| ANT-MSG-04 | 应当 | 工具：`tools[]` + `tool_choice`（`auto` / `any` / `tool` / `none`）；模型输出 `tool_use` 块，`input` 为对象；流式以 `input_json_delta` 增量填充 | `MessageCreateParamsBase.tool_choice`（`messages.ts:7841`）；官方文档 |
| ANT-MSG-05 | 必须 | 非流式响应含 `id`、`type:"message"`、`role:"assistant"`、`model`、`content[]`、`stop_reason`、`usage`；`stop_reason` ∈ `end_turn\|max_tokens\|stop_sequence\|tool_use\|pause_turn\|refusal\|model_context_window_exceeded` | `StopReason`（`messages.ts:5632`） |
| ANT-MSG-06 | 必须 | 流式事件序列：`message_start` → `content_block_start` → `content_block_delta`* → `content_block_stop` → … → `message_delta` → `message_stop`；`message_start.message.stop_reason` 为 null，`message_delta` 携带最终 `stop_reason` 与 `usage` | `RawMessageStreamEvent`（`messages.ts:5441`）；`Message.stop_reason` 注释（`:5145`） |
| ANT-MSG-07 | 应当 | 文档定义 `ping` 与 `error` 流事件；SDK 的 `RawMessageStreamEvent` 只建模六类业务事件，`ping` 可选、`error` 在失败时必须使用 | [官方流式文档](https://docs.claude.com/en/api/streaming)；`MessageStream.ts` |
| ANT-MSG-08 | 必须 | `usage` 含 `input_tokens`、`output_tokens`；缓存分项 `cache_creation_input_tokens`、`cache_read_input_tokens`（可为 null）与 `cache_creation`、`output_tokens_details`、`server_tool_use` | `Usage`（`messages.ts:6535`） |
| ANT-MSG-09 | 必须 | 错误响应为 `{"type":"error","error":{"type":...,"message":...}}`；SDK 以 `body.error.type` / `body.error.message` 解析 | `core/error.ts`（`APIError` 构造，`:66-76`） |

## 备注

- 当前实现已知偏离：system 内图片被丢弃、`tool_result.is_error` 未映射、`thinking` 块无 `signature`、`message_start.usage` 恒 0 且无缓存分项——基线记 `fail` 或按条款注明 `not-supported`。
- `document` / `search_result` 等服务端块当前未实现；矩阵按「静默丢弃记 fail」处理。
- `model_context_window_exceeded` 是较新的 stop_reason，映射表需覆盖。
