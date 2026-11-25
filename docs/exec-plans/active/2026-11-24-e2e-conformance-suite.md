# 实弹 e2e 一致性测试体系：接口相似度矩阵

类型：测试基础设施（跨 provider / 协议层）
状态：已验证（未合并；测试暴露的缺陷另开分支修复）
Owner：wayne
所属模块/入口：`scripts/e2e/`、`src/registry.ts`、`src/shared/trace.ts`、两 provider 出站请求点
关联：[README](../../../README.md)、[产品规格](../../product-specs/codebuddy-provider.md)、[官方条款清单](../../references/official-api/README.md)、[GLOSSARY](../../../GLOSSARY.md)

## 1. 摘要

仓库现有 157 个进程内单测，但**没有任何实弹 e2e**：不经过真实上游、不经过 HTTP、不验证客户端真实用法。近期 Anthropic 组装层的丢图缺陷表明，协议转换中的静默丢弃（丢图、丢字段、未知模型静默换模型）无法靠 stub 单测发现。本变更建立一套可重复的实弹一致性测试：以 OpenAI 官方（Chat Completions / Responses）与 Anthropic Messages 文档为参照系，按「端点 × provider × 特性」矩阵逐格判定提供接口与官方接口的相似度，产出基线报告、缺陷清单与脱敏样本。

## 2. 目标与验收

- `bun run e2e` 可重复执行：子进程拉起 any2api，打真实 CodeBuddy / CodeArts 上游，产出矩阵报告。
- 矩阵每格状态 ∈ {pass, fail, not-supported, skipped}，且每个状态都有可复核的证据（响应、SSE 帧、上游转储、耗时）。
- 图片 pilot 必须能测出已知缺陷（如 Responses `input_image` 丢弃、CodeArts 未知模型回退 `models[0]`），证明 harness 有效。
- 首份基线报告入库，缺陷清单进入本文件；修复不在本次范围。

## 3. 决策台账（2026-11-24 grilling 锁定）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 参照系 | OpenAI Chat Completions / Responses + Anthropic Messages 官方文档；无官方 key，**不做差分测试** |
| D2 | 相似度定义 | L1 线格式 + L2 特性对等为硬门槛；L3 语义保真抽样人工；完整矩阵要求每格有明确状态 |
| D3 | 测试拓扑 | 实弹真上游（CodeBuddy / CodeArts），非假上游 |
| D4 | 覆盖范围 | 全部已暴露端点 × 两 provider，先定义全量矩阵，图片链路 pilot 先行 |
| D5 | 修复边界 | 本变更只交付测试、基线、缺陷清单；P0 缺陷另开分支修复 |
| D6 | 运行载体 | `scripts/e2e/` 独立 runner + `bun run e2e`；默认 `bun test` 保持纯离线单测 |
| D7 | 凭据与成本 | 复用现有自动提取 + env 覆盖；`E2E_MAX_CALLS` 硬上限（默认 200，2026-11-24 由 40 调高）；用户同意消耗真实 token |
| D8 | 模型选择 | 偏好 `GLM-5.3-Flash > DeepSeek-v4.1-Flash(1017)`，`E2E_MODEL_PREFERENCE` 可配；fallback：`E2E_MODEL_FALLBACK` → 启发式 → skipped；绝不静默回退 `models[0]` |
| D9 | 静默丢弃观测 | 服务器 env 门控的上游请求转储 + 行为探测；MITM 不入自动化 |
| D10 | 样本 | 实弹流量脱敏后录 `e2e/fixtures/`（合成数据、≤2MB）；v1 不做离线 replay |
| D11 | 矩阵内容 | 见 §5；`not-supported` 期望显式编码 |
| D12 | 官方参照物 | `docs/references/official-api/` 条款清单（URL + 条款 ID），机器 schema 后置 |
| D13 | 客户端冒烟 | 手动清单：Claude Code / Codex 直连 any2api；不经 cc-switch 代理、不作为测试依赖 |
| D14 | 报告 | 基线入库三件套：`docs/generated/e2e-baseline.html`（人类可读，跨 provider 对照矩阵 + 按 provider 分区的场景证据）、`e2e-baseline.json`（机器可读，含入站/上游/响应原文、`scenarioSet` 与 `coverage`）、`e2e-baseline.md`（最小入口）；日常运行写 gitignored 的 `e2e/reports/latest.{html,json}` |
| D15 | 定期评估 | 手动 `bun run e2e:corpus` + runbook；不设定时任务 |
| D16 | 采集 | `TRACE_CAPTURE_DIR` opt-in 入站 JSONL（默认关闭、脱敏、限额）纳入 v1；Claude Code 会话重组器后置 |
| D17 | 客户端证据 | cc-switch 日志无 body，否定为证据源；自身采集为准 |
| D18 | 场景一致性 | 所有 provider 共用同一份场景模板与判定逻辑；provider 只改变执行结果，不得增删场景或按 provider 分支改判 |
| D19 | 一致性硬约束 | `buildScenarios` 从模板绑定 provider；单测断言各 provider 的 ID、顺序、endpoint、feature、clause 一致；运行结束做覆盖校验，不一致直接失败 |
| D20 | 报告呈现 | 一张跨 provider 对照矩阵（一行场景、两列状态，状态格链到对应证据）；全局 healthz 单独小节；筛选按任一 provider 命中 |
| D21 | 基线更新 | 沿用 2026-11-24 证据离线重渲染并补 `scenarioSet` / `coverage`；仅定点运行 `responses.tools.forced`（2 次调用）验证删除 provider 分支无回归 |

