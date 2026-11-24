# e2e 相似度报告

- 生成时间：2026-11-24T09:13:48.404Z
- 目标：http://127.0.0.1:60058
- 预算：50/60 次上游调用
- provider：codearts, codebuddy
  - codearts: glm-5.3-flash
  - codebuddy: glm-5.3-flash
- 汇总：总计 57 · pass 32 · fail 17 · not-supported 4 · skipped 4

| 场景 | provider | endpoint | 特性 | 状态 | 条款 | 说明 |
|---|---|---|---|---|---|---|
| chat.basic.nonstream | codearts | /v1/chat/completions | 基础非流式（含 usage） | pass | OAI-CHAT-01 | HTTP 200；契约通过 |
| chat.basic.stream | codearts | /v1/chat/completions | SSE 流式 + usage 块 | pass | OAI-CHAT-02 | HTTP 200；契约通过 |
| chat.image.data_url | codearts | /v1/chat/completions | image_url data URL | pass | OAI-CHAT-04 | 图片送达上游且颜色识别正确 |
| chat.image.url | codearts | /v1/chat/completions | image_url 公网 URL | skipped | OAI-CHAT-04 | 未设置 E2E_IMAGE_URL |
| chat.multi_turn.system | codearts | /v1/chat/completions | multi-turn + system | pass | - | HTTP 200；契约通过 |
| chat.response_format.json_schema | codearts | /v1/chat/completions | response_format json_schema | fail | OAI-CHAT-06 | 上游请求未包含 response_format.json_schema（静默丢弃） |
| chat.tools.forced | codearts | /v1/chat/completions | tools + 强制 tool_choice | not-supported | OAI-CHAT-05 | 上游显式拒绝，但状态码被映射为 502：{"error":{"message":"upstream_error: no choices in upstream SSE: InferHub.001001005.400: The request param is invalid, Please check it","type":"upstream_error","code":null}} |
| chat.response_format.json | codearts | /v1/chat/completions | response_format json_object | fail | OAI-CHAT-06 | 上游请求未包含 response_format（静默丢弃） |
| chat.logprobs | codearts | /v1/chat/completions | logprobs / top_logprobs | fail | OAI-CHAT-07 | 响应缺少 choices[0].logprobs.content（参数被静默丢弃） |
| chat.n | codearts | /v1/chat/completions | n > 1 | fail | OAI-CHAT-08 | choices 数量为 1（n=2 被静默丢弃） |
| chat.negative.unknown_model | codearts | /v1/chat/completions | 未知模型显式拒绝 | fail | OAI-CHAT-03 | 未知模型被静默接受/回退（响应 model=deepseek-v4.1-flash-1017） |
| chat.negative.invalid_json | codearts | /v1/chat/completions | 非法 JSON 请求体 | pass | OAI-CHAT-03 | HTTP 400；错误信封合规 |
| messages.basic.nonstream | codearts | /v1/messages | 基础非流式（含 usage） | pass | ANT-MSG-01 | HTTP 200；契约通过 |
| messages.basic.stream | codearts | /v1/messages | SSE 事件序列 | pass | ANT-MSG-02 | HTTP 200；契约通过 |
| messages.multi_turn.system | codearts | /v1/messages | multi-turn + system string | pass | - | HTTP 200；契约通过 |
| messages.image.base64 | codearts | /v1/messages | base64 图片 | pass | ANT-MSG-03 | 图片送达上游且颜色识别正确 |
| messages.image.url | codearts | /v1/messages | URL 图片 | skipped | ANT-MSG-03 | 未设置 E2E_IMAGE_URL |
| messages.image.tool_result | codearts | /v1/messages | tool_result 内嵌图片 | pass | ANT-MSG-04 | tool_result 图片送达上游且颜色识别正确 |
| messages.image.system | codearts | /v1/messages | system 数组中的图片 | fail（已知缺陷） | ANT-MSG-05 | system 图片未送达上游（静默丢弃） |
| messages.tools.forced | codearts | /v1/messages | tools + 强制 tool_choice | not-supported | ANT-MSG-06 | 上游显式拒绝，但状态码被映射为 502：{"error":{"message":"upstream_error: no choices in upstream SSE: InferHub.001001005.400: The request param is invalid, Please check it","type":"upstream_error","code":null}} |
| messages.negative.unknown_model | codearts | /v1/messages | 未知模型 + 错误信封归一 | fail | ANT-MSG-07 | 未知模型被静默接受/回退（响应 model=e2e-model-does-not-exist） |
| messages.negative.invalid_json | codearts | /v1/messages | 非法 JSON 请求体 | pass | ANT-MSG-07 | HTTP 400；错误信封合规 |
| responses.basic.nonstream | codearts | /v1/responses | 基础非流式（含 usage） | pass | OAI-RESP-01 | HTTP 200；契约通过 |
| responses.basic.stream | codearts | /v1/responses | SSE 事件序列 | fail（已知缺陷） | OAI-RESP-02 | 缺少 response.output_text.done |
| responses.image.data_url | codearts | /v1/responses | input_image data URL | fail（已知缺陷） | OAI-RESP-03 | 上游请求未包含图片字段（input_image 被丢弃） |
| responses.tools.forced | codearts | /v1/responses | function tools + 强制 tool_choice | not-supported | OAI-RESP-04 | 上游显式拒绝，但状态码被映射为 502：{"error":{"message":"upstream_error: no choices in upstream SSE: InferHub.001001005.400: The request param is invalid, Please check it","type":"upstream_error","code":null}} |
| responses.negative.unknown_model | codearts | /v1/responses | 未知模型显式拒绝 | fail | OAI-RESP-05 | 未知模型被静默接受/回退（响应 model=e2e-model-does-not-exist） |
| models.list | codearts | /v1/models | 模型列表形状 | pass | OAI-MODEL-01 | HTTP 200；契约通过 |
| chat.basic.nonstream | codebuddy | /v1/chat/completions | 基础非流式（含 usage） | pass | OAI-CHAT-01 | HTTP 200；契约通过 |
| chat.basic.stream | codebuddy | /v1/chat/completions | SSE 流式 + usage 块 | fail | OAI-CHAT-02 | usage 块应带空 choices |
| chat.image.data_url | codebuddy | /v1/chat/completions | image_url data URL | pass | OAI-CHAT-04 | 图片送达上游且颜色识别正确 |
| chat.image.url | codebuddy | /v1/chat/completions | image_url 公网 URL | skipped | OAI-CHAT-04 | 未设置 E2E_IMAGE_URL |
| chat.multi_turn.system | codebuddy | /v1/chat/completions | multi-turn + system | pass | - | HTTP 200；契约通过 |
| chat.response_format.json_schema | codebuddy | /v1/chat/completions | response_format json_schema | fail | OAI-CHAT-06 | json_schema 已送达上游，但 content 不是 JSON（上游未强制结构）：```json {"ok": true} ``` |
| chat.tools.forced | codebuddy | /v1/chat/completions | tools + 强制 tool_choice | not-supported | OAI-CHAT-05 | 上游显式拒绝（HTTP 400）：{"error":{"message":"Invalid request. Please retry","type":"invalid_request_error","code":11101}} |
| chat.response_format.json | codebuddy | /v1/chat/completions | response_format json_object | pass | OAI-CHAT-06 | response_format 送达上游且输出为 JSON |
| chat.logprobs | codebuddy | /v1/chat/completions | logprobs / top_logprobs | fail | OAI-CHAT-07 | 响应缺少 choices[0].logprobs.content（参数被静默丢弃） |
| chat.n | codebuddy | /v1/chat/completions | n > 1 | fail | OAI-CHAT-08 | choices 数量为 1（n=2 被静默丢弃） |
| chat.negative.unknown_model | codebuddy | /v1/chat/completions | 未知模型显式拒绝 | pass | OAI-CHAT-03 | 显式拒绝（HTTP 404） |
| chat.negative.invalid_json | codebuddy | /v1/chat/completions | 非法 JSON 请求体 | pass | OAI-CHAT-03 | HTTP 400；错误信封合规 |
| messages.basic.nonstream | codebuddy | /v1/messages | 基础非流式（含 usage） | pass | ANT-MSG-01 | HTTP 200；契约通过 |
| messages.basic.stream | codebuddy | /v1/messages | SSE 事件序列 | pass | ANT-MSG-02 | HTTP 200；契约通过 |
| messages.multi_turn.system | codebuddy | /v1/messages | multi-turn + system string | pass | - | HTTP 200；契约通过 |
| messages.image.base64 | codebuddy | /v1/messages | base64 图片 | pass | ANT-MSG-03 | 图片送达上游且颜色识别正确 |
| messages.image.url | codebuddy | /v1/messages | URL 图片 | skipped | ANT-MSG-03 | 未设置 E2E_IMAGE_URL |
| messages.image.tool_result | codebuddy | /v1/messages | tool_result 内嵌图片 | pass | ANT-MSG-04 | tool_result 图片送达上游且颜色识别正确 |
| messages.image.system | codebuddy | /v1/messages | system 数组中的图片 | fail（已知缺陷） | ANT-MSG-05 | system 图片未送达上游（静默丢弃） |
| messages.tools.forced | codebuddy | /v1/messages | tools + 强制 tool_choice | pass | ANT-MSG-06 | 强制 tool_choice 生效 |
| messages.negative.unknown_model | codebuddy | /v1/messages | 未知模型 + 错误信封归一 | pass | ANT-MSG-07 | 显式拒绝（HTTP 404） |
| messages.negative.invalid_json | codebuddy | /v1/messages | 非法 JSON 请求体 | pass | ANT-MSG-07 | HTTP 400；错误信封合规 |
| responses.basic.nonstream | codebuddy | /v1/responses | 基础非流式（含 usage） | pass | OAI-RESP-01 | HTTP 200；契约通过 |
| responses.basic.stream | codebuddy | /v1/responses | SSE 事件序列 | fail（已知缺陷） | OAI-RESP-02 | 缺少 response.output_text.done |
| responses.image.data_url | codebuddy | /v1/responses | input_image data URL | fail（已知缺陷） | OAI-RESP-03 | 上游请求未包含图片字段（input_image 被丢弃） |
| responses.tools.forced | codebuddy | /v1/responses | function tools + 强制 tool_choice | pass | OAI-RESP-04 | 强制 tool_choice 生效 |
| responses.negative.unknown_model | codebuddy | /v1/responses | 未知模型显式拒绝 | pass | OAI-RESP-05 | 显式拒绝（HTTP 404） |
| models.list | codebuddy | /v1/models | 模型列表形状 | pass | OAI-MODEL-01 | HTTP 200；契约通过 |
| healthz.aggregate | all | /healthz | 聚合健康检查 | pass | - | HTTP 200；2 个 provider |
