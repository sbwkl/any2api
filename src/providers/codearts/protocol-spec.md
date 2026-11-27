# CodeArts Agent 真实客户端模拟规格 & OpenAI 兼容代理架构设计

> 日期：2026-11-20
> 前置说明：早期总体逆向报告（原 `/private/tmp/codearts-agent-llm-analysis.md`）已随 /tmp 丢失；一手材料为本机内核二进制 `~/.codeartsdoer/CodeArts_Agent/AgentKernel_*`（Bun 单文件可执行，多版本并存）。需要核对线上形状时从中提取内嵌 JS：`grep -abo` 定位标记（如 `chat-session/heartbeat`）→ `dd` 按字节偏移切片 → `tr` 清洗非可见字节。
> 本文目标：给出"让 snap-access 后端把代理流量识别为真实客户端流量"所需的**逐字实现规格**，全部内容来自内核二进制 JS 还原 + 本机真实日志采样（2026-11-20 实测），并给出 OpenAI 兼容代理（方案 B）的完整架构。
> 用户已明确接受 ToS/风控风险；本文仅覆盖技术事实。

---

## 0. 真实请求头全息样本（本机 2026-11-20T15:00 实测）

`POST https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions`

Provider 层（sl.sign 后、加密层 re-sign 前）完整头集（日志原文）：

```json
{
  "x-ot-trace-id":          "9c48e08f330df91adb8f1ee96e4b0d0d",
  "x-ot-span-id":           "9a21ba9de0aef34c",
  "x-snap-traceid":         "9c48e08f330df91adb8f1ee96e4b0d0d_c390af85fde3467e",
  "x-ot-session-id":        "ses_e086d3e9affegz2pqNl4byb3ru",
  "x-ot-parent-session-id": "",
  "user-session-id":        "ses_e086d3e9affegz2pqNl4byb3ru",
  "x-ot-function":          "agent-claw",
  "X-Language":             "en-us",
  "user-msg-id":            "msg_1f7c0e8b10014OdqA9Qtx64JYB",
  "created-time":           "2026-11-20T07:00:17Z",
  "model-id":               "glm-5.3-flash",
  "model-name":             "GLM-5.3-Flash",
  "x-ot-client-type":       "IDE",
  "x-ot-client-version":    "26.11.200",
  "plugin-name":            "codemate_vscode",
  "plugin-version":         "26.11.200",
  "ide-name":               "VSCode",
  "ide-version":            "26.11.200",
  "client-ip":              "192.168.1.9",
  "X-Sdk-Date":             "20261120T070017Z",
  "host":                   "snap-access.cn-north-4.myhuaweicloud.com",
  "Authorization":          "SDK-HMAC-SHA256 Access=..., SignedHeaders=..., Signature=...",
  "X-Security-token":       "<sts accessToken>"
}
```

加密层追加/覆盖（encrypting-fetch re-sign 后**上线最终形态**）：

```
Content-Type:             application/octet-stream
X-Encrypt-Algo:           sm4-gcm
X-Encrypt-Key-Id:         <keyId>
X-Encrypt-Iv:             <base64 12B>
X-Encrypt-Tag:            <base64 16B>
X-Encrypt-Ts:             1795159217259          (ms 字符串)
X-Sdk-Content-Sha256:     UNSIGNED-PAYLOAD
X-Sdk-Date:               20261120T070017Z       (re-sign 新生成)
Authorization:            SDK-HMAC-SHA256 Access=..., SignedHeaders=content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token, Signature=...
X-Encrypt-Capable:        sm4-gcm                (ChatHeaders 钩子加，不参与签名)
User-Agent:               opencode/126.11.2-20261117200150
x-session-affinity:       ses_e086d3e9affegz2pqNl4byb3ru   (不参与签名)
x-message-id:             msg_1f7c0e8b10014OdqA9Qtx64JYB   (不参与签名)
x-session-user-message:   true                             (仅 primary agent 的首轮，不签名)
```

**关键结论：上线时的 `Authorization` 是 encrypting-fetch 的 signSimple 签名**（签名头集 = `content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token`，payload 哈希为 `UNSIGNED-PAYLOAD` 字面量），provider 层对 x-ot-* 头的签名被覆盖。x-ot-*/user-*/model-* 头**不参与签名**，仅由网关采集做业务统计。

---

## 1. 凭证获取链

### 1.1 凭证集（推荐路径：从运行中的 app 提取）