## 4. 影响范围与非目标

**受影响**

- 新增：`scripts/e2e/`（runner、矩阵、场景、证据摘要与报告、合成图片生成）、`src/shared/trace.ts`（入站采集与上游转储）、`e2e/fixtures/`、`docs/references/official-api/`、`docs/generated/e2e-baseline.{html,json,md}`
- 修改：`src/registry.ts`（采集挂钩）、两 provider 出站请求点（上游转储）、`package.json`（`e2e` / `e2e:corpus` 脚本）、README（命令、healthz 路径纠错）、product-spec 状态同步
- 新增单测：采集/转储、SSE 解析、矩阵状态、模型选择、脱敏、报告格式化、场景集一致性、覆盖校验

**本次明确不做**

- 不修复测试暴露的缺陷（另开分支，P0 优先）
- 不做官方端点差分（无 key）、MITM 自动化、fixture replay、Claude Code 会话重组、定时评估
- 不改变默认运行路径：`bun test` 不触网、不读凭据

## 5. 相似度矩阵

**端点**：`/v1/chat/completions`（同步/流式）、`/v1/messages`（同步/流式）、`/v1/responses`（同步/流式）、`/v1/models`、`/v1/healthz`
**Provider**：codearts（必需）、codebuddy（可选，未配置 = skipped）
**场景集**：两个 provider 共用 29 个场景模板，顺序与元数据一致；provider 只影响执行结果。`responses.tools.forced` 不再按 provider 改变判定。第 29 个场景 `messages.usage.cache_semantics`（2026-11-25 新增，见 [2026-11-25-codearts-usage-semantics](2026-11-25-codearts-usage-semantics.md)）锁定 Anthropic 未缓存输入语义：唯一 marker + 长 system 保证冷缓存，两次相同非流式请求，断言第一次 `cache_read_input_tokens=0`、第二次 >0 且 `input_tokens` 小于第一次；两 provider 执行同一判定。`docs/generated/` 下的基线仍是 2026-11-24 的 **28 场景快照**，早于该场景，本次不重生成。

**特性行**

1. 基础文本（同步 / 流式、`finish_reason` / `stop_reason` 映射）
2. multi-turn 与 system（string / Anthropic text 数组）
3. 图片：URL、data URL、多图、`tool_result` 内嵌图、system 图、Responses `input_image`
4. 工具：定义、调用、强制 `tool_choice`、`tool_result` 回传、并行调用
5. 采样参数：temperature / top_p / stop / seed / max_tokens
6. response_format：json_object / json_schema
7. usage：prompt/completion/total、缓存分项、reasoning 分项、流式 usage（`stream_options.include_usage`）、Anthropic cache 字段
8. SSE 语法与事件序列（OpenAI `data:` 帧、Anthropic 事件类型序列、Responses 事件序列）
9. 负例：非法模型、坏 body、错误路径、provider 故障
10. 未知模型路由：必须显式 4xx，禁止静默回退
11. thinking / reasoning 字段（入参与回放）

