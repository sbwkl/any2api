# 竞品调研：Anthropic /v1/messages 翻译层对服务端工具与 tool_choice 的处理

2026-11-25 快照调研。背景：any2api 共享协议层把 Anthropic 服务端工具（`web_search_*` 等带 `type` 的工具声明）在翻译为 OpenAI chat 请求时丢弃，但 `tool_choice:{"type":"tool","name":...}` 仍被映射为强制函数选择，产出「tools 缺失 + 强制选择引用不存在函数」的矛盾请求，上游 400。本文调研 GitHub 同类「AI 编程工具通道转 API」项目与通用网关在翻译层如何处理这两件事。

调研问题：
1. Anthropic 服务端工具类型（`web_search_*`、`web_fetch_*`、`code_execution_*` 等）出现在 `tools[]` 时：透传、丢弃、报错，还是网关自执行？
2. `tool_choice` 为 `{"type":"tool","name":...}` 或 `{"type":"any"}` 时如何翻译？引用的工具被丢弃/剥离后是否防悬空？

## 项目清单

| 仓库 | star | 服务端工具处理 | tool_choice 悬空处理 |
|---|---|---|---|
| router-for-me/CLIProxyAPI | 59k | 透传（退化 function） | 未处理（仅未知类型兜底 none） |
| musistudio/claude-code-router | 38k | 自执行（hosted bridge 剥离+执行） | 删除（被剥离工具是 choice 目标则删） |
| looplj/axonhub | 5.5k | 丢弃（非 function 类型滤除） | 部分（tools 滤空则删 choice） |
| linguo2625469/workbuddy2api-panel | 5k | 自执行（专用搜索端点，不占 /v1/messages） | 删除（未识别形态删 choice） |
| Quorinex/Kiro-Go | 1.2k | 自执行（剥离声明+注入 function schema） | 忽略（不转发上游） |
| shuishuipingan/qoder2api-hub | 671 | 自执行（专用路径）+普通路径透传 | 未处理（普通路径） |
| caidaoli/kiro2api | 643 | 丢弃（按名静默滤除） | 忽略（仅影响上游触发模式） |
| Zhengyuuuui/qoder2api | 125 | 透传（退化 function） | 忽略（不转发上游） |
| cacaview/iflow2api | 111 | 透传（退化 function） | 未处理（tool 名透传无校验） |
| Tom6814/WorkBuddy2API | 116 | 无 /v1/messages 层 | 不适用 |
| HanHan666666/codebuddy2openai | 91 | 无 /v1/messages 层 | 不适用 |
| Sliverkiss/CodeBuddy2api | 86 | 无 /v1/messages 层 | 不适用 |
| xueyue33/codebuddy2api | 134 | 无 /v1/messages 层（同 Sliverkiss 源） | 不适用 |
| jyao0708/qoder2api | 34 | 透传（退化 function） | 忽略（不转发上游） |
| orangeboyChen/codebuddy2api | 36 | 自执行（按 type 分类+改写+执行） | 删除（reconcileToolChoice） |
| maiphucgiang/codebuddy2api | 271 | 自执行（拆分+注入 WebSearch/WebFetch） | 重映射（choice 名映射到注入工具名） |
| Nanying666/KeyPort | 9 | 透传（退化 function） | 未处理（name 透传无校验） |
| XuanBoWu/codebuddy2api | 5 | 报错（400 Unsupported server tool） | 报错（引用未定义工具即 400） |
| wugxxx/codebuddy2api | 4 | 透传（退化 function） | 未处理（name 透传无校验） |
| linqiu919/augment2api | 191 | 无 /v1/messages 层 | 不适用 |

## 各项目证据

### 1. router-for-me/CLIProxyAPI（59,413★，Go）

Anthropic 入站 → OpenAI chat 上游的翻译器位于 `internal/translator/openai/claude/`。

工具转换盲目透传，服务端工具的 `type` 字段被忽略、无 `input_schema` 时 parameters 置空 object：

```go
// internal/translator/openai/claude/openai_claude_request.go:477
func convertClaudeToolToOpenAI(tool ojson.Result) []byte {
	openAIToolDoc := ojson.NewDocString(`{"type":"function","function":{"name":"","description":""}}`)
	_ = openAIToolDoc.Set("function.name", tool.Get("name").String())
	...
	} else {
		_ = openAIToolDoc.SetRaw("function.parameters", `{"type":"object","properties":{}}`)
	}
```

`tool_choice` 的 `{"type":"tool"}` 直接透传 name，不校验该工具是否还在 tools 里；未识别类型 fail-closed 为 `none`：