| 项 | 来源 | 复用语义 |
|---|---|---|
| AK/SK/securityToken | 内核 GlobalConfig `userInfo.{accessKeyId,secretAccessKey,accessToken,expiresAt,domainId}`（STS 临时凭证） | accessToken 到期前由 IDE 刷新；代理可直接复用 |
| userToken（备用） | GlobalConfig `userToken`，30 天有效期 | x-auth-token 模式，日志证实主链路走 AKSK |
| inferhubBaseUrl | GlobalConfig，国内生产 = `https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/` | 决定网关 origin |

提取方式（本机即可完成）：
1. `ps eww <AgentKernel pid>` 取 `OPENCODE_SERVER_PASSWORD`；端口读 `~/.codeartsdoer/CodeArts_Agent/Vscode_*/server_config.properties`；
2. 内核接口读 GlobalConfig：`GET /global/config`（Basic `codearts:{password}`）——注意实测该端点字段名与 PATCH schema 对齐（`userInfo` 内含 AK/SK/token）；
3. 兜底：`env HW_ACCESS_KEY/HW_SECRET_KEY/HW_SECURITY_TOKEN/CODEARTS_CLI_AK/SK`；
4. 凭证失效处理：401 时若 `CODEARTS_CLI_AK/SK` 存在走 `qie()` 刷新逻辑；代理应实现"401 → 提示重新从 app 提取"。

### 1.2 AKSK 鉴权优先级（内核逐字逻辑，`Sh()`）

```
if (isHC && (userInfo.ak || CODEARTS_CLI_AK) && (userInfo.sk || CODEARTS_CLI_SK))
    → AKSK 签名（X-Security-token = userInfo.accessToken）
else if (GlobalConfig.userToken)
    → x-auth-token
else → 无鉴权（不发送）
```

---

## 2. AKSK 签名器（逐字还原）

### 2.1 两个签名器

内核有**两套** signer，行为不同，必须按用途选择：

| | `sl.sign`（provider 层） | `bL.signSimple`（OTLP/encrypting-fetch Ew） |
|---|---|---|
| 用途 | provider 生成全套头（含 x-ot-*） | encrypting-fetch re-sign、OTLP 上报、key-exchange |
| content-type | **非 multipart 时从签名头删除** | 参与签名（固定传入） |
| payload hash | `sha256(JSON.stringify(body.data))`（有 data 时） | 固定 `UNSIGNED-PAYLOAD` |
| CanonicalHeaders key | 保留原大小写（仅排序按小写） | **转小写** |
| 最终 Authorization | 被加密层覆盖（chat 场景） | **chat/OTLP 实际上线值** |

### 2.2 `sl.sign` 算法（伪代码，可直接移植）

```
sign(req, {ak, sk}):
  date = req.headers["X-Sdk-Date"] ? formatDate(new Date(该值)) : formatDate(now)
        // formatDate = UTC "YYYYMMDDTHHmmssZ"；若原 headers 没有 X-Sdk-Date 则注入
  url = new URL(req.endpoint)
  host = url.host  (默认端口不加后缀; headers.Host 优先)
  headers = { ...req.headers, "X-Sdk-Date": date, "host": host }   // host 键为小写
  delete headers["content-type"] 除非 value 含 "multipart/form-data"
  canonicalURI  = url.pathname 每段 urlEncode 后以 "/" 连接，且**强制补尾 "/"**
  canonicalQuery= queryParams 按 key 排序，urlEncode(key)=urlEncode(value)（数组值先排序，& 连接）；无参数 = ""
  signedHeaders = keys(headers).sort(按 lowercase localeCompare).join(";").toLowerCase()
  canonicalHeaders = 每个 header "key:value\n"（key 保留原大小写；value 去掉 \r\n、trim）
  payloadHash   = headers["X-Sdk-Content-Sha256"] ?? (req.data ? sha256hex(JSON.stringify(req.data)) : EMPTY_BODY_SHA256)
                  // EMPTY_BODY_SHA256 = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
  canonicalRequest = [method, canonicalURI, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n")
  stringToSign  = ["SDK-HMAC-SHA256", date, sha256hex(canonicalRequest)].join("\n")
  signature     = hexHMAC-SHA256(sk, stringToSign)
  Authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  返回 headers + Authorization
```

### 2.3 `signSimple`（上线形态）——固定签名头集

