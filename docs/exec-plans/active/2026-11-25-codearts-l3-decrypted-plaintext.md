# CodeArts L3 记录解密后的明文响应

类型：可观测性 / 隐私边界
状态：已实现
Owner：wayne
所属模块/入口：`src/shared/trace.ts`、`src/providers/codearts/snap.ts`、`src/providers/codearts/snap.test.ts`、README、GLOSSARY、ADR
关联：GitHub issue [#30](https://github.com/sbwkl/any2api/issues/30)、[四层请求记录](../completed/2026-11-25-four-layer-request-record.md)、[ADR](../../design-docs/adr/codearts-l3-decrypted-plaintext.md)

## 1. 摘要

CodeArts chat 的响应在 wire 上是 SM4-GCM 加密 SSE；当前四层观测的 L3 忠实记录密文，导致审计无法区分「上游不支持」与「翻译层静默丢弃」。本变更把 CodeArts 的 L3 改为默认记录解密后的明文响应，并把记录 schema 升到 3。

## 2. 目标与验收

- CodeArts chat 成功响应在 L3 中为解密后的可读 SSE 明文；调用方仍收到同一份解密结果。
- L3 不再保留 `x-encrypt-*` 头；`content-type` 为解码后的类型。
- `chunks[].bytes` 与 L3 `body` 可对账，表示解码后输出块。
- 解密失败时 L3 写不设枚举的 `decode_error.stage`，`body` 保留失败前已解密的明文，`complete:false`。
- 非 CodeArts 上游与不带传输加密的 CodeArts 响应保持现有记录语义。
- 记录 schema 为 3；历史 schema 2 文件不迁移。
- 采集开关不变，默认仍关闭；开启后无需新增环境变量，CodeArts L3 默认明文。

## 3. 决策台账（2026-11-25 grilling 锁定）

| # | 决策 | 结论 |
|---|---|---|
| D1 | L3 定义 | 上游可读响应：provider 解码后、协议翻译前 |
| D2 | 默认策略 | 默认落 CodeArts 解密后的明文全文 |
| D3 | 加密头 | L3 不保留 `x-encrypt-*` |
| D4 | chunk 语义 | 解码后输出块；`bytes` 为 UTF-8 字节数 |
| D5 | 解密失败 | 结构化 `decode_error`；`stage` 不设枚举；保留已解出明文 |
| D6 | 重试 | 流式解密失败不新增重试 |
| D7 | 错误位置 | 只写 `upstream[i].response.decode_error`，不改 `abort_reason` |
| D8 | 实现位置 | CodeArts 专用 `decryptingFetch`；共享 trace 不加通用钩子 |
| D9 | schema | 升到 3，保持现有记录形状 |
| D10 | 历史 | schema 2 与现快照原样保留，不回溯改写 |
| D11 | 文档 | 更新 README / GLOSSARY；ADR 记录隐私权衡 |
| D12 | 错误载体 | 共享 `UpstreamDecodeError` 仅承载 `stage` / `chunk_index` / `message`；CodeArts 负责抛出，trace 负责写入 L3 |
| D13 | 作用范围 | 四层采集仍默认关闭；开启后 CodeArts L3 默认明文，不提供密文模式或额外开关 |

## 4. 影响范围与非目标

**修改**

- `src/shared/trace.ts`：schema 3；导出 `UpstreamDecodeError`；L3 可选 `decode_error`；chunks 语义注释与实现。
- `src/providers/codearts/snap.ts`：在 `traceUpstream` 前组合专用 `decryptingFetch`。
- `src/providers/codearts/snap.test.ts`：L3 明文、头移除、chunk 对账、解密失败与历史密文断言改写。
- `README.md`：请求采集说明改为 schema 3、CodeArts L3 明文。
- `GLOSSARY.md`：已改为「上游可读响应」。
- `docs/design-docs/index.md` 与 ADR：已登记。

**本次不做**

- 通用 provider 解码钩子。
- 解密失败重试或预读缓冲。
- schema 2 回溯迁移。
- 轮转、保留期、采样或安全阀。
- 其它 provider 的 L3 语义调整。

## 5. 验证

- `bun test` 全绿；新增 CodeArts L3 明文断言。
- `bun build src/index.ts --target=bun`、`tsc --noEmit` 通过。
- `bun scripts/check-docs-links.ts` 通过。
- 手工核对一条 CodeArts 采集记录：L3 `body` 以 `data:` / `{` 开头且不含 `iv:tag:ct`。

## 6. 风险与未决

| 风险 | 影响 | 处理 |
|---|---|---|
| 默认明文扩大敏感内容落盘面 | 隐私 | 用户已明确接受；文件仍 0600、opt-in 开启 |
| 失去 wire 字节可追溯性 | 无法核对传输层体积/密文形态 | 由 provider 日志与网络层另行排查；本次接受 |
| 解密失败只保留前缀 | 审计不完整 | `complete:false` + `decode_error` 明确表达 |
| 现有快照不可复现 | 无法回填 1043/1043 证据 | 文档标为历史快照、待补可复验证据 |

## 7. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 设计锁定 | wayne | 2026-11-25 grilling D1–D13；ADR 与术语已更新 |
