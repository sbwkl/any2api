# CHG-0002 CodeBuddy 协议适配层（Anthropic Messages + Responses）、旁路信号与模型目录

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/providers/codebuddy/`
功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
关联：[RFC-0001](../../design-docs/rfcs/codebuddy-agent-simulation.md)、[CHG-0001](CHG-0001-codebuddy-provider-initial.md)

## 1. 摘要

补齐 CodeBuddy provider 的协议面：`POST /codebuddy/v1/messages`（Anthropic Messages，Claude Code / Claude Desktop）与 `POST /codebuddy/v1/responses`（OpenAI Responses，Codex CLI），把可选的消息中心轮询与自动刷新开关接入 provider，并用本机云端产品缓存（`cloud_product_config_cache`）补齐模型目录。首版已完成的 OpenAI Chat / Models 行为不变。

## 2. 变更理由与证据

- **对应功能卡的问题/目标**：REQ-0001 G1；让 CodeBuddy 像 codearts 一样同时服务 OpenAI Chat、Anthropic Messages、Responses 三类客户端。
- **触发原因**：用户 2026-11-20 要求完成剩余开发；CHG-0001 已把这两个适配层列为后续 CHG。
- **证据**：
  - 真实上游只支持流式（`stream:false` → `code 11101`），代理在非流式客户端侧聚合；流式客户端由适配器翻译事件。
  - 真实实测：Anthropic 非流式返回 `content:[{type:"text",text:"OK"}]`、`stop_reason:end_turn`；Responses 非流式返回 `object:"response"`、`status:completed`；两者流式均产生对应事件。
  - 消息中心：`GET /v2/msg-center/message/summary`，30s，带 `uid/tenant_id/product_code`（本机日志 + 实测 200）。
- **不做的后果**：CodeBuddy 只能接 OpenAI Chat 客户端，Claude Code / Codex 无法直连，与 codearts 的协议覆盖不一致。

## 3. 行为 / AC delta

- **新增 R12**：When 收到 `POST /codebuddy/v1/messages`, the system shall 将 Anthropic Messages 请求转换为 OpenAI chat 请求（system、text/thinking/tool_use/tool_result 块、tools、tool_choice、max_tokens、stop_sequences），并把响应转换回 Anthropic message（非流式）或 Anthropic SSE（流式）。
- **新增 R13**：When 收到 `POST /codebuddy/v1/responses`, the system shall 将 Responses 请求转换为 OpenAI chat 请求（instructions、input 的 message/function_call/function_call_output、tools、reasoning.effort、max_output_tokens），并把响应转换回 Responses object（非流式）或 Responses SSE（流式）。
- **新增 R14**：Where `CODEBUDDY_MSG_CENTER=1`, the system shall 每 30s 调用 `/v2/msg-center/message/summary`，使用当前凭证；失败静默，不影响 chat。
- **新增 R15**：Where `CODEBUDDY_AUTO_REFRESH=0`, the system shall 不在 401 时自动刷新 token（默认仍自动刷新并重试一次）。
- **修改 R1**：模型列表来源由「product.json + agent models + 观测模型」改为「优先本机 `state.vscdb` 的 `cloud_product_config_cache`（按 uid 匹配，缺失时取最新一条），失败回退 product.json + agent models + 观测模型」。
- **修改 R5**：客户端未指定 `tools` 时由「使用所选 profile 的默认工具集」改为「不发送 tools」（首版不包含内置默认工具集，profile 只影响系统提示词）。理由：工具 JSON schema 尚未逐字还原，宁可少发也不发错误 schema；客户端需要工具时显式传 `tools`。
- **修改**：REQ-0001 §9 的「首版范围」由「只 OpenAI Chat + Models」更新为「首版 + 协议适配（CHG-0002）」。

## 4. 影响范围与非目标

**受影响**

- 新增 `src/providers/codebuddy/anthropic.ts` + 测试：请求/响应/SSE 翻译。
- 新增 `src/providers/codebuddy/responses.ts` + 测试。
- 新增 `src/providers/codebuddy/msgcenter.ts` + 测试（可选，默认关闭）。
- 修改 `openai.ts`：抽出 `respond()` 跨协议管线；`getCredentials()`；`CODEBUDDY_AUTO_REFRESH` 开关。
- 修改 `config.ts`：读取 `cloud_product_config_cache`（非密钥）补齐 24 个模型与 agent 绑定；支持 `CODEBUDDY_STATE_DB` / `CODEBUDDY_PRODUCT_CACHE=0`。
- 修改 `index.ts`：注册 `/codebuddy/v1/messages`、`/codebuddy/v1/responses`；`CODEBUDDY_MSG_CENTER=1` 时启动轮询；`loadProductConfig(uid)`。
- 修改 `README.md`：CodeBuddy 端点与环境变量。
- 不改 codearts。

**本次明确不做**

- 遥测 `/v2/report`、`/llm/data/report`、`/v1/traces`（payload 未完全还原，伪造反而增加风险）。
- TLS/JA3 指纹伪装（Bun vs Electron 残余差异）。
- 排队协议见 [CHG-0004](CHG-0004-codebuddy-queue.md)（本轮不做）。
- 内置工具 schema（工具仍只来自客户端 `tools`）。

## 5. 验证与观测

- 自动化：`bun test` → **47 pass / 0 fail / 210 expect() calls**（9 个测试文件）。
- 模型目录：`loadProductConfig(uid)` → **24 个模型**（`auto/hy4std/hy4flash/hy4flash-free/...`），agent 绑定与云端缓存一致；`hy4std` 真实非流式调用返回 200（上游 model `hy4`）。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 真实上游（不启动服务，脚本直调 facade）：
  - Anthropic 非流式：`content=[{type:"text",text:"OK"}]`、`stop_reason=end_turn`、usage 正确。
  - Responses 非流式：`object=response`、`status=completed`、output 含 reasoning + message。
  - Anthropic 流式：`message_start` / `message_delta` / `message_stop`。
  - Responses 流式：`response.created` / `response.output_item.added` / `response.reasoning_summary_text.delta`。
- 未做：服务端重启/部署、7 天稳定性、真实 401 演练。

## 6. 回滚方案

- **回滚方式**：从 `index.ts` 移除两条路由与三个 import；删除 `anthropic.ts`、`responses.ts`、`msgcenter.ts` 及测试。`openai.ts` 的 `respond()` 拆分是向后兼容的，保留不影响 Chat。
- **数据/配置兼容**：无持久化状态；消息中心默认关闭，回滚不改变运行时流量。
- **回滚验证**：`/codebuddy/v1/chat/completions` 与 `/codebuddy/v1/models` 仍正常；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| Anthropic `tool_choice: any/tool` | 上游只支持 auto | 映射为 auto；Claude Code 的工具循环仍可用 |
| `thinking` 未开启时不返回 thinking 块 | Claude 客户端可能期望 reasoning | 按 Anthropic 语义只在 `thinking.enabled` 时输出；非流式同规则 |
| Responses reasoning summary 形态 | Codex 可能依赖 `response.reasoning_summary_text.delta` | 已实现；以真实 Codex 回归为准（未部署验证） |
| 自动刷新会轮换 refresh token | 可能导致 IDE 下次刷新失效 | 默认开启；`CODEBUDDY_AUTO_REFRESH=0` 可关闭；写回 Keychain 未实现（后续） |
| 消息中心轮询 | 默认关闭；开启后每 30s 一次请求 | 失败静默；不影响 chat |
| 模型目录 | 云端缓存按 uid 匹配；缓存缺失/损坏时回退 | 读取失败回退 product.json + agent models + 观测模型；`CODEBUDDY_PRODUCT_CACHE=0` 可强制回退 |

## 8. 关联与证据

- 功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
- 技术方案：[RFC-0001](../../design-docs/rfcs/codebuddy-agent-simulation.md)
- 前置：[CHG-0001](CHG-0001-codebuddy-provider-initial.md)
- 后续：Anthropic/Responses 适配已抽到共享 `src/protocols/`，SSE 抽到 `src/shared/sse.ts`，codearts 与 codebuddy 均已切换，见 [CHG-0003](CHG-0003-provider-registry-protocols.md)。
- 协议规格：[protocol-spec](../../../src/providers/codebuddy/protocol-spec.md)
- 测试：`src/providers/codebuddy/anthropic.test.ts`、`responses.test.ts`、`msgcenter.test.ts`、`openai.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 实现 Anthropic/Responses 适配 + msg-center + auto-refresh 开关 + 云端模型目录；47 tests 全绿；真实上游四类调用与 `hy4std` 实测；未部署 |