```
X = {
  "Content-Type": <传入 ct>,              // chat 加密体 = "application/octet-stream"；key-exchange = "application/json"；OTLP = "application/json"
  "X-Sdk-Content-Sha256": "UNSIGNED-PAYLOAD",
  "X-Security-Token": <securityToken>,    // 有则带
  "X-Sdk-Date": formatDate(now),
  "Host": <hostname[:non-default-port]>
}
canonicalRequest = [method, urlEncodeURI(pathname)+"尾部/", "", canonicalHeaders(X, key小写), signedHeaders, "UNSIGNED-PAYLOAD"].join("\n")
signedHeaders = "content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token"（实际按存在性）
```

### 2.4 urlEncode（华为云 SDK 版，非 encodeURIComponent）

- ASCII 且在 noEscape 表中 → 保留；noEscape 表：`A-Z a-z 0-9 - _ . ! ~ * ' ( )`（表索引 45,46,95,126 等，0x21/0x27/0x2a/0x2d/0x2e/0x5f/0x7e 及字母数字不转义）
- 其余逐字节 `%XX` **大写** hex；UTF-8 多字节按 2/3/4 字节展开
- 实现：直接照抄 `sl.urlEncode` 逻辑（hexTable 全部大写）

---

## 3. SM4-GCM 加解密（逐字还原）

### 3.1 密钥协商 `POST /api/v1/security/key-exchange`（明文 JSON）

```
请求头: signSimple 形态（Content-Type: application/json, UNSIGNED-PAYLOAD, AKSK 签名）
        或无 AKSK 时 {"Content-Type":"application/json", x-auth-token}
请求体: {"clientPublicKey": base64(ECDH P-256 65B 未压缩公钥 → 88 字符),
         "sessionId": randomBytes(16).toString("hex")   // 32 hex 字符
         "timestamp": Date.now()}                       // ms 数字
响应:   {"serverPublicKey": base64, "keyId": "...", "expiresIn": 3600}
sessionKey = SHA256(ECDH_shared_secret).subarray(0,16)    // Uint8Array 16B
```

### 3.2 会话密钥管理器（`d$` 逐字语义）

- 复用条件：`Date.now() < expiresAt - 300_000`（提前 5 分钟换新）
- `expiresAt = Date.now() + expiresIn*1000`
- 协商失败且旧 key 未到期 → 继续用旧 key（fallbackOnFailure=true）
- 收到 `ENCRYPT_KEY_EXPIRED`（响应体包含该串）→ `clearKey()` + 立即重协商 + **同一请求重试一次**（代理实现中这次重发扣一次共享重试预算）

### 3.3 请求加密

```
enabled 判定（UXe）: CODEAGENT_IS_WEB_AGENT!=="true"
  && config.enabled && sm4.enabled
  && pathname.startsWith("/api/v2/chat/completions")     // 仅此路径；key-exchange 恒明文

iv   = 12 字节随机（SM4-GCM 标准）
AAD  = `${METHOD}|${pathname}|${Date.now()}`              // 例 "POST|/api/v2/chat/completions|1795159217259"
密文体 = base64(SM4-GCM-Encrypt(key, UTF8(原始JSON), iv, AAD).ciphertext)
tag  = base64(authTag 16B)，iv = base64(iv)
```

新 Headers = 原 headers 全量保留，再 set：
```
X-Encrypt-Algo: sm4-gcm
X-Encrypt-Key-Id: <keyId>
X-Encrypt-Iv: <b64>
X-Encrypt-Tag: <b64>
X-Encrypt-Ts: <ms string>
Content-Type: application/octet-stream
```
然后 Ew signSimple re-sign（覆盖 Authorization/X-Sdk-Date）。
**失败回退链**（客户端明确行为，代理可复用以提高拟真度）：协商失败→明文发送；加密请求网络错误→明文重发；非 2xx→读 body，含 ENCRYPT_KEY_EXPIRED→换 key 重试一次，否则明文重发。

> **代理实现偏差（2026-11-25 / 2026-11-27）**：chat 的明文回退实测 8/8 被上游以 415 拒绝，只会掩盖真实故障。代理不再对 chat 回退明文：协商失败直接报错；非 2xx 按状态级重试表处理（429 / 406 / 502 总尝试 ≤10，500 / 503 / 504 / 407 总尝试 ≤3，其它 4xx/5xx 与裸网络错误不重试），同一入站请求共享一份尝试预算，退避指数增长并尊重 `retry-after` / `retry-after-ms`；`ENCRYPT_KEY_EXPIRED` 换 key 重发保留并扣预算。实现见 `src/providers/codearts/retry.ts` 与 #51。`CODEARTS_FORCE_PLAINTEXT=1` 仅作调试。首次偏差的决策与证据见 `docs/exec-plans/completed/2026-11-25-p0-upstream-errors-tool-fidelity.md`。

