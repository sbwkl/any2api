# CHG-0012 评审修复：协议层作用域、max tokens 互斥、cache 策略、空值过滤

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/shared/cache.ts`、`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0009](CHG-0009-codebuddy-system-sanitize.md)、[CHG-0010](CHG-0010-codebuddy-peer-audit.md)、[CHG-0011](CHG-0011-codebuddy-cache-and-model-404.md)

## 1. 摘要

按评审修复 7 项：

1. **协议层 system sanitize 作用域**：从共享 `protocols/anthropic.ts`、`responses.ts` 移除 sanitize，统一由 codebuddy 的 `normalizeMessages` 处理；共享层不再对 provider 做专属改写。`sanitizeSystemText` 改为全局替换。
2. **thinking → reasoning_effort**：codearts 也通过 `createProtocolRoutes` 使用共享协议层，之前的 thinking 映射会改变 codearts 行为。修复：新增 `thinkingToEffort` / `thinking` 能力开关；codebuddy 开启，codearts 关闭（保持原行为）。
3. **max_tokens / max_completion_tokens 互斥**：客户端给 `max_completion_tokens` 时不再同时写 `max_tokens`。
4. **cache_control 逐条判断**：去掉「任一消息有 cache_control 就整体跳过」的早退；每个目标消息单独判断。
5. **cache_control 选最长 system**：不再只处理第一条 system；agent 提示词 + 客户端长 system 时，缓存客户端的长 system。
6. **off effort 语义统一**：R29 与实现/测试一致（无 supported → low；有 supported → 就近，可能 high）。
7. **空消息过滤**：`content` 为 `null` 或空数组且无 tool_calls 时也丢弃；空字符串仍保留。

## 2. 变更理由与证据

- **触发原因**：架构评审（7 项，3 个中优先级 + 4 个低优先级）。
- **证据**：
  - 评审探针：`buildRequestBody` 同时输出 `{max_tokens:64000, max_completion_tokens:123}`；
  - `applyPromptCacheControl` 在任一消息有 cache_control 时整体返回；只处理第一条 system；
  - `normalizeMessages` 的 `content !== undefined` 放过 `null` / `[]`；
  - `sanitizeSystemText` 无 `g` 标志，只替换第一处；
  - codearts 通过 `createProtocolRoutes` 复用共享层；本轮用 `thinking:false, thinkingToEffort:false` 保持其行为。
- **不做的后果**：跨 provider 行为泄漏、上游 400、缓存失效、客户端上限失效、空消息触发 400。

## 3. 行为 / AC delta

- **新增 R33**：When 客户端提供 `max_completion_tokens`, the system shall 不发送 `max_tokens`（二者互斥）；未提供时按模型类型选择 `max_tokens` 或 `max_completion_tokens`。
- **修改 R29**：`disabled/off` → 按模型 `reasoning.supportedEfforts` 钳制（无列表时 low；有列表时就近，可能 high）。
- **修改 R30**：丢弃 `content` 为 `null`/空数组且无 `tool_calls` 的消息；空字符串 `content: ""` 保留。
- **修改 R31**：对**最长的一条 system** 与最后一条 user 逐条判断；消息已有显式 `cache_control` 时只跳过该消息，不影响其他消息。
- **修改**：共享协议层不再做 sanitize；由 codebuddy `normalizeMessages` 统一处理，codearts 不做 sanitize。

## 4. 影响范围与非目标

**受影响**

- `src/shared/cache.ts`：逐条 cache_control、最长 system。
- `src/shared/system.ts`：全局替换。
- `src/providers/codebuddy/envelope.ts`：max tokens 互斥、null/空数组过滤。
- `src/protocols/types.ts`：`thinking` / `thinkingToEffort` 能力开关。
- `src/providers/codearts/index.ts`：关闭 thinking/thinkingToEffort；`src/providers/codebuddy/index.ts`：开启。
- `src/protocols/anthropic.ts`、`responses.ts`：移除 sanitize（共享层通用）。
- 测试：`cache.test.ts`、`envelope.test.ts`、`protocols.test.ts`。
- 文档：REQ R29/R30/R31/R33、本 CHG、CHG-0009/0010 注记。

**本次明确不做**

- codearts 的旧 anthropic/responses 已删除（共享层统一）。
- TLS、遥测、排队、图片、内置工具 schema。
- 多账号/缓存池。

## 5. 验证与观测

- `bun test` → **110 pass / 0 fail / 383 expect() calls**（14 个测试文件）。
- 新增/更新测试：
  - max_completion_tokens 时 max_tokens 为 undefined；
  - cache_control 逐条：一个显式 cache_control 不阻止其他消息自动添加；
  - cache_control 选最长 system（agent 短 system + 客户端长 system）；
  - null / 空数组 content 被丢弃，空字符串保留；
  - sanitize 全局替换两处 preamble；
  - off + supportedEfforts ["high"] → high；无 supported → low。
- `bun build src/index.ts --target=bun` → 成功。
- 临时集成分支 `tmp/integration-codebuddy`（main + feat）→ **110 pass / 0 fail**，build 通过，已删除。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：`git revert` 本变更；恢复共享层 sanitize、全局 cache 早退、max tokens 双写、null/空数组放行。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：110 tests 回退；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 共享层不再 sanitize | 其他 provider 若复用共享层需自行处理 | codebuddy `normalizeMessages` 已覆盖；codearts 不做 sanitize（保持原行为） |
| 最长 system 缓存 | 只缓存一条 system | agent + 客户端长 system 场景下选客户端长 system；多条长 system 只缓存最长一条 |
| max tokens 互斥 | 客户端同时传两个字段时只保留 max_completion_tokens | 符合 OpenAI 语义；避免上游 400 |
| null/空数组丢弃 | 某些客户端用空数组表示空消息 | 空字符串仍保留；null/空数组无内容，丢弃 |
| off 钳制为 high | 客户端想关闭 thinking 但模型不支持 | 与 IDE 行为一致；文档明确 |

## 8. 关联与证据

- 评审：7 项发现（P0/P1）。
- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 代码：`src/shared/cache.ts`、`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`、`src/protocols/`
- 测试：`cache.test.ts`、`envelope.test.ts`、`protocols.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 7 项评审修复 + 复审 3 项；110 tests 全绿；临时集成分支通过；未部署 |