# CHG-0003 any2api provider 注册表与共享协议层

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/registry.ts`、`src/protocols/`、`src/shared/sse.ts`、`src/index.ts`、`src/providers/*/index.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[RFC-0001](../rfcs/RFC-0001-codebuddy-agent-simulation.md)、[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)

## 1. 摘要

按架构评审重构 provider 边界：

1. **静态注册表 + 相对路由**：provider 不再知道自己的公开前缀；`src/index.ts` 不再硬编码 if/else；新增 provider 只加一行注册。
2. **统一 404/405/503 + 聚合 health**：最长前缀 + 路径边界匹配，`/healthz` 聚合各 provider 状态。
3. **共享协议层**：Anthropic Messages / Responses 适配抽到 `src/protocols/`，只依赖 `ChatBackend`；provider 差异用 `ProtocolCapabilities` 表达（`toolChoice`、`errorShape`、`thinking`），共享层不出现 `provider.name` 判断。
4. **共享 SSE**：`sseData` / `aggregateSseToCompletion` 抽到 `src/shared/sse.ts`。

本轮 **codebuddy 与 codearts 均切到共享协议层**；codearts 的私有 anthropic/responses/SSE 副本已删除，协议差异通过 capabilities 表达。

## 2. 变更理由与证据

- **触发原因**：架构评审指出四个耦合点——入口硬编码、provider 感知挂载点、启动失败策略靠调用点约定、协议层重复。
- **证据**：
  - `src/index.ts` 的 `if /codebuddy → codebuddy else → codearts`；
  - codebuddy 路由写死 `/codebuddy`、codearts 写死 `/v1`；
  - codearts 失败退出、codebuddy 失败 503 由入口 try/catch 决定；
  - codebuddy 与 codearts 的 anthropic/responses/SSE 各自一份。
- **不做的后果**：新增 provider 的边际成本是「1 份路由 + 2 份协议 + 1 份 SSE」，协议差异会继续复制。

## 3. 行为 / AC delta

- **新增 R16**：When 服务启动, the system shall 通过注册表按 provider 前缀分发路由；匹配使用最长前缀 + 路径边界（`prefix` 或 `prefix + "/"`），未知路径返回 404，已知路径错误方法返回 405，可选 provider 不可用时其前缀返回 503，`required` provider 创建失败时进程退出。
- **新增 R17**：The system shall 通过共享协议层（`src/protocols/`）提供 Anthropic Messages 与 Responses 路由；provider 差异通过 `ProtocolCapabilities`（`toolChoice`、`errorShape`、`thinking`）表达，共享层不得按 provider 名称分支。
- **新增 R18**：When 收到 `GET /healthz`, the system shall 返回聚合 JSON（`{ok, providers:[...]}`），其中每个 provider 报告 `ok` 与可选详情。
- **修改**：`/healthz` 由 codearts 的纯文本 `ok` 改为聚合 JSON（调用方应使用 JSON 解析）。
- **不改变**：`/v1/*`（codearts）与 `/codebuddy/v1/*`（codebuddy）的路径、请求/响应语义；codebuddy 的模型目录、Anthropic/Responses 行为。

## 4. 影响范围与非目标

**受影响**

- 新增 `src/registry.ts` + `src/registry.test.ts`。
- 新增 `src/protocols/{index,types,anthropic,responses}.ts`。
- 新增 `src/shared/sse.ts`；移动 `sse.test.ts` 到 `src/shared/`。
- 修改 `src/index.ts`：注册表启动。
- 修改 `src/providers/codearts/index.ts`：改为 `codeartsProvider`（prefix=""、required），路由来自 `createProtocolRoutes`；`start()` 用注册表。
- 修改 `src/providers/codearts/openai.ts`：SSE 聚合改 import 共享实现。
- 删除 `src/providers/codearts/{anthropic,responses}.ts`（已由共享层替代）。
- 修改 `src/providers/codebuddy/index.ts`：改为 `codebuddyProvider`（prefix="/codebuddy"、required=false），路由来自 `createProtocolRoutes`。
- 修改 `src/providers/codebuddy/openai.ts`：SSE 聚合改 import 共享实现。
- 修改 `src/providers/codebuddy/envelope.ts`：`mapUsage`/`mapFinishReason` 改为从共享 SSE 模块 re-export。
- 删除 `src/providers/codebuddy/{anthropic,responses,sse}.ts`（已由共享层替代）。
- 新增 `src/protocols/protocols.test.ts`（codearts full/passthrough 能力契约）。
- 修改 `README.md`：结构与新增 provider 说明、`/healthz` 语义。

**本次明确不做**

- 无（本轮完成 codebuddy 与 codearts 的协议层迁移）。
- Hono / 自动发现 / 独立进程（评审结论：不急）。
- 遥测、TLS 指纹、排队协议（沿用 CHG-0002 的非目标）。

## 5. 验证与观测

- 自动化：`bun test` → **64 pass / 0 fail / 251 expect() calls**（11 个测试文件）。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 注册表实测（脚本直调 `mountProviders`，不启动服务）：
  - `/healthz` → 200，`codearts:true, codebuddy:true`；
  - `/codebuddy/v1/models` → 200，24 个模型；
  - `/codebuddy/v1/chat/completions` → 200，content `OK`；
  - `/codebuddy/v1/messages` → 200，Anthropic message；
  - `/codebuddy/v1/responses` → 200，Responses object；
  - `/v1/models` → 200，12 个 codearts 模型；
  - `/v1/messages` → 200，Anthropic message（glm-5.3-flash）；
  - `/v1/responses` → 200，Responses object（glm-5.3-flash）。
- 临时集成分支 `tmp/integration-codebuddy`（从 main 合入 feat）→ **64 pass / 0 fail**，`bun build` 通过，分支已删除。
- 未做：服务端重启/部署、7 天稳定性。

## 6. 回滚方案

- **回滚方式**：`git revert` 本变更的 commit；恢复 `src/index.ts` 的注册表前版本与各 provider 的 `createHandler` 路由；共享 `protocols/`、`shared/sse.ts` 可保留（不影响旧路径），也可一并删除。
- **数据/配置兼容**：无持久化状态；`/healthz` 响应格式回退为 codearts 的纯文本 `ok`。
- **回滚验证**：`/v1/models`、`/codebuddy/v1/models`、`/healthz` 恢复；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| codearts 协议路径迁移 | 共享层改变工具选择与错误透传 | 用 full/passthrough 契约测试 + 真实 codearts e2e（`/v1/messages`、`/v1/responses`）回归 |
| `/healthz` 响应格式变化 | 依赖纯文本 `ok` 的脚本可能失败 | 返回 JSON 仍含 `ok` 字段；README 已说明；调用方应解析 JSON |
| 注册表路径边界 | `/codebuddyx` 误命中 | 最长前缀 + `prefix + "/"` 边界匹配，已有测试 |
| required provider 失败 | 进程退出 | codearts `required: true`（保持原行为）；codebuddy `required: false`（503） |
| 共享层能力参数不足 | 未来 provider 差异变成控制流 | 新增差异优先加 `ProtocolCapabilities`；若升级为控制流，保留 provider 私有适配层 |

## 8. 关联与证据

- 架构评审：用户提供的架构师评审（静态注册表 + ChatBackend 共享协议层）。
- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 前置：[CHG-0002](CHG-0002-codebuddy-protocol-adapters.md)
- 代码：`src/registry.ts`、`src/protocols/`、`src/shared/sse.ts`、`src/index.ts`
- 测试：`src/registry.test.ts`、`src/providers/codebuddy/anthropic.test.ts`、`responses.test.ts`、`src/shared/sse.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 注册表 + 相对路由 + 聚合 health + 共享 SSE + codebuddy/codearts 共享协议层；64 tests 全绿；真实上游 registry e2e（含 codearts `/v1/messages`、`/v1/responses`）通过；临时集成分支通过；未部署 |