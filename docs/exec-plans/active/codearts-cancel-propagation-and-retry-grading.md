# CodeArts 取消传播与重试分级

类型：变更（CodeArts provider + 共享协议门面）
状态：已定案（未开始实现；无代码改动、无验证证据）
Owner：wayne
所属模块/入口：`src/providers/codearts/`、`src/protocols/types.ts`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`、`src/shared/trace.ts`
功能卡：无（本轮为可靠性对齐，不新增产品能力）
关联：[#49](https://github.com/sbwkl/any2api/issues/49)、[P0 上游错误语义修复](../completed/2026-11-25-p0-upstream-errors-tool-fidelity.md)、[四层请求记录](../completed/2026-11-25-four-layer-request-record.md)
上游规格：[codearts/protocol-spec.md](../../../src/providers/codearts/protocol-spec.md)（内核 `x-session-retry` / Busy / retry-after 条目）
验证命令：测试 `bun test`；构建 `bun build src/index.ts --target=bun`；类型 `tsc --noEmit`；文档链接 `bun scripts/check-docs-links.ts`

> 本文记录定案与实现边界；实现完成后补验证证据并移入 `completed/`。

## 1. 摘要

把 CodeArts 代理层在两件事上与官方内核对齐：

1. **取消传播**：客户端中断入站请求时，停止该请求发起的上游 chat 调用，而不是让上游继续跑完。
2. **重试分级**：按官方错误类别与次数上限重试，使用单一预算与退避，替代现有「两层各重试一次、429 不重试」的薄策略。

两件事都**不解决** 60 秒静默断连：官方内核对该类裸网络错误同样判为不可重试，本次明确不承诺恢复。

## 2. 变更理由与证据

数据源：`capture-2026-11-26.jsonl` + `capture-2026-11-27.jsonl`，共 3022 条请求记录（codearts 2643 / codebuddy 379）。

| 现象 | 数量 | 证据 |
|---|---:|---|
| `client_disconnect` | 4 | 其中 1 条上游仍跑满 197.9s、8548 chunk、8832 completion tokens、1.96MB；L3 记 `complete:true`，L4 `complete:false` |
| 上游 429 `APIG.0308` | 4 | 2026-11-26 12:39–12:45；未重试，原样 429 返回客户端 |
| 上游 503 `APIG.0613` | 3 | 同一窗口；各重试一次，2 成功（503→200）、1 失败（503→503） |
| 60s 静默断连流失败 | 36 | 最后 chunk → 结束间隔 59,713–60,003ms，仅 glm-5.3-flash；官方同类不重试 |

代码事实（实现前核对）：

- `SnapClient.chat(url, headers, bodyObj, isRetry)` 无 `signal`；`traceUpstream` 支持 `request.signal` 但无人传。
- `anthropicSse`（`src/protocols/anthropic.ts:375`）与 `normalizeChatSseUsage`（`src/shared/sse.ts:96`）无 `cancel()`；`sseData` 只 `releaseLock()`，不 `cancel` 上游 reader。
- trace 的 `finishTrace` 会 clone 并读空 L4，等于客户端断开后仍强制消费上游流。
- 重试分层：`SnapClient` 一次（网络 / `ENCRYPT_KEY_EXPIRED` / 500-504，无退避）+ 非流式聚合一次（≥500），最坏单请求 4 次上游 POST；429 不重试。

官方内核证据（`AgentKernel_Vscode_26_11_300_126_11_3-20261124194420`，26.11.300 / 126.11.3，按字节偏移提取 JS）：

- 首 token 超时 300,000ms、块间空闲 600,000ms，均晚于网关 60s 断连；
- 429 / 406 / `ModelArts.81101` Busy ≤10（另一条内部路径 ≤20）、502 ≤10、503 ≤3、空响应 ≤3、自身超时 ≤3；
- 退避 500ms→5s + jitter；读 `retry-after` / `retry-after-ms`；
- 裸网络错误 → 503 不可重试（407 例外）；
- 流包装器 `cancel(){...; P.cancel()}`，取消向下游传播；
- `need-switch-model`、`x-session-retry` 为官方插件协议；
- 内核保留日志中无 ECONNRESET 实例，60s 断连的线上表现只能由代码推断（待验证）。

## 3. 决策与行为 delta

### 3.1 取消传播

- **显式 signal**：`ChatBackend.respond` opts 增加 `signal?: AbortSignal`；`handleAnthropicMessages` / `handleResponses` / OpenAIFacade 从 `req.signal` 取值；仅 codearts 传递；`SnapClient.chat` 增加可选 `signal` 并写入 `traceUpstream({ signal })`。
- **作用范围**：仅本次请求的 chat POST（流式与非流式）。key-exchange（全局缓存、可能被其他请求等待）、心跳、遥测、凭证保活、启动模型发现不跟随取消。
- **检查点**：`respond` 入口、每次上游尝试前、退避 sleep 中、key 协商之后；`signal.aborted` 优先于一切重试判断。
- **中止方式**：中止上游 fetch（非仅停止读取）；解密流 read 随 fetch 中止而 reject，协议包装器循环随之退出。
- **不改流包装器**：`anthropicSse` / `normalizeChatSseUsage` / `sseData` 不加 `cancel()`。
- **401 刷新**：保留「401 → `refreshNow` → 重试一次」，作为独立凭证修复动作，不占瞬时重试预算；`signal` 中止时同样放弃。
- **trace**：不改 schema 3；`abort_reason` 由既有 first-wins 保持 `client_disconnect`；L3 `complete:false` 自然产生；不新增 `aborted_by`。

### 3.2 重试分级（仅 codearts）

- **单一预算**：一次入站请求一个总尝试计数器，`SnapClient` 与 provider 共用；阈值与**总尝试次数**比较（官方 `x-session-retry` 语义：先 429 重试 5 次后再遇 503，总 attempt=6 ≥ 3，503 不再重试）；换 key 重发扣一次。
- **档位**：

| 类别 | 上限 |
|---|---:|
| 429 / 406 / 帧内 Busy（`ModelArts.81101`） | 10 |
| 502 | 10 |
| 500 / 503 / 504 | 3 |
| 407 | 3 |
| 其它 4xx/5xx、裸网络错误 | 不重试 |

- **退避**：指数 base 500ms、×2、上限 5s、jitter 0–200ms；`retry-after`（秒）与 `retry-after-ms` 优先，钳制 ≤30s。
- **边界**：仅在客户端尚未收到任何字节前重试。流式仅对非 2xx 重试，出字节后不重放；非流式聚合可重试非 2xx、帧内 Busy/429，帧内其它 error 直接报错。不做首包预读。
- **维持不重试**：空响应（`NO_CHOICES`）、180s 空闲超时。
- **删除**：`SnapClient` 网络错误同 key 重试一次（官方判不可重试）；`NON_STREAM_ATTEMPTS` 外层一次重试（由预算统一裁决）。
- **保留**：`ENCRYPT_KEY_EXPIRED` 换 key 重发（扣预算）。
- **不实现**：`need-switch-model` 自动切模型（映射为不可重试的明确错误）；`x-session-retry` 请求头；官方 ≤20 内部路径；env 开关。
- **日志**：每次重试输出类别、attempt/max、delay；不静默。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/types.ts`（`respond` opts 加 `signal`）
- `src/protocols/anthropic.ts`、`src/protocols/responses.ts`（把 `req.signal` 传入 `backend.respond`）
- `src/providers/codearts/openai.ts`（`respond` 签名、重试执行器、非流式聚合帧内错误识别、401 刷新受 signal 约束）
- `src/providers/codearts/snap.ts`（`chat` 接收 signal 与预算；删除网络重试；重试档位与退避）
- 新增重试策略模块（位置在实现时定，倾向 `src/providers/codearts/retry.ts`）
- 单测与 registry 集成测试
- `GLOSSARY.md`（新增「取消传播」「重试分级」「重试预算」「首字节前重试」）
- `README.md` / `src/providers/codearts/protocol-spec.md` 中与重试行为冲突的旧表述（如「同 key 重试一次」）

