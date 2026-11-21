# CHG-0006 统一 provider 前缀为 `/<name>/v1`

类型：CHG
状态：开发中
Owner：wayne
所属模块/入口：`src/providers/codearts/index.ts`、`src/index.ts`
功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
关联：[CHG-0003](CHG-0003-provider-registry-protocols.md)

## 1. 摘要

codearts 的公开前缀从空字符串改为 `/codearts`；codebuddy 保持 `/codebuddy`。两个 provider 统一为 `/<name>/v1`：codearts `http://127.0.0.1:8787/codearts/v1`，codebuddy `http://127.0.0.1:8787/codebuddy/v1`。不再保留无前缀的 `/v1`。

## 2. 变更理由与证据

- **触发原因**：codearts 无前缀、codebuddy 有前缀，URL 不统一；用户要求统一加前缀。
- **证据**：`codeartsProvider.prefix === ""`、`codebuddyProvider.prefix === "/codebuddy"`；README 示例分别使用 `/v1` 与 `/codebuddy/v1`。
- **不做的后果**：客户端需要记住两个不同的 URL 形态；新增 provider 时前缀规则不一致。

## 3. 行为 / AC delta

- **新增 R24**：When 服务启动, the system shall 为每个 provider 使用 `/<name>/v1` 前缀（codearts `/codearts/v1`、codebuddy `/codebuddy/v1`）；不再保留无前缀的 `/v1`。
- **修改**：codearts prefix `""` → `/codearts`；顶层路由日志；README 示例与端点；codearts `start()` 日志。
- **破坏性**：之前使用 `http://127.0.0.1:8787/v1` 的 codearts 客户端需改为 `/codearts/v1`；不提供别名。

## 4. 影响范围与非目标

**受影响**

- `src/providers/codearts/index.ts`（prefix、日志）。
- `src/index.ts`（路由日志）。
- `src/providers/prefixes.test.ts`（新增）。
- `README.md`（路由、示例、端点）。
- 文档：REQ G1/R1/R2/R24、RFC §5.1、CHG-0003 注记。

**本次明确不做**

- 不保留 `/v1` 别名。
- 不改 codebuddy 前缀。
- 不改上游 `https://copilot.tencent.com` 路径。

## 5. 验证与观测

- `bun test` → **87 pass / 0 fail / 310 expect() calls**（13 个测试文件，含 `prefixes.test.ts`）。
- `bun build src/index.ts --target=bun` → 成功。
- 临时集成分支 `tmp/integration-codebuddy`（main + feat）→ **87 pass / 0 fail**，build 通过，已删除。
- 未启动/未重启服务。

## 6. 回滚方案

- **回滚方式**：把 codearts prefix 改回 `""`，恢复 README/日志；`/v1` 重新可用。
- **数据/配置兼容**：无持久化状态。
- **回滚验证**：`/v1/models` 恢复；`bun test` 通过。

## 7. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 现有 codearts 客户端使用 `/v1` | 404 | 用户明确要求统一；在 README/发布说明中提示 base_url 改为 `/codearts/v1` |
| 外部依赖 `/v1` | 破坏性变更 | 不提供别名；如需兼容可后续加 rewrite，但会重新引入前缀歧义 |

## 8. 关联与证据

- 功能卡：[REQ-0001](../requirements/REQ-0001-codebuddy-provider.md)
- 前置：[CHG-0003](CHG-0003-provider-registry-protocols.md)
- 代码：`src/providers/codearts/index.ts`、`src/index.ts`
- 测试：`src/providers/prefixes.test.ts`

## 9. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | codearts prefix → `/codearts`；README/日志同步；87 tests；临时集成分支通过；未部署 |