```go
// internal/translator/openai/claude/openai_claude_request.go:449
case "tool":
	// Specific tool choice
	toolName := toolChoice.Get("name").String()
	if toolName != "" {
		toolChoiceJSON := []byte(`{"type":"function","function":{"name":""}}`)
		...
	default:
		// Fail closed: unrecognized tool_choice values must not turn into permission
		_ = outDoc.Set("tool_choice", "none")
```

另：Claude 原生上游 executor（`internal/runtime/executor/helps/claude_builtin_tools.go:27`）有 `IsClaudeServerToolType` 按 `web_search_`/`web_fetch_`/`code_execution_` 等前缀识别服务端工具类型，但只用于原生透传路径的保护名单，不作用于 Claude→OpenAI 翻译器。

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 悬空未处理（仅未知类型兜底 none）。
- 证据：<https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/openai/claude/openai_claude_request.go>（L449-461、L477-489）；<https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/helps/claude_builtin_tools.go>（L27-45）。issue #7892 记录上游拒绝混合工具声明：<https://github.com/router-for-me/CLIProxyAPI/issues/7892>。

### 2. looplj/axonhub（5,490★，Go）

多上游 LLM 网关。Anthropic 入站把已知版本的原生 web_search 转成统一 `llm.ToolTypeWebSearch`；未知原生工具显式丢弃，不猜测版本、不降级为 function：

```go
// llm/transformer/anthropic/inbound_convert.go:765
func convertToolToLLM(tool Tool) (llm.Tool, bool) {
	if isNativeWebSearchToolType(tool.Type) {
		return convertNativeWebSearchToolToLLM(tool, tool.Type), true
	}
	...
	default:
		// Ignore other native tools (image_generation, google_*, web_search versions
		// this package does not know, etc.). An unknown version must not be guessed
		// from its prefix, nor degraded into a function tool.
		return llm.Tool{}, false
```

OpenAI chat 出站把所有非 function 类型滤除，并在 tools 被滤空时同步丢弃 tool_choice 与 parallel_tool_calls（注释给出理由——正是本缺陷的对症处理）：

```go
// llm/transformer/openai/outbound_convert.go:81
	// Convert Tools – only include function tools; other types
	// (image_generation, responses_custom_tool, etc.) are not supported
	// by the Chat Completions API and must be filtered out.
	req.Tools = lo.FilterMap(r.Tools, func(t llm.Tool, _ int) (Tool, bool) {
		return ToolFromLLM(t), t.Type == llm.ToolTypeFunction
	})
	...
	if len(req.Tools) == 0 {
		// Some upstreams reject parallel_tool_calls and tool_choice when no
		// tools are sent. Omitting tool_choice is equivalent to the default
		// "auto", so drop both.
		req.ParallelToolCalls = nil
		req.ToolChoice = nil
	}
```

`tool_choice` 映射 `any→required`、`tool{name}→NamedToolChoice` 透传，不校验名称是否在幸存 tools 中（`inbound_convert.go:401` `convertAnthropicToolChoiceToLLM`）。Anthropic 出站同样按平台能力过滤 web_search（`outbound_convert.go:271` 注释）。

- 处理方式归类：服务端工具丢弃（非 function 类型滤除）；tool_choice 悬空部分处理——tools 全滤空时删 choice，混合场景下命名引用被滤工具不校验。
- 证据：<https://github.com/looplj/axonhub/blob/unstable/llm/transformer/openai/outbound_convert.go>（L81-105）；<https://github.com/looplj/axonhub/blob/unstable/llm/transformer/anthropic/inbound_convert.go>（L765-786）。相关 issue：#2476「Convert unsupported Responses API tool types to function definitions instead of silently dropping」（<https://github.com/looplj/axonhub/issues/2476>）、#2898「Responses 请求带 web_search 工具时，DeepSeek 渠道返回 400 Protocol conversion failed」（<https://github.com/looplj/axonhub/issues/2898>）。

### 3. musistudio/claude-code-router（38,352★，TypeScript）

托管 web search 协议桥（`packages/core/src/gateway/features/hosted-web-search/`）把 Anthropic `web_search_20250305` 声明剥离出 tools，由网关经 Fusion（浏览器 MCP 或 Tavily/Brave/Exa 等搜索 provider）自执行后合成响应。剥离时明确同步处理 tool_choice 悬空——被剥离的工具正是 choice 目标、或 tools 剥空时，删除 tool_choice：

```ts
// packages/core/src/gateway/features/hosted-web-search/request-transform.ts:195
function stripAnthropicHostedWebSearchTools(body) {
  const tools = body.tools.filter((tool) => !isAnthropicHostedWebSearchTool(tool));
  ...
  const choiceWasRemoved = body.tools.some((tool) =>
    isAnthropicHostedWebSearchTool(tool) && isRecord(tool) && tool.name === toolChoiceName
  );
  if (tools.length === 0 || choiceWasRemoved) {
    delete next.tool_choice;
  }
```

