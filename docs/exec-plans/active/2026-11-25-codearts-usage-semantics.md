# CodeArts Anthropic usage 未缓存输入语义修复

类型：修复（CodeArts provider + 共享协议能力位）
状态：开发中（本地验证通过，未合并）
Owner：wayne
所属模块/入口：`src/providers/codearts/`、`src/protocols/`
功能卡：[CodeBuddy provider](../../product-specs/codebuddy-provider.md)（R37）
关联：[R37](../../product-specs/codebuddy-provider.md)、[2026-11-23-usage-field-semantics](2026-11-23-usage-field-semantics.md)、[2026-11-24-e2e-conformance-suite](2026-11-24-e2e-conformance-suite.md)
上游规格：[codearts/protocol-spec.md](../../../src/providers/codearts/protocol-spec.md) §7.3.1

## 1. 摘要

CodeArts 上游 OpenAI Chat usage 的 `prompt_tokens` 是**总输入**（含缓存命中），映射到 Anthropic Messages 时被原样透传为 `input_tokens`，导致 cc-switch / Claude Desktop 的 “fresh input” 被放大（实测平均 55.1×）。本变更在 CodeArts 协议能力中显式开启 `promptTokensIncludeCache=true`，由共享 Anthropic 映射把 `input_tokens` 修正为未缓存输入（总输入扣除缓存读取与缓存写入），缓存分项继续单独透传；共享路由默认能力位保持 false。修复由确定性单测与跨 provider 共享 e2e 场景锁住，并同步产品规格、协议实测与场景计数。

## 2. 变更理由与证据

- **实测证据（四层请求记录）**：trace 记录 `2026-11-25T01:33:36.888Z` 的 L4 为 `input_tokens=127,983`、`cache_read_input_tokens=127,232`、`cache_creation_input_tokens=0`；同一请求 L1 约 467,744 字符，按约 3.65 字符/token 折算约 128k tokens，与 127,983 同量级。若 127,983 是未缓存输入，总输入将达 ~256k tokens，与请求体规模不符，故 127,983 是总输入、真实未缓存约 751。
- **规模证据**：cc-switch DB 中 Any2Api CodeArts 2456 条，`Σinput=366,739,665`、`Σcache_read=360,085,376`、`Σfresh=6,654,289`，平均放大 55.1×。
- **先验**：[2026-11-23-usage-field-semantics](2026-11-23-usage-field-semantics.md) 已对 CodeBuddy 建立同一语义；当时「CodeArts 的 usage 语义未实测」，本次补齐实测后才开启能力位。
- **不伪造**：`cache_creation_input_tokens` 继续透传上游值，缺失按 0，不推导。

## 3. 行为 / AC delta

- **新增**：`CODEARTS_PROTOCOL_CAPABILITIES`（`src/providers/codearts/protocol-capabilities.ts`）抽出 CodeArts 协议能力常量，`promptTokensIncludeCache: true`；路由装配引用同一常量，审计时一眼可见。
- **修改**：共享 Anthropic 映射在该能力位为 true 时 `input_tokens = max(0, prompt_tokens - cached_tokens - cache_creation_tokens)`；为 false 时保持上游 `prompt_tokens` 原值（默认 false 不变）。
- **不影响**：非流式与流式两条 Anthropic 路径共用同一映射；流式多帧 usage 按字段合并，缺失字段不覆盖已采集值；请求映射、错误结构、模型池、codebuddy 私有逻辑。
- **总输入还原**：`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`。
- **不提供兼容层/开关**：语义不同的上游只有能力位一条声明路径。

## 4. 影响范围与非目标

**受影响**

- `src/providers/codearts/protocol-capabilities.ts`（新增）、`src/providers/codearts/index.ts`（引用常量）
- `src/protocols/protocols.test.ts`（能力位与扣减公式单测）
- `scripts/e2e/scenarios/anthropic.ts`、`scripts/e2e/scenarios/index.test.ts`（共享 e2e 场景 `messages.usage.cache_semantics`）
- 文档：产品规格 R37、CodeArts 协议规格 §7.3.1、README 与 e2e 计划的场景计数、`docs/generated/index.md` 基线说明、本变更记录

**本次明确不做**