### 3.4 响应解密（SSE）

响应头 `X-Encrypt-Algo: sm4-gcm` 时：
- 按体按 `\n\n` 分帧；每帧一行 `iv:tag:ciphertext`（三段 base64，":" 分隔）
- 明文 = SM4-GCM-Decrypt(key, iv=seg0, tag=seg1, ct=seg2, AAD=`${keyId}|${chunkIndex}`)，chunkIndex 从 0 递增（含最后残余帧）
- 输出补 `\n\n` 回放；每 50 帧 `setImmediate` 让步
- 透传时删除响应头 X-Encrypt-Algo / X-Encrypt-Key-Id，Content-Type 改 `text/event-stream`

### 3.5 证书锁定

默认 `certPin.enabled=false`（`$h` 默认配置）；可被 `TRANSPORT_SECURITY_CONFIG` 环境变量覆盖。pin 校验 = `sha256/` + base64(SPKI DER sha256)。→ **代理无需处理 pin**（真实客户端默认也未启用）。

---

## 4. ID 体系与复用语义矩阵（最重要）

### 4.1 opencode 实体 ID 生成器（逐字还原）

```
前缀表: event=evt, session=ses, message=msg, permission=per, question=que,
        user=usr, part=prt, pty=pty, tool=tool, workspace=wrk
create(kind):
  ms = Date.now(); 同毫秒内 counter++（跨毫秒重置）
  o  = BigInt(ms)*4096n + counter
  hex12 = 6 字节大端 hex（o >> 40-8f 截取）           // 12 hex 字符
  rand14 = 14 字符，alphabet = [0-9A-Za-z]，randomBytes[i] % 62
  id = `${prefix}_${hex12}${rand14}`                  // 总长 = 4+1+12+14 = 31
```
实测样本：`ses_e086d3e9affegz2pqNl4byb3ru`（12hex+14alnum ✓）、`msg_1f7c0e8b10014OdqA9Qtx64JYB` ✓。**代理必须以此格式造 ses_/msg_ ID**（后端按前缀+结构做画像）。

### 4.2 trace/session 头语义矩阵