另有独立防悬空点：grok provider hook 在工具被移除时同步删 choice（`packages/core/src/gateway/core-runtime/local-agent-auth-provider-hook.ts:290`：`if (tools.length === 0 || grokToolChoiceNamesRemovedTool(next.tool_choice, removedToolNames)) { delete next.tool_choice; }`）。

注意：核心的 anthropic_messages→openai chat 协议翻译（工具 schema 转换等）不在仓库内，外包给 npm 依赖 `@the-next-ai/ai-gateway`（见 `packages/core/package.json` dependencies），本节证据仅覆盖仓库内可见部分。

- 处理方式归类：服务端工具自执行（hosted bridge 剥离+执行）；tool_choice 悬空删除（被剥离工具是 choice 目标则删；tools 剥空也删）。
- 证据：<https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/gateway/features/hosted-web-search/request-transform.ts>（L195-218）；<https://github.com/musistudio/claude-code-router/blob/main/packages/core/src/gateway/features/hosted-web-search/discovery.ts>（L74-96）；<https://github.com/musistudio/claude-code-router/blob/main/packages/core/package.json>。

### 4. orangeboyChen/codebuddy2api（36★，TypeScript）

Next.js 代理，明确支持 Anthropic 与 OpenAI 双兼容出口给 Claude Code/Codex。服务端工具由代理自执行：按 **type** 分类（专门注释解释为什么绝不能按 name 判断），改写为上游能调用的 function，执行后回填协议原生块：

```ts
// lib/server/proxy/server-tools/classify.ts:9
 * The name is deliberately never consulted. `normalizeToolName` strips case and
 * separators — `WebSearch` and `web_search` both become `websearch` — so a
 * name-based test cannot tell Claude Code's own `WebSearch` function from the
 * server tool. Matching on the name made the proxy answer a call the client had
 * every intention of resolving itself: Claude Code never received the
 * `tool_use` block it needed, so the search it asked for never happened and the
 * turn ended with an answer invented from memory.
```

悬空防护是显式函数 `reconcileToolChoice`：强制选择引用的工具不在上游 tools 中时，整个 choice 直接删除：

```ts
// lib/server/proxy/server-tools/classify.ts:382
export const reconcileToolChoice = (toolChoice, tools) => {
  const name = getForcedToolName(toolChoice);
  if (!name || !Array.isArray(tools)) {
    return toolChoice;
  }
  const offered = tools.some(
    (tool) => asRecord(asRecord(tool)?.function)?.name === name,
  );
  return offered ? toolChoice : undefined;
};
```

调用点的注释直击本调研的缺陷形态（`lib/server/proxy/anthropic.ts:133`）：

```ts
      // `upstreamTools` matters here even though no turn runs: when a server
      // tool is declared but nothing on this deployment can execute it, the
      // declaration still has to be rewritten, or upstream is sent a
      // `web_search_20250305` type it has never heard of.
      ...
      // A server tool nothing here can run is withdrawn from `tools`, so a
      // choice forcing it has to go too.
      tool_choice: reconcileToolChoice(chatBody.tool_choice, upstreamTools),
```

`tool_choice` 形态映射（`lib/server/proxy/anthropic/request.ts:439`）：`auto→"auto"`、`any→"required"`、`{type:'tool',name}→{type:'function',function:{name}}`、`none→"none"`。多轮 agentic loop 中后续 hop 用 `relaxToolChoice` 防止「被强制的服务端工具再次触发搜索」（`server-tools/turn.ts:733`）。

- 处理方式归类：服务端工具自执行；tool_choice 悬空删除（reconcileToolChoice），并有按 name 误判的踩坑记录。
- 证据：<https://github.com/orangeboyChen/codebuddy2api/blob/main/lib/server/proxy/server-tools/classify.ts>（L9-26、L382-397）；<https://github.com/orangeboyChen/codebuddy2api/blob/main/lib/server/proxy/anthropic.ts>（L125-141）；<https://github.com/orangeboyChen/codebuddy2api/blob/main/lib/server/proxy/anthropic/request.ts>（L439-465）。

### 5. maiphucgiang/codebuddy2api（271★，Python）

功能最全的 CodeBuddy 网关。模块 docstring 声明整体策略——服务端工具由网关换成注入的 function 工具并自执行：

