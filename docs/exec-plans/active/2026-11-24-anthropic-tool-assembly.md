# 修复 Anthropic 消息组装：图片丢失、工具调用拆分与静默空回答

类型：修复（跨 provider 共享协议层）
状态：开发中（本地验证通过，未合并）
Owner：wayne
所属模块/入口：`src/protocols/anthropic.ts`、`src/shared/sse.ts`
关联：[R12 / R21 / R29](../../product-specs/codebuddy-provider.md)、[CHG-0007](CHG-0007-responses-null-content.md)、[CHG-0008](CHG-0008-responses-parallel-tool-calls.md)

## 1. 摘要

`/v1/messages` 适配层把一次 Anthropic 消息翻译成多条 OpenAI 消息，并在此过程中丢掉三类信息，最终表现为客户端里「助手只宣布一句要做的事、没有任何工具调用、`stop_reason: end_turn`」。本变更修四件事：**图片真正送达上游**；**同一轮文本与 `tool_calls` 保持同一条 assistant 消息**；**工具调用/结果配对修复**（悬空调用补合成结果、孤立结果降级为用户文本）；**上游错误与空流不再伪装成正常空回答**。

## 2. 变更理由与证据

真实故障现场（本机 Claude Code 2.1.330，会话 `e99811f6-…`，cwd `/Users/wayne/workspace/perch`）：

- 第 946–955 条记录：模型用 Bash 驱动 GUI 并 `Read` 了 `/tmp/seclick.png`；工具结果里是**一张 530KB 的 base64 截图**。
- 第 956 条是故障回合：模型输出「Coordinates via screenshot are unreliable here. Let me use the accessibility tree…」，无工具调用，`stop_reason: end_turn`。
- 前一条工具结果经适配层后变成字符串 `"[image omitted]"`（旧 `contentToOpenAi` 的 `case "image"` 分支）。**模型确实拿不到图**，因此它看到的历史是「我读了一张图，结果只有一行占位符」，接着只能再宣布一次动作。

用同一份真实历史构造 `/v1/messages` 请求（40 条消息、4 个工具、1.18MB），对同一上游做 A/B：

| 路径 | 截图类提问的回答 |
|---|---|
| 旧实现 | 「我看不到这张截图，因为图片在消息里被省略了，没能传过来」 |
| 新实现 | 「红色按钮位于窗口左上角，是 macOS 三个窗口控制按钮中最左侧的关闭按钮」 |

其余三项的证据：

- **工具调用拆分**：旧实现把同一轮的 `text` 与 `tool_use` 拆成两条 assistant 消息（先是只有 `content` 的一条，再是只有 `tool_calls` 的一条）。真实历史中这一轮工具调用 20 次、文本 20 段，全部被拆成 40 条消息。
- **工具结果分解**：旧实现把 `tool_result` 的内容里非 `text` 块整段丢弃（截图工具结果 → 空字符串），且 `tool_use` 后直接跟 user 文本时不补结果。
- **静默空回答**（已在本次修复前的审计中实测确认）：上游把错误塞进 HTTP 200 的 SSE（`{"text":"[DONE]","error_code":"InferHub.001001014.406","error_msg":"Tool type is invalid"}`）时，旧实现因为没有 choices 而直接发 `message_delta{stop_reason:"end_turn"}` 收尾，客户端把一次上游失败当成「模型正常说完了一句话」。

## 3. 行为 / AC delta

