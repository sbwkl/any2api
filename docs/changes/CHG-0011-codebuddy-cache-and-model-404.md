# CHG-0011 CodeBuddy prompt cache_control 与未知模型 404

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/shared/cache.ts`、`src/providers/codebuddy/openai.ts`、`src/providers/codebuddy/config.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0010](CHG-0010-codebuddy-peer-audit.md)

## 1. 摘要

落实同类项目审计的 #1、#4：

1. **prompt cache_control**：对单段文本最长的一条 system 与最后一条 user 消息（单段 ≥1024 字符）自动加 `cache_control: {type:"ephemeral"}`；单条消息已有显式 cache_control 时只跳过该消息。
2. **未知模型 404**：`resolveModel` 不再回退到「原样透传」，未在 codebuddy 模型目录中的模型直接返回 404 `model_not_found`，不向上游发请求。

## 2. 变更理由与证据

- **#1 证据**：`orangeboyChen/codebuddy2api` 的 `lib/server/proxy/codebuddy/upstream.ts` 在 `normalizeMessages` 后调用 `applyPromptCacheControl`，`MIN_AUTO_CACHE_TEXT_LENGTH = 1024`，给 system / 最后一条 user 加 `cache_control`。我们的 Anthropic 适配器此前把客户端的 cache_control 丢掉，也不会自动添加，导致缓存命中率低、token 画像与 IDE 不同。
- **#4 证据**：同类项目按 credential supported models 校验；我们之前对未知模型回退 `{id:name,name}` 并透传上游，上游返回 400/11136，客户端难以区分「模型不存在」与「上游错误」。
- **不做的后果**：缓存能力浪费；未知模型请求打到上游，错误信息不可控。

## 3. 行为 / AC delta

- **新增 R31**：When codebuddy 的**最长单段 system**（单段 ≥1024）或最后一条 user 消息（单段 ≥1024）没有显式 `cache_control`, the system shall 为该消息添加 `cache_control: {type:"ephemeral"}`；其他消息的显式 cache_control 不影响该判断。
- **新增 R32**：When 请求的模型不在 codebuddy 模型目录中, the system shall 返回 404 `model_not_found`，不向上游发送请求。
- **修改**：`resolveModel` 返回 `ModelInfo | undefined`；codebuddy `respond` 在模型为空时返回 404。

## 4. 影响范围与非目标

**受影响**

- 新增 `src/shared/cache.ts` + 测试。
- 修改 `src/providers/codebuddy/openai.ts`：应用 cache control；模型 404。
- 修改 `src/providers/codebuddy/config.ts`：`resolveModel` 不再回退。
- 测试：`src/shared/cache.test.ts`、`config.test.ts`、`openai.test.ts`。
- 文档：REQ R31/R32、本 CHG、docs/README。

**本次明确不做**

- 不改 codearts 的模型解析与缓存策略。
- 不处理 prompt 超长时的截断（只加 cache_control）。
- 不实现自定义 cache 路由/多账号缓存。

## 5. 验证与观测

- 单元测试：
  - 长 system / 最后一条 user → content 转为数组并带 `cache_control`；
  - 短消息、已有 cache_control → 不变；
  - `resolveModel` 已知 id/展示名 → 命中；未知 → undefined；
  - `handleChat` 未知模型 → 404 `model_not_found`。
- `bun test` → **103 pass / 0 fail / 364 expect() calls**（14 个测试文件）。
- 真实上游 e2e：
  - system 约 1.1KB + `cache_control` → **200**，usage 出现 `cached_tokens`；
  - 未知模型 → **404** `model_not_found`。
- `bun build src/index.ts --target=bun` → 成功。
- 临时集成分支全量测试：见 §9。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：移除 `applyPromptCacheControl` 调用与 `src/shared/cache.ts`；`resolveModel` 恢复回退 `{id:name,name}`。
- **数据/配置兼容**：无持久化状态；回滚后未知模型重新透传上游。
- **回滚验证**：103 tests 回退；未知模型重新 400；缓存字段消失。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| cache_control 改变请求体 | 上游若不支持会 400 | 实测 200；同类项目已在生产使用 |
| 严格模型校验 | 使用自定义模型名的客户端会 404 | 这是预期；`/v1/models` 列出可用模型，未知模型应显式报错 |
| 缓存最小长度阈值 | <1024 的 system 不缓存 | 与同类项目一致（1024） |
| 客户端已有 cache_control | 不重复添加 | 保留客户端显式控制 |

## 8. 关联与证据

- 参考：`orangeboyChen/codebuddy2api` 的 `upstream.ts`（`MIN_AUTO_CACHE_TEXT_LENGTH=1024`、`applyPromptCacheControl`）。
- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 代码：`src/shared/cache.ts`、`src/providers/codebuddy/openai.ts`、`config.ts`
- 后续：cache 目标改为「最长 system」并逐条判断，见 [CHG-0012](CHG-0012-review-fixes-2.md)。
- 测试：`src/shared/cache.test.ts`、`config.test.ts`、`openai.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | cache_control + 未知模型 404；103 tests；真实上游 e2e 通过；未部署 |