- `message_start.usage.input_tokens` 仍为 0 的限制（另开 issue #18 跟踪）。
- cc-switch 的代码、数据库或 `input_token_semantics` 配置修改。
- 给 CodeArts 增加 `cache_control`（上游自动缓存已生效，非本次问题）。
- 全量 e2e 基线重生成：只定点跑新场景，`docs/generated/` 保持 2026-11-24 的 28 场景快照。
- 其他 provider 的 usage 语义调整。
- 不新增 ADR：这是契约对齐的 bug fix，不满足「难回退 / 无上下文困惑 / 真实权衡」三条。

## 5. 验证与观测

- **单测（确定性、离线、假 backend）**：
  - `bun test` → **277 pass / 0 fail**。
  - 关键断言：能力位 `promptTokensIncludeCache === true`；假 backend 返回 `prompt_tokens=31 / cached=7 / creation=2` 时非流式与流式均得 `input_tokens=22`，且 `cache_read=7` / `cache_creation=2` 保留。
- **构建**：`bun build src/index.ts --target=bun` → exit 0。
- **定点 e2e（只跑新场景 `messages.usage.cache_semantics`，真实 token）**：
  - CodeArts：第一次 `input=12371 / read=0`，第二次 `input=19 / read=12352` → pass。
  - CodeBuddy：第一次 `input=12373 / read=0`，第二次 `input=21 / read=12352` → pass。
  - 场景集计数 28 → 29；两 provider 执行同一判定，不按 provider 分支。
- **场景前缀调整**：初版用约 4k 字符 system 无法稳定越过上游可缓存前缀阈值（阈值在 ~1.3k tokens 以上），改为约 64k 字符（880 段重复句 + 唯一 marker）保证首轮冷缓存；第二次无命中时最多重试 2 次，仍无命中判 fail 而非 skip。
- **未做**：`message_start` 路径的 usage 断言（#18）；cc-switch 行级回归；全量基线重跑。

## 6. 回滚方案

- **回滚方式**：revert 本变更提交（含能力位常量与 e2e 场景）；无数据迁移、无配置变更。
- **数据/配置兼容**：无持久化状态；回滚后 CodeArts 的 Anthropic `input_tokens` 恢复为上游总输入。
- **回滚验证**：`bun test` 通过；定点 e2e 场景随场景集一并回退（计数回到 28）。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 上游缓存命中存在时延 / 一致性窗口 | 第二次请求可能未命中，场景 flake | 唯一 marker 降低串扰；无命中最多重试 2 次；仍失败判 fail，便于发现真实回归 |
| 上游可缓存前缀阈值变化（当前 >~1.3k tokens） | 冷缓存不成立，场景误判 | 场景用约 64k 字符前缀留足余量；阈值变化时调整场景数据而非按 provider 分支判定 |
| 上游若改为 Anthropic 语义（`prompt_tokens` 已排除缓存） | 再扣除会少算 `input_tokens` | 以协议规格 §7.3.1 与实测为事实源；上游变更时更新能力位并补测试 |
| `message_start.usage.input_tokens` 仍为 0 | 只读 `message_start` 的客户端看不到正确输入量 | 由 #18 单独跟踪，不在本次范围 |
| 全量基线仍是 28 场景快照 | 基线不含缓存语义场景 | 已在 README / e2e 计划 / `docs/generated/index.md` 注明；下次全矩阵重跑时再生成 |

## 8. 关联与证据

- 产品规格：[codebuddy-provider.md](../../product-specs/codebuddy-provider.md)（R37）
- 协议规格：[codearts/protocol-spec.md](../../../src/providers/codearts/protocol-spec.md) §7.3.1
- 变更记录：[2026-11-23-usage-field-semantics](2026-11-23-usage-field-semantics.md)（CodeBuddy 侧同一语义）
- e2e：[2026-11-24-e2e-conformance-suite](2026-11-24-e2e-conformance-suite.md) §5、§11
- 工单：#15（能力位 + 单测）、#16（共享 e2e 场景）、#17（本文件与文档同步）；spec #14

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 2026-11-25 #15 合并（aa50e97）：能力位常量 + 单测，CodeArts `promptTokensIncludeCache=true` |
| 开发中 | wayne | 2026-11-25 #16 合并（18ed2fe）：共享 e2e 场景 `messages.usage.cache_semantics`，场景集 28→29，两 provider 定点 pass |
| 开发中 | wayne | 2026-11-25 #17：产品规格 R37 纳入 CodeArts、协议规格补 §7.3.1 实测、README 与 e2e 计划计数 29、基线注明 28 场景快照、本变更记录；`bun test` 277 pass / 0 fail，`bun build` exit 0 |