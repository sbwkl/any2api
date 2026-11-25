# tool_choice 官方语义调研（Anthropic Messages / OpenAI Chat Completions）

日期：2026-11-25（快照，逐节填充中）。调研问题：Anthropic 请求带服务端工具 `web_search_20250305` 且 `tool_choice:{"type":"tool","name":"web_search"}`，OpenAI Chat Completions 无法表达该形状；翻译层丢弃服务端工具后仍发送强制 `tool_choice`，产出「tools:[] + 强制选择引用不存在函数」的请求。

## 1. Anthropic Messages API

### 证据来源（本节）

官方文档站点本机不可达（实测：`docs.anthropic.com` → 301 → `platform.claude.com` → 307 → `www.anthropic.com/app-unavailable-in-region`，地区封锁；WebFetch 域名校验失败、WebSearch 网关 502）。以下条款全部取自 Anthropic 官方 GitHub 仓库源码快照（api.github.com 可达），文档站 URL 仅列作人工阅读入口、标注「未直接核实」。快照：`anthropic-sdk-typescript@main 554d74b26beb`、`anthropic-sdk-python@main f1edcd7d751a`、`anthropics/skills@main e4bb5d960d87`（`skills/claude-api/`，与本机打包技能 v2.1.330 同源，打包版略新）、`claude-cookbooks@main 8ad5de647d4f`。

### 1.1 tool_choice 各类型的官方定义

官方定义页：`https://docs.anthropic.com/en/docs/agents-and-tools/tool-use`（301 跳转至 `https://platform.claude.com/docs/en/agents-and-tools/tool-use`；SDK docstring 引用的具名页面是 `https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview`）。站点未直接核实；以下为第一方源码原文。

四型语义（TS SDK `messages.ts:6107-6163`，Python SDK `tool_choice_*_param.py` 同文）：

| 类型 | 原文 |
|---|---|
| `auto` | "The model will automatically decide whether to use tools."（默认） |
| `any` | "The model will use any available tools." |
| `tool` | "The model will use the specified tool with `tool_choice.name`."；`name` 字段："The name of the tool to use." |
| `none` | "The model will not be allowed to use tools." |

`disable_parallel_tool_use` 的官方语义按类型不同（同一文件）：`any`/`tool` 下为 "If set to `true`, the model will output **exactly** one tool use."；`auto` 下为 "**at most** one tool use"。

顶层 docstring（Python `message_create_params.py`）：["How the model should use the provided tools. The model can use a specific tool, any available tool, decide by itself, or not use tools at all."]

[官方技能版表格（skills 仓库 tool-use-concepts.md § Tool Choice Options）：("`auto` — Claude decides whether to use tools (default)"; "`any` — Claude must use at least one tool"; "`tool` — Claude must use the specified tool"; "`none` — Claude cannot use tools")]

### 1.2 `tool_choice.type="tool"` 的 name 引用不在 tools[] 中时：官方文档未定义

- 已核实的全部第一方来源对 `name` 只有一句：["The name of the tool to use."]（TS `messages.ts:6151` / Python `tool_choice_tool_param.py`）。没有任何条款规定 name 必须存在于 `tools[]`，也没有规定缺失时的行为（报错类型、错误码）。
- 旁证：SDK 建模的结构化错误详情只有 [`tool_name_conflict`]（重名工具，`messages.ts:6170-6172`）与 [`tool_reference_unresolved`]（`tool_reference` 未解析，`:6198-6200`），不存在 tool_choice 引用缺失工具对应的错误码。
- 结论：**官方文档未定义**（已核实范围内）。文档站 overview / errors 页（`https://platform.claude.com/docs/en/api/errors`）本机不可达，未能核实散文条款——待补。

### 1.3 服务端工具（server tools）语义

官方文档页（SDK docstring 内引用，站点未直接核实）：`https://platform.claude.com/docs/en/agents-and-tools/tool-use/server-tools`、`.../web-search-tool`。

