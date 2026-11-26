# CodeArts L3 记录解密后的明文响应

CodeArts 的 chat 响应在 wire 上是 SM4-GCM 加密的 SSE；四层观测的 L3 需要区分「上游未返回」与「翻译层丢弃」，因此不能以不可读密文作为正文。默认记录解密后的明文，使 L3 成为经 provider 解码、尚未协议翻译的上游可读响应，而不是传输层字节的忠实副本。

## 决策

- L3 的 `body`、`headers` 与 `chunks` 均表示 provider 解码后的可读响应；CodeArts 的 `x-encrypt-*` 头不进入 L3。
- `chunks[].bytes` 记录解码后输出块的 UTF-8 字节数，保证与 `body` 可对账。
- 解密失败时写 `decode_error`；`stage` 不设枚举，`body` 保留失败前已成功解密的明文。
- CodeArts 的解密仅在该 provider 内实现为专用 `decryptingFetch`，共享 trace 不提供通用解码钩子；解密失败通过共享的最小错误载体 `UpstreamDecodeError` 传给 trace。
- 记录 schema 从 2 升到 3；历史 schema 2 文件原样保留，不回溯迁移。
- 采集仍默认关闭；开启四层记录后，CodeArts 的 L3 默认落明文，不提供密文模式或额外开关。历史快照不追溯改写。

## 背景与替代方案

该选择改变默认隐私基线并放弃 wire 字节可追溯性。权衡结论：审计可读性优先；扩大落盘面的隐私风险由「采集默认关闭 + 文件 0600 + 用户明确接受」承担，wire 字节可追溯性损失由 provider 日志与网络层另行排查承担。替代方案包括：默认密文并加 `encrypted` 标记（审计不可读）、opt-in 落解密明文（默认仍不可用）、只落结构化摘要（丢失原始语义）。它们均无法同时满足本次决策的审计可读性与默认可用性。