**状态机**：`pass`（符合官方契约）/ `fail`（偏离或静默丢弃）/ `not-supported`（期望显式拒绝，实际若静默丢弃记 fail）/ `skipped`（凭据、模型或预算缺失，附原因）。

## 6. 技术方案

- **runner**：`bun scripts/e2e/run.ts`；顺序执行（规避上游并发限制），每场景计数并在 `E2E_MAX_CALLS` 用尽后余下场景标 `skipped(budget)`。
- **服务器生命周期**：`Bun.spawn` 启动 `src/index.ts`，随机端口（env `PORT`），轮询 `/healthz`；退出时回收子进程。
- **凭据**：沿用 server 现有自动提取（launchd / `state.vscdb`）与 env 覆盖；codearts 起不来则整轮失败并给出原因。
- **模型选择**：`GET /{provider}/v1/models` → 偏好序列（大小写不敏感、兼容 `(1017)` 后缀）→ `E2E_MODEL_FALLBACK` → 启发式（flash/mini/lite/small）→ skipped；报告记录实际模型。
- **观测**：`UPSTREAM_DUMP_DIR` 记录翻译后的上游请求（JSONL）供 L2 断言字段未被丢弃；`TRACE_CAPTURE_DIR` 采集四层请求记录（schema 3 单行 JSONL，脱敏、不截断；schema 2 为历史快照不再代表当前格式，见 [四层请求记录（历史 schema 2）](../completed/2026-11-25-four-layer-request-record.md) 与 [CodeArts L3 明文变更](2026-11-25-codearts-l3-decrypted-plaintext.md)）。
- **图片探测**：程序生成纯色 PNG（无三方依赖），要求模型回答主色；同时保留「已知会失败」的格子验证 harness 检出能力。
- **报告**：`e2e/reports/latest.html` + `latest.json`（gitignored）。HTML 用一张跨 provider 对照矩阵（一行场景、两列状态；点击状态格展开对应 provider 的输入 / 上游请求 / 输出摘要），下方按 provider 分区展示证据，全局 healthz 单独成节；筛选按任一 provider 命中。JSON 保留入站请求、上游请求与响应原文（单条 ≤64KB），并写入 `scenarioSet` 与 `coverage`；运行结束若覆盖不一致直接失败。`--baseline` 写 `docs/generated/e2e-baseline.{html,json,md}`，其中 MD 仅作入口与链接。
- **语料评估**：`bun run e2e:corpus` 读取采集目录，按端点契约做 L1 校验并输出差异报告（手动执行，写入 runbook）。仍按 v1 记录字段解析，历史 schema 2 与当前 schema 3 记录均未适配（与四层请求记录 D12 的决定一致；schema 3 变更见 [CodeArts L3 明文变更](2026-11-25-codearts-l3-decrypted-plaintext.md)）。

## 7. 验证与证据（2026-11-24）