- 由 Anthropic 服务端执行。SDK `tools.md`：["Raw definitions are for server tools, such as `{\"type\": \"web_search_20250305\", \"name\": \"web_search\"}`, which the API runs. The tool runner never runs one: a call to it gets a \"not found\" error result and a warning"]（`tools.md` L172）。
- 结果以内容块在同一响应内返回（skills 仓库 Server Tools 节）：["Server-side tools run on Anthropic's infrastructure - no client-side execution loop. Declare in `tools`; results arrive as content blocks in the same response."]；web search 结果块为 [`web_search_tool_result`]，其 `content` 是 `web_search_result` 列表。类型证据：响应 content 含 `server_tool_use` / `web_search_tool_result` 块，`usage.server_tool_use.web_search_requests` 计数（Python SDK 类型文件与 `message_create_params.py` 的 tools docstring）。
- `message_create_params.py` tools docstring 明确区分两类工具：["There are two types of tools: **client tools** and **server tools**. The behavior described below applies to client tools. For [server tools], see their individual documentation as each has its own behavior (e.g., the [web search tool])."]
- 服务端采样循环：["When using server-side tools (code execution, web search, etc.), the API runs a server-side sampling loop. If this loop reaches its default limit of 10 iterations, the response will have `stop_reason: \"pause_turn\"`."]（skills 仓库 tool-use-concepts.md）
- 服务端工具错误不抛异常：["Server-tool errors don't raise. Web search and web fetch errors return HTTP 200 with a `web_search_tool_result` / `web_fetch_tool_result` block whose `content` is a single error object (e.g. `{error_code: \"max_uses_exceeded\"}`) - not a raised exception."]（skills 仓库）
- **与自定义工具混用**：schema 层面允许——`tools[]` 是统一数组，`ToolUnionParam = Union[ToolParam(自定义), WebSearchTool20250305Param, CodeExecutionTool*, ...]`（Python `tool_union_param.py`）；「允许/禁止混用」的散文条款未找到，待补。
- **强制 tool_choice 对服务端工具**：已核实来源中无任何条款允许「强制选择 server tool」，也无直接禁止条款；唯一相关的不兼容条款是 programmatic tool calling（`code_execution_20260120`）：["Not compatible with `strict: true`, `disable_parallel_tool_use`, forced `tool_choice`, or MCP tools."]（skills 仓库 tool-use-concepts.md）。叠加 1.4 后，当前一代模型上「强制选择 web_search」必然 400；其余模型上的行为待补。
- 服务端工具名的官方定义：TS `messages.ts:7093-7099`，`WebSearchTool20250305` 的 `name: 'web_search'`，docstring ["This is how the tool will be called by the model and in `tool_use` blocks."]。

### 1.4 线索核实：当前一代模型对强制 tool_choice 直接返回 400 —— 证实

- skills 仓库 `tool-use-concepts.md` L106：["**Claude Fable 5.1, Claude Mythos 5.1, Claude Opus 5.5, and Claude Sonnet 5.5 reject forced tool use:** `{\"type\": \"any\"}` and `{\"type\": \"tool\", \"name\": ...}` return a 400 there (`tool_choice: type \"tool\" and \"any\" are not supported for this model.` - on `count_tokens` and Batches too). It is a model-specific restriction (Claude Fable 5 and Claude Opus 5 accept them)."]（本机打包技能 v2.1.330 同句模型清单还含 Fable 5.2 / Mythos 5.2。）
- `model-migration.md`（Fable 5.1 节 Breaking change 1）：["`tool_choice: {\"type\": \"any\"}` and `tool_choice: {\"type\": \"tool\", \"name\": \"...\"}` return a 400 `invalid_request_error` on Claude Fable 5.1 and Claude Mythos 5.1 - on the Messages API, the Message Batches API, and the token-counting endpoint"] + 错误原文：`tool_choice: type "tool" and "any" are not supported for this model.`；["This is a model-specific restriction, not a consequence of always-on thinking... `{\"type\": \"auto\"}` (the default) and `{\"type\": \"none\"}` are unchanged. `disable_parallel_tool_use: true` still works with `auto` but now means *at most* one call"]
- Opus 5.5 节（L1919）：["...return a 400 `invalid_request_error` ... on the Messages API, the Message Batches API, and the token-counting endpoint, where Claude Opus 5 accepts both."]；Sonnet 5.5 节 Breaking change 2 同文（"where Claude Sonnet 5 accepts both"）。
- 官方 cookbook `tool_use/tool_choice.ipynb` 的 Model note：["this notebook uses `claude-haiku-5-5` because forced `tool_choice` (`{\"type\": \"tool\"}` / `{\"type\": \"any\"}`) is accepted on Claude Haiku 5.5 but rejected with a 400 by Claude Opus 5.5, Claude Sonnet 5.5, and Claude Fable 5.1. On those models use `tool_choice: {\"type\": \"auto\"}` with an explicit instruction naming the tool, add `\"strict\": true` to the tool definition, or use structured outputs (`output_config.format`)."]
- 结论：任务线索证实。400 限于 `any` / `tool`；`auto` / `none` 不受影响；Haiku 5.5、Fable 5、Opus 5 等仍接受强制 tool_choice。官方替代方案 = `auto` + 提示词明确指令（+ `strict: true` 保参数合法性，或结构化输出）。

## 2. OpenAI Chat Completions API

### 证据来源（本节）

