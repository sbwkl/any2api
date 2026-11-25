# 门禁补强：类型检查与文档链接检查

类型：工程化（check 门禁 + 存量类型修正）
状态：已验证（单测 327 pass / 0 fail + `tsc --noEmit` exit 0 + 链接检查 0 死链；未合并 main、未部署）
Owner：wayne
所属模块/入口：`package.json`（`bun run check`）、`tsconfig.json`、`scripts/check-docs-links.ts`、`.github/workflows/ci.yml`
关联：retro 候选 1（类型/lint 护栏）与候选 2（文档链接检查）；对应跟踪 issue [#28](https://github.com/sbwkl/any2api/issues/28)（check 缺类型检查）
验证命令：`bun run check`（= `bun test` + `bun build src/index.ts --target=bun` + `tsc --noEmit` + `bun scripts/check-docs-links.ts`）

## 1. 背景

2026-11-25 的 retro 审计发现两个护栏缺口：

1. `check` 只有测试与 `bun build`，而 Bun 构建只转译不做类型检查；仓库没有 `tsconfig.json`，也没有 linter。session 中实际出现的「未使用的参数 / 未使用的导入 / 错误的类型来源」都只能靠人工评审发现。
2. `AGENTS.md` 声明「文档结构与本地链接检查：未配置；待补」，而 exec-plan 在 `active/` 与 `completed/` 之间移动是常规操作；全仓 229 条本地链接中已有 2 条死链。

## 2. 变更

### 2.1 类型检查

- 新增 `tsconfig.json`：`strict`、`noUnusedLocals`、`noUnusedParameters`、`noFallthroughCasesInSwitch`、`moduleResolution: bundler`、`types: ["bun"]`、`lib: ["ESNext","DOM"]`、`noEmit`；覆盖 `src` 与 `scripts`（`e2e/` 无 TS 文件）。
- 新增 devDependencies：`typescript`、`@types/bun`（生成 `bun.lock`；CI 已有 `bun install` 步骤）。
- `bun run check` 增加 `tsc --noEmit`；CI 复用同一命令，无工作流改动。

### 2.2 文档链接检查

- 新增 `scripts/check-docs-links.ts`：扫描仓库内 `*.md` 的本地链接（跳过外部 URL、纯锚点、代码围栏、`node_modules`/`logs`/`reports`），解析为相对路径后判定存在性，失败时列出 `文件:行号 → 目标` 并退出 1。
- 新增 `scripts/check-docs-links.test.ts`（3 例：相对路径与行号、外部/锚点/代码围栏忽略、按所在文件解析）。
- 修复存量死链 2 条：`README.md`（`../AGENTS.md` → `AGENTS.md`）、`docs/exec-plans/completed/2026-11-22-align-doc-knowledge-base.md`（`../../../../AGENTS.md` → `../../../AGENTS.md`）。
- `AGENTS.md` 与 `README.md` 的开发命令改为 `bun run check`，删除「未配置；待补」表述。

### 2.3 存量类型问题（首次接入 `tsc --noEmit` 的 48 条）

按类别处理，均不改变运行时行为，另有 3 处顺带修正：

- **类型来源错误**：`Credentials` 实际定义在 `signer.ts`，`config.ts` 只是转引；`codearts/index.ts`、`refresher.ts` 改为从 `signer` 导入；`openai.ts`/`snap.ts`/`test-policy.ts` 删除未使用的导入。
- **隐式 any**：`anthropic.ts` 的 `tools.filter/map`、`util.ts` 的 `tools.map` 显式标注 `(t: any)`。
- **catch 变量**：`refresher.ts` 两处 `catch (e: any)`。
- **测试替身类型**：`handleChat` 改成 `async` 返回 `Promise<Response>`；31 处 fetch mock 由 `as typeof fetch` 改为 `as unknown as typeof fetch`。
- **流类型**：`readWithIdleTimeout` 去掉错误的显式返回标注；`snap` 头对象标注 `Record<string, string>`；`gzipBody` 返回 `Uint8Array<ArrayBuffer>`（BodyInit 只接受 ArrayBuffer-backed 视图）。
- **死代码**：删除从未被调用的 `fromRunningApp`/`fromKernelHttp`（凭证链实际只用 env 与 `state.vscdb`）、`telemetry` 的未读 `timer` 字段（定时器改为 `unref`）、测试中未使用的 `messagesWith`、e2e 报告中未使用的 `counts`。
- **重复属性**：`codebuddy` 的 `health` 由 `{ ok: true, ...healthPayload() }` 改为 `healthPayload()`（`ok` 本来就被覆盖）。
- **参数**：`Credentials` 增加可选 `refreshToken`，并在 `toCredentials()` 回填（见 §2.4）。

### 2.4 顺带修复：启动凭证守卫恒真（存量缺陷）

类型检查接上后暴露出 `index.ts` 的守卫 `if (!secretCreds?.refreshToken) throw` 恒真：

- `Credentials` 此前从未声明 `refreshToken`，`toCredentials()` 也不回填，因此该字段永远是 `undefined`；
- 结果是「STS 已过期但 SecretStorage lineage 仍有效」时，启动直接报「无刷新凭据」，永远走不到 `refreshNow()`；守卫由 `dfb84d3`（2026-11-20 启动加固）引入，从未生效；
- 同一条 `!creds.expiresAt || …` 判断还会把 **env 静态凭证**（无有效期字段）当成已过期，一并命中该守卫。

修复：

- `toCredentials()` 回填 `refreshToken: auth.refresh_token`；
- 启动决策抽成纯函数 `planStartupCredentials(bootstrap, secret)`：无有效期/无效日期/未过期 → 直接用；已过期且有 lineage → 刷新；已过期且无 lineage → 明确报错；
- 行为 delta：env 静态凭证不再被当作过期；过期但可刷新时现在会真正执行 `refreshNow()`。

## 3. 非目标

- 不引入 linter / 格式化工具（可后续叠加，届时 `check` 再加一步）。
- 不检查外部 URL 可达性（离线、易抖动）。
- 不校验 `#anchor` 是否对应标题（只校验文件存在）。
- 不新增 pre-commit 钩子；CI 与 `bun run check` 已是唯一入口。

## 4. 验证

- `bun test` → **327 pass / 0 fail**（新增 3 条链接检查 + 8 条启动决策 + 2 条 SecretStorage→Credentials 映射用例）。
- `bun build src/index.ts --target=bun` → exit 0。
- `tsc --noEmit` → exit 0（首次为 48 条错误，全部归零）。
- `bun scripts/check-docs-links.ts` → 0 死链（修复前 2 条）。
- 启动守卫：过期 + lineage → `refresh: true`；env 静态凭证 → `refresh: false`；过期无 lineage → 抛「无刷新凭据」。
- 根因护栏：`toCredentials()` 的 `refreshToken` 透传有直接断言；删掉该行后「过期+lineage 触发刷新」用例立即失败（变异验证）。
- `bun run check` → exit 0。

## 5. 回滚

- revert 本分支提交即可；回滚后 `check` 恢复为测试 + 构建，链接与类型不再被门禁覆盖。
- 无数据/配置迁移；`node_modules/` 已被 gitignore，`bun.lock` 随提交回退。

## 6. 风险

| 风险 | 影响 | 处理 |
|---|---|---|
| `tsc` 与 Bun 类型对某些运行时形状判定不一致 | 未来新增代码需按类型修正 | 已用 `skipLibCheck` 隔离依赖库；错误集中在自有代码 |
| devDependencies 引入 `node_modules` 与锁文件 | CI 首次需下载（已有 `bun install`） | 版本写在 `package.json`，`bun.lock` 锁定 |
| 链接检查只验文件存在 | 死锚点仍可能漏 | 已注明非目标；需要时补锚点校验 |
| 删除死代码 `fromKernelHttp` | 若未来启用内核 GlobalConfig 兜底需重写 | 该路径从未被调用；规格 §1 仍记录内核行为 |

## 7. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 2026-11-25 创建；来源为当日 retro 候选 1、2 |
| 已验证 | wayne | 2026-11-25 接入 `tsc --noEmit` 与链接检查，清理 48 条存量类型错误；`bun run check` exit 0 |
| 已验证（复审修复） | wayne | 2026-11-25 修复启动凭证守卫恒真（refreshToken 回填 + `planStartupCredentials`），并为映射补根因护栏；`bun test` 327 pass / 0 fail |