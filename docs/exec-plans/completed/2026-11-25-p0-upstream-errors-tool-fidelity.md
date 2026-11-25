# P0 日志审计修复：上游错误语义、故障恢复、namespace 工具保真

类型：修复（codearts 传输/错误映射 + Responses 工具翻译）
状态：已验证（单测 309 pass / 0 fail + build exit 0；未合并 main、未部署）
Owner：wayne
所属模块/入口：`src/shared/errors.ts`、`src/providers/codearts/`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`
关联：本文件 §2 的审计快照；[#22](https://github.com/sbwkl/any2api/issues/22)（服务端工具产品评估，不在本次范围）、[#24](https://github.com/sbwkl/any2api/issues/24)（namespace 工具静默丢弃）
验证命令：测试 `bun test`；编译/构建 `bun build src/index.ts --target=bun`；文档结构与本地链接检查：未配置；待补。

## 1. 摘要

对 2026-11-25 四层请求记录（快照 1149 条 / 962MB，截至 `08:36:25Z`）做审计，确认当前进程健康（修复后窗口 389 条请求仅 4 次 429），但暴露三类 P0 问题：

1. **上游错误语义坍缩**：200 SSE 内的业务错误（400 参数错、429 限流、415、ECONNRESET）在非流式下一律变成 `502 upstream_error`；`upstream_error` 不是 Anthropic 合法错误类型。
2. **CodeArts 故障路径无恢复力**：加密请求非 2xx 后的「明文回退」实测 8/8 得到内嵌 415，是死路；body 读取阶段的 ECONNRESET 不触发任何重试；非流式聚合失败直接 502，尽管此时尚未向客户端发送任何字节。
3. **namespace 工具被静默丢弃**：83 条 Codex Responses 请求每轮 15 个工具只送达 10 个，固定丢失 4 个 namespace（`multi_agent_v1`、`mcp__codex_security`、`mcp__codex_app`、`mcp__node_repl`）与 1 个 `web_search`。

本变更修复前两项与 namespace 展开；服务端工具（`web_search`）的「网关自执行 vs 显式拒绝」属 #22 产品评估，明确不做。

## 2. 审计证据（快照 `2026-11-25T08:36:25Z`）

| 现象 | 数量 | 时间窗 | 证据 |
|---|---:|---|---|
| dangling `tool_choice` → 上游 400 → 502 | 99（90 非流式 502 + 9 流式 200+error） | 01:03–04:10 | 已由 #23 修复，修复后零复现 |
| ECONNRESET（读取上游 body 阶段） | 31（14 非流式 502 + 17 流式 200+error） | 04:13–04:48 | 上游先吐 0.6–2.3MB，随后 34–110s 无数据并重置 |
| 504 → 明文回退 → 内嵌 415 | 8（6 非流式 502 + 2 流式 200+error） | 04:10–04:39 | 第一次加密尝试 `60s` 后 504，第二次明文尝试 200 但 body 为 415 错误帧 |
| 429 限流 → 502 | 4（3 非流式 502 + 1 流式 200+error） | 08:19:56–59 | 单会话并发触发；上游 `ModelArts.81101.429` |
| namespace 工具丢失 | 83 条请求 × 5 个工具 | 04:28–08:36 | L1 15 tools → L2 10 tools，丢 `multi_agent_v1`/`mcp__codex_security`/`mcp__codex_app`/`mcp__node_repl`/`web_search` |

修复后窗口（`05:55Z` 起）389 条请求中真实错误仅上述 4 次 429；心跳在进程重启后均为 `?status=` 200。

**审计限制**：CodeArts 成功的上游响应在 L3 是 SM4 密文（1043/1043），四层观测对主 provider 实际只有 L1/L2/L4 可读。已另开 issue。

## 3. 决策与行为 delta

### 3.1 错误映射（P0-1）

- 新增 `classifyUpstreamStatus`：从上游错误文本中提取内嵌 HTTP 状态（`.400:` / `.429:` / `415` 等）与语义关键词（rate limit、timeout、ECONNRESET），映射为 `400/429/502/504`。内嵌状态只认前后不接数字、字母或 `:` 的独立三段码，端口（`host:443`）与十六进制 id 不会误判成状态。
- 新增 `anthropicErrorTypeForStatus`：Anthropic 合法类型（`invalid_request_error` / `rate_limit_error` / `authentication_error` / `permission_error` / `not_found_error` / `request_too_large` / `overloaded_error` / `api_error`）。
- `errorTypeForStatus` 的 5xx 默认值由 `upstream_error` 改为 OpenAI 合法的 `server_error`；`safeRespond` 同步。
- CodeArts provider 的非 2xx 响应不再原样透传上游体，而是返回带 `x-any2api-error-source: proxy` 的 OpenAI 错误信封（保留上游 message），由协议层按请求方协议归一。
- 非流式聚合遇到 200+error 帧时按分类结果返回状态码（429→429、参数错→400、重置→502、超时→504），不再一律 502。
- 流式错误事件按分类选择 Anthropic error type；HTTP 状态保持 200（SSE 头已发出）。
- Responses 流同样识别上游错误帧与「无 choice 的空流」，不再输出一个成功但空的 `response.completed`；错误事件 `code` 按 `rate_limit_exceeded` / `server_error` / `invalid_request_error` 分类。

### 3.2 故障恢复（P0-2）

- **删除 chat 的明文回退**（与 `protocol-spec.md` §3.3 的内核逐字行为偏离，理由：实测 8/8 不可用且掩盖真实错误）；`CODEARTS_FORCE_PLAINTEXT=1` 调试开关保留。
  - key-exchange 失败：回退缓存 key（已有）；无可用 key 则直接抛错。
  - 加密请求网络错误：同 key 重试一次，仍失败抛错。
  - 非 2xx 502/503/504：加密重试一次；仍失败返回该响应。
  - `ENCRYPT_KEY_EXPIRED`：保留 clearKey + 重协商 + 重试一次（与瞬时重试共用一次预算）。
- 新增上游读空闲超时：`CODEARTS_UPSTREAM_IDLE_TIMEOUT_MS`（默认 180000），仅作用于解密流；超时取消 reader 并以 `upstream idle timeout` 报错。
- 非流式聚合在尚未向客户端发送任何字节前，对「聚合/读取阶段」的瞬时网络错误重试一次（重建签名、复用 session/trace id）；连接建立类失败不叠加外层预算（SnapClient 内已重试一次），真空流与参数错/限流/鉴权错误不重试。
- **不做**：内核完整的 `x-session-retry`/Busy 退避协议（407×3、81101 ≤10–20 次）；本轮只做有界重试，另开 issue。

### 3.3 namespace 工具保真（P0-3 / #24）

- `type:"namespace"` 的成员函数展开为上游函数工具：`<namespace>__<name>`（非法字符替换为 `_`；超 64 字符或冲突时加短哈希/序号）。
- Responses `input` 中带 `namespace` 的 `function_call` 项，翻译为上游 assistant `tool_calls` 时使用同一展开名。
- 上游返回的工具调用（非流式 `completionToResponse`、流式 `responsesSse` 的 `output_item.added`/`done`）反向还原为 `{name:<成员名>, namespace:<命名空间>}`。
- `tool_choice` 若带 namespace，同样映射到展开名；`pruneDanglingToolChoice` 继续兜底。
- 未声明的 namespace 或非 function 成员保持现有忽略行为。
- `web_search` 服务端工具仍按 #22 当前边界丢弃（本次不改）。

### 3.4 非目标

- #22 服务端工具自执行/显式拒绝。
- #18 `message_start.usage`。
- L3 密文观测、静默字段清单、日志时间戳、`readSecretSession` DB 锁（均另开 issue）。
- e2e 全矩阵重跑；只在单测层覆盖，必要时定点实弹复测。

## 4. 影响范围

**修改**

- `src/shared/errors.ts`（分类与协议错误类型）
- `src/providers/codearts/openai.ts`（错误信封、非流式重试）
- `src/providers/codearts/snap.ts`（去明文回退、有界重试、读空闲超时）
- `src/protocols/anthropic.ts`（Anthropic 错误类型）
- `src/protocols/util.ts`（`safeRespond` 类型）
- `src/protocols/responses.ts`（namespace 展开/还原）
- `src/providers/codearts/protocol-capabilities.ts`（`normalizeErrors` 注释：代理信封仍归一）
- 测试：`src/shared/errors.test.ts`（新增）、`src/protocols/responses-tools.test.ts`（新增）、`src/providers/codearts/openai.test.ts`、`src/providers/codearts/snap.test.ts`、`src/protocols/protocols.test.ts`、`src/providers/codebuddy/openai.test.ts`
- 文档：`README.md`（已知限制）、`src/providers/codearts/protocol-spec.md`（§3.3/§7.3 偏差说明）

## 5. 验证与观测

- **单测**：`bun test` → **314 pass / 0 fail**（1287 断言，36 文件）。新增覆盖：
  - 错误分类表（内嵌 400/429/415、ECONNRESET、timeout、空流回退 502；端口 443、十六进制 450 不被误判）；
  - OpenAI `server_error` / Anthropic `api_error` 等协议合法类型；
  - 200 SSE 内嵌 429 → 429 `rate_limit_error`；内嵌 400 不重试；
  - 非 2xx 504 → 代理错误信封（`x-any2api-error-source: proxy`）保留上游 message；
  - 非流式聚合遇 ECONNRESET → 重试一次后成功；真空流只发一次上游请求；连接建立失败只发一次（snap 内已重试）；
  - SnapClient：瞬时 5xx 加密重试一次、网络错误加密重试一次、key-exchange 失败直接抛错、读空闲超时、`CODEARTS_FORCE_PLAINTEXT=1` 明文调试路径；
  - Responses（全部经共享路由 S1）：namespace 展开（含 64 字符截断/同名冲突/与顶层函数撞名去重）、输入 `function_call.namespace` 映射、`tool_choice` 重写、非流式/流式输出还原 `name`+`namespace`、函数名晚到仍先发正确 `output_item.added`；
  - Responses 流错误帧与空流 → 分类错误事件。
- **构建**：`bun build src/index.ts --target=bun` → exit 0。
- **定点实弹（未执行）**：用 Codex 发一轮带 namespace 工具的请求，确认 L2 工具数恢复、L4 回出 `namespace`；需用户同意消耗真实 token 后执行。
- **日志复测（待合并后）**：观察 429/504/重置不再伪装成 502，namespace 工具每轮 15→15（服务端 `web_search` 仍丢弃时为 14）。

## 6. 回滚

- revert 本分支提交；无数据/配置迁移。
- 回滚后恢复：明文回退、单一 502 映射、namespace 丢弃。
- 回滚验证：`bun test` 通过；Codex 工具数回到 10。

## 7. 风险与未决

| 风险 | 影响 | 处理 |
|---|---|---|
| 去掉明文回退后，若某环境确实只能明文 | chat 直接失败而非静默降级 | 保留 `CODEARTS_FORCE_PLAINTEXT=1`；失败信息含上游原文 |
| 有界重试增加最坏延迟（非流式 +1 次上游调用） | 长生成再等一轮 | 仅瞬时错误重试一次；参数/限流/鉴权不重试 |
| namespace 展开名超过 64 字符或冲突 | 上游拒绝工具或映射错位 | 短哈希/序号去重；单测覆盖 |
| 客户端依赖未展开的裸成员名 | 工具调用无法路由 | 输出严格还原 `name`+`namespace`，与 Codex 输入形状对称 |
| 上游错误文本格式变化 | 分类退回 502 | 分类为纯增量；无法识别时保持 502 `server_error`，不误判 4xx |
| 本轮未做完整内核重试协议 | 407/Busy 场景仍失败 | 记录 issue 跟踪 |

## 8. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 2026-11-25 创建；审计快照与决策见 §2/§3 |
| 已验证 | wayne | 2026-11-25 实现 P0-1/P0-2/P0-3；`bun test` 309 pass / 0 fail，`bun build` exit 0；非本轮问题登记为 #30–#35（needs-triage） |
| 已验证（评审修复） | wayne | 2026-11-25 两轴评审后修复：真空流不重试、函数名晚到仍先发 `output_item.added`、测试全部经 S1 共享路由 + 撞名/明文开关覆盖、能力位注释与 §7.3 事实分离、错误映射去重；`bun test` 312 pass / 0 fail，`bun build` exit 0；PR #37 |
| 已验证（复审修复） | wayne | 2026-11-25 内嵌状态码收紧（端口/十六进制不再误判）、非流式外层重试不再叠加 snap 预算；`bun test` 314 pass / 0 fail，`bun build` exit 0 |