`platform.openai.com` 本机 403 不可达（function calling 指南 WebFetch 亦失败）。以下条款全部取自 OpenAI 官方 openapi.yaml 快照：`openai/openai-openapi@main abe304d1e5f1`（2026-11-25 抓取，4,338,319 B，OpenAPI 3.1.0）。固定链接：`https://github.com/openai/openai-openapi/blob/abe304d1e5f1/openapi.yaml`。人工阅读入口 `https://platform.openai.com/docs/api-reference/chat` 与 `https://platform.openai.com/docs/guides/function-calling` 未直接核实。

### 2.1 tools / tool_choice 的官方定义

`ChatCompletionToolChoiceOption`（openapi.yaml L45278-45310）description 全文：

> Controls which (if any) tool is called by the model.
> `none` means the model will not call any tool and instead generates a message.
> `auto` means the model can pick between generating a message or calling one or more tools.
> `required` means the model must call one or more tools.
> Specifying a particular tool via `{"type": "function", "function": {"name": "my_function"}}` forces the model to call that tool.
> `none` is the default when no tools are present. `auto` is the default if tools are present.

枚举形态（oneOf）：字符串 `none|auto|required`；具名 function（`ChatCompletionNamedToolChoice`，L44495：["Specifies a tool the model should use. Use to force the model to call a specific function."]，`function.name` "The name of the function to call."）；具名 custom（`ChatCompletionNamedToolChoiceCustom`，L44516，"Use to force the model to call a specific custom tool."）；`allowed_tools`（`ChatCompletionAllowedToolsChoice`，L44019：["Constrains the tools available to the model to a pre-defined set."]）。

`tools[]` 元素类型（`CreateChatCompletionRequest`，L46731）：["A list of tools the model may call. You can provide either [custom tools] or [function tools]."]，oneOf `ChatCompletionTool`（type const `function`）或 `CustomToolChatCompletions`——均为客户端执行的工具形态；Chat Completions 的 `tools[]` 中不存在 Anthropic 式「服务端执行工具」类型。独立的 `web_search_options` 请求参数（L46489-46497，"This tool searches the web for relevant results to use in a response."）是另一形状，非 `tools[]` 条目。旧参数 `function_call`：["Deprecated in favor of `tool_choice`."]。

### 2.2 具名 tool_choice 引用不在 tools 里的函数：官方文档未定义

- openapi.yaml 对具名 choice 只定义形状与意图（引文见 2.1），无任何「name 必须存在于 tools[]」的约束，也未定义缺失时的错误行为（是否 400、错误码、错误消息）。
- schema 层面 `tools` 与 `tool_choice` 互不交叉引用，`oneOf` 仅校验 tool_choice 自身形状。
- function calling 指南散文不可达，未能核实是否有补充条款——**官方文档未定义（已核实范围）**，服务端实际行为**待验证**。任何「报错」或「忽略」的假设均无官方文本背书。

### 2.3 tools 为空数组/缺省时发送 tool_choice

- schema 层面合法：`CreateChatCompletionRequest.tools`（array，可选）与 `tool_choice`（可选）之间无 required/条件约束；两者同时出现或仅出现 tool_choice 均通过 schema 校验。
- 唯一与「tools 是否存在」相关的官方文本是 2.1 的默认值句：["`none` is the default when no tools are present. `auto` is the default if tools are present."]——它定义的是**不发送 tool_choice 时**的默认行为，未定义「发送了 tool_choice 但无 tools」时的处理。
- 服务端对「tools 缺省/空数组 + 具名 tool_choice」是否拒绝：**待验证**（文档站不可达）。

## 3. 「显式报错 vs 静默降级」的官方指导原则

**结论：两家均未提供此类跨能力通用原则（已核实范围内）。**

- OpenAI：官方 openapi.yaml 的 `Error` schema 只定义错误体结构（`error.{message,type,param,code}`），无「不支持的能力应报错还是降级」的通用条款；默认值句（"`none` is the default when no tools are present"）是针对单个参数的默认行为规定，不是通用降级原则。指南散文不可达未能核实，待补。
- Anthropic：错误文档页 `https://platform.claude.com/docs/en/api/errors`（SDK docstring 引用存在）按**具体形状逐条列错误**——佐证：`message_create_params.py` prefill docstring 明确 ["On models that don't support prefill, creating a message that ends with a partial `assistant` response returns a 400 error. See [Prefill not supported](https://platform.claude.com/docs/en/api/errors#prefill-not-supported)."]，即「不支持 → 显式 400 + 错误页具名锚点」的逐特性模式；1.4 的强制 tool_choice 400 也是同类实例。但**未找到**抽象层面的通用指导条款；该页本机不可达，全文核实待补。
- 含义：不支持能力的处理方式必须由调用方/翻译层自行决策——官方对「静默降级」没有任何文本背书，仅有逐特性的显式错误条款先例。