| 头 | 生成者 | 粒度 | 值格式 | 说明 |
|---|---|---|---|---|
| `x-ot-trace-id` | **IDE**（用户发 prompt 时） | 每次用户消息（同一 prompt 的全部 LLM 请求共享，含子 agent） | uuid 无连字符 32hex | 经 ALS 传播；`agent==="preference"` 时置空 |
| `x-ot-span-id` | 内核 chat.headers 钩子 | 每 LLM 请求 | 16 hex 小写 | = 会话 otel span 的 spanId，回退 ALS spanId，再回退 `zr()`（随机 16hex） |
| `x-snap-traceid` | IDE 传基值 + 内核 Qg() | 每 LLM 请求 | `{traceId}_{16hex}`（≤64 字符） | Qg(): 若 ALS.inferenceId 存在 → `inferenceId + "_" + uuid去连字符前16位` |
| `x-ot-session-id` | 内核 | 每会话 | opencode sessionID `ses_xxx` | **直接用内核 sessionID** |
| `x-ot-parent-session-id` | Et() | 每会话 | 父会话 ses_xxx 或 `""` | 根会话恒空串；子任务/子 agent 才有；`ses_dummy_touchup` → 空 |
| `user-session-id` | hc chat.headers 钩子 | 顶层会话 | `Et(sessionID) || sessionID` | **子会话上报父会话 ID**；心跳同款 |
| `x-ot-function` | IDE tc holder / Nwt() | 每 prompt | `agent-claw`（主力 chat）、`agent-general`、`agent-base`、`agent-teams`、`agent-custom`、`agent-tui`、`agent-server`、`agent-kernel-sdk-*` | cron 场景映射：source=claw→agent-claw；kernel+build→agent-general |
| `maas_type` | IDE 传入 | 每 prompt | 可空 | 仅显式存在才发送 |
| `user-msg-id` | nr() / message.id | 每用户消息 | opencode msgID `msg_xxx` | = 触发本轮的用户消息 ID；VLM 调用也带同一 ID |
| `x-message-id` | 同上 | 同上 | 同上 | 不签名 |
| `created-time` | new Date().toISOString() | 每 LLM 请求 | UTC ISO，**去毫秒**：`2026-11-20T07:00:17Z` | |
| `model-id` | model.id | 每请求 | 如 `glm-5.3-flash` | |
| `model-name` | hae(ALS.modelName \|\| headers.model-name) | 每请求 | 已含 `%XX` 则透传，否则 encodeURIComponent；实测 `GLM-5.3-Flash`（展示名） | |
| `x-ot-client-type` | IDE 注入 GlobalConfig | 进程级 | `IDE`（商业版 CodeArts 分支）/`VSCode`；CLI 场景 `CLI` | Mr = isCommercialVersion && appName 含 "codearts" |
| `x-ot-client-version` | 同上 | 进程级 | `26.11.200`；CLI 场景 = 内核版本 `126.11.2-20261117200150` | |
| `X-Language` | ls() | 进程级 | env CODEAGENT_LANGUAGE \|\| GlobalConfig.language；en*→`en-us`，zh*→`zh-cn`，默认 `zh-cn`（实测 en-us） | |
| `client-ip` | R9() | 每请求 | 第一个非 internal 的 IPv4（networkInterfaces 顺序），无则 `127.0.0.1` | 实测 `192.168.1.9` |
| `x-codearts-doer-scenario-type` | ALS/IDE | prompt 级 | 可空 | |
| `x-session-retry` | 内核重试器 | 每重试 | 数字（0 起） | 407/Busy 重试协议，≤3（407）；Busy 类 ≤10~20 |
| `x-session-user-message` | hc 钩子 | 首轮 | `"true"` | 仅 agent.mode==="primary" && !hidden |
| `x-session-affinity` | 内核 | 每请求 | sessionID | 不签名 |
| `X-Encrypt-Capable` | transport-security 钩子 | 恒定 | `sm4-gcm` | sm4.enabled 时注入 |
| `User-Agent` | 内核 HTTP 客户端 | 恒定 | `opencode/126.11.2-20261117200150` | **格式 `opencode/{内核版本}`** |
| `app-id` / `is-need-queue` | doStream 非 hc 分支 | - | `CodeAgent3.0` / `true` | 仅非 hc（token 模式）chat 才加 |

### 4.3 头发送顺序

JS 对象构造序 → fetch 按插入序发出（Bun undici-ish）。拟真顺序即上表顺序：先 x-ot-* 追踪族，再业务头（user-msg-id/created-time/model-*），再 client 头（client-type/version/plugin-*/ide-*），再 client-ip，最后加密族（X-Encrypt-*、Content-Type）与签名族（X-Sdk-*、Authorization）。HTTP/2 下实际以 hpack 帧序呈现——代理用同序注入即可。

---

## 5. 会话生命周期行为（必须仿真的"旁路信号"）

### 5.1 心跳（`snap-manager/v1/chat-session/heartbeat`）

- **`PUT {snap-origin}/snap-manager/v1/chat-session/heartbeat?status=busy|idle`**（PUT 不是 POST；**status 放查询参数**，与内核 `uA.put(path, headers, {}, { status })` 逐字一致）
- 头：`user-session-id: <顶层会话ID>` + AKSK 签名（Sh() 模式，X-Sdk-Content-Sha256=UNSIGNED-PAYLOAD，status 查询参数参与 canonical query 签名）或 x-auth-token
- 体：固定 `{}`（status 不放 body）
- 节奏：session.status=busy → 立即 busy，然后每 **30s** 一次；idle → 停表 + 立即 idle
- 会话聚合：**只有顶层会话发心跳**（子会话只刷新活跃时间戳）；心跳静默 >24h 自动转 idle
- 代理应按 OpenAI 会话粒度模拟：每次代理"会话"首个请求 → busy + 30s 定时；会话结束/空闲 → idle
- 排障：返回 `400 {"error_code":"TM.00001001","error_msg":"参数校验失败: wsf.validator.session.status"}` 表示 **status 查询参数缺失或非法**——先检查 URL 是否带 `?status=busy|idle`，而不是往 body 里塞字段

### 5.2 订阅查询