- [x] 单测：`bun test` → 225 pass / 0 fail（28 files，771 assertions）。覆盖 SSE 解析、模型选择、配置、证据摘要、HTML/JSON 报告、上游转储解析、合成图片、契约校验、场景判定、语料评估、场景集一致性、覆盖校验。
- [x] 静态检查：`bun build src/index.ts --target=bun`、`bun build scripts/e2e/run.ts --target=bun`、`bun build scripts/e2e/corpus.ts --target=bun` 均零错误。
- [x] 实弹：`E2E_MAX_CALLS=60 E2E_RECORD=1 bun run e2e --baseline`（2026-11-24）；50/60 次上游调用，未超预算；57 格：32 pass / 17 fail / 4 not-supported / 4 skipped。首轮曾因 `response_format` 场景 128 token 被 reasoning 吃满误判 codebuddy `json_object` fail；调至 512 后定点复测通过并重跑全矩阵，最终基线以此轮为准。
- [x] 基线产物（2026-11-24 证据离线重渲染，未重跑全矩阵）：[`e2e-baseline.html`](../../generated/e2e-baseline.html)（158,184 B，一张跨 provider 对照矩阵 + 按 provider 分区证据 + 全局 healthz 小节 + 状态筛选）、[`e2e-baseline.json`](../../generated/e2e-baseline.json)（165,264 B，含入站 / 上游 / 响应原文、`scenarioSet`、`coverage`）、[`e2e-baseline.md`](../../generated/e2e-baseline.md)（667 B 入口）。49 个非 skipped 场景均有入站证据；4 个 skipped 均为未设置 `E2E_IMAGE_URL`。
- [x] 场景集一致性：单测断言 29 个模板唯一，且两 provider 的 ID / 顺序 / endpoint / feature / clause / knownDefect / needsImageUrl 与模板完全一致；基线与定点报告均通过运行时 `coverage` 校验（见下），不一致会让运行失败。（2026-11-25 更新：模板增至 29 个，一致性单测随场景集同步；基线当时的 28 记录见下行。）
- [x] 基线覆盖元数据：`scenarioSet` 28 项；`coverage` codearts 28/28、codebuddy 28/28，`missing` / `extra` 为空，`orderMatches=true`；HTML 顶部显示「场景集一致：codearts 28/28 · codebuddy 28/28」。（2026-11-24 快照；当前场景集为 29，29 场景下的覆盖元数据待下次全矩阵重跑后更新。）
- [x] 定点实弹（验证删除 `responses.tools.forced` 的 provider 特判无回归）：`E2E_MAX_CALLS=2 E2E_ONLY=responses.tools.forced E2E_REPORTS_DIR=/tmp/e2e-targeted-reports bun run e2e` → codearts `NOT-SUPPORTED`（上游显式拒绝，状态码被映射为 502）、codebuddy `PASS`（强制 `tool_choice` 生效）；2/2 调用；矩阵行 `data-statuses="not-supported pass"`，覆盖 1/1 每家。
- [x] 报告交互验证：Chrome 1440px 单矩阵两 provider 状态列、状态格跳转对应证据、覆盖行置顶正常；500px 每条场景降级为卡片（场景 / 接口 / 特性 / 两 provider 状态与摘要），无横向溢出；`fail` 筛选按任一 provider 命中统计行数。
- [x] 已知缺陷可检出：Responses `input_image` 丢弃（两家）、Anthropic `system` 数组图片丢弃（两家）、Responses 流缺 `response.output_text.done`（两家）、codearts 未知模型静默回退（chat/messages/responses）、`logprobs` 与 `n` 静默丢弃（两家）、codearts `response_format` 静默丢弃。
- [x] 图片 pilot：`chat.image.data_url`、`messages.image.base64`、`messages.image.tool_result` 两家均 pass（模型回答 Red）；`responses.image.data_url`、`messages.image.system` 两家均 fail，证明探测能通过正确链路也能捕获真实缺陷。
- [x] fixture：`e2e/fixtures/` 53 个文件 / 244KB（≤2MB），含入站调用与上游请求；Authorization / x-api-key / cookie 已脱敏；日常报告在 gitignored 的 `e2e/reports/`。
- [ ] 客户端直连冒烟：手动清单见 §10；本轮未执行，不作为矩阵基线的一部分。
- [ ] 文档结构 / 链接检查：仓库未配置项目级检查；待补。本轮用一次性脚本核对仓库内相对链接 0 broken；`README` / `AGENTS` 指向的工作区根 `../AGENTS.md` 在当前工作区不存在，属既有跨项目约定。

## 8. 风险与未决问题

| 风险 / 未决 | 影响 | 处理 |
|---|---|---|
| 真实上游并发限制（实测 3） | 并行场景会 400 | runner 默认串行 |
| codebuddy 图片行为不稳定 | 图片格可能 flake | 重试 1 次；仍失败记 fail 并注明上游行为 |
| 凭据提取触发 Keychain / 过期 | 整轮无法启动 | 启动失败即报错，人工刷新凭据 |
| 真实上游返回与官方契约无关的私有错误体 | 负例期望误判 | 负例只断言状态码与 JSON 形状，不比对错误文案 |
| 采集含敏感内容 | 隐私风险 | 默认关闭；本地目录不入库；脱敏与限额 |
| 模型升级导致偏好失效 | 矩阵被 skip | 报告显式列出 skipped 原因，改 `E2E_MODEL_PREFERENCE` |

