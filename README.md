# any2api

把各 AI 编程工具的私有 LLM 通道封装为通用 **OpenAI 兼容 API**。每个工具是一个独立 provider（`src/providers/<name>/`），对外统一暴露 OpenAI 兼容端点（codearts：`/codearts/v1/*`；codebuddy：`/codebuddy/v1/*`）。

- 当前 provider：**codearts**（码道 CodeArts Agent，华为云 snap-access 通道）、**codebuddy**（腾讯 CodeBuddy CN，`copilot.tencent.com`）
- 路由：`/codearts/v1/*` → codearts；`/codebuddy/v1/*` → codebuddy
- 运行时：Bun（原生执行 TypeScript，无需编译）

## 结构

```
src/
├── index.ts                  # 顶层入口：注册表 + Bun.serve
├── registry.ts               # ProviderModule 注册表、前缀路由、404/405/503、聚合 health
├── shared/
│   ├── ids.ts                # 通用 ID 生成（跨 provider 复用）
│   └── sse.ts                # 通用 SSE 解析 + chat.completion 聚合
├── protocols/                # 共享协议层（只依赖 ChatBackend，不感知 provider 名称）
│   ├── index.ts              # createProtocolRoutes（models/chat/messages/responses/health）
│   ├── types.ts              # ChatBackend / ProtocolCapabilities
│   ├── anthropic.ts          # Anthropic Messages 适配
│   └── responses.ts          # OpenAI Responses 适配
└── providers/
    ├── codearts/             # 码道适配器（自包含；协议适配复用共享 protocols/）
    │   ├── index.ts          # provider 模块（prefix="/codearts"，required）
    │   ├── openai.ts         # 内部统一管线 + OpenAI Chat 门面
    │   ├── snap.ts           # 加密通道（key-exchange + SM4-GCM SSE）
    │   ├── refresher.ts      # STS 自动刷新（DPoP + refresh_token 轮换回写）
    │   ├── signer.ts         # 华为云双签名器（sl.sign / signSimple）
    │   ├── sm4.ts            # SM4-GCM（内核逐字语义，含 GHASH 块边界行为）
    │   ├── config.ts         # 凭证加载 + 模型池
    │   ├── telemetry.ts      # OTLP 最小仿真
    │   └── protocol-spec.md  # 内核协议权威规格
    └── codebuddy/            # CodeBuddy CN 适配器
        ├── index.ts          # provider 模块（prefix=/codebuddy，required=false）
        ├── openai.ts         # OpenAI Chat 门面 + 跨协议 respond 管线
        ├── client.ts         # 头集合 / gzip / 401 刷新
        ├── envelope.ts       # OpenAI ↔ CodeBuddy 请求体映射
        ├── msgcenter.ts      # 可选消息中心轮询（30s）
        ├── config.ts         # 凭证（Keychain safeStorage）+ 模型/提示词
        ├── ids.ts            # 32hex ID + 会话/轮次
        ├── types.ts          # 公共类型
        ├── protocol-spec.md  # 协议权威规格
        └── *.test.ts         # bun test
```

## 新增 provider

在 `src/providers/<name>/` 实现一个 `ProviderModule`（`name`、`prefix`、`required`、`create()` 返回 `routes` + `health`），并在 `src/index.ts` 的注册表加一行即可。路由匹配由 `src/registry.ts` 统一处理（最长前缀 + 路径边界、404/405/503、聚合 `/healthz`）；Anthropic/Responses 适配优先复用 `src/protocols/`，provider 差异用 `ProtocolCapabilities` 表达（`toolChoice`、`errorShape`、`thinking`）。

## 生产启动（launchd，已配置）

服务由 macOS LaunchAgent 管理：登录自启、崩溃/被杀自动拉起、日志落盘。

```bash
launchctl kickstart -k gui/$(id -u)/cn.wayne.any2api   # 重启（改代码后）
launchctl bootout gui/$(id -u)/cn.wayne.any2api        # 停止
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/cn.wayne.any2api.plist  # 再启动
tail -f logs/any2api.log                                # 看日志
```

配置文件：`~/Library/LaunchAgents/cn.wayne.any2api.plist`。

手动前台运行（调试用）：

