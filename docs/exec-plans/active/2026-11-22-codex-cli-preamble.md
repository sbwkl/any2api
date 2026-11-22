# 替换 Codex CLI 自述首句，修复 Codex 会话 400（11128）

| 项 | 内容 |
|---|---|
| 类型 | 变更文档 |
| 状态 | 进行中 |
| Owner | wayne |
| 所属模块 / 入口 | `src/shared/system.ts` |
| 关联 | [产品规格：CodeBuddy provider](../../product-specs/codebuddy-provider.md)、[CHG-0009](CHG-0009-codebuddy-system-sanitize.md) |

## 1. 摘要

Codex（ChatGPT 桌面版 / Codex CLI）在 system 首条 developer 消息里发送自述首句：

```
You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.
```

只要这段整句出现在 system/developer 文本中，CodeBuddy 上游就返回
`400 {"error":{"message":"Request blocked. Please send it again","type":"invalid_request_error","code":11128}}`，与 CHG-0009 的 Claude Code preamble、CHG-0013 的计费头属于同一类竞品客户端标识拦截。

修复：代理在发送上游前把这句替换为新建 Codex 会话实际使用的短提示词
`You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.`，长提示词的其余部分原样保留。

## 2. 变更理由与证据

- **现象**：用户 Codex 里名为「微信消息巡检」的会话（自动化巡检，每 4 小时一次）全部返回 `Request blocked. Please send it again`；同账号的新建会话正常。
- **定位过程**（本机，2026-11-22）：
  1. `~/.codex/sessions` 中找到该会话（`01a0f16e`），rollout 里 5 次失败记录均带 `code: 11128`。
  2. `codex exec fork 微信消息巡检` 复现，在本地临时抓包代理拿到真实请求（2.7 MB、2815 个 input 项、14 个工具），原样重放 → 同样 400。
  3. 逐项二分：去掉 `tools` 仍 400；按角色拆，`developer` 400、`user`/`assistant` 200；再定位到第一条 developer 消息（21 KB 的 Codex CLI 提示词）单独即 400；最后定位到首行整句。
  4. 对照实验：

     | 改写 | 结果 |
     |---|---|
     | 原句原样 | 400（11128） |
     | 换成中性句 | 200 |
     | 只删结尾句号 | 200 |
     | `Codex CLI` → `Codex` | 200 |
     | 换模型（hy4std / hy4flash / deepseek-v4-flash / glm-5.3-flash） | 400 |

     → 整句精确匹配，与模型无关。
  5. 新建 Codex 会话实际发送的首条 developer 消息为 117 字符短提示词，实测 200。

- **为什么只有这个会话中招**：该会话创建于 2026-09-30，续跑时注入的是长版 Codex CLI 提示词；新建会话使用短版，不受影响。

## 3. AC delta

- **新增 R35**：When codebuddy 的 system/developer 文本包含 Codex CLI 自述首句 `You are a coding agent running in the Codex CLI, a terminal-based coding assistant. Codex CLI is an open source project led by OpenAI. You are expected to be precise, safe, and helpful.`, the system shall 将其替换为 `You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.`，其余内容保持不变。
- **不改变**：CHG-0009 / CHG-0013 的既有规则、用户消息、工具调用、模型映射、codearts。

## 4. 改动范围

- `src/shared/system.ts`：新增 `CODEX_PREAMBLE` 正则与替换文本。
- 测试：`src/providers/codebuddy/envelope.test.ts`（+2 例）。
- 文档：产品规格 R35 与变更索引、本变更文档。

**本次明确不做**

- 不扩展成通用提示词指纹库（只覆盖实测的这一句）。
- 不改 codearts 与其他 provider。

## 5. 验证

- 单元测试：`bun test` → **120 pass / 0 fail / 402 expect() calls**（14 个文件）。
- 构建：`bun build src/index.ts --target=bun` → 成功。
- 真实 e2e：`codex exec fork 微信消息巡检 "ping"` 指向修复后的代理 → **成功返回 `pong`**（同一命令在修复前返回 11128）。
- 未部署；分支 `feat/codex-cli-preamble` 待用户审核。

## 6. 回滚

- **回滚方式**：移除 `CODEX_PREAMBLE` 与替换调用。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：Codex 会话重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 上游可能再拦截其他客户端提示词 | 仍可能 400 | 只覆盖实测句；出现新拦截时扩展 |
| 正则依赖精确句子，Codex 升级改文案 | 拦截复现 | 届时按实际请求更新正则 |
| 长提示词其余部分仍保留 | 无 | 实测替换首句后 200 |

## 8. 关联与证据

- 代码：`src/shared/system.ts`
- 测试：`src/providers/codebuddy/envelope.test.ts`
- 复现材料：`~/.codex/sessions/2026/10/20/rollout-2026-10-20T07-30-32-01a0f16e-*.jsonl`（失败记录带 `code: 11128`）