- **修改**：`image` 块（含 `tool_result` 内嵌图片）映射为 OpenAI `image_url`（base64 → `data:` URL，url 源原样）。仅当 `source` 缺失或类型未知时写占位文本，并在占位符里带上源类型以便诊断。
- **修改**：同一轮 Anthropic 消息始终产出**一条** assistant 消息，同时携带文本、`reasoning`（来自 `thinking` 块）与 `tool_calls`；assistant 轮中的 `tool_result` 排在该消息之后。
- **修改**：`tool_result` 块内的文本与图片按原顺序合并；只含文本时仍是字符串（保持旧形态）。
- **新增**：`normalizeToolPairs` 修复配对——未收到结果的 `tool_use` 补一条合成 tool 消息（内容说明该调用未返回、应视为失败）；找不到对应调用的 `tool_result` 降级为 user 文本而不是裸 tool 消息；user 文本夹在未闭合调用中间时先补齐再继续。
- **新增**：末尾 user 轮被翻译成空时补 `(no content)` 占位，避免请求以 assistant 结尾被上游当作预填续写。
- **修改**：`content_filter` 映射为 Anthropic `refusal`（原为 `end_turn`）。
- **修改**：流式 `thinking: {type:"adaptive"}` 也输出 thinking 块（原只认 `enabled`，而翻译层已把 adaptive 换成 `reasoning_effort`，推理内容被整段丢弃）。
- **修改**：`tool_use` 的 `content_block_start` 携带 `input: {}`（Anthropic 规范要求起始为空对象），后续以 `input_json_delta` 填充。
- **新增**：上游 SSE 帧带 `error_code`/`error_msg`（或 `error.{code,message}`）且无 choices 时，转为 Anthropic `error` 事件；整条流没有任何 choices 时同样报错。两者都不再发 `end_turn`。
- **不影响**：请求体校验、模型解析、usage 语义（R37）、错误信封归一化、Responses 路径、provider 私有逻辑。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/anthropic.ts`
- `src/shared/sse.ts`（新增 `upstreamErrorFromChunk`，供三协议共用）
- `src/protocols/anthropic-assembly.test.ts`（新增 15 条回归测试）
- `src/providers/codebuddy/anthropic.test.ts`（原断言「文本与工具调用拆两条消息」，与本次修复相反，改为断言合并）
- 产品规格 R12 / R21 / R29 的验收细化；本变更记录。

**本次明确不做**

- 不做图片压缩/降采样。历史里一张 530KB 的 base64 会让请求体从 12KB 涨到 1.18MB；上游是否接受该体积**待验证**（本次实测 codearts `deepseek-v4.1-flash-1017` 接受并正确识别图片内容）。
- 不改 codearts / codebuddy 的 provider 私有层（`mapBody`、envelope 清洗）。
- 不新增 Anthropic `stop_sequence` 回传：当前上游 stop 字符串不回传，保持 `null`。
- 不处理 `redacted_thinking`、`server_tool_use`、`web_search_tool_result` 等 provider 执行型块（本仓库目前只对接 chat 形态上游）。

## 5. 验证与观测

- **失败测试先行**：`src/protocols/anthropic-assembly.test.ts` 共 15 条，覆盖文本+工具同一消息、并行调用、结果顺序、悬空调用、孤立结果、顶层图片、工具结果内嵌图片、thinking 回放、空 user 轮、无文本 assistant 轮、`input: {}`、adaptive thinking、`refusal`、in-band 错误、空流。修复前这些用例均为红（旧实现下 13 条失败）。
- **全套测试**：`bun test` → **151 pass / 0 fail / 487 expect() calls**（16 个文件）。
- **构建**：`bun build src/index.ts --target=bun` → 成功。
- **真实上游 A/B**（同一请求分别打到旧进程 8787 与新进程 8788）：
  - `/codearts/v1/messages` 真实历史回放（40 条消息、1.18MB）：两侧都是 `stop_reason=tool_use`，工具调用参数正常（旧实现给出的是与历史无关的 `ls`，新实现续上了用户正在做的 GUI 点击动作）。
  - 图片投递（`/codearts/v1/messages`，`deepseek-v4.1-flash-1017`）：旧实现 4/4 回答「图片被省略/看不到」，新实现 4/4 正确描述截图内容（红色元素位置）。
  - 工具配对 4 组（悬空后重试、文本+调用、孤立结果、正常配对）：新旧都不报协议错误，新实现不再出现「工具调用数翻倍」「孤立结果被当作裸 tool 消息」的形态。
  - codearts `/v1/chat/completions` 直连（不经过本次改动的组装层）作为对照：同一张截图也能正确描述。
- **未做**：Claude Code 客户端端到端复现（需要在真实 GUI 任务里重跑一遍完整会话）；codebuddy 图片路径的模型侧行为不稳定（同一张图纯文本提问也会编造截图内容），因此不以 codebuddy 作为图片投递的判定依据。

## 6. 回滚方案

- **回滚方式**：revert 本变更提交；无数据迁移、无配置变更。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：`bun test` 通过；`/v1/messages` 恢复旧组装行为（图片占位、工具调用拆分）。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 图片随历史反复回放，请求体可达数 MB | 上游可能拒绝或显著变慢；本次实测单张 530KB 截图可用，**更大体积未验证** | 需要真实长会话观测；必要时另开变更做降采样/丢弃旧图 |
| 合成 tool 结果内容为英文固定句 | 中文会话里模型可能用英文确认 | 语义无害（明示调用失败）；如需本地化另议 |
| 孤立 `tool_result` 降级为 user 文本 | 极少数客户端可能把该文本当成用户发言 | 优于上游以未知 `tool_call_id` 拒绝整个请求 |
| codebuddy 模型对图片的响应不稳定 | 无法用 codebuddy 判定图片投递正确性 | 以 codearts 实测为准；codebuddy 侧**待验证** |
| 真实客户端端到端未复现 | 不能声称「客户端里不再出现只宣布不执行」 | 需要在真实 GUI 任务中重跑验证 |

## 8. 关联与证据

- 产品规格：[codebuddy-provider.md](../../product-specs/codebuddy-provider.md)（R12、R21、R29）
- 上游证据：本机会话 transcript `/Users/wayne/.claude/projects/-Users-wayne-workspace-perch/e99811f6-8fe7-4bf2-8c0f-244c90e96efb.jsonl`，第 946–958 条
- A/B 脚本与回放数据保留在 `/tmp/a2a-audit/`（`replay_messages.py`、`ab_messages.mjs`、`img_anthropic.mjs`、`pairs.mjs`）；属于临时工作区，不入库

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 15 条新测试 TDD 红→绿；151 tests 全绿；build 成功；真实上游 A/B 已完成；未合并、未部署 |