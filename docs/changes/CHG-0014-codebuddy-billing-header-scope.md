# CHG-0014 评审修复：计费头清理范围最小化，不改变其他 system 内容

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0013](CHG-0013-codebuddy-billing-header.md)

## 1. 摘要

[CHG-0013](CHG-0013-codebuddy-billing-header.md) 的评审指出：清理逻辑超出了 R34「只删计费头行、其他 system 内容不变」的范围——`sanitizeSystemText` 全局 `.trim()` 会改动所有 system 文本的首尾空白；空块过滤会连「本来就空」的 text 块一起删掉，若该块带 `cache_control`，显式缓存标记会丢失。

修复：把清理收窄为「只处理因删除计费头而变空的块/消息」，并移除全局 `.trim()`。不带计费头的客户端（OpenAI Chat / Responses / codearts）行为完全不变。

## 2. 变更理由与证据

- **问题 1（全局 trim）**：`system = "  keep me  "` 会被裁成 `"keep me"`；与 R34「不改变其他 system 内容」冲突。
- **问题 2（预置空块被删）**：`system = [{type:"text",text:"",cache_control:{type:"ephemeral"}}, ...]` 中的首块被整块移除，`applyPromptCacheControl` 的 `hasCacheControl` 再也看不到该显式标记。
- **问题 3（预置空 system 消息被删）**：`content: ""` 的 system 消息在 CHG-0013 下被丢弃；上游实测接受空 system（`system` 为 `[]`/`""`/`[{text:""}]`、system 消息 `content:""` 均 200），丢弃没有必要。
- **结论**：只需在「清洗前非空、清洗后为空」时丢弃，其余原样透传。

## 3. 行为 / AC delta

- **修改 R34**：仅当 system/developer 的文本块或消息**因删除计费头而变空**时不再发送；清洗前已为空的文本块、`content: ""` 的消息、其他 system 内容（含首尾空白）保持不变；`content` 为 `null` 或空数组的消息仍按 R30 丢弃（前置过滤先于清洗，system/developer 不例外）。
- **不改变**：计费头删除本身（CHG-0013 的 400 修复）、preamble 替换、工具调用、模型映射、codearts。

## 4. 影响范围与非目标

**受影响**

- `src/shared/system.ts`：去掉 `.trim()`。
- `src/providers/codebuddy/envelope.ts`：新增 `isTextBlock` / `isEmptyText` / `hasContent`；空块过滤改为「清洗前非空 && 清洗后为空」；system 消息丢弃同样以「清洗前后」为条件。
- 测试：`src/providers/codebuddy/envelope.test.ts`（+4 例）。
- 文档：REQ R34、本 CHG。

**本次明确不做**

- 不改计费头正则（仍只匹配行首，行中间出现的情况已在 CHG-0013 列为非目标）。
- 不改 codearts 与其他 provider。

## 5. 验证与观测

- 单元测试：`bun test` → **118 pass / 0 fail / 400 expect() calls**（14 个文件）。
- 构建：`bun build src/index.ts --target=bun` → 成功（131.32 KB）。
- 新增用例：
  - 无计费头时首尾空白原样保留；
  - 预置空 text 块（带 `cache_control`）原样保留；
  - 预置空 system 消息（`content: ""`）原样保留；
  - `content` 为 `[]`（system 与 developer）或 `null` 的消息按 R30 丢弃；
  - CRLF 计费头行被删除，其余文本与行尾符不变。
- 真实 Claude Code e2e（本分支代码，:8788 临时实例）→ **200**，`is_error:false`、`result:"OK"`。
- 未部署；分支 `feat/codebuddy-billing-header-scope` 待用户审核。

## 6. 回滚方案

- **回滚方式**：恢复 CHG-0013 的 `.trim()` 与无条件空块过滤。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：`bun test` 通过；Claude Code 会话仍 200（计费头仍被删除）。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 计费头行之外只剩空白时，块内容为 `"\n"` 而非 `""` | 该块被丢弃（清洗前非空） | 符合预期；单独验证过上游接受空块，但这里按 R34 语义丢弃更干净 |
| 行中间出现 `x-anthropic-billing-header:` | 仍可能 400 | CHG-0013 已列为非目标；实测 Claude Code 为独立行 |

## 8. 关联与证据

- 评审意见：CHG-0013 第 1 条（低）。
- 代码：`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`
- 测试：`src/providers/codebuddy/envelope.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 清理范围最小化；116 tests；Claude Code e2e 200；未部署 |