```python
# app/server_tools.py:1
"""Gateway-executed web tools declared through protocol server-tool syntax.

Clients may declare Anthropic ``web_search_*`` / ``web_fetch_*`` server tools or
OpenAI ``web_search`` tools. The gateway swaps them for the WorkBuddy-CLI-shaped
function tools the upstream models already know, executes the calls itself
against the agenttool endpoints, and returns protocol-native blocks.
"""
SEARCH_TYPE_RE = re.compile(r"^web_search(_\d{8})?$")
FETCH_TYPE_RE = re.compile(r"^web_fetch_\d{8}$")
```

`split_server_tools` 把声明从 tools[] 拆出、替换为注入的 `WebSearch`/`WebFetch` function 工具（客户端同名工具优先，防冲突）。`tool_choice` 的悬空处理是**重映射**：choice 引用 `web_search`/`web_fetch` 且对应服务端工具已声明时，名字改指注入工具，保证强制选择永远指向 tools 里存在的函数：

```python
# app/adapters/anthropic_adapter.py:105
    if "tool_choice" in body:
        tc = body["tool_choice"]
        if isinstance(tc, dict):
            kind = tc.get("type")
            if kind == "tool":
                # Anthropic names the hosted tools web_search / web_fetch; map
                # declared server-tool names onto the injected gateway names.
                name = tc.get("name", "")
                if name == "web_search" and server_spec and server_tools.TOOL_SEARCH in server_spec:
                    name = server_tools.TOOL_SEARCH
                elif name == "web_fetch" and server_spec and server_tools.TOOL_FETCH in server_spec:
                    name = server_tools.TOOL_FETCH
                chat["tool_choice"] = {"type": "function", "function": {"name": name}}
            elif kind in ("auto", "none", "any"):
                chat["tool_choice"] = "required" if kind == "any" else kind
            else:
                raise ValueError("unsupported tool_choice type")
```

`any→required`、`disable_parallel_tool_use→parallel_tool_calls`，未知 tool_choice 类型抛 ValueError（HTTP 400）。

- 处理方式归类：服务端工具自执行（拆分+注入 WebSearch/WebFetch）；tool_choice 悬空重映射（choice 名改指注入工具名），未知类型报 400。
- 证据：<https://github.com/maiphucgiang/codebuddy2api/blob/main/app/server_tools.py>（L1-24、L140-166）；<https://github.com/maiphucgiang/codebuddy2api/blob/main/app/adapters/anthropic_adapter.py>（L90-126、L321-338）。

### 6. XuanBoWu/codebuddy2api（5★，Python）

严格拒绝派：任何带 `type` 字段的工具声明（即全部服务端工具）直接 400，不做丢弃也不做自执行：

```python
# src/anthropic_compat.py:380
    def _tools(self, value: Any) -> Optional[List[Dict[str, Any]]]:
        for tool in value:
            if tool.get("type") is not None:
                _bad("Unsupported Anthropic server tool")
```

`tool_choice` 有配套校验——引用未定义工具同样 400，从根上杜绝悬空：

```python
# src/anthropic_compat.py:406
        elif kind == "tool":
            mapped_name = self._tool_names.map(value.get("name"))
            if tools is not None and mapped_name not in {
                tool["function"]["name"] for tool in tools
            }:
                _bad("Anthropic tool_choice names an undefined tool")
```

`any→required`、`none→none`，未知 tool_choice 类型 `_bad("Unsupported Anthropic tool_choice type")`。服务端工具的历史块（`server_tool_use`、`web_search_tool_result` 等）在消息转换里按「provider 托管历史」整组处理（`src/anthropic_compat.py:44` `_PROVIDER_MANAGED_ASSISTANT_HISTORY_TYPES`）。

- 处理方式归类：服务端工具报错（400 Unsupported server tool）；tool_choice 悬空报错（400 names an undefined tool）。
- 证据：<https://github.com/XuanBoWu/codebuddy2api/blob/main/src/anthropic_compat.py>（L380-437）。

### 7. wugxxx/codebuddy2api（4★，TypeScript）

工具盲目透传，服务端工具因无 `input_schema` 变成空 schema 退化 function，`type` 字段被忽略：

```ts
// src/translate/anthropic.ts:22
  if (Array.isArray(req.tools)) {
    out.tools = (req.tools as Array<Record<string, unknown>>).map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
```

`tool_choice` 映射标准（`any→required`、`tool→function choice`）但无悬空校验：

```ts
// src/translate/anthropic.ts:32
  if (req.tool_choice && typeof req.tool_choice === "object") {
    const tc = req.tool_choice as Record<string, unknown>;
    if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "auto") out.tool_choice = "auto";
    else if (tc.type === "tool" && tc.name)
      out.tool_choice = { type: "function", function: { name: tc.name } };
  }
```

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 悬空未处理。
- 证据：<https://github.com/wugxxx/codebuddy2api/blob/main/src/translate/anthropic.ts>（L22-38）。