## 9. 基线暴露的缺陷（修复不在本次范围）

优先级为建议值，由后续修复分支确认。状态均为基线当时行为；其中部分缺陷已在 `fix/e2e-clear-defects` 修复，见 §11 变更记录。

| 缺陷 | 范围 | 基线证据 | 影响 | 建议 |
|---|---|---|---|---|
| Responses `input_image` 静默丢弃 | codearts、codebuddy | `responses.image.data_url` fail；上游转储无图片字段 | 图片请求被当纯文本处理，客户端无感知 | P0 |
| Anthropic `system` 数组中的图片静默丢弃 | codearts、codebuddy | `messages.image.system` fail；上游转储无图片字段 | 同上 | P0 |
| Responses 流缺 `response.output_text.done` | codearts、codebuddy | `responses.basic.stream` fail | 依赖该事件收尾的客户端拿不到最终文本 | P1 |
| codearts `response_format` 静默丢弃 | codearts | `chat.response_format.json` / `json_schema` fail；上游转储无字段 | json_object / json_schema 契约不成立 | P1 |
| codearts 未知模型静默回退 | codearts | 三个 `negative.unknown_model` fail；请求被接受，chat 响应 `model` 变为 `deepseek-v4.1-flash-1017`，messages/responses 回显请求值（回退被掩盖） | 以为在用 A 实际在用 B，质量与计费不可控 | P1 |
| codearts 强制 `tool_choice` 的上游 400 被映射为 502 | codearts | `chat/messages/responses.tools.forced` 为 not-supported，但错误体为 `upstream_error` + 502 | 客户端无法区分「不支持」与「上游故障」，重试策略错误 | P1 |
| `logprobs` / `top_logprobs` 静默丢弃 | codearts、codebuddy | `chat.logprobs` fail | 依赖概率的客户端拿到空结果 | P2 |
| `n > 1` 静默丢弃 | codearts、codebuddy | `chat.n` fail（choices 长度 1） | 请求 2 条只返回 1 条 | P2 |
| `include_usage` 块带非空 `choices` | codebuddy | `chat.basic.stream` fail | 严格按官方语义解析 usage 的 SDK 可能重复计数 | P2 |
| `json_schema` 送达但上游输出带 markdown 围栏 | codebuddy | `chat.response_format.json_schema` fail | 200 但内容不可按 JSON 解析；需代理侧校验/重试或声明不支持 | P1 |

### 9.1 覆盖缺口（下一轮矩阵补充）

- 采样参数（temperature / top_p / stop / seed）与 `max_tokens` 互斥未单列。
- 并行工具调用、多图、Anthropic `system` 文本数组、thinking / reasoning 入参与回放未单列。
- usage 的缓存与 reasoning 分项只做形状校验，未断言数值语义；Anthropic cache 分项在真实上游的取值未覆盖。
- provider 级 `/v1/healthz` 未单列（全局聚合已覆盖）。
- 流中错误帧、排队 6020/429、401 刷新路径需要可控触发，本期未覆盖。
- URL 图片场景依赖 `E2E_IMAGE_URL`，本期 skipped；图片缺陷修复后需回归。

## 10. 客户端直连冒烟清单（手动，待执行）

D13 约定：客户端只直连 any2api，**不经 cc-switch 代理、不新增依赖**。冒烟不进入 `bun run e2e` 矩阵。

1. 启动服务（`bun src/index.ts` 或 launchd），确认 `GET /healthz` 的 `ok=true`。
2. Claude Code：把 Anthropic base URL 指向 `http://127.0.0.1:8787/codebuddy`（或 `/codearts`），API key 任意非空；模型从对应 `GET /{provider}/v1/models` 选择。
3. Codex CLI：把 Responses base URL 指向 `http://127.0.0.1:8787/codebuddy/v1`（或 `/codearts/v1`），`wire_api` 使用 Responses；模型同上。
4. 每个客户端至少验证：
   - 流式文本与 reasoning / thinking 正常显示；
   - 触发一次工具调用（如读文件），tool_use / tool_result 能往返；
   - usage 有值且与官方字段语义一致。
5. 记录客户端版本、provider、模型、通过 / 失败与失败现象；未执行前不得标「已验证」。