- `GET {snap-origin}/snap-manager/v1/statistics/plugin`（AKSK，Content-Type: application/json）→ 返回 `{package:{spec_code,...}}`；真实客户端在启动/git-ai 判定时调用
- `GET {opengw}/api/v1/gateway/config`（AKSK）→ `{endpoint, models:[{model_id,model_name,model_alias}]}` —— **代理的模型发现与 endpoint 下发通道**

### 5.3 OTLP 遥测（`collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/{logs,traces}`）

- POST OTLP/JSON，`compression:none`，AKSK signSimple（Content-Type 参与签名、UNSIGNED-PAYLOAD）
- 批处理：**5s 或 30 条**触发导出，超时 30s
- UA：`OTel-OTLP-Exporter-JavaScript`
- 关键资源属性：`service.name=<app-id 常量>`、`service.version="1.0"`、`service.component`、`agent_runtime_type`（webagent/cli/`ide-codeartsdoer`/unknown）、`w3account`
- span/log 属性族：`execution.agent_run_id`（=`traceId#agent_id`）、`execution.agent_id`、`execution.trigger.type`、`execution.prompt_id`（uuid 无连字符）、`execution.parent_agent_run_id/parent_agent_id`、`service.function`（=x-ot-function 同源）、`channel_scenario`、`domainId`、`user.id`、`process.owner`
- 结论：**后端可交叉验证"chat 请求头 vs 遥测 traceId"**。拟真代理应至少上报与 chat 同 traceId 的最小 trace/log 流（5s 批量节奏），否则"有请求无遥测"是显著异常。

---

## 6. TLS / HTTP 传输层

| 项 | 真实客户端 | 拟真代理对策 |
|---|---|---|
| 运行时 | Bun 单文件内核，fetch = Bun 内置（BoringSSL 系） | 残余指纹差异：ClientHello/JA3/JA4 与 Node/curl/Python 不同 |
| User-Agent | `opencode/126.11.2-20261117200150` | 完全一致（必须） |
| HTTP 版本 | HTTP/2（APG 网关） | 用支持 h2 的客户端，头顺序对齐 |
| 证书校验 | 系统校验；pin 默认关 | 无需伪装 |
| 代理链 | 支持 GlobalConfig proxy/noProxy | 可直连 |

残余差异（诚实清单）：
1. **TLS 指纹**：最难的点。可选：(a) 用 Bun 运行代理本体（指纹同源，工程量最小、拟真度最高——推荐）；(b) curl-impersonate/JA3 伪造库（只能逼近浏览器指纹，反而更假）；(c) 接受差异（服务端若采集 JA3 会看到"Bun UA + 非Bun指纹"的矛盾组合）。**推荐 (a)：整个代理直接用 Bun 实现**，UA、TLS、h2 行为全部同源。
2. 头集合完整性：日志已给出全集，遗漏任何一颗头都是差异。按 §0 清单逐项实现。

---

## 7. OpenAI 兼容代理架构（方案 B 完整设计）

### 7.1 组件图

```
第三方 Agent（OpenAI SDK 兼容）
        │  POST /v1/chat/completions (OpenAI 格式, stream 可选)
┌───────▼────────────────────────────────────────────────────┐
│ codearts-proxy（推荐 Bun 实现，单进程）                       │
│  ┌──────────────┐  ┌──────────────────┐  ┌──────────────┐   │
│  │ OpenAI 门面   │  │ 会话/ID 管理器     │  │ 凭证管理器    │   │
│  │ - 请求映射     │  │ - traceId/msg/ses │  │ - AK/SK/token│   │
│  │ - SSE 回放    │  │ - 心跳调度 30s    │  │ - 401 刷新    │   │
│  └──────┬───────┘  └────────┬─────────┘  └──────┬───────┘   │
│  ┌──────▼───────────────────▼───────────────────▼───────┐   │
│  │ snap 客户端栈（复刻 §2-§4）                             │   │
│  │  signSimple → key-exchange manager → SM4-GCM → 头组装  │   │
│  └──────────────────────┬─────────────────────────────────┘   │
│  ┌──────────────────────▼─────────────┐                       │
│  │ 遥测仿真器（OTLP/JSON，5s 批量）      │  (可选但推荐)          │
│  └─────────────────────────────────────┘                      │
└──────────────────────┬─────────────────────────────────────────┘
                       │ h2 + Bun TLS + UA=opencode/{ver}
              snap-access.cn-north-4.myhuaweicloud.com
```

### 7.2 请求映射（OpenAI → CodeArts）

