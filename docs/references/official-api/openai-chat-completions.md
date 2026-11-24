# OpenAI Chat Completions 条款清单

端点：`POST /v1/chat/completions`；schema 根：`CreateChatCompletionRequest` / `CreateChatCompletionResponse`。

| ID | 等级 | 条款 | 证据 |
|---|---|---|---|
| OAI-CHAT-01 | 必须 | 请求体为 JSON，至少包含 `model` 与 `messages`（`minItems: 1`） | `CreateChatCompletionRequest.properties.messages`、`model` |
| OAI-CHAT-02 | 必须 | `messages[].content` 可为字符串或 content part 数组；文本 part 为 `{type:"text",text}`；图片 part 为 `{type:"image_url",image_url:{url}}`，`url` 可为公网 URL **或** base64 data URL，`detail` ∈ `auto\|low\|high\|original` | `ChatCompletionRequestMessageContentPartText`、`ChatCompletionRequestMessageContentPartImage`（`openapi.yaml:44445`，`required: [type, image_url]`，`image_url.required: [url]`） |
| OAI-CHAT-03 | 应当 | 工具调用：请求 `tools[]`（`type:"function"`）+ 可选 `tool_choice`；响应 assistant 消息可带 `tool_calls[]`，后续以 `role:"tool"` + `tool_call_id` 回传结果；`finish_reason=tool_calls` | `CreateChatCompletionRequest.properties.tools` / `tool_choice`；`finish_reason` 枚举 |
| OAI-CHAT-04 | 应当 | 采样与格式参数：`max_tokens` / `max_completion_tokens`、`temperature`、`top_p`、`stop`、`seed`、`frequency_penalty`、`presence_penalty`、`parallel_tool_calls`、`response_format`（`text` / `json_object` / `json_schema`）、`stream`、`stream_options.include_usage` | `CreateChatCompletionRequest.properties.*` |
| OAI-CHAT-05 | 必须 | 非流式响应对象含 `id`、`object:"chat.completion"`、`created`、`model`、`choices[]`（`index`、`message`、`finish_reason`）与 `usage`；`finish_reason` ∈ `stop\|length\|tool_calls\|content_filter\|function_call` | `CreateChatCompletionResponse`（`openapi.yaml:46500`，`finish_reason` 枚举 `:46538`） |
| OAI-CHAT-06 | 必须 | 流式响应为 SSE：每帧 `data: <chunk JSON>`，chunk `object:"chat.completion.chunk"`、`choices[].delta`；流以 `data: [DONE]` 结束；`usage` 仅在 `stream_options.include_usage=true` 时出现于结束前最后一帧 | `CreateChatCompletionStreamResponse`；官方流式文档（人工入口） |
| OAI-CHAT-07 | 必须 | `usage` 含 `prompt_tokens`、`completion_tokens`、`total_tokens`（description：total = prompt + completion）；`completion_tokens_details.{reasoning_tokens,audio_tokens,accepted_prediction_tokens,rejected_prediction_tokens}` 与 `prompt_tokens_details.{cached_tokens,audio_tokens}` 为官方分项 | `CompletionUsage`（`openapi.yaml:45237`） |
| OAI-CHAT-08 | 必须 | 错误响应为 `{"error":{message,type,param,code}}`，四个字段均为 required（值可为 null） | `Error`（`openapi.yaml:51603`，`required: [type, message, param, code]`） |

## 备注

- `n > 1`、`logprobs`、`logit_bias`、`modalities`、`audio` 属于官方契约，但当前实现未读取；矩阵以「静默丢弃记 fail」处理，是否实现另行决策。
- 错误 `code` 允许 `null`，但字段必须存在。
