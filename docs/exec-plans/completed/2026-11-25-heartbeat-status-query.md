# 修复 CodeArts 会话心跳线格式：status 查询参数与失败可见性

类型：修复（provider 私有上行）
状态：已验证（单测 288 pass / 0 fail + 实弹验证通过；未合并 main、未部署）
Owner：wayne
所属模块/入口：`src/providers/codearts/snap.ts`（HeartbeatManager）、`src/providers/codearts/signer.ts`（signSh）
关联：[spec issue #26](https://github.com/sbwkl/any2api/issues/26)

## 1. 摘要

any2api 代理发出的 CodeArts 会话心跳 `PUT /snap-manager/v1/chat-session/heartbeat` 被真实上游 100% 拒绝（400 `TM.00001001 / wsf.validator.session.status`），且除首个 busy 外全部静默失败。根因：status 被放进 JSON body，而后端校验器要求它出现在查询参数。本变更把线格式修正为与真实内核逐字一致：`PUT .../heartbeat?status=busy|idle`、body 固定 `{}`，status 查询参数参与 AKSK canonical query 签名；同时为两条发送路径补上失败可见性（非 2xx `warn`、网络异常 `error`、成功静默）。busy/idle 调度节奏与四层记录边界不变，不引入重试。

## 2. 变更理由与证据

**故障现场**（`/Users/wayne/logs/request-records/capture-2026-11-25.jsonl` 第 4、5、15、30、31、90、99、120、133、217、218、231、241、244、259、260 行）：16 次心跳 16/16 返回 400 同错误码；L2 请求均为无 query 的 `PUT`、body `{"status":"busy"}`、头含 `user-session-id` 与 AKSK 签名。

**根因证据（内核反编译，本机 `AgentKernel_Vscode_26_11_200_126_11_2-20261117200150`）**：真实客户端 `sendHeartbeat` 为 `new uA(base, ...).put(EMe, headers, {}, { status })`；`uA.put(path, headers, data = {}, queryParams = {})` 明确把第四个参数作为查询参数发送。token 路径 `ka.put(EMe, {}, { params: { status }, headers })` 同样把 status 放入 query。

**静默失败证据**：`sendBackground` 原实现 `.catch(() => {})` 只吞 fetch 抛出的网络异常；fetch 对非 2xx 不抛错，响应被直接丢弃，无任何日志。只有首个 busy 走 `traceUpstream` 进入四层记录，定时 tick 与 idle 在运行日志中完全不可见。

**实弹对照**（2026-11-25，真实 `snap-access` 端点 + 真实 STS，临时探测脚本）：

| 形状 | 结果 |
|---|---|
| 无 query + body `{"status":"busy"}`（修复前形状，签名含 body） | 400 `TM.00001001` |
| 无 query + body `{"status":"busy"}`（signBody=false） | 400 `TM.00001001` |
| `?status=busy` + body `{}`（查询参数参与签名） | **200 `{"status":"ok"}`** |
| `?status=busy` 无 body | 200 `{"status":"ok"}` |
| `?status=idle` + body `{}` | **200 `{"status":"ok"}`** |

## 3. 行为 delta

- **修改**：`HeartbeatManager.buildHeartbeat` 线格式——URL 带 `?status=busy|idle`，body 固定字符串 `"{}"`；签名 endpoint 传不含 query 的路径，status 经 `queryParams` 参与 canonical query。
- **修改**：`signSh` 请求类型新增可选 `queryParams?: Record<string, string | string[]>`，经既有 `{ ...req }` 展开透传 `signSl`（后者早已支持）；对既有调用方零行为变化。
- **修改**：新增两条发送路径共享的响应检查——非 2xx 读响应体前 300 字符并 `console.warn`（含 sessionId、status、HTTP 状态码与响应片段）；fetch 抛错 `console.error`；成功不打印日志。`sendRecorded`（`traceUpstream`）与 `sendBackground`（原始 fetch）行为不再漂移。
- **不影响**：busy 立即发送 + 30s tick 节奏、idle 立即发送、24h 静默转 idle、`touch` 逻辑、`startBusy`/`stopBusy` 公开签名、四层记录边界（首个 busy 进请求记录，tick 与 idle 仍为 GLOSSARY「后台主动调用」）、`.catch` 兜底；不加重试/退避——下一次 30s tick 即天然重试。

## 4. 影响范围与非目标

**受影响**：`src/providers/codearts/snap.ts`、`src/providers/codearts/signer.ts`、`src/providers/codearts/snap.test.ts`、`src/providers/codearts/protocol-spec.md`（§5.1 修正，注明 `TM.00001001` 排障含义）。

**本次明确不做**：心跳重试/指数退避/熔断/失败计数；OTLP 遥测上报或与 chat traceId 交叉关联；心跳层处理凭证过期（继续由既有刷新链负责）；改变节奏/阈值/会话聚合粒度；logger 抽象或日志级别配置；e2e 场景矩阵新增心跳场景；修正其他后台主动调用（statistics/plugin、遥测、消息中心轮询）的响应检查；抓包脱敏名单补充。

## 5. 验证与观测

**失败测试先行**：`snap.test.ts` 两个既有 heartbeat 用例期望从错误形状（URL 无 query、body `{status:"busy"}`）修正为正确形状（`?status=busy` + body `{}`），与两个新增失败可见性用例（非 2xx warn、网络错误 error）合计 4 例先行变红；修复实现后转绿。测试只断言注入 fetch 收到的 URL/method/body 与 console 副作用；「首个 busy 进记录、tick 与 idle 不进记录」的边界断言保留。

**修复后全量**：`bun test` → **288 pass / 0 fail**（34 文件，1199 expect）；`bun build src/index.ts --target=bun` → 成功。

**实弹复验**（合并到集成分支后，探测脚本走修复后的 `signSh`/`buildHeartbeat` 形状）：

| 状态 | 请求形状 | 结果 |
|---|---|---|
| busy | `?status=busy` + `{}` | **200 `{"status":"ok"}`** |
| idle | `?status=idle` + `{}` | **200 `{"status":"ok"}`** |

**验证副作用**：早期探测因本地 STS 过期触发过一次 `refreshNow()`，轮换后的 refresh_token 已按既有刷新链语义回写 SecretStorage（与代理保活链行为一致）；最终复验未再触发刷新。

**未做 / 待补**：文档结构与本地链接检查未配置；实弹探测脚本为 /tmp 临时脚本，未入库（Out of Scope：e2e 矩阵新增心跳场景另行立项）。
