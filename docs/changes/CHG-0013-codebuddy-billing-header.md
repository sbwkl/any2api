# CHG-0013 剥离客户端计费指纹头，修复 Claude Code 400 Request blocked

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0009](CHG-0009-codebuddy-system-sanitize.md)、[CHG-0014](CHG-0014-codebuddy-billing-header-scope.md)（清理范围收窄）

## 1. 摘要

Claude Code（含 Claude Desktop 的 Code 标签页）在 `system` 的第一个 text 块里发送客户端计费指纹：

```
x-anthropic-billing-header: cc_version=2.1.319.cb2; cc_entrypoint=claude-desktop
```

只要 system 中出现字面量 `x-anthropic-billing-header:`，CodeBuddy 上游就返回 `400 {"error":{"message":"Request blocked. Please send it again"}}`。该行只用于客户端计费/遥测，删除不影响模型行为。

修复：代理在发送上游前删除 system 文本中以 `x-anthropic-billing-header:` 开头的整行；被删空的 text 块与被清空的 system 消息不再发送。

> 清理范围已由 [CHG-0014](CHG-0014-codebuddy-billing-header-scope.md) 收窄：不再做全局 `.trim()`，只有「清洗前非空、清洗后为空」的块/消息才被丢弃。本 CHG §3/§5 描述的是初版行为。

## 2. 变更理由与证据

- **现象**：用户把 Claude Code 切到 CodeBuddy 后仍报 400（[CHG-0009](CHG-0009-codebuddy-system-sanitize.md) 只替换 `You are Claude Code, Anthropic's official CLI for Claude.` 这句 preamble，而 Claude Code 的 system 首块只有计费头，第二句已是 `You are a Claude agent, built on Anthropic's Claude Agent SDK.`，R27 覆盖不到）。
- **复现方式**：用真实 Claude Code CLI 发起会话（`claude -p "Reply with exactly: OK"`，指向本代理），在转发代理上抓到原始 `/v1/messages` 请求（101,197 字节；`system` 3 块，首块为计费头；21 个工具；`thinking: {type:"adaptive}`），原样重放：

  | 服务端代码 | 结果 |
  |---|---|
  | 合并后的 main（不含本变更） | **400 Request blocked** |
  | 本变更 | **200**，`result=OK` |

- **触发点定位**（同一请求逐项改写后重放，均打到不含本变更的服务端）：

  | 改写 | 结果 |
  |---|---|
  | 删除首块（计费头） | 200 |
  | 首块文本置空（保留空 text 块） | 200 |
  | 首块替换为中性文本 | 200 |
  | `cc_entrypoint=claude-desktop` → `sdk-cli` | 400 |
  | 去掉 `; cc_entrypoint=...` | 400 |
  | 改 `cc_version` 取值 | 400 |
  | 只留 `x-anthropic-billing-header:` | 400 |
  | 头名改为 `x-other-header:` | 200 |

  → 触发点是 system 中出现字面量 `x-anthropic-billing-header:`，与取值、客户端类型、所在块位置无关。
- **空 system 内容本身不被拦截**：`system` 为 `[]`、`""`、`[{type:"text",text:""}]`、system 消息 `content:""`、`content:"   "` 均 200。因此 `envelope.ts` 里「删空的 text 块移除」「被清空的 system 消息丢弃」不是修复所必需，属于清理（避免把只承载该头的空块/空消息发给上游），行为影响见 §4。

## 3. 行为 / AC delta

- **新增 R34**：When codebuddy 的 system/developer 文本（字符串或 text 块）包含以 `x-anthropic-billing-header:` 开头的行, the system shall 在发送上游前删除该行；删除后为空的 text 块与被清空的 system 消息不再发送。
- **修改**：`sanitizeSystemText` 在 R27 的 preamble 替换之后追加计费头删除与首尾空白裁剪；`codebuddy` 的 `normalizeMessages` 对 system/developer 结果为空的消息返回 `null` 并过滤。
- **不改变**：其他 system 内容、用户消息、工具调用、模型映射、流式/非流式行为；codearts 不受影响。

## 4. 影响范围与非目标

**受影响**

- `src/shared/system.ts`：新增 `BILLING_HEADER` 正则与 `.trim()`。
- `src/providers/codebuddy/envelope.ts`：text 块过滤、空 system 消息丢弃。
- 测试：`src/providers/codebuddy/envelope.test.ts`（+2 例）。
- 文档：REQ-0001 R34、本 CHG。

**本次明确不做**

- 不扩展成通用请求头/指纹 denylist（只覆盖实测的这一个头）。
- 不改 codearts、不改用户消息内容。
- 不处理非 system 消息中的该字符串（实测触发点是 system；如出现再扩展）。

## 5. 验证与观测

- 单元测试：`bun test` → **112 pass / 0 fail / 387 expect() calls**（14 个文件）。
- 构建：`bun build src/index.ts --target=bun` → 成功（130.91 KB）。
- 真实 Claude Code e2e（用户报障的同一条路径，`claude -p`）：
  - 本变更 → **200**，`is_error:false`、`result:"OK"`、1 轮、21 个工具 schema 正常下发；
  - 不含本变更的同代码副本（:8788）→ **400 Request blocked**（对照）。
- 原始请求重放矩阵：见 §2。
- 未部署；分支 `feat/codebuddy-billing-header` 待用户审核。

## 6. 回滚方案

- **回滚方式**：移除 `src/shared/system.ts` 中的 `BILLING_HEADER` 与 `.trim()`，恢复 `envelope.ts` 的 system 处理。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：Claude Code 会话重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 上游可能再拦截其他客户端指纹 | 仍可能 400 | 只覆盖实测头；出现新拦截时扩展正则 |
| 用户 system 里恰好有同名文本行 | 被删除 | 该行是客户端遥测格式，正常内容不会以此开头 |
| `.trim()` 改变 system 首尾空白 | 极小 | 仅影响首尾空白；实测无语义影响 |
| 空 text 块被移除后 `cache_control` 位置变化 | 无实际影响 | cache 在 normalize 之后按消息计算，不依赖块下标 |

## 8. 关联与证据

- 用户报告：Claude Code 切换到 CodeBuddy 仍提示 400。
- 实测：真实 Claude Code 会话抓包 + 原样重放 + 逐项改写矩阵（§2）。
- 代码：`src/shared/system.ts`、`src/providers/codebuddy/envelope.ts`
- 测试：`src/providers/codebuddy/envelope.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 计费头剥离；112 tests；Claude Code e2e 200（对照 400）；未部署 |