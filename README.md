# any2api

把各 AI 编程工具的私有 LLM 通道封装为通用 **OpenAI 兼容 API**。每个工具是一个独立 provider（`src/providers/<name>/`），对外统一暴露 `/v1/chat/completions` 与 `/v1/models`。

- 当前 provider：**codearts**（码道 CodeArts Agent，华为云 snap-access 通道）
- 计划 provider：codebuddy 等
- 运行时：Bun（原生执行 TypeScript，无需编译）

## 结构

```
src/
├── index.ts                  # 顶层入口：provider 注册点（新增 provider 在此加一行）
├── shared/
│   └── ids.ts                # 通用 ID 生成（跨 provider 复用）
└── providers/
    └── codearts/             # 码道适配器（自包含）
        ├── index.ts          # provider 装配与启动（路由注册）
        ├── openai.ts         # 内部统一管线 + OpenAI Chat 门面
        ├── anthropic.ts      # Anthropic /v1/messages 协议适配
        ├── responses.ts      # OpenAI Responses /v1/responses 协议适配
        ├── snap.ts           # 加密通道（key-exchange + SM4-GCM SSE）
        ├── refresher.ts      # STS 自动刷新（DPoP + refresh_token 轮换回写）
        ├── signer.ts         # 华为云双签名器（sl.sign / signSimple）
        ├── sm4.ts            # SM4-GCM（内核逐字语义，含 GHASH 块边界行为）
        ├── config.ts         # 凭证加载 + 模型池
        ├── telemetry.ts      # OTLP 最小仿真
        └── protocol-spec.md  # 内核协议权威规格
```

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

## 使用方式

服务即标准 OpenAI API，任何支持「OpenAI 兼容 / 自定义 Base URL」的客户端都能接（Cherry Studio、LobeChat、Open WebUI、Cline、Aider 等）。

OpenAI SDK（任意语言）：

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="anything")  # api-key 随意非空
resp = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "你好"}],
    stream=True,  # 支持流式 reasoning + content
)
```

curl 直测：

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"glm-5.3-flash","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

端点（同一服务内三种协议，Claude Code / Codex / 任意 OpenAI 客户端均可直连）：

- `POST /v1/chat/completions` — OpenAI Chat 格式，流式/非流式
- `POST /v1/messages` — Anthropic Messages 格式（Claude Code / Claude Desktop），text/thinking/tool_use/tool_result 块、tool 流式事件
- `POST /v1/responses` — OpenAI Responses 格式（Codex CLI），instructions/input items、function_call 往返、reasoning summary 流
- `GET /v1/models` — 模型列表
- `GET /healthz` — 健康检查

当前模型池：启动时通过 Policy Center `POST /v1/policy/bundle`（Agent-Type: PromptCenter，商业版 x-auth-token 为空串、靠 provider 层 AKSK 签名认证）动态发现——这是 IDE 模型下拉的真实数据源，后端调整模型无需改代码；失败时回退观测池（`glm-5.3-flash`、`deepseek-v4.1-flash`）。

## 凭证与续期行为

- 前提：曾在码道 app 内登录过一次（凭证取自 app 的 SecretStorage：refresh_token、PKCE、DPoP 密钥对）
- **无需 app 在线**：STS 每 60s 巡检；余量 <30min 自动续期；chat 收到 401 自动刷新并重试
- refresh_token 家族 30 天有效，每次续期自动轮换并回写 app 的 SecretStorage（与 app 多窗口语义一致，互不破坏）
- app 与代理共享 lineage，任一方续期另一方自动获益
- 若 lineage 意外失效（如续期成功但回写前进程崩溃），日志会提示重新登录一次

## 已知限制

- 服务无鉴权：默认只绑 `127.0.0.1`，仅本机可用；改 `HOST=0.0.0.0` 前请评估风险
- 模型池为启动时动态发现（见上），失败回退观测池
- 协议适配边界：图像块被省略（占位 `[image omitted]`）；强制 `tool_choice`（any/tool）上游不支持，仅 auto 生效（真实客户端同样只用 auto）；`previous_response_id` 无服务端存储语义（Codex 以全量上下文重发，不受影响）
- 残余可识别特征：Bun 与内核（Node）的 TLS 指纹差异、OTLP service.name 为占位值
- 明文回退为死路径：chat 后端硬性要求加密通道（实测 415 Unsupported Media Type），密钥协商失败即不可用（代理已实现换 key 重试）
