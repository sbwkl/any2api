# 四层请求记录：trace 扩展（L1–L4）

类型：可观测性 / 测试基础设施
状态：已验证（本地回归通过；未合并 main、未部署）
Owner：wayne
所属模块/入口：`src/shared/trace.ts`、`src/registry.ts`、两 provider 出站调用点
关联：spec [sbwkl/any2api#6](https://github.com/sbwkl/any2api/issues/6)、[GLOSSARY](../../../GLOSSARY.md)、[e2e 一致性测试](../active/2026-11-24-e2e-conformance-suite.md)

## 1. 摘要

现有采集只覆盖 L1 入站请求与 L4 出站响应，L2 上游请求只有 body，L3 上游原始响应缺失，无法区分「上游不支持」与「翻译层静默丢弃」，也无法评估信封仿真准确性。本变更把 trace 扩展为四层观测：一次入站请求一条 JSONL 记录，内嵌 L1–L4；请求上下文内的所有上游调用完整记录（多尝试、原始流式帧与到达时间）；后台主动调用不记录；不截断、不轮转；敏感头脱敏；文件 0600；开关仍为单一环境变量。

## 2. 目标与验收

- 一次入站请求产生一条 `schema: 2` 记录，含 L1（全量头脱敏、解析后 JSON / raw_request）、`upstream[]`（每次尝试的 L2 + L3，含 chunk 到达时间）、L4（状态、头、content_type、正文、first_byte_ms、duration_ms、complete、abort_reason）。
- 请求上下文内的全部上游调用（含 401 刷新重发、排队重试、加密协商重发、刷新/排队/模型发现）按尝试记录；后台主动调用（心跳、遥测、凭证保活、消息中心轮询、启动时模型发现）不记录。
- 记录不截断、不设安全阀、不轮转、不清理；按天文件 `capture-YYYY-MM-DD.jsonl` 保留，删除由用户手工执行；文件权限 0600。
- 采集不影响请求主路径：写入失败静默，响应内容与延迟不变。
- 修复既有缺陷：响应头在消费前快照（content_type 恒 null）、流式耗时同时记录首字节与总时长。
- e2e 的上游请求转储与报告逻辑保持不变；e2e 语料评估不做新格式适配（遇 v2 记录失败按决定不处理）。
- 验证：`bun test` 全绿；`bun build src/index.ts --target=bun` 与 e2e 脚本构建零错误（证据见 §6）。

## 3. 决策台账（2026-11-25 grilling 锁定）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 层定义 | L1 入站请求、L2 上游请求、L3 上游原始响应、L4 出站响应 |
| D2 | 记录模型 | 单一开关、单一日文件、一条记录内嵌四层，不做跨记录关联 |
| D3 | 上游范围 | 请求上下文内全部上游调用进 `upstream[]`，不区分推理/辅助、不加类别字段 |
| D4 | 后台调用 | 不记录；判定规则为不继承请求异步上下文 |
| D5 | 写入时机 | 请求结束一次性追加；崩溃只丢进行中请求 |
| D6 | 中断标记 | `complete:false` + `abort_reason` ∈ {client_disconnect, upstream_error, timeout, proxy_error} |
| D7 | 脱敏 | authorization、x-api-key、x-auth-token、x-refresh-token、x-security-token、x-device-token、x-user-id、cookie、set-cookie → `<redacted>` |
| D8 | 限制 | 不截断、无安全阀；磁盘与内存风险接受 |
| D9 | 保留 | 不轮转、不清理，用户手工删除 |
| D10 | 权限 | 0600 |
| D11 | 配置 | 仅环境变量；废弃单条正文上限变量 |
| D12 | e2e | 上游请求转储与报告不动；语料评估不适配新格式 |

实现复核（2026-11-25）：D1–D12 与最终实现一致，无行为偏差。实现层限制仅一处——L1 头经 Fetch `Headers` 记录，同名头会被合并、名称顺序按规范归一，无法还原线上原始重复头与顺序（L2 为构造对象，保留插入顺序）；见 §5。

## 4. 影响范围与非目标

**受影响**：共享 trace 记录器与请求上下文、注册表接线、codearts / codebuddy 出站调用点、README 环境变量表、GLOSSARY。

**本次不做**：e2e 报告消费新记录、fixture 录制 L3、离线 mock 回放、语料评估适配、截断/采样/安全阀/轮转/保留期、后台主动调用记录、HTTP 查询接口与 UI、自动聚类或自动修复、移除 e2e 上游请求转储。

## 5. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| 磁盘无界增长 | 长期占用磁盘 | 用户已接受；手工删除 |
| 超大响应内存缓冲 | 进程内存压力 | 用户已接受；已知风险 |
| 提示词 / 工具内容明文落盘 | 隐私 | 仅本地私有环境；目录与文件仅所有者可访问 |
| 响应旁路读取影响流 | 响应延迟或背压 | 旁路读取不得阻塞主路径，必要时异步排水 |
| 后台调用误记 | 记录混入非客户端流量 | 以请求异步上下文为判定边界 |
| 请求内创建的定时器继承首个请求的 ALS 上下文 | 后台 tick 可能混入首个请求的记录 | 心跳 tick 与遥测已显式用原始 fetch 脱离上下文；未来新增定时上游调用需同样显式脱离 |
| 代理无主动请求超时 | `timeout` 仅在 handler 抛 `TimeoutError` 时产生，挂起的上游不会自动记 timeout | 中断标记以实际异常为准；主动超时另行设计 |
| 上游网络错误被 provider 翻译为完整 502 响应 | L4 记 `complete:true` / `abort_reason:null`，中断信息只体现在该次 upstream 尝试的 `complete:false` | 归因时对照 `upstream[]` 中该尝试；L4 语义保持「出站响应完整返回」 |
| L1 头顺序 / 重复头不可还原 | 信封仿真的头集合顺序判断可能失真 | Fetch `Headers` 语义导致同名头合并、顺序归一；当前真实客户端未出现重复头，接受 |
| 进程崩溃丢失进行中请求 | 该请求无记录 | 设计选择（D5）：请求结束才落盘；已接受 |
| 生产 launchd 仍设置已废弃的单条正文上限变量 | 无功能影响（v2 已忽略该变量） | 待用户移除该键并重启服务；本变更不改 launchd |

## 6. 验证与证据（2026-11-25，本地 worktree）

- [x] 单测：`bun test` → 273 pass / 0 fail，32 个文件、1157 次断言。覆盖 trace 核心（schema 2、L1 头脱敏、parsed / `raw_request`、多尝试顺序、chunk 计时、中断原因、无截断（大 body 完整记录）、空正文 `first_byte_ms` 兜底、handler 异常不阻塞响应、0600、无上下文 no-op、写入失败静默）、注册表集成缝隙（L1–L4、空 `upstream`、messages / responses 入站）、两 provider 出站注入 fetch 的记录与无上下文回归。
- [x] 静态检查：`bun build src/index.ts --target=bun`、`bun build scripts/e2e/run.ts --target=bun` 均退出码 0、stderr 为空。
- [x] e2e 未改动：`git diff --stat main...HEAD -- scripts/e2e` 输出为空。
- [x] 残留清理（零残留）：全仓 `grep TRACE_CAPTURE_MAX_BYTES|startTraceCapture|maxBodyBytes` 在 src / scripts / docs / README 零命中；`git diff main...HEAD -- src scripts` 无新增任何 `console.*` 调用；README 与 e2e exec-plan 中原有的旧版限额与轮转描述已按 schema 2 实现改写。
- [x] 文档结构 / 本地链接检查：仓库未配置项目级检查（未配置；待补）。对改动的 README、本文件与 e2e exec-plan 共 23 个相对链接人工核对：22 个存在；`README.md → ../AGENTS.md` 为既有跨项目约定（指向工作区根，在当前 worktree 不存在），非本次引入。
- [ ] 部署（用户手工，未执行）：生产 launchd 仍加载旧配置；需移除已废弃的单条正文上限变量并重启服务（`launchctl bootout` + `bootstrap`）。

## 7. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 已完成 | wayne | 2026-11-25 grilling 锁定 D1–D12；spec #6 已发布；本文件创建 |
| 已完成（#7 核心） | wayne | e807a74（合并 6e715ad）：schema 2 记录器、请求上下文、出站记录入口与单测 |
| 已完成（#9 codebuddy） | wayne | 7bcaf05（合并 5d3e74d）：出站调用接入四层记录 |
| 已完成（#8 注册表） | wayne | fbbbeb5 + 525ecbb（合并 55cc84d）：请求级上下文、中断原因、messages / responses 集成缝隙 |
| 已完成（#10 codearts） | wayne | 0a28f5f（合并 f900204）：出站调用接入四层记录并新增可注入 fetch |
| 已完成（#11 收尾） | wayne | 本次提交：README 采集说明、e2e exec-plan 旧说明修正、本文件证据与变更记录；验证见 §6 |
| 已完成（review 修复） | wayne | 本次提交：删除 trace 死代码与旧上限变量残留；空正文 `first_byte_ms` 兜底；handler 异常不再等待上游 pending 流；codebuddy 出站重复调用去重、codearts 心跳记录 / 后台发送拆分；本文件迁入 `completed/` 并补风险与语料说明；验证见 §6 |