### 8. Nanying666/KeyPort（9★，Python）

CodeBuddy/WorkBuddy/ZCode 多账户网关，Anthropic↔OpenAI 双向。工具同样盲目透传（退化 function）；因上游只认 string 形态 tool_choice，`{"type":"tool","name":X}` 被压成裸 name 字符串透传，无校验：

```python
# keyport/protocol/anthropic.py:53
def _tool_choice(tc: Any) -> str:
    """Anthropic tool_choice → OpenAI（上游只认 string）。"""
    if not isinstance(tc, dict):
        return "auto"
    ttype = tc.get("type")
    if ttype == "any":
        return "required"
    if ttype == "tool":
        return str(tc.get("name", "")) or "auto"
    if ttype == "none":
        return "none"
    return "auto"
```

```python
# keyport/protocol/anthropic.py:359
        converted.append({
            "type": "function",
            "function": {
                "name": str(tool.get("name", "")),
                ...
                "parameters": tool.get("input_schema") or {"type": "object", "properties": {}},
            },
        })
```

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 悬空未处理（name 压成字符串透传）。
- 证据：<https://github.com/Nanying666/KeyPort/blob/main/keyport/protocol/anthropic.py>（L53-64、L359-379）。

### 9. linguo2625469/workbuddy2api-panel（4,977★，Go）

腾讯 WorkBuddy 多账号网关。**不占用 `/v1/messages`**：chat 不做 Anthropic 协议入站，Anthropic 形态只服务一个专用搜索端点 `/v1/search/messages`，为 DSH 内置搜索 provider 做协议壳。文件头注释完整交代了取舍：

```go
// internal/server/messages.go:1
// messages.go Anthropic Messages 兼容的搜索端点 POST /v1/search/messages。
//
// 存在理由：DSH 内置的搜索 provider（`@deepseek-ai/dsh-web-search-deepseek`）把
// 搜索请求硬编码发到 `${baseURL}/messages`，且要求响应是 Anthropic Messages 形态
// （含 `web_search_tool_result` block）。...
// 为什么不占用 `/v1/messages`：那是 Anthropic **模型对话**的标准路径，将来网关若要
// 支持 Anthropic 协议的 chat 转发会与搜索冲突。搜索挂在 `/v1/search/messages`，...
//
// 与真实 Anthropic 行为的差异（有意为之）：本端点**不做模型调用**。真实 Anthropic
// 的 web_search 是 server tool，由模型决定何时搜、并生成带引用的自然语言回答；
// 这里直接执行一次搜索并返回结构化结果块——因为网关没有模型，客户端（DSH）只从
// 结果块里取 sources，不消费自然语言回答。
```

该端点两种形态都认服务端工具声明（`messages.go:46`：`{type:"web_search_20250305"}` 与简化形态 `{name:"web_search"}`；未声明 web_search 的请求 400）。OpenAI 形态上游 payload 侧的 tool_choice 归一化以「上游该字段是 string，对象形式会 400 code=11101」为前提，未识别形态直接删除：

```go
// internal/upstream/payload.go:376
// normalizeToolChoice 按上游 Go struct（string 类型）改写 OpenAI tool_choice。
//   - {"type":"function","function":{"name":"x"}} → 字符串 "x"
//   - 其他对象/非标量 → 删 tool_choice
		default:
			delete(obj, "tool_choice")
```

- 处理方式归类：服务端工具自执行（专用搜索端点，不占 /v1/messages）；tool_choice 未识别形态删除（上游 string-only 约束），但无名称-工具校验。
- 证据：<https://github.com/linguo2625469/workbuddy2api-panel/blob/main/internal/server/messages.go>（L1-26、L46-72、L264-268）；<https://github.com/linguo2625469/workbuddy2api-panel/blob/main/internal/upstream/payload.go>（L3-13、L376-424）。

### 10. Tom6814/WorkBuddy2API（116★，Python）

WorkBuddy/CodeBuddy 逆向 API。**无 /v1/messages 层**（OpenAI-only），服务端工具问题不适用；其工具处理在 OpenAI 路径是原样透传——`tool_choice` 从请求体取出后不经转换直接交给上游封装函数：

```python
# server.py:225
    tools = body.get("tools")
    tool_choice = body.get("tool_choice")
```

```python
# codebuddy_direct_api.py:411
            tool_choice: "auto"|"none"|"required"|{"type": "function", "function": {"name": "..."}}。
...
        if tool_choice is not None:
            body["tool_choice"] = tool_choice
```

- 处理方式归类：无 /v1/messages 层（不适用）；OpenAI 路径 tool_choice 原样透传。
- 证据：<https://github.com/Tom6814/WorkBuddy2API/blob/main/server.py>（L222-227）；<https://github.com/Tom6814/WorkBuddy2API/blob/main/codebuddy_direct_api.py>（L403-440）。

### 11. HanHan666666/codebuddy2openai（91★，Python）

CodeBuddy/WorkBuddy → OpenAI 兼容 API。**无 /v1/messages 层**（不适用）。工具处理是白名单整体透传，不做任何 schema 校验或形态改写：

```python
# converter.py:228
# 后端请求体里出现过的额外字段（透传时若客户端给了就保留）
PASSTHROUGH_BODY_KEYS = {
    "model", "messages", "tools", "tool_choice", "temperature",
    "max_tokens", "max_completion_tokens", "top_p", "stream",
    ...
}
```

- 处理方式归类：无 /v1/messages 层（不适用）；OpenAI 路径 tools/tool_choice 白名单透传。
- 证据：<https://github.com/HanHan666666/codebuddy2openai/blob/main/converter.py>（L227-234）。

### 12. Sliverkiss/CodeBuddy2api（86★，Python）

将 CodeBuddy 官方 API 包装为 OpenAI 兼容服务。**无 /v1/messages 层**（不适用）：仓库内无任何 Anthropic 端点；`tool_choice` 仅作为 OpenAI 请求模型字段声明后透传，无处理逻辑：

```python
# src/models.py:24
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None
```

- 处理方式归类：无 /v1/messages 层（不适用）。
- 证据：<https://github.com/Sliverkiss/CodeBuddy2api/blob/main/src/models.py>（L24）；全仓库无 `v1/messages` 命中（2026-11-25 快照核对）。

### 13. xueyue33/codebuddy2api（134★，Python）

与 Sliverkiss/CodeBuddy2api 同源代码（2026-11-25 diff 核对：仅差 .dockerignore/.env.example/.gitignore/README/LICENSE 等外围文件，`src/` 内容一致）。**无 /v1/messages 层**（不适用），tool_choice 同样只是 `src/models.py:24` 的模型字段。

- 处理方式归类：无 /v1/messages 层（不适用，同 Sliverkiss）。
- 证据：<https://github.com/xueyue33/codebuddy2api/blob/main/src/models.py>（L24）。

### 14. Quorinex/Kiro-Go（1,210★，Go）

Kiro → OpenAI/Anthropic 双兼容。原生 web_search 剥离出转发工具并注入 Kiro 形态 schema，由代理经 Kiro MCP 自执行；注释给出剥离理由：

```go
// proxy/translator.go:803
	for _, tool := range tools {
		// Anthropic native server tools (web_search_*) are executed by this proxy
		// via the MCP endpoint, not by generateAssistantResponse. Do not forward
		// them as Kiro tool specifications — the model would otherwise emit a
		// client-side tool_use that hosts like Claude Desktop cannot execute.
		// When mixed with other tools, the agentic loop still injects a real
		// web_search schema below if the client only sent the native form.
		if isNativeWebSearchTool(tool) {
			continue
		}
```

混合场景注入 `web_search` function schema（`translator.go:839-847`）；混合请求走 agentic loop（`handler.go:885` `hasWebSearchAmongTools → runWebSearchLoop`），纯 web_search 请求走专用 MCP 路径并产出 `server_tool_use`/`web_search_tool_result` 块（`websearch.go:3-6`：「Anthropic native web_search tools are relayed through Kiro's MCP endpoint... generateAssistantResponse does not execute web_search; it only surfaces tool_use, so pure web_search needs this dedicated path」）。判定按 `name=="web_search" && type 前缀 web_search_` 双条件，避免误伤同名客户端工具（`websearch.go:97-102`）。

`tool_choice` 仅保留在入站 struct（`translator.go:132`）用于缓存指纹（`cache_tracker.go:278`），**不翻译不转发**——Kiro 上游无此概念，悬空问题因不透出而自然消失。

- 处理方式归类：服务端工具自执行（剥离+注入 schema+MCP 执行）；tool_choice 忽略（不转发上游）。
- 证据：<https://github.com/Quorinex/Kiro-Go/blob/main/proxy/translator.go>（L803-848）；<https://github.com/Quorinex/Kiro-Go/blob/main/proxy/websearch.go>（L3-6、L97-128）；<https://github.com/Quorinex/Kiro-Go/blob/main/proxy/handler.go>（L885-891）。

### 15. caidaoli/kiro2api（643★，Go）

Kiro/CodeWhisperer 通道。工具按**名称**静默过滤（含声明与历史 tool_use 块两处）：

```go
// converter/tools.go:35
		// 过滤不支持的工具：web_search (静默过滤，不发送到上游)
		if tool.Function.Name == "web_search" || tool.Function.Name == "websearch" {
			continue
		}
```

`tool_choice` 不透传具体名称——`{"type":"tool"}`/`{"type":"any"}` 只影响上游触发模式取 `AUTO`，否则 `MANUAL`：

```go
// converter/codewhisperer.go:26
	// 检查tool_choice是否强制要求使用工具
	if anthropicReq.ToolChoice != nil {
		if tc, ok := anthropicReq.ToolChoice.(*types.ToolChoice); ok && tc != nil {
			if tc.Type == "any" || tc.Type == "tool" {
				return "AUTO" // 自动工具调用
			}
```

另 `convertOpenAIToolChoiceToAnthropic`（`converter/tools.go:174-218`，OpenAI→Anthropic 反方向）把未知字符串默认 auto、`none→nil`（「Anthropic 没有 none 选项」）。

- 处理方式归类：服务端工具丢弃（按名静默滤除）；tool_choice 忽略（仅转成上游触发模式，名称不透传）。
- 证据：<https://github.com/caidaoli/kiro2api/blob/main/converter/tools.go>（L35-38、L172-218）；<https://github.com/caidaoli/kiro2api/blob/main/converter/codewhisperer.go>（L26-44、L308-313）。

### 16. shuishuipingan/qoder2api-hub（671★，Python）

Qoder 双区多账号网关。声明了托管 web 工具的 Anthropic 请求被路由到专用自执行路径（`qoder_proxy.py:13846` `qoder_anthropic_web.applies(payload)`），网关执行搜索/抓取后返回 `server_tool_use`/`web_search_tool_result` 块：

```python
# qoder_anthropic_web.py:19
_TYPES = {"web_search_20250305": "web_search", "web_fetch_20250910": "web_fetch"}
```

但普通 chat 路径（`qoder_anthropic.py`）对工具盲目透传（服务端工具变退化 function）且 tool_choice 无悬空校验：

```python
# qoder_anthropic.py:175
def _tool_choice_to_chat(tc):
    """Anthropic tool_choice 四形态 -> chat 形态（auto/any/tool/none）。"""
    ...
    if t == "tool" and tc.get("name"):
        return {"type": "function",
                "function": {"name": str(tc.get("name"))}}
```

```python
# qoder_anthropic.py:249
def _tools_to_chat(tools):
    """Anthropic tools（name/description/input_schema）-> chat function 工具。"""
    ...
        schema = t.get("input_schema")
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}}
```

- 处理方式归类：服务端工具自执行（专用路径）+ 普通路径透传；tool_choice 悬空未处理（普通路径 name 直传）。
- 证据：<https://github.com/shuishuipingan/qoder2api-hub/blob/main/qoder_anthropic_web.py>（L19-69）；<https://github.com/shuishuipingan/qoder2api-hub/blob/main/qoder_anthropic.py>（L175-190、L249-271）；<https://github.com/shuishuipingan/qoder2api-hub/blob/main/qoder_proxy.py>（L13846-13861）。

### 17. Zhengyuuuui/qoder2api（125★，Go）

Qoder → OpenAI/Claude/Codex 格式。`/v1/messages` 路径工具盲目转换（`internal/bridge/claude.go:42` `ConvertClaudeToolsToOpenAI`；L478-484 逐个映射 `input_schema→parameters`），服务端工具变退化 function；**全仓库无 tool_choice 处理**（2026-11-25 grep 核对零命中），选择被完全忽略：

```go
// internal/bridge/claude.go:40
	// Claude format: tools use name+input_schema directly
	// Convert to OpenAI-style for Qoder upstream
	tools := ConvertClaudeToolsToOpenAI(req["tools"])
```

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 忽略（不转发上游）。
- 证据：<https://github.com/Zhengyuuuui/qoder2api/blob/main/internal/bridge/claude.go>（L37-48、L470-489）。

### 18. jyao0708/qoder2api（34★，Go）

Go bridge，Qoder → OpenAI & Anthropic 兼容（适配 Codex CLI 与 Claude Code）。`/v1/messages` 路径（`internal/bridge/handler.go:31`）同样盲目转换工具、全仓库无 tool_choice 处理（grep 零命中，含 tool_choice/toolChoice）：

```go
// internal/bridge/messages.go:288
	var tools []protocol.Message
	for _, part := range parts {
		switch stringValue(part["type"]) {
		case "text":
			texts = append(texts, stringValue(part["text"]))
		case "tool_result":
			tools = append(tools, protocol.Message{
				Role:       "tool",
				ToolCallID: stringValue(part["tool_use_id"]),
				...
```

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 忽略（不转发上游）。
- 证据：<https://github.com/jyao0708/qoder2api/blob/master/internal/bridge/handler.go>（L31）；<https://github.com/jyao0708/qoder2api/blob/master/internal/bridge/messages.go>（L285-302）。

