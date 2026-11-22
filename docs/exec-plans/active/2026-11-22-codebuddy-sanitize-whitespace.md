# 修复 Claude Code preamble 空白变体仍被 400（Request blocked）

| 项 | 内容 |
|---|---|
| 类型 | 变更文档 |
| 状态 | 进行中 |
| Owner | wayne |
| 所属模块 / 入口 | `src/shared/system.ts` |
| 关联 | [产品规格：CodeBuddy provider](../../product-specs/codebuddy-provider.md)、[CHG-0009](CHG-0009-codebuddy-system-sanitize.md) |

## 1. 摘要

Claude Desktop 新会话发送的 Claude Code 自述首句里，`You are Claude Code,` 与 `Anthropic's` 之间是**双空格**（或其他空白变体）。原 sanitizer 正则只匹配单空格，未替换该 preamble，CodeBuddy 上游仍返回 `400 Request blocked`。

修复：把正则改为空白/撇号容错：

```ts
/You\s+are\s+Claude\s+Code,\s+Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\.?/gi
```

## 2. 变更理由与证据

- **现象**：项目移到 `/Users/wayne/workspace/any2api` 并重启服务后，Claude Desktop 新建会话（如「文档结构与 usage-ledger 差异」）仍报 `Request blocked. Please send it again`（400）。
- **实测对照**（本机，2026-11-22，live service）：
  - 单空格 `You are Claude Code, Anthropic's official CLI for Claude.` → 200（旧 sanitizer 已覆盖）；
  - **双空格** `You are Claude Code,  Anthropic's official CLI for Claude.` → **400（旧 sanitizer 未覆盖）**；
  - 换行、制表符、Unicode 撇号、无句点 → 200；
  - 双空格在修复后 → **200**；多词之间多空格（`You  are  Claude  Code, ...`）同样 → 200。
- **结论**：触发点是同一句 preamble 的空白变体；后端按整句匹配，空白不一致就绕过 sanitizer。

## 3. 行为 / AC delta

- **修改**：`sanitizeSystemText` 的 **Claude** preamble 正则改为 `Claude\s+Code,\s+Anthropic['’]s ...`，覆盖多空格、制表符、换行、ASCII/Unicode 撇号、可选句点。
- **不改变**：其余 system 内容、计费头清理、**Codex preamble 过滤（保持 main 的固定空格版本）**。

## 4. 影响范围与非目标

**受影响**

- `src/shared/system.ts`。
- 新增 `src/shared/system.test.ts`（空白/撇号变体、无关文本、计费头）。
- 文档：本变更文档。

**本次明确不做**

- 不做通用“竞品提示词”识别；只覆盖已实测的 Claude Code preamble。
- 不改 Codex preamble 过滤（评审要求；保持 main 的固定空格版本）。
- 不改 Claude Desktop 客户端；不改 codearts。

## 5. 验证与观测

- `bun test` → **123 pass / 0 fail / 418 expect() calls**（15 个测试文件）。
- 真实上游 e2e：双空格 system + 工具 → **200**（`deepseek-v4.1-flash`，返回 `OK`）。
- `bun build src/index.ts --target=bun` → 通过。
- 服务已用该分支重启；live 双空格请求 200。

## 6. 回滚方案

- **回滚方式**：把 Claude 正则改回单空格版本；删除 `system.test.ts`；Codex 正则未改动。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：双空格请求重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 其他空白/控制字符变体 | 仍可能绕过 | `\s+` 覆盖空格/制表/换行；如出现新变体再扩展 |
| 后端可能拦截其他竞品句 | 仍可能 400 | 目前只覆盖已实测句；出现新拦截时按同样方式补规则 |
| 服务运行在 fix 分支 | 未合并 main | 用户审核后合并；合并前服务加载的是该分支 |

## 8. 关联与证据

- 产品规格：[CodeBuddy provider](../../product-specs/codebuddy-provider.md)
- 前置：[CHG-0009](CHG-0009-codebuddy-system-sanitize.md)
- 代码：`src/shared/system.ts`
- 测试：`src/shared/system.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 进行中 | wayne | 仅 Claude 全空白容错；123 tests；真实上游双空格/多空格 e2e 200；服务已用该分支重启 |