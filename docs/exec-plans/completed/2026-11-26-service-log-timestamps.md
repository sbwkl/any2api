# 服务日志统一加 ISO UTC 时间戳

类型：可观测性 / 变更
状态：已验证
Owner：wayne
所属模块/入口：`src/shared/log.ts`、各 provider 与注册表的生产日志调用点
关联：本轮服务日志与请求记录时间对齐分析；[GLOSSARY](../../../GLOSSARY.md)

## 1. 摘要

服务日志（launchd 的 stdout/stderr）当前没有时间戳，无法与请求记录的 `ts` 或上游错误时间对齐。本变更把生产服务日志统一改为 `ISO UTC 时间戳 + 原消息`。

## 2. 变更理由与证据

- 触发原因：今日请求记录中 37 条上游读取中断可定位到具体 `ts`，但 `logs/any2api.err.log` 的 ECONNRESET 无时间戳，无法逐条核对。
- 证据：`logs/any2api.err.log` 69 次 ECONNRESET 均以 `[snap]` 开头，无时间字段；请求记录每条有 `ts`。
- 不做的后果：后续排障仍需靠文件 mtime 和行序猜测，无法稳定归因。

## 3. 行为 / AC delta

- 服务日志的每条 `log` / `warn` / `error` 输出以 `YYYY-MM-DDTHH:mm:ss.sssZ` 开头，随后一个空格和原消息。
- 字符串参数内含 `\r\n`、`\n` 或 `\r` 时按物理行拆分；每行使用同一 ISO UTC 时间戳，非字符串参数保留在其所在物理行。
- 请求记录（四层观测）格式不变。
- 本次不新增 PID、request id 或其它关联字段。

## 4. 影响范围与非目标

**受影响**：`src/index.ts`、`src/registry.ts`、`src/providers/codearts/{index,config,refresher,openai,snap}.ts`、`src/providers/codebuddy/{index,msgcenter}.ts`、`src/shared/log.ts`、相关测试与 `GLOSSARY.md`。

**本次不做**：日志轮转、结构化 JSON 日志、request id / PID、开发自检脚本 `test-policy.ts` / `test-signer.ts`、`sm4.ts` 的 `import.meta.main` 输出。

## 5. 验证与观测

- 自动化测试：`src/shared/log.test.ts` 断言三种级别均带 ISO UTC 前缀，并断言多行字符串参数的每个物理行都带同一时间戳。
- 全量门禁（2026-11-26，worktree `any2api-integration-service-log-timestamps`，head `197b29f`）：`bun test` → 332 pass / 0 fail / 1341 expect；`bun build src/index.ts --target=bun` 退出码 0；`tsc --noEmit` 退出码 0；`bun scripts/check-docs-links.ts` → 全部本地链接有效。
- 手工验证：`PORT=18787 bun src/index.ts`，stdout 首行为 `2026-11-26T08:20:13.360Z [codearts] ...`，stderr 为空。
- 未验证：launchd 生产服务尚未重启加载本变更（待部署）。

## 6. 回滚方案

回滚本分支即可；不涉及数据或配置迁移。

## 7. 风险与未决问题

- 时间戳只解决时间对齐，不提供逐条请求关联；已确认本次不追加 request id。
- 现有测试若断言完整日志字符串需同步调整；当前仅 snap 心跳测试断言消息片段，不依赖前缀。

## 8. 关联与证据

- 日志分析结论：37 条上游读取中断，时间 2026-11-26T02:30:08.481Z–05:42:19.887Z。
- 规格：[#33](https://github.com/sbwkl/any2api/issues/33)。

## 9. 变更记录

| 状态 | 操作人 | 证据/链接 |
|---|---|---|
| 开发中 | wayne | 2026-11-26 grilling 锁定：服务日志加 ISO UTC 时间戳，不加其它关联字段 |
| 已验证 | wayne | head `197b29f` 单测 332 pass / 0 fail；build、tsc、docs-links 通过；真实进程冒烟通过；生产未部署 |
