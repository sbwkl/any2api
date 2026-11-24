# OpenAI Responses 条款清单

端点：`POST /v1/responses`；schema 根：`CreateResponse`；流式事件联合：`ResponseStreamEvent`。

| ID | 等级 | 条款 | 证据 |
|---|---|---|---|
| OAI-RESP-01 | 必须 | 请求体含 `model` 与 `input`；`input` 可为字符串或输入项数组；响应对象 `object:"response"`，含 `id`、`status`、`output[]`、`usage` | `CreateResponse`（`openapi.yaml:49390`）；官方文档（人工入口） |
| OAI-RESP-02 | 必须 | 输入图片项为 `{type:"input_image", image_url, detail}`；`image_url` 可为公网 URL 或 base64 data URL；`detail` ∈ `high\|low\|auto\|original` | `InputImageContent`（`openapi.yaml:84042`） |
| OAI-RESP-03 | 应当 | 工具：`tools[]`（`type:"function"`）→ 输出项 `function_call`；后续以 `function_call_output` 输入回传；流式为 `response.function_call_arguments.delta` / `.done` | 事件联合（`ResponseFunctionCallArgumentsDeltaEvent` / `DoneEvent`）；官方文档 |
| OAI-RESP-04 | 必须 | 输出项可为 `message`（内容 part 为 `output_text`）与 `reasoning`；非流式 `output` 数组必须与流式事件表达的内容一致 | `ResponseOutputItem` / `ResponseTextDeltaEvent`（`openapi.yaml:75356`，`type:"response.output_text.delta"`） |
| OAI-RESP-05 | 必须 | 流式为 SSE `event:` + `data:` 帧，`data.type` 标识事件；文本事件序列至少包含 `response.created` → `response.output_item.added` → `response.content_part.added` → `response.output_text.delta`* → `response.output_text.done` → `response.content_part.done` → `response.output_item.done` → `response.completed`；失败时为 `response.failed` 或 `response.error`（不再是 `completed`） | `ResponseStreamEvent` 联合（`openapi.yaml:75260`，含 `ResponseTextDoneEvent`、`ResponseFailedEvent`、`ResponseErrorEvent`） |
| OAI-RESP-06 | 必须 | `usage` 含 `input_tokens`、`output_tokens`、`total_tokens`；`input_tokens_details.{cached_tokens,cache_write_tokens}`、`output_tokens_details.reasoning_tokens` 为 required 分项 | `ResponseUsage`（`openapi.yaml:75478`） |
| OAI-RESP-07 | 必须 | 非流式错误体为 `{"error":{message,type,param,code}}`；流式失败必须终止于失败事件，不能以空 `completed` 伪装成功 | `Error`；`ResponseFailedEvent` / `ResponseErrorEvent` |

## 备注

- 当前实现已知偏离：`input_image` 在组装层被丢弃、流式缺 `response.output_text.done`、失败场景可能静默 `completed` 空输出——这些在基线中应记为 `fail`。
- `previous_response_id`、`truncation`、`include`、`text.format` 属官方契约但当前未映射，按「静默丢弃记 fail」处理。
