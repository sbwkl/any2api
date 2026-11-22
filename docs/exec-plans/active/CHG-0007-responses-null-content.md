# CHG-0007 修复 Responses reasoning 项 `content: null` 导致 400

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/protocols/responses.ts`
功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
关联：[CHG-0005](CHG-0005-review-fixes.md)

## 1. 摘要

Codex 的工具续轮会回传上一轮的 `reasoning` 项，其中 `content: null`。共享 Responses 适配器把非 string/array 的 `content` 一律判为非法，导致请求 400。修复：非 message 项跳过 `content` 校验；message 项的 `content: null` 允许，转换时若最终无文本则丢弃该 message。

## 2. 变更理由与证据

- **触发原因**：用户使用 Codex 多步工具任务时随机 400；请求体含：
  ```json
  {"type":"reasoning","id":"rs_...","summary":[...],"content":null,"encrypted_content":null}
  ```
- **对照实验**（只改一个字段）：
  - `content: null` → 400；
  - `content: []` → 200；
  - 不带 `content` → 200；
  - 只有 `summary` → 200。
- **影响**：codearts 与 codebuddy 共用共享 Responses 适配器，均受影响；约一半请求失败（模型有推理内容时 Codex 才带 reasoning 项）。
- **不做的后果**：Codex 多步工具任务不稳定，无法可靠使用。

## 3. 行为 / AC delta

- **新增 R25**：When Responses `input` 项不是 message（如 `reasoning`）, the system shall 不因 `content` 校验拒绝该请求；当 message 项的 `content` 存在且非 `null` 时，须为 string 或 array。
- **修改**：`validateResponses` 对非 message 项跳过 content 校验；message 项 `content: null` 允许（转换时按空处理；若最终无文本则丢弃该 message）。
- **不改变**：message 项 `content: 123` / `[123]` 仍返回 400。

## 4. 影响范围与非目标

**受影响**

- `src/protocols/responses.ts`：`validateResponses`。
- `src/protocols/protocols.test.ts`：新增 reasoning null / message null / 非 message 非法 content 用例。
- 文档：REQ R25、本 CHG、docs/README。

**本次明确不做**

- 不解析/改写 reasoning 项的 `summary`/`encrypted_content`。
- 不改变 Anthropic/OpenAI Chat 的校验。

## 5. 验证与观测

- 新增测试（先红后绿）：
  - reasoning 项 `content: null` + user message → 200；
  - message 项 `content: null` → 200（无文本，message 不进入 messages）；
  - reasoning 项 `content: 123` → 200（非 message 跳过校验）；
  - 原有 message `content: 123` / `[123]` → 400 保持。
- `bun test` → **88 pass / 0 fail / 313 expect() calls**（13 个测试文件）。
- `bun build src/index.ts --target=bun` → 成功。
- 真实上游 e2e：`reasoning` 项 `content:null` + user message → **200**（Responses object，含 reasoning summary + message）。
- 临时集成分支 `tmp/integration-codebuddy`（main + fix）→ **88 pass / 0 fail**，build 通过，已删除。
- 未部署；fix 分支待用户审核/合并。

## 6. 回滚方案

- **回滚方式**：恢复 `validateResponses` 对所有 `content` 非 string/array 一律 400；回滚测试。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：Codex reasoning 项重新 400；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| message `content: null` | 转换时按空处理；若最终无文本则丢弃该 message，不发送空消息 | 与 `content: []`/缺失一致；Codex 的 reasoning 项不是 message |
| 非 message 项的 content 完全忽略 | 畸形 content 不再报错 | 非 message 项的 content 不参与消息构造；可接受 |
| 其他 Responses 客户端依赖严格校验 | 可能接受更多输入 | 仍拒绝 message 的非法 content；非 message 本来就不应校验 |

## 8. 关联与证据

- 用户实测：reasoning `content:null` → 400；`[]`/缺失 → 200；codearts/codebuddy 均受影响。
- 功能卡：[REQ-0001](../../product-specs/codebuddy-provider.md)
- 前置：[CHG-0005](CHG-0005-review-fixes.md)
- 代码：`src/protocols/responses.ts`
- 测试：`src/protocols/protocols.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 修复 Responses 非 message/null content 校验；88 tests；真实上游 e2e 200；临时集成分支通过；未部署 |