```bash
bun src/index.ts
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址；设 `0.0.0.0` 可暴露局域网（服务无鉴权，勿暴露公网） |
| `OTLP_ENABLED` | `true` | OTLP 遥测仿真开关 |
| `OTLP_SERVICE_NAME` | `codeagent-kernel` | 遥测 service.name |
| `SNAP_ORIGIN` | 华为云生产地址 | snap-access 通道覆盖 |
| `CODEBUDDY_AGENT` | `chat` | codebuddy 默认 profile：`chat` / `ask` / `craft` |
| `CODEBUDDY_AUTO_REFRESH` | `1` | codebuddy 401 时是否自动刷新 token 并重试（`0` 关闭） |
| `CODEBUDDY_MSG_CENTER` | `0` | codebuddy 是否开启消息中心 30s 轮询（`1` 开启） |
| `CODEBUDDY_QUEUE_TIMEOUT_MS` | `120000` | codebuddy 排队等待上限（ms） |
| `CODEBUDDY_TOKEN` / `CODEBUDDY_UID` | 从 Keychain 提取 | codebuddy 凭证兜底（可配 `CODEBUDDY_REFRESH_TOKEN`） |
| `CODEBUDDY_DEVICE_TOKEN` | 空 | codebuddy 可选的 TuringShield 设备令牌 |
| `CODEBUDDY_GENIE_HOME` | 本机 CodeBuddy 安装路径 | codebuddy 产品配置/提示词来源 |
| `CODEBUDDY_STATE_DB` | CodeBuddy 的 `state.vscdb` | 凭证与云端产品缓存来源（测试或自定义路径） |
| `CODEBUDDY_PRODUCT_CACHE` | `1` | codebuddy 是否读取云端产品缓存（`0` 关闭，回退 product.json） |

## 使用方式

服务即标准 OpenAI API，任何支持「OpenAI 兼容 / 自定义 Base URL」的客户端都能接（Cherry Studio、LobeChat、Open WebUI、Cline、Aider 等）。

OpenAI SDK（任意语言）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/codearts/v1", api_key="anything")  # api-key 随意非空
resp = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,  # 支持流式 reasoning + content
)
```

curl 直测：

```bash
curl -N http://127.0.0.1:8787/codearts/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

端点（同一服务内三种协议，Claude Code / Codex / 任意 OpenAI 客户端均可直连）：

- `POST /codearts/v1/chat/completions` — OpenAI Chat 格式，流式/非流式
- `POST /codearts/v1/messages` — Anthropic Messages 格式（Claude Code / Claude Desktop），text/thinking/tool_use/tool_result 块、tool 流式事件
- `POST /codearts/v1/responses` — OpenAI Responses 格式（Codex CLI），instructions/input items、function_call 往返、reasoning summary 流
- `GET /codearts/v1/models` — 模型列表
- `GET /healthz` — 聚合健康检查（JSON：`{ok, providers:[...]}`）

当前模型池：启动时通过 Policy Center `POST /v1/policy/bundle`（Agent-Type: PromptCenter，商业版 x-auth-token 为空串、靠 provider 层 AKSK 签名认证）动态发现——这是 IDE 模型下拉的真实数据源，后端调整模型无需改代码；失败时回退观测池（`glm-5.3-flash`、`deepseek-v4.1-flash`）。

### CodeBuddy（codebuddy provider）

Base URL 用 `/codebuddy/v1`：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/codebuddy/v1", api_key="anything")
resp = client.chat.completions.create(
    model="hy4flash-free",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,  # 上游只支持流式；非流式由代理聚合
)
```

- `GET /codebuddy/v1/models` — 当前模型池（云端产品缓存优先，回退 product.json + agent models + 观测模型）。
- `POST /codebuddy/v1/chat/completions` — 流式/非流式、标准 OpenAI 工具调用往返。
- `POST /codebuddy/v1/messages` — Anthropic Messages（Claude Code / Claude Desktop），text/thinking/tool_use/tool_result 块。
- `POST /codebuddy/v1/responses` — OpenAI Responses（Codex CLI），instructions/input items、function_call 往返、reasoning summary。
- `GET /codebuddy/healthz` — 凭证来源、模型数。
- profile：请求头 `x-codebuddy-agent: chat|ask|craft`（默认 `chat`）；`ask`/`craft` 会注入 IDE 的系统提示词。
- 凭证：自动从 Keychain + `state.vscdb` 提取（需登录过一次），也可用 `CODEBUDDY_TOKEN` / `CODEBUDDY_UID`。

## 凭证与续期行为

- 前提：曾在码道 app 内登录过一次（凭证取自 app 的 SecretStorage：refresh_token、PKCE、DPoP 密钥对）
- **无需 app 在线**：STS 每 60s 巡检；余量 <30min 自动续期；chat 收到 401 自动刷新并重试
- refresh_token 家族 30 天有效，每次续期自动轮换并回写 app 的 SecretStorage（与 app 多窗口语义一致，互不破坏）
- app 与代理共享 lineage，任一方续期另一方自动获益
- 若 lineage 意外失效（如续期成功但回写前进程崩溃），日志会提示重新登录一次

### CodeBuddy

- 凭证来自 macOS Keychain `CodeBuddy CN Safe Storage` + `state.vscdb` 的 `planning-genie.new.accessTokencn`（v10 safeStorage 解密）。
- token 过期：401 时调用 `/v2/plugin/auth/token/refresh` 刷新并重试一次；失败提示重新登录。
- 无需 IDE 在线；Keychain 授权只需一次。

## 已知限制

- 服务无鉴权：默认只绑 `127.0.0.1`，仅本机可用；改 `HOST=0.0.0.0` 前请评估风险
- 模型池为启动时动态发现（见上），失败回退观测池
- 协议适配边界：图像块被省略（占位 `[image omitted]`）；强制 `tool_choice`（any/tool）上游不支持，仅 auto 生效（真实客户端同样只用 auto）；`previous_response_id` 无服务端存储语义（Codex 以全量上下文重发，不受影响）
- 残余可识别特征：Bun 与内核（Node）的 TLS 指纹差异、OTLP service.name 为占位值
- 明文回退为死路径：chat 后端硬性要求加密通道（实测 415 Unsupported Media Type），密钥协商失败即不可用（代理已实现换 key 重试）
- codebuddy 支持 OpenAI Chat + Anthropic Messages + OpenAI Responses；遥测（`/v2/report`、`/llm/data/report`、`/v1/traces`）未做，消息中心轮询需 `CODEBUDDY_MSG_CENTER=1` 显式开启
- codebuddy 模型池读取本机云端产品缓存（24 个，与 IDE 一致）；缓存缺失时回退 product.json + agent models + 观测模型
- codebuddy 默认不发送 `X-Device-Token`（实测当前通道可省略），不伪造 TuringShield
- codebuddy 的 ask/craft profile 只切换系统提示词；工具 schema 仅来自客户端 `tools`
- codebuddy 会过滤已知的竞品客户端 system preamble（Claude Code 的 "official CLI" 句）与客户端计费指纹行（`x-anthropic-billing-header:`），避免后端 400 Request blocked；其他敏感 system 仍可能被拦截

<!-- usage-ledger-docs-map -->
## 文档地图

本项目的知识库结构与兄弟项目 `usage-ledger` 一致；动手前先读 [`AGENTS.md`](AGENTS.md) 地图。

| 文档 | 内容 | 何时读 |
|---|---|---|
| [`AGENTS.md`](AGENTS.md) | 项目工作区地图、硬规则、文档指针 | 进入项目时 |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | As-Built 架构；暂无事实写「待补」 | 了解整体结构 / 排障时 |
| [`docs/DESIGN.md`](docs/DESIGN.md) 及相邻领域宪章 | 设计、前端、计划、产品感知、质量、可靠性、安全 | 对应领域评审时 |
| [`docs/design-docs/index.md`](docs/design-docs/index.md) | 设计知识库状态索引 | 查 ADR / RFC / 历史设计时 |
| [`docs/product-specs/index.md`](docs/product-specs/index.md) | 产品行为规格索引 | 产品 / 需求、开始新特性前 |
| [`docs/exec-plans/completed/`](docs/exec-plans/completed/) | 已验证变更记录 | 开发 / 评审时 |
| [`docs/references/index.md`](docs/references/index.md) | 调研、实测与外部参考证据 | 查证据时 |
| [`docs/generated/index.md`](docs/generated/index.md) | 生成物索引 | 核对生成物时 |

历史 `REQ-xxxx` / `CHG-xxxx` / `ADR-xxxx` 编号冻结；新增文档使用语义化主题路径，不再分配顺序编号。状态以文档首部为准，没有验证 / 部署证据不得标「已验证 / 已发布」。

## 开发约定

跨项目流程见 [工作区根 AGENTS.md](../AGENTS.md)：`main` 保护、新特性走 `feat/<特性名>`、脏工作区用 worktree、TDD、提交前静态检查、临时集成分支、PR / 合并前用户同意。项目级测试：`bun test`；编译 / 构建 / 静态检查：`bun build src/index.ts --target=bun`。未配置的检查保持「待补」，不得用跳过规则压掉告警。