| OpenAI 入参 | 处理 |
|---|---|
| `model` | 经 `/api/v1/gateway/config` 模型池映射：外部别名 → `{model_id, model_name}`；`model-id=model_id`、`model-name=model_name`（展示名） |
| `messages` | 原样透传（后端本就吃 OpenAI 格式）；`system` 保留 |
| `tools/tool_choice` | 透传（内核同款 function calling） |
| `stream` | true → `stream:true` + `stream_options:{include_usage:true}`（内核固定加） |
| `max_tokens` | `eH(modelId)` 决定 `max_tokens` 或 `max_completion_tokens`（DeepSeek/R 系用后者） |
| `reasoning_effort` | 透传；tH(modelId)（R 系+tools）时强制 `reasoning_effort:"none"` |
| `user_prompt` 扩展 | 内核有 `user_prompt` 字段（x-user-prompt-label 同步）；代理可选加 |

新增内核私有头（§4.2 全集），其中代理内部维护：
- 每个代理会话（由第三方 `user`/会话 key 或首次请求分配）→ 固定 `x-ot-session-id`=`user-session-id`=`x-session-affinity`=`ses_...`
- 每个用户消息（一轮）→ 新 `x-ot-trace-id`（uuid32）+ `user-msg-id`（`msg_...`），该轮内所有请求（含工具循环后续 LLM 调用）复用 traceId
- 每 LLM 请求 → 新 `x-ot-span-id`、`x-snap-traceid={traceId}_{rand16}`、`created-time`、`X-Sdk-Date`

### 7.3 响应映射（CodeArts → OpenAI）

- 加密 SSE 三段式 → 解密出标准 `data: {choices:[{delta:{content,reasoning_content,tool_calls}}],usage}` → 原样转 OpenAI chunk
- `reasoning_content` 映射为 OpenAI `reasoning`/自定义字段（第三方按需）
- 错误映射：SSE 内嵌错误按内嵌状态码分类为 400/415/429/502/504，归一为 OpenAI 4xx/5xx + 错误体；传输层按状态级重试表恢复（429 / 406 / 502 总尝试 ≤10，500 / 503 / 504 / 407 总尝试 ≤3，其它 4xx/5xx 与裸网络错误不重试；共享单一预算 + 退避，见 §3.3 与 #51）。非流式聚合识别 HTTP 200 SSE 内嵌的 Busy（`ModelArts.81101`）/ 429 错误帧并按限流档在同一预算内重试；帧内其它错误、空响应与 180s 空闲超时直接上报不重试（#52）。401 刷新后的重发是独立凭证修复动作，不占瞬时重试预算但仍受取消约束。
- 取消传播（代理行为）：客户端中断入站请求时，代理中止该请求发起的 chat（流式与非流式），取消后不再重试、也不再发起新请求；中止 fetch 本身而非仅停止读取。取消不消耗重试预算，且优先于一切重试判断。密钥协商（全局缓存）、心跳、遥测、凭证保活与启动模型发现属后台主动调用，不跟随取消（#50）。
- `TM.00020005`（租户冻结）、`TM.00001054`（内容安全）→ 直接 4xx + 原文 error_msg

### 7.3.1 上游 usage 语义（OpenAI Chat 与 Anthropic 映射）

实测结论：CodeArts 上游 OpenAI Chat usage 的 `prompt_tokens` 为**总输入**，包含缓存命中分量；`prompt_tokens_details.cached_tokens` 为其中缓存读取部分。因此映射到 Anthropic Messages 时不能直接透传 `input_tokens`，须扣除缓存分项。

证据（四层请求记录，trace 记录 `2026-11-25T01:33:36.888Z`）：

| 层 | 字段 | 值 |
|---|---|---|
| L4（出站响应，翻译后） | `usage.input_tokens` | 127,983 |
| L4（出站响应，翻译后） | `usage.cache_read_input_tokens` | 127,232 |
| L4（出站响应，翻译后） | `usage.cache_creation_input_tokens` | 0 |
| L1（入站请求） | 请求体规模 | 约 467,744 字符 |

注：该结论来自 2026-11-25T01:33:36.888Z 的历史时点记录；当时上游原始响应（L3）为 SM4 加密的 SSE 原文，未直接读取，结论依据为 L4 出站响应（翻译后）加 L1 请求体规模（约 467,744 字符，按约 3.65 字符/token 折算约 128k tokens）。当前 CodeArts L3 默认记录解密后的明文，见 [ADR](../../../docs/design-docs/adr/codearts-l3-decrypted-plaintext.md)。

