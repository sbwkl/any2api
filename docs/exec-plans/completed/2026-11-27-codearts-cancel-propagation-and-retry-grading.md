# CodeArts 取消传播与重试分级

类型：变更（CodeArts provider + 共享协议门面）
状态：已验证（2026-11-27；四道门禁全绿，取消与 429 重试各做过一次临时记录目录复核，见 §5）
Owner：wayne
所属模块/入口：`src/providers/codearts/`、`src/protocols/types.ts`、`src/protocols/anthropic.ts`、`src/protocols/responses.ts`、`src/shared/trace.ts`
功能卡：无（本轮为可靠性对齐，不新增产品能力）
关联：[#49](https://github.com/sbwkl/any2api/issues/49)、[#50](https://github.com/sbwkl/any2api/issues/50)（取消传播）、[#51](https://github.com/sbwkl/any2api/issues/51)（单一预算与状态级重试）、[#52](https://github.com/sbwkl/any2api/issues/52)（帧内错误与首字节边界）、[#53](https://github.com/sbwkl/any2api/issues/53)（本收尾）、[P0 上游错误语义修复](2026-11-25-p0-upstream-errors-tool-fidelity.md)、[四层请求记录](2026-11-25-four-layer-request-record.md)
上游规格：[codearts/protocol-spec.md](../../../src/providers/codearts/protocol-spec.md)（内核 `x-session-retry` / Busy / retry-after 条目）
验证命令：测试 `bun test`；构建 `bun build src/index.ts --target=bun`；类型 `tsc --noEmit`；文档链接 `bun scripts/check-docs-links.ts`

> 已归档。三刀实现与验证证据见 §3.3 与 §5；未覆盖边界见 §7。
> 文档差异已修正（2026-11-27）：README 的 L2 记录措辞已区分「记录条目」与「重试预算」；README / `protocol-spec.md` 中「网络错误同 key 重试一次」「非流式再重试一次 / `NON_STREAM_ATTEMPTS`」等旧表述已核对无残留；README 与 `protocol-spec.md` 补充了取消传播的代理行为。

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
| 429 / 406 / 帧内 Busy（`ModelArts.81101`）/ 帧内限流码（独立 `.429` 段、`APIG.0308`） | 10 |
| 502 | 10 |
| 500 / 503 / 504 | 3 |
| 407 | 3 |
| 其它 4xx/5xx、裸网络错误 | 不重试 |

- **退避**：指数 base 500ms、×2、上限 5s、jitter 0–200ms；`retry-after`（秒）与 `retry-after-ms` 优先，钳制 ≤30s。
- **边界**：仅在客户端尚未收到任何字节前重试。流式仅对非 2xx 重试，出字节后不重放；非流式聚合可重试非 2xx、帧内 Busy/429，帧内其它 error 直接报错。不做首包预读。
- **维持不重试**：空响应（`NO_CHOICES`）、180s 空闲超时。
- **删除**：`SnapClient` 网络错误同 key 重试一次（官方判不可重试）；`NON_STREAM_ATTEMPTS` 外层一次重试（由预算统一裁决）。
- **保留**：`ENCRYPT_KEY_EXPIRED` 换 key 重发（扣预算）。
- **不实现**：`need-switch-model` 自动切模型；该响应头出现时立即停止重试并返回不可重试的明确错误（409）；`x-session-retry` 请求头；官方 ≤20 内部路径；env 开关。
- **日志**：每次重试输出类别、attempt/max、delay；不静默。

### 3.3 三刀落地与行为 delta

| 切片 | 提交（含合并） | 行为 delta |
|---|---|---|
| #50 取消传播 | `0a6bd0f`（合并 `00ce297`） | 共享 `respond` opts 增加 `signal`；CodeArts 把入站 `req.signal` 一路传到上游 chat fetch 并中止 fetch；请求入口、每次尝试前、退避中、密钥协商后设检查点；取消不消耗预算、不触发重试；观测关闭时同样生效 |
| #51 单一预算与状态级重试 | `ecc6864`（合并 `93a6113`） | 新增 `retry.ts`（档位判定、指数退避 + jitter、`retry-after` / `retry-after-ms`、单一预算扣减，`sleep`/`now`/`random` 可注入）；`SnapClient` 删除裸网络错误同 key 重试；429 / 406 / 502 总尝试 ≤10、500 / 503 / 504 / 407 ≤3；`ENCRYPT_KEY_EXPIRED` 换 key 重发保留并扣预算 |
| #52 帧内错误与首字节边界 | `4f8101f`（合并 `004ba6c`） | 非流式聚合识别 HTTP 200 SSE 内嵌 Busy（`ModelArts.81101`）/ 429 并按限流档在同一预算内重试；帧内其它错误直接上报；退役 `NON_STREAM_ATTEMPTS`、非流式独立重试循环与 `isTransientFailure`；流式仅非 2xx 首字节前重试；401 刷新后的重发不占瞬时预算但仍受取消约束 |

## 4. 影响范围与非目标

**受影响**

- `src/protocols/types.ts`（`respond` opts 加 `signal`）
- `src/protocols/anthropic.ts`、`src/protocols/responses.ts`（把 `req.signal` 传入 `backend.respond`）
- `src/providers/codearts/openai.ts`（`respond` 签名、重试执行器、非流式聚合帧内错误识别、401 刷新受 signal 约束）
- `src/providers/codearts/snap.ts`（`chat` 接收 signal 与预算；删除网络重试；重试档位与退避）
- 新增重试策略模块 `src/providers/codearts/retry.ts`（档位、退避、单一预算，`sleep`/`now`/`random` 可注入）
- 单测与 registry 集成测试
- `GLOSSARY.md`（新增「取消传播」「重试分级」「重试预算」「首字节前重试」）
- `README.md` / `src/providers/codearts/protocol-spec.md` 中与重试行为冲突的旧表述，以及取消传播说明（已修正）

**本次明确不做**

- codebuddy 的取消/重试行为（已有 `onQueue` / `retry_after` 语义）。
- 60s 静默断连恢复；trace schema 升版；流式首包预读。
- `need-switch-model` 自动切模型（仅映射为不可重试的明确错误）；`x-session-retry` 请求头。
- 环境变量开关；影子实例验证（如需要另开 issue）。
- 全量 e2e 基线重跑。

## 5. 验证与观测

全部门禁在 2026-11-27 本分支（`feat/codearts-cancel-retry-t53`，基于集成分支 tip `004ba6c`）实跑，输出如下：

| 门禁 | 命令 | 结果 |
|---|---|---|
| 测试 | `~/.bun/bin/bun test` | 393 pass / 0 fail / 1612 expect；40 个文件 |
| 构建 | `~/.bun/bin/bun build src/index.ts --target=bun` | 退出码 0 |
| 类型 | `~/.bun/bin/bunx tsc --noEmit` | 退出码 0 |
| 文档链接 | `~/.bun/bin/bun scripts/check-docs-links.ts` | 见 §5.3 |

**单测覆盖（确定性、离线、注入 fake fetch/stream 与假时钟）**：

- 客户端取消 → 上游 fetch 收到 abort、不触发重试、不再发新请求（`snap.test.ts` / `openai.test.ts` / `protocols.test.ts`）；
- 429 / 406 / 502 / 503 / 407 的状态级重试次数与顺序、总尝试阈值混排、退避序列与 jitter 边界、`retry-after` / `retry-after-ms` 覆盖与 30s 钳制（`retry.test.ts` / `snap.test.ts`）；
- 裸网络错误不重试；换 key 扣预算；取消打断退避且不扣预算；
- 非流式帧内 Busy/429 → 重试；帧内其它 error → 报错；空响应、180s 空闲超时、裸网络故障不重试；401 刷新重发不占预算（`openai.test.ts`）；
- 流式出字节后失败 → 不重放；首包预读未实现。

### 5.1 观测复核一：客户端取消

复用 registry 集成测试（假 fetch、临时 `TRACE_CAPTURE_DIR`、无真实等待），一次流式请求读到首个 chunk 后 `controller.abort()`。临时目录 JSONL 关键字段（已脱敏，不贴请求体）：

| 字段 | 值 |
|---|---|
| `provider` / `path` | `codearts` / `/codearts/v1/chat/completions` |
| L4 `response.status` / `complete` | 200 / `false` |
| L4 `abort_reason` | `client_disconnect` |
| 上游 chat 调用次数 | 1 |
| L3 key-exchange | `status=200`、`complete=true`（后台协商不跟随取消） |
| L3 chat | `status=200`、`complete=false`（中止时仅有首个 chunk 到达） |

该 `status=200` 对应「流式响应已提交给客户端之后」的取消路径：首字节已发出，HTTP 状态不能再改写，中断由 `abort_reason=client_disconnect` 表达。若取消发生在出站响应提交之前（尚未发出任何响应字节），代理返回 `499` 空体（见 README / `protocol-spec.md`）；两条路径分别产生 200 与 499，互不矛盾。

断言落在 `src/registry.test.ts` 的「client disconnect aborts the upstream chat…」：`abort_reason=client_disconnect`、L3 `complete:false`、`chatCalls.length=1`；观测关闭时另有用例断言同样中止。

### 5.2 观测复核二：429 → 200 重试成功

同一 registry 接缝，假 fetch 第一次 chat 返回 HTTP 429（`APIG.0308`）、第二次返回 200 SSE；退避用注入假 sleep。临时目录 JSONL 关键字段：

| 字段 | 值 |
|---|---|
| L4 `response.status` / `complete` | 200 / `true` |
| 上游 chat 调用次数 | 2 |
| 两次 chat 的 L3 `response.status` | 429 → 200 |
| 两次 L3 `complete` | `true` / `true` |
| 注入的退避等待 | `500ms`（1 次；无真实等待） |
| L4 正文含成功 chunk | 是 |

重试日志实跑输出：`[snap] 重试 class=rate_limit status=429 attempt=1/10 delay=500ms`。断言落在 `src/registry.test.ts` 的「a 429 before the first byte is retried…」：上游序列、最终 200、记录中两条 chat 尝试（429 → 200）与假 sleep 序列。

### 5.3 文档链接检查

`bun scripts/check-docs-links.ts` 在归档后实跑：`[docs-links] 全部本地链接有效`，退出码 0（含本文件新路径与 README / `protocol-spec.md` / 旧执行计划的反向引用）。

### 5.4 未验证 / 待补

- 真实上游联调未跑：本 ticket 禁止触网，取消与重试均以假 fetch 判定。
- 60 秒静默断连的线上表现仍未验证（官方内核保留日志无 ECONNRESET 样本）。
- 180s 空闲超时未做真实定时器端到端联调：`SnapClient` 有 50ms 缩短超时的真实定时器用例，门面级仅有注入错误覆盖。
- 流式 HTTP 200 SSE 内嵌 Busy/429 的识别未实现（见 §7）。
- 帧内限流码 `APIG.0308` 的映射依据是 HTTP 429 的实测观测，尚无真实帧内 429 样本（待验证）；当前只有注入假帧的确定性单测。

## 6. 回滚方案

- 回滚方式：revert 本次提交（无数据迁移、无持久化状态、无配置变更）。
- 行为恢复：取消不再传播（恢复现状）；重试恢复为两层各一次、429 不重试。
- 回滚验证：`bun test` 通过；registry 集成测试随提交一并回退。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 精确照官方次数且无总时限（429 最坏约 37s） | 客户端自身超时先到，用户看到「卡住」 | 已定案接受；文档写明这是照官方的代价；不提供 env 回退，只能 revert |
| 删除网络错误重试 | 网关瞬时抖动不再自动恢复 | 现有 3022 条记录无网络错误样本；官方同样不重试；如线上出现再评估（待验证） |
| 帧内 Busy/429 识别 | 可能把模型正文里的「429」「Busy」误判为错误 | 已用结构化错误码（`error.code` / `error_code`）判定，不做正文关键词匹配；正文含「429 Busy」的用例通过 |
| 取消依赖 `req.signal` 的触发时机 | 若 Bun 未及时 abort，drain 仍会读满 | 集成测试锁定 signal → 上游 fetch abort；线上 4 条 `client_disconnect` 为佐证 |
| 官方 60s 断连线上行为 | 只能从代码推断 | 仍不在本次承诺内；内核保留日志无 ECONNRESET 样本（待验证） |
| 流式 HTTP 200 SSE 内嵌 Busy/429 | 流式不识别帧内错误，按上游原文透传；客户端可能显示模型空响应 | 已知边界，不在 #52 范围；帧内识别仅覆盖非流式聚合 |
| 180s 空闲超时覆盖 | 门面级只有注入错误用例，未做真实定时器端到端联调 | `SnapClient` 有 50ms 缩短超时的真实定时器用例；门面级联调待补（待验证） |
| `protocol-spec.md` 与 README 旧表述 | 读者误以为仍有一次网络重试 | 文档差异已修正（2026-11-27）；`check-docs-links.ts` 通过 |

## 8. 变更记录

| 状态 | 操作人 | 证据/链接 |
|---|---|---|
| 已定案 | wayne | #49 spec 与 grilling 锁定行为边界；无代码改动 |
| 开发中 | wayne | #50 `0a6bd0f`、#51 `ecc6864`、#52 `4f8101f` 分三刀合入集成分支 |
| 已验证 | wayne | 2026-11-27，#53：`bun test` 393 pass / 0 fail / 1612 expect；build、tsc、docs-links 通过；取消与 429→200 各做一次临时记录目录复核（§5）；未触网、未真实等待 |