# 修复三协议 usage 字段语义（Anthropic / OpenAI Chat / Responses）

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/protocols/`、`src/shared/`
功能卡：[CodeBuddy provider](../../product-specs/codebuddy-provider.md)
关联：[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)、[CHG-0003](CHG-0003-provider-registry-protocols.md)

## 1. 摘要

修复共享协议层的 token usage 语义：Anthropic 的 `input_tokens` 只表示未缓存输入，必须扣除 `cache_read_input_tokens` 与 `cache_creation_input_tokens`；OpenAI Chat 聚合保留 `prompt_tokens_details.cache_creation_tokens`；Responses 流式初始 usage 带完整 details 字段。

## 2. 变更理由与证据

- **现象**：CC Switch 统计异常。本地记录显示 `proxy_request_logs` 中 `input_tokens≈19.5 万` 与 `cache_read_tokens≈18.7 万` 并存；按 Anthropic 规范 `input_tokens` 应为未缓存部分，缓存部分重复计入全价输入。
- **上游字段**：CodeBuddy 实测 `prompt_tokens` 为总输入；`prompt_tokens_details.cached_tokens` 为缓存读取。项目 protocol-spec 已记录后者，但 Anthropic 映射未扣除。
- **客户端行为**：本机 Claude Code 2.1.319 的 SDK 代码在 `message_delta` 合并 `usage.input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`；本机 CC Switch 记录中也有非零 token，说明问题不是『完全没收到 usage』，而是语义与后续定价/汇总。
- **不改的部分**：不修改上游字段；不伪造 `cache_creation_tokens`（上游规格未记录该字段，缺失时按 0）；不改变 CC Switch 数据库与定价配置。

## 3. 行为 / AC delta

- **修改**：Anthropic 非流式与流式 usage 统一由 `anthropicUsage` 映射：`input_tokens = max(0, prompt_tokens - cached_tokens - cache_creation_tokens)`。
- **修改**：OpenAI Chat 聚合 `mapUsage` 保留 `prompt_tokens_details.cache_creation_tokens`。
- **修改**：Responses 流式初始 `usage` 包含 `input_tokens_details.cached_tokens` 与 `output_tokens_details.reasoning_tokens`。
- **不影响**：请求映射、工具调用、错误结构、模型池、codebuddy 系统清洗。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/anthropic.ts`
- `src/protocols/responses.ts`
- `src/shared/sse.ts`
- 对应三个测试文件；产品规格与 protocol-spec；本变更记录。

**本次明确不做**

- 不改变 CC Switch 的模型定价与日汇总逻辑（属于 CC Switch 配置/应用侧）。
- 不为只读 `message_start` 的客户端缓冲整个流（延迟输出会改变首字节行为，另开变更评估）。
- 不伪造或推断上游未提供的 `cache_creation_tokens`。

## 5. 验证与观测

- 新增失败测试先行：Anthropic `input_tokens` 原为 31，应为 22；`response.created.usage.input_tokens_details` 原为 undefined；`mapUsage` 原丢弃 `cache_creation_tokens`。
- 修复后：`bun test src/providers/codebuddy/anthropic.test.ts src/shared/sse.test.ts src/providers/codebuddy/responses.test.ts` → 29 pass / 0 fail。
- 全套：`bun test` → 131 pass / 0 fail / 438 expect() calls（15 个测试文件）。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 未做：真实上游回归（本机限流 429，重置时间 2026-11-24 16:29:08 UTC+8）；CC Switch 定价配置与 UI 统计复查。

## 6. 回滚方案

- **回滚方式**：revert 本变更提交；无需数据迁移。
- **数据/配置兼容**：无持久化状态变化；回滚后 Anthropic 恢复旧语义（输入 token 为上游总 prompt tokens）。
- **回滚验证**：`bun test` 通过；Anthropic 响应 usage 与旧版本一致。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 上游若改为 Anthropic 语义（prompt_tokens 已排除缓存） | 再扣除会少算 input_tokens | 以协议规格与实测为事实源；上游变更时更新映射并补测试 |
| `message_start.usage.input_tokens` 仍为 0 | 只读 `message_start` 的客户端仍看不到正确输入量 | 当前只支持合并 `message_delta` 的客户端；缓冲方案另评估 |
| CC Switch 成本仍为 0 | 定价缺失与日汇总未更新不是代理代码问题 | 在 CC Switch 配置 `hy4flash-free` 定价并重建汇总 |
| CodeBuddy 无 `cache_creation_tokens` 证据 | 当前字段为 0，不影响结果 | 标记「待验证」；不伪造数值 |

## 8. 关联与证据

- 产品规格：[codebuddy-provider.md](../../product-specs/codebuddy-provider.md)
- 协议规格：[protocol-spec](../../../src/providers/codebuddy/protocol-spec.md)
- 变更记录：[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)、[CHG-0003](CHG-0003-provider-registry-protocols.md)

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | TDD 红灯→绿灯；131 tests 全绿；build 成功；未部署 |