## 11. 变更记录

| 状态 | 操作人 | 证据 / 链接 |
|---|---|---|
| 开发中 | wayne | 2026-11-24 决策锁定（D1–D17，见 §3）；本文件创建 |
| 已验证（未合并） | wayne | 2026-11-24 最终基线：50/60 调用，32 pass / 17 fail / 4 not-supported / 4 skipped；报告改为 HTML + JSON + 最小 MD（D14 更新），49 个非 skipped 场景带场景证据；`bun test` 219 pass；三处 `bun build` 零错误；fixtures 53 文件 / 244KB；1440px / 500px 布局与筛选已验证；缺陷与缺口见 §9；客户端冒烟待执行（§10） |
| 已验证（未合并） | wayne | 2026-11-24 场景集一致性与跨 provider 对照矩阵（D18–D21）：场景改为 provider 无关模板、`buildScenarios` 统一绑定，删除 `responses.tools.forced` 的 codebuddy 特判；单测断言两 provider 场景清单与判定元数据一致，运行时 `coverage` 不一致即失败；报告改一张矩阵 + provider 分区证据 + 全局小节，JSON 增加 `scenarioSet` / `coverage`；基线离线重渲染（HTML 158,184 B / JSON 165,264 B / MD 667 B，coverage 28/28 × 2）；定点实弹 `responses.tools.forced` 2 次调用结果不变（codearts not-supported / codebuddy pass）；`bun test` 225 pass / 0 fail（28 files，771 assertions），三处 `bun build` 零错误 |
| 开发中 | wayne | 2026-11-24 分支 `fix/e2e-clear-defects` 修复 §9 中契约明确的缺陷：① Responses 流补 `response.output_text.done`（先于 `content_part.done`）；② Responses `input_image` 映射为 chat `image_url`（无 URL 时保留诊断占位）；③ codearts 未知模型显式 404，不再回退 `models[0]`；④ 代理自身生成的错误响应加 `x-any2api-error-source: proxy`，协议层在 `normalizeErrors=false` 时仍按请求方协议归一；⑤ 两家 SSE usage 归一为末尾单个 `choices: []` 块（合并分片字段）。证据：`bun test` 238 pass / 0 fail（28 files，807 assertions）；三处 `bun build` 零错误；定点实弹 `basic.stream` 6/6、`image.data_url` 4/4、`unknown_model` 6/6 pass（`/tmp/e2e-fix1..3`）；全矩阵 40 pass / 9 fail / 4 not-supported / 4 skipped（50/60 调用，`/tmp/e2e-full-fix`），剩余 9 格即待审核的 6 个场景，无回归。上游能力探测（2026-11-24，临时脚本未入库）：codearts `n=2` 上游 400（`InferHub.001001005` 参数非法），`logprobs` / `response_format`（json_object、json_schema）接受但不生效（中性 prompt 返回纯文本、无 logprobs）；codebuddy `n=2`、`logprobs` 接受但忽略（choices=1、无 logprobs），`response_format` 接受但不强制。剩余 5 个场景（response_format × 2、logprobs、n、system 图片）经用户 2026-11-24 审核：**均不做修改，保持原样**（上游能力探测结论留档于本行，供后续决定）。e2e 场景模板不随代码修复改动，`knownDefect` 标记保持基线值 |
| 开发中 | wayne | 2026-11-24 配置默认值调整（用户决定）：`E2E_IMAGE_URL` 默认 `https://pic.rmb.bdstatic.com/bjh/news/49a357178ac9972519fab6f835ba61aa.jpeg`；`E2E_MAX_CALLS` 默认 40 → 200；README 环境变量表与 D7 同步；`bun test` 238 pass / 0 fail，三处 `bun build` 零错误 |
| 开发中 | wayne | 2026-11-25 场景集 28 → 29：新增共享场景 `messages.usage.cache_semantics`（CodeArts 未缓存输入语义，见 [2026-11-25-codearts-usage-semantics](2026-11-25-codearts-usage-semantics.md)）；定点 e2e 两 provider 均 pass（codearts 12371→19 / codebuddy 12373→21，read=12352）；`docs/generated/` 基线保持 2026-11-24 的 28 场景快照，未重生成 |
