# 修复翻译层防悬空 tool_choice 与空 tools 键（服务端工具一致性）

类型：修复（跨 provider 共享协议层）
状态：已验证（单测 286 pass / 0 fail + 实弹验证通过；未合并 main、未部署）
Owner：wayne
所属模块/入口：`src/protocols/anthropic.ts`、`src/protocols/responses.ts`
关联：[spec issue #21](https://github.com/sbwkl/any2api/issues/21)、[产品演进 issue #22](https://github.com/sbwkl/any2api/issues/22)、[竞品调研](../../references/2026-11-25-server-tool-competitor-survey.md)、[官方语义调研](../../references/2026-11-25-tool-choice-official-semantics.md)、[R12](../../product-specs/codebuddy-provider.md)

## 1. 摘要

Anthropic 请求携带服务端执行工具（`web_search_20250305` 等）时，翻译层按既有边界丢弃该工具，但 `tool_choice:{"type":"tool","name":...}` 仍被无条件映射为强制函数选择，产出「tools 空 + 强制选择引用不存在函数」的矛盾请求。上游对这种形状确定性拒绝，真实客户端（Claude Desktop 搜索子代理）2026-11-25 实测 11/11 全败。本变更使翻译层防悬空：具名选择引用被滤除工具时删除 choice；工具全滤空时省略 `tools` 键并删除 choice。Anthropic 与 Responses 两入口同修。

## 2. 变更理由与证据

真实故障现场（trace 采集 `capture-2026-11-25.jsonl`，Claude Desktop 2.1.330 web-search 子代理，模型 `deepseek-v4.1-flash-1017`）：

- 11 条同形状请求：`tools:[{"type":"web_search_20250305","name":"web_search","max_uses":8}]` + `tool_choice:{"type":"tool","name":"web_search"}`。
- L2 上游请求实际为 `tools:[]` + `tool_choice:{"type":"function","function":{"name":"web_search"}}`——工具被滤除但强制选择保留。
- 上游 HTTP 200 但 SSE 内嵌 `InferHub.001001005.400: The request param is invalid`；流式表现为 200 + `event: error`，非流式表现为 502 `upstream_error`。11/11 全败，客户端指数退避重试 10 次后放弃。

调研证据（见 references 两份笔记）：

- 竞品 20 项目：无任何成熟实现把矛盾形状发给上游；防悬空是标配（删除 choice / 重映射 / 400 校验三种姿势均有实例）；CCR 的精确模式（引用被剥工具即删 choice）与 axonhub 的书面理由（「有些上游在无 tools 时拒绝 tool_choice」）为本修复的直接依据。
- 官方语义：Anthropic 与 OpenAI 均未定义「tool_choice 引用缺失工具」的行为，静默降级无官方背书；竞品主流与实弹证据支持删除 choice。

决策记录（spec #21 评审定稿）：悬空防护采用删 choice 而非显式 400；服务端工具保持丢弃（不自执行——竞品主流做法，作为产品演进另立 #22）；不发空 `tools` 键；Responses 入口同修；L2 键序问题明确不修。

## 3. 行为 delta

- **修改**：Anthropic 翻译中 `tools` 过滤后为空时不再发送 `tools` 键（原发送空数组）。
- **修改**：`tool_choice` 具名映射后，若引用的工具不在幸存 tools 中则删除该键；幸存 tools 为空时无论选择类型（required / 具名 / auto / none）一律删除。检查在能力位映射之后统一应用，full 与 auto-only 两个能力位路径都生效。
- **修改**：Responses 翻译同两条规则（原还会发送空 `tools` 键 + 悬空具名 choice）。
- **不影响**：幸存自定义工具上的强制选择、`any`→`required` 映射、`none` 语义、错误信封、usage 语义、provider 私有层。

## 4. 影响范围与非目标

**受影响**：`src/protocols/anthropic.ts`、`src/protocols/protocols.test.ts`、`src/protocols/anthropic-assembly.test.ts`（新增 5 例）、`src/protocols/responses.ts`。

**本次明确不做**：网关自执行服务端工具（#22 评估）；显式 400 拒绝悬空形状；服务端工具结果块回填；`mapBody`/`respond` 双构建路径的键序统一；采集脱敏名单补充（`user-session-id` / `x-session-affinity`，独立任务）；语料评估器适配 schema 2。

**与相似度 L2 标准的关系**：GLOSSARY「相似度 L2（特性对等）」要求特性等价支持或显式拒绝、不允许静默丢弃。服务端执行工具当前被丢弃，是对 L2 的**已记录例外**（OpenAI chat 无对应类别）；收敛路径见 #22（自执行 = 等价支持，或显式拒绝）。本变更不扩大例外面，仅消除丢弃引发的矛盾形状。

## 5. 验证与观测

**失败测试先行**：`anthropic-assembly.test.ts` 新增 5 例（真实 web-search 形状悬空删除、混合幸存保留、混合悬空删除、全滤空删除、auto-only 两分支）；修复前实跑 **4 fail / 1 pass**（通过的那例是对幸存行为的回归守卫）。`protocols.test.ts` 新增 2 例 Responses 路由级（滤空删除、混合保留）。

**修复后全量**：`bun test` → **286 pass / 0 fail**（34 文件，1190 expect）；`bun build src/index.ts --target=bun` → 成功。

**实弹验证**（临时实例 `PORT=8788`，独立 `TRACE_CAPTURE_DIR=/tmp/a2a-livefire`，重放故障形状）：

| 形状 | 修复前基线（今日 trace） | 修复后 |
|---|---|---|
| 非流式 web-search 请求 | 502 + `InferHub.001001005.400` | **200**，合法 Anthropic message 信封 |
| 流式 web-search 请求 | 200 + `event: error`（同错误码） | **200**，正常 `message_start → message_delta → message_stop` 事件流 |
| L2 上游请求体 | `tools:[]` + 悬空强制 choice | **无 `tools` 键、无 `tool_choice` 键**（键集 `max_tokens/messages/model/stream/stream_options`） |

非流式响应 `stop_reason: max_tokens`（模型推理耗尽 1000 输出 token，文本为空）——与「无搜索能力下模型直接作答」的预期行为一致，属既有聚合语义，不在本变更范围。

**未做 / 待补**：`bun test` 中 4 例红灯到绿灯的过程截图未留存（终端输出即证据）；e2e 矩阵无服务端工具场景（#22 立项时一并考虑）。