**本次明确不做**

- codebuddy 的取消/重试行为（已有 `onQueue` / `retry_after` 语义）。
- 60s 静默断连恢复；trace schema 升版；流式首包预读。
- `need-switch-model` 自动切模型；`x-session-retry` 请求头。
- 环境变量开关；影子实例验证（如需要另开 issue）。
- 全量 e2e 基线重跑。

## 5. 验证与观测

- **单测（确定性、离线、注入 fake fetch/stream 与假时钟）**：
  - 客户端取消 → 上游 fetch 收到 abort、不触发重试、不再发新请求；
  - 429 连续失败后成功 → 最终 200；
  - 阈值按总尝试次数生效（429 与 503 混排）；502 ≤10、503 ≤3、407 ≤3；
  - 退避时序与 jitter 范围、`retry-after` / `retry-after-ms` 覆盖与 30s 钳制；
  - 裸网络错误不重试；换 key 扣预算；
  - 非流式帧内 Busy → 重试；帧内其它 error → 报错；
  - 流式出字节后失败 → 不重放。
- **集成测试**：经 `registry` + 临时 `TRACE_CAPTURE_DIR`，客户端中途断开 → 记录 `abort_reason=client_disconnect`、L3 `complete:false`、上游只收到一次请求。
- **门禁**：`bun test`、`bun build src/index.ts --target=bun`、`tsc --noEmit`、`bun scripts/check-docs-links.ts`。
- **观测**：重试日志逐次输出 `class/attempt/delay`；四层记录中每次尝试仍是独立 L2/L3。

## 6. 回滚方案

- 回滚方式：revert 本次提交（无数据迁移、无持久化状态、无配置变更）。
- 行为恢复：取消不再传播（恢复现状）；重试恢复为两层各一次、429 不重试。
- 回滚验证：`bun test` 通过；registry 集成测试随提交一并回退。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 精确照官方次数且无总时限（429 最坏约 37s） | 客户端自身超时先到，用户看到「卡住」 | 已定案接受；文档写明这是照官方的代价；不提供 env 回退，只能 revert |
| 删除网络错误重试 | 网关瞬时抖动不再自动恢复 | 现有 3022 条记录无网络错误样本；官方同样不重试；如线上出现再评估 |
| 帧内 Busy/429 识别 | 可能把模型正文里的「429」「Busy」误判为错误 | 只解析 SSE JSON 结构（`error` 字段 / 无 choices 的错误帧），不做文本匹配 |
| 取消依赖 `req.signal` 的触发时机 | 若 Bun 未及时 abort，drain 仍会读满 | 现有 4 条 `client_disconnect` 证明 signal 会触发；集成测试锁定 |
| 官方 60s 断连线上行为 | 只能从代码推断 | 已在 §2 标注待验证；不在本次承诺内 |
| `protocol-spec.md` 与 README 旧表述 | 读者误以为仍有一次网络重试 | 实现时同步修订相关段落 |