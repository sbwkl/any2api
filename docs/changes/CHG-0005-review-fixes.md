# CHG-0005 评审修复：错误边界、空流、类型校验、能力契约、共享 SSE、前缀校验

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/protocols/`、`src/registry.ts`、`src/shared/sse.ts`、`src/providers/codebuddy/openai.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0003](CHG-0003-provider-registry-protocols.md)

## 1. 摘要

按评审 P0/P1 清单修复：

- **P0-1 错误边界**：`CodeBuddyFacade.respond` 捕获 `postChat`/SSE 聚合异常 → 502 OpenAI 错误；共享协议层用 `safeRespond` 捕获 backend 异常 → 502；注册表在 `route.handle` 外加兜底 → JSON 500（不再裸 500 文本）。
- **P0-2 空流**：`aggregateSseToCompletion` 在没有 choices 时抛错，调用方转 502，不再把空流当成功。
- **P1-3 类型校验**：Anthropic `messages`/`content`/`metadata.user_id`、Responses `input`/`input[].content`/`session_id`/`user`、OpenAI `messages`/`tools` 非法类型 → 400。
- **P1-4 能力契约**：`errorShape` 改为布尔 `normalizeErrors`（CodeBuddy=true，codearts=false），Anthropic/Responses 路由使用同一语义。
- **P1-5 共享 SSE**：协议层改用 `shared/sse.ts` 的 `sseData`，覆盖 `[DONE]` 与末帧无换行。
- **P1-6 前缀校验**：注册表启动时校验 prefix 非空、唯一、最多一个空 prefix、以 `/` 开头且不以 `/` 结尾。

## 2. 变更理由与证据

- **触发原因**：评审指出两个高优先级问题——上游网络异常会变成裸 500、空流会被当作成功空回答；以及四项 P1 设计/健壮性问题。
- **证据**：评审文本；现有 69 个测试全部通过；本次新增回归用例（网络 reject、空流、畸形 body、重复 prefix、末帧无换行）。
- **不做的后果**：客户端可能收到 500 文本或“成功但空”的响应，难以判断失败；畸形输入可能抛 TypeError；能力契约不一致会让测试与生产行为分叉。

## 3. 行为 / AC delta

- **新增 R20**：When 上游请求或 SSE 聚合抛出异常, the system shall 返回 502 的 OpenAI 错误结构；注册表对未捕获的 provider 异常返回 JSON 500。
- **新增 R21**：When 上游 SSE 没有任何 choices, the system shall 返回 502，不得返回成功空回答。
- **新增 R22**：When Anthropic/Responses/OpenAI 请求体字段类型不合法（`messages`/`input`/`input[].content`/`content`/`metadata.user_id`/`session_id`/`user`/`tools`）, the system shall 返回 400 协议错误。
- **新增 R23**：When provider prefix 重复、出现多个空 prefix、或格式不合法（不以 `/` 开头、以 `/` 结尾、为 `/`）, the system shall 启动失败并给出明确错误。
- **修改 R17**：`ProtocolCapabilities` 的错误契约字段由 `errorShape` 改为布尔 `normalizeErrors`。
- **不改变**：正常流式/非流式响应、工具调用、usage、队列协议。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/types.ts`：`errorShape` → `normalizeErrors`。
- `src/protocols/util.ts`（新增）：`safeRespond`，backend 异常 → 502 JSON。
- `src/protocols/anthropic.ts`、`responses.ts`：使用共享 `sseData`；类型校验；`safeRespond`；`normalizeErrors`。
- `src/providers/codebuddy/openai.ts`：`respond` 外层 try/catch → 502；`handleChat` 校验 messages/tools。
- `src/registry.ts`：`route.handle` 兜底 → JSON 500；启动时 prefix 校验。
- `src/shared/sse.ts`：无 choices 抛错。
- 测试：`registry.test.ts`、`protocols/protocols.test.ts`、`shared/sse.test.ts`、`providers/codebuddy/openai.test.ts`。
- 文档：CHG-0003/REQ R17 的能力字段名。

**本次明确不做**

- 遥测、TLS 指纹、内置工具 schema（沿用 CHG-0002 非目标）。
- 排队协议之外的限流退避策略。

## 5. 验证与观测

- `bun test` → **83 pass / 0 fail / 296 expect() calls**（12 个测试文件）。
- 新增回归：
  - fetch reject → OpenAI 502；Anthropic/Responses backend 异常 → 502；注册表 route 抛错 → JSON 500。
  - 空 SSE / 只有 error 事件的流 → 502（CodeBuddy 与 CodeArts 均覆盖；CodeArts 见 `providers/codearts/openai.test.ts`）。
  - `messages:{}`、`content:123`、`metadata.user_id:123`、`input:{}`、`input[].content:123`、`input[].content:[123]`、`session_id:123`、OpenAI `tools:{}` → 400。
  - 末帧无换行 → Anthropic 流式正常输出。
  - 重复 prefix / 两个空 prefix / `codebuddy` / `/codebuddy/` → 启动失败。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 临时集成分支 `tmp/integration-codebuddy`（main + feat）→ **83 pass / 0 fail**，build 通过，已删除。

## 6. 回滚方案

- **回滚方式**：`git revert` 本变更；恢复旧的 `errorShape`、局部 SSE 解析、无校验版本。
- **数据/配置兼容**：无持久化状态；`normalizeErrors` 是内部类型，不影响外部 API。
- **回滚验证**：82 个测试回退到上一版；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 所有上游异常统一 502 | 编程错误也被归为 502 | 注册表兜底 500；日志保留原始 message；可接受 |
| `normalizeErrors` 重命名 | 外部引用旧字段会失败 | 内部类型；已全局替换；无外部消费者 |
| 类型校验更严格 | 某些宽松客户端可能被拒 | 400 带明确字段名；主流客户端回归测试 |
| 前缀校验 | 之前可运行的重复/非法前缀现在启动失败 | 启动即失败，给出明确错误；当前注册表无冲突 |

## 8. 关联与证据

- 评审文本：P0-1/P0-2、P1-3..P1-6。
- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 前置：[CHG-0003](CHG-0003-provider-registry-protocols.md)
- 代码：`src/protocols/`、`src/registry.ts`、`src/shared/sse.ts`、`src/providers/codebuddy/openai.ts`
- 测试：`registry.test.ts`、`protocols/protocols.test.ts`、`shared/sse.test.ts`、`providers/codebuddy/openai.test.ts`、`providers/codearts/openai.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | P0/P1 修复；83 tests 全绿；新增回归覆盖网络 reject、空 SSE（CodeBuddy + CodeArts）、畸形 body（含 Responses 嵌套 content）、重复 prefix、末帧无换行；临时集成分支通过；未部署 |