按约 3.65 字符/token 折算，L1 约 128k tokens，与 `input_tokens=127,983` 同量级；若 127,983 是未缓存输入，总输入将达 ~256k tokens，与请求体规模不符。故 127,983 是**总输入**而非未缓存输入，真实未缓存输入约 751（127,983 − 127,232）。

映射（能力位 `promptTokensIncludeCache=true`，见 `protocol-capabilities.ts`）：

```
input_tokens = max(0, prompt_tokens - cached_tokens - cache_creation_tokens)
```

- `cache_read_input_tokens` / `cache_creation_input_tokens` 继续透传上游值，缺失按 0；不推导、不伪造。
- 总输入由 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` 还原。
- 共享协议路由的默认能力位为 false，仅 CodeArts / CodeBuddy 显式开启（规格见产品规格 R37）。

### 7.4 启动与发现流程

1. 载入凭证（§1.1）
2. `GET /api/v1/gateway/config`（AKSK）→ endpoint + 模型池 → 暴露 `GET /v1/models`
3. 首个 chat 请求前：key-exchange 协商（§3.1），缓存 keyId/sessionKey（TTL-5min）
4. 会话首个请求：发 busy 心跳，起 30s 定时器；空闲/结束 → idle
5. （推荐）遥测仿真器启动：每 5s 聚合本进程 chat 请求 → OTLP logs/traces（带同 traceId）

### 7.5 拟真度检查单（防识别）

- [ ] UA = `opencode/{内核版本}` 且代理运行在 Bun 上（TLS 同源）
- [ ] ses_/msg_ ID 严格按 §4.1 算法（前缀+12hex 时间戳+14 随机）
- [ ] traceId 一轮内共享、span/snap 每请求刷新（§4.2 粒度不能错）
- [ ] user-session-id 恒等于顶层 ses_，子任务给 parent-session-id
- [ ] created-time 秒级 ISO-Z；X-Sdk-Date UTC 紧凑格式
- [ ] Authorization 用 signSimple 头集（content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token），UNSIGNED-PAYLOAD
- [ ] 密文体 base64(密文)（非 iv||ct||tag 拼接），iv/tag 走头
- [ ] SSE 解密 AAD=`{keyId}|{chunkIndex}` 从 0 计数
- [ ] 心跳 PUT + 30s busy 节奏 + idle 收尾
- [ ] OTLP 5s/30 条批量上报，与 chat 同 traceId（可选但强烈建议）
- [ ] client-ip = 本机局域网 IPv4
- [x] chat 不明文回退；按状态级重试表恢复（429 / 406 / 502 ≤10，500 / 503 / 504 / 407 ≤3，其它 4xx/5xx 与裸网络错误不重试，共享单一预算；有意偏差，见 §3.3 注）

---

## 8. 已知实现捷径与风险对照

| 捷径 | 收益 | 识别风险 |
|---|---|---|
| `CODEAGENT_IS_WEB_AGENT=true` 禁用加密 | 零加密实现 | 巨大：webagent 是另一类客户端画像，且头集中无 X-Encrypt-*；**不要用** |
| 明文回退（制造 key 协商失败） | 绕过 SM4 | 巨大：服务端若强制加密即失效；且"协商失败→明文"本身是可观测异常模式；**不要主动用** |
| 直连本地内核 Agent API（方案 A） | 零逆向 | 非 LLM 语义、依赖 app 存活；只适合脚本场景 |
| 本方案（协议直连 + 全头模拟） | 完整 LLM 能力 | 残余：TLS 指纹（Bun 方案可消）、遥测缺失（建议补）、行为节奏偏差（心跳/批量已给规格） |

## 9. 后续验证建议

1. 用 Bun 实现 §2/§3 最小签名+加密原型，先打 `key-exchange`（明文），再打一条最小 chat（`messages=[{role:"user",content:"hi"}]`，无 tools），对照本机日志头集逐项 diff。
2. 抓取真实客户端一次完整会话的云端行为（可用内核 DEBUG 日志：`PATCH /v1/config logLevel=DEBUG`），确认心跳/遥测节奏与本规格一致。
3. 模型池别名验证：`gateway/config` 返回的 `model_alias` 与 `model_id` 的映射关系，决定 `/v1/models` 暴露名。

> 本文档为纯技术还原记录，仅供安全研究与互操作分析；使用行为受账号协议约束，风险自担（用户已知悉）。