### 19. cacaview/iflow2api（111★，Python）

iFlow CLI 模型解锁。`/v1/messages` 端点（`iflow2api/app.py:1227`）工具盲目映射 + tool_choice 标准映射无校验；无服务端工具识别（grep 零命中 web_search/server_tool）：

```python
# iflow2api/app.py:481
    if "tools" in body:
        openai_body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "parameters": t.get("input_schema", {}),
                },
            }
            for t in body["tools"]
        ]
    # 6. 转换 tool_choice
    if "tool_choice" in body:
        ...
            elif tc_type == "tool":
                openai_body["tool_choice"] = {
                    "type": "function",
                    "function": {"name": tc.get("name", "")},
                }
```

- 处理方式归类：服务端工具透传（退化 function）；tool_choice 悬空未处理。
- 证据：<https://github.com/cacaview/iflow2api/blob/main/iflow2api/app.py>（L481-509）。

### 20. linqiu919/augment2api（191★，Go）

Augment 通道转 OpenAI 兼容 API。**无 /v1/messages 层**（不适用）：仓库内仅模型列表里出现 "anthropic" 字样（`api/handler.go:507` `OwnedBy: "anthropic"`），无 Anthropic 协议入站、无工具翻译代码（grep `tool_choice` 零命中）。

- 处理方式归类：无 /v1/messages 层（不适用）。
- 证据：<https://github.com/linqiu919/augment2api/blob/master/api/handler.go>（L507）。

## 模式归纳（详细）

1. **服务端工具主流做法是「网关自执行」，不是丢弃。** 15 个有 Anthropic /v1/messages 翻译层的项目中，6 家实现自执行（orangeboyChen、maiphucgiang、workbuddy2api-panel、Kiro-Go、qoder2api-hub 专用路径、claude-code-router hosted bridge）：把带 `type` 的服务端工具声明剥离出 `tools[]`，由网关自己执行搜索后回填 `server_tool_use`/`web_search_tool_result` 块——因为上游（CodeBuddy/Kiro/Qoder 的 chat 通道）根本不认识这些类型，也不执行工具。axonhub 是折中：已知类型转统一内部类型、未知类型丢弃（注释明确「不得猜测版本、不得降级为 function」）。盲目透传派（CLIProxyAPI、wugxxx、KeyPort、iflow2api、Zhengyuuuui、jyao0708、qoder2api-hub 普通路径）会把服务端工具变成空 schema 的退化 function 发给上游；显式报错（XuanBoWu）与按名静默丢弃（caidaoli）是少数派。
2. **tool_choice 形态映射高度一致，分歧全在悬空防护。** `any→required`、`{"type":"tool","name"}→{"type":"function","function":{"name"}}` 是行业模板（各家实现几乎逐字相同）；上游不支持对象形态时压成 name 字符串（KeyPort、workbuddy2api-panel）或直接忽略（Kiro-Go、caidaoli、Zhengyuuuui、jyao0708——上游本无此概念）。防悬空的四种姿势都有实例：删除 choice（orangeboyChen `reconcileToolChoice`、axonhub 滤空时、claude-code-router `stripAnthropicHostedWebSearchTools`）、重映射到注入工具名（maiphucgiang）、400 校验（XuanBoWu）、上游侧归一化时删未识别形态（workbuddy2api-panel）。**没有任何一家把「tools 为空/缺失 + 强制选择引用不存在函数」的矛盾请求发给上游**——这正是 any2api 当前缺陷形态，且 orangeboyChen 的调用点注释（「A server tool nothing here can run is withdrawn from tools, so a choice forcing it has to go too」）与 axonhub 的注释（「Some upstreams reject parallel_tool_calls and tool_choice when no tools are sent」）给出了同一结论的两种表述。
3. **取舍讨论有迹可循。** orangeboyChen 在 `classify.ts` 记录了按 name 匹配导致代理吞掉 Claude Code 自有 `WebSearch` 函数调用的踩坑（结论：只认 type）；axonhub issue #2476 讨论不支持的工具类型「转 function vs 静默丢弃」、#2898 记录 web_search 工具发往不支持渠道被 400 拒绝的真实故障；CLIProxyAPI issue #7892 记录上游拒绝服务端工具与 function 混合声明。这些与 any2api 的缺陷同属一类：服务端工具语义在上游不存在时，翻译层必须三选一——剥离并自执行、报错拒绝、或连同其上的 tool_choice 一起清场，唯独不能「丢工具、留选择」。
