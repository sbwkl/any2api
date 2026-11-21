# CHG-0004 CodeBuddy 排队协议与限流错误映射

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/providers/codebuddy/client.ts`、`src/providers/codebuddy/openai.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)、[RFC-0001](../rfcs/RFC-0001-codebuddy-agent-simulation.md)

## 1. 摘要

补齐 CodeBuddy 的排队协议：上游返回 `code 6020`（排队中）时，读取 `retry_after`（或查询 `POST /v2/chat/queue/status`），等待后重试一次；`6021`（队列满）、`6022`（用户限流）、`14003`（模型资源限流）归一为 429。

## 2. 变更理由与证据

- **对应功能卡的问题/目标**：REQ-0001 G1/G2；排队是真实 IDE 的行为，首版直接返回错误会降低高峰可用性。
- **证据**：
  - 扩展 bundle：`CRAFT_QUEUE_WAITING(6020)` → `POST /v2/chat/queue/status`（body `{model}`，头 `X-Conversation-Request-ID`），`CRAFT_QUEUE_FULL(6021)`、`CRAFT_QUEUE_USER_LIMIT(6022)`；`14003 = MODEL_RESOURCE_EXCEEDS_LIMITED`。
  - 真实客户端在每个 `getChatCompletions` 前调用 `/v2/chat/queue/cancel`；本代理首版不主动取消（无排队上下文），只在收到 6020 时查询状态。
- **不做的后果**：高峰期收到 6020 时直接失败，而不是等待重试。

## 3. 行为 / AC delta

- **新增 R19**：When 上游返回 `code 6020`, the system shall 读取 `retry_after`（或调用 `/v2/chat/queue/status` 获取），等待后重试一次；若等待超过 `CODEBUDDY_QUEUE_TIMEOUT_MS`（默认 120000）或重试仍为 6020，返回 429；`code 6021/6022/14003` 映射为 429 并保留上游 message。
- **修改**：`postChat` 增加 `onQueue` 钩子（收到 6020 时调用）；`openai.ts` 在 6020 时查询排队状态并等待。
- **新增环境变量**：`CODEBUDDY_QUEUE_TIMEOUT_MS`（默认 120000）。

## 4. 影响范围与非目标

**受影响**

- `src/providers/codebuddy/client.ts`：新增 `fetchQueueStatus`、`sleep`；`postChat` 增加 `onQueue`。
- `src/providers/codebuddy/openai.ts`：6020 等待重试；6021/6022/14003 → 429。
- 测试：`client.test.ts`、`openai.test.ts` 新增排队用例。
- `README.md`：新增 `CODEBUDDY_QUEUE_TIMEOUT_MS`。

**本次明确不做**

- 主动调用 `/v2/chat/queue/cancel`（没有排队上下文，避免误取消其他会话）。
- 遥测、TLS 指纹、内置工具 schema。
- 排队位置的 UI 暴露（只在日志/错误中保留 code）。

## 5. 验证与观测

- `bun test` → **69 pass / 0 fail / 268 expect() calls**（11 个测试文件）。
- 单测覆盖：6020 → 查询状态 → 重试一次；`onQueue` 拒绝时不重试；6021 → 429；`fetchQueueStatus` 头/体/`retry_after` 解析。
- 真实排队场景未观测到（本机未触发 6020）；逻辑按 bundle 实测语义实现，待真实高峰验证。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 临时集成分支 `tmp/integration-codebuddy`（main + feat）→ 69 pass / 0 fail，build 通过，已删除。

## 6. 回滚方案

- **回滚方式**：移除 `onQueue` 钩子与 6020/6021/6022/14003 的 429 映射；`fetchQueueStatus` 可保留（不影响主路径）。
- **数据/配置兼容**：无持久化状态；`CODEBUDDY_QUEUE_TIMEOUT_MS` 仅影响等待上限。
- **回滚验证**：6020 返回错误而非等待；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 排队响应结构可能不同 | 读取不到 `retry_after` | 回退默认 5s；超时上限 120s；未知结构时返回 429 而不阻塞 |
| 等待期间用户已断开 | 延迟/资源占用 | 等待上限；只重试一次 |
| 真实 6020 未观测 | 行为未在真实高峰验证 | 记录为待验证；后续高峰观察 |

## 8. 关联与证据

- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 前置：[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)
- 代码：`src/providers/codebuddy/client.ts`、`openai.ts`
- 测试：`client.test.ts`、`openai.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 排队协议 + 限流错误映射；69 tests 全绿；临时集成分支通过；真实 6020 未观测（待验证） |