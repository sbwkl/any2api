// OpenAI 兼容门面 — spec §7：/v1/models + /v1/chat/completions（stream/non-stream）
import { networkInterfaces } from "os";
import { createId, uuid32, rand16hex } from "../../shared/ids";
import type { SnapClient } from "./snap";
import { HeartbeatManager } from "./snap";
import { signSl } from "./signer";
import { getCredentials } from "./config";
import { refreshNow } from "./refresher";
import type { GatewayConfig, ModelInfo, Credentials } from "./config";
import type { TelemetrySimulator } from "./telemetry";
import { aggregateSseToCompletion, normalizeChatSseUsage, NO_CHOICES } from "../../shared/sse";
import { classifyUpstreamStatus, errorTypeForStatus, extractUpstreamErrorMessage, PROXY_ERROR_HEADER } from "../../shared/errors";
import { dumpUpstream, type FetchLike } from "../../shared/trace";

const CLIENT_TYPE = "IDE";
const CLIENT_VERSION = "26.11.200";
const PLUGIN_NAME = "codemate_vscode";
const IDE_NAME = "VSCode";
const OT_FUNCTION = "agent-claw";
const USER_AGENT = process.env.PROXY_USER_AGENT ?? "opencode/126.11.2-20261117200150";
const LANGUAGE = "en-us";
const IDLE_TO_IDLE_MS = 120000; // 无请求 2 分钟后发 idle 收尾
// 非流式聚合在尚未向客户端发出任何字节前，瞬时网络错误重试一次。
const NON_STREAM_ATTEMPTS = 2;

function clientIp(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) return ni.address;
    }
  }
  return "127.0.0.1";
}

const CLIENT_IP = clientIp();

function secIsoZ(d = new Date()): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface SessionState { id: string; firstRequestDone: boolean; lastActivity: number }

/** 上游错误消息是否值得重试：连接类/超时类/空流。参数错、限流、鉴权不重试。 */
function isTransientFailure(message: string): boolean {
  if (/ECONNRESET|socket connection was closed|ECONNREFUSED|EPIPE|network|timeout|timed out|ETIMEDOUT/i.test(message))
    return true;
  // 空流没有上游错误细节：可能是一次即时抖动，重试一次安全。
  return message === NO_CHOICES;
}

export class OpenAIFacade {
  private sessions = new Map<string, SessionState>();
  private heartbeats: HeartbeatManager;
  private chatUrl: string;

  constructor(
    private snap: SnapClient,
    private gw: GatewayConfig,
    private telemetry: TelemetrySimulator,
    private fetchImpl: FetchLike = fetch,
  ) {
    this.heartbeats = new HeartbeatManager(new URL(this.chatOrigin()).origin, { fetch: this.fetchImpl });
    this.chatUrl = `${this.chatOrigin()}/api/v2/chat/completions`;
    // 会话空闲清理：发 idle 心跳收尾
    setInterval(() => {
      const now = Date.now();
      for (const [key, s] of this.sessions) {
        if (now - s.lastActivity > IDLE_TO_IDLE_MS) {
          this.heartbeats.stopBusy(s.id);
          this.sessions.delete(key);
        }
      }
    }, 30000).unref?.();
  }

  private chatOrigin(): string {
    return getCredentials().origin ?? process.env.SNAP_ORIGIN ?? "https://snap-access.cn-north-4.myhuaweicloud.com";
  }

  private chatUpstream(headers: Record<string, string>, body: any): Promise<Response> {
    dumpUpstream("codearts", this.chatUrl, body);
    return this.snap.chat(this.chatUrl, headers, body);
  }

  modelsPayload(): any {
    return {
      object: "list",
      data: this.gw.models.map((m) => ({
        id: m.modelId, object: "model", created: 0, owned_by: "codearts",
        // OpenRouter 风格上下文长度（policy/bundle input_length），Codex 模型目录直接可用
        ...(m.inputLength ? { context_length: m.inputLength } : {}),
      })),
    };
  }

  private resolveModel(name: string | undefined): ModelInfo | null {
    const models = this.gw.models;
    if (!name) return models[0];
    const lower = name.toLowerCase();
    return (
      models.find((m) => m.modelId.toLowerCase() === lower) ??
      models.find((m) => m.modelName.toLowerCase() === lower) ??
      models.find((m) => m.modelId.toLowerCase().includes(lower) || lower.includes(m.modelId.toLowerCase())) ??
      null
    );
  }

  private sessionFor(key: string): SessionState {
    let s = this.sessions.get(key);
    if (!s) {
      s = { id: createId("session"), firstRequestDone: false, lastActivity: Date.now() };
      this.sessions.set(key, s);
    }
    s.lastActivity = Date.now();
    return s;
  }

  private mapBody(body: any, model: ModelInfo): any {
    // role 归一化：developer ≡ system（OpenAI 新命名）；上游仅认 system/user/assistant/tool
    const messages = (body.messages ?? []).map((m: any) =>
      m?.role === "developer" ? { ...m, role: "system" } : m,
    );
    const out: any = {
      model: model.modelId,
      messages,
    };
    if (body.stream === true) {
      out.stream = true;
      out.stream_options = { include_usage: true }; // 内核固定加
    }
    for (const k of ["tools", "tool_choice", "temperature", "top_p", "max_tokens", "stop", "seed", "reasoning_effort"] as const) {
      if (body[k] !== undefined) out[k] = body[k];
    }
    return out;
  }

  async handleChat(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages))
      return jsonError(400, "invalid_request: messages is required");
    const sessionKey =
      (req.headers.get("x-codearts-session") || (typeof body.user === "string" && body.user) || "default").slice(0, 128);
    return this.respond(body, body.stream === true, sessionKey);
  }

  // 内部统一管线（协议适配层复用）：body 为 OpenAI chat 形态。
  // wantStream=true → 透传上游 SSE（OpenAI chunk）；false → 聚合为单个 chat.completion JSON。
  async respond(body: any, wantStream: boolean, sessionKey: string): Promise<Response> {
    if (!body || !Array.isArray(body.messages))
      return jsonError(400, "invalid_request: messages is required");
    const model = this.resolveModel(body.model);
    // 未知模型必须显式 4xx：静默回退 models[0] 会让客户端以为在用 A 实际在用 B。
    if (!model) return jsonError(404, `model_not_found: ${String(body.model)}`);
    const session = this.sessionFor(sessionKey);

    // 一轮 = 一次用户消息：新 traceId + msg_；会话内复用 ses_
    const traceId = uuid32();
    const msgId = createId("message");
    const spanId = rand16hex();
    const snapTraceId = `${traceId}_${rand16hex()}`;

    const baseHeaders: Record<string, string> = {
      "x-ot-trace-id": traceId,
      "x-ot-span-id": spanId,
      "x-snap-traceid": snapTraceId,
      "x-ot-session-id": session.id,
      "x-ot-parent-session-id": "",
      "user-session-id": session.id,
      "x-ot-function": OT_FUNCTION,
      "X-Language": LANGUAGE,
      "user-msg-id": msgId,
      "created-time": secIsoZ(),
      "model-id": model.modelId,
      "model-name": encodeURIComponent(model.modelName),
      "x-ot-client-type": CLIENT_TYPE,
      "x-ot-client-version": CLIENT_VERSION,
      "plugin-name": PLUGIN_NAME,
      "plugin-version": CLIENT_VERSION,
      "ide-name": IDE_NAME,
      "ide-version": CLIENT_VERSION,
      "client-ip": CLIENT_IP,
      "User-Agent": USER_AGENT,
      "X-Security-token": getCredentials().securityToken, // spec §0 provider 层含此头（sl.sign 签名集内）
      "x-session-affinity": session.id,       // 不签名
      "x-message-id": msgId,                  // 不签名
      "X-Encrypt-Capable": "sm4-gcm",         // 不签名
    };
    if (!session.firstRequestDone) {
      baseHeaders["x-session-user-message"] = "true"; // 仅首轮
      session.firstRequestDone = true;
    }
    // 心跳：会话首个请求 → busy + 30s 定时
    this.heartbeats.startBusy(session.id);

    const mapped = this.mapBody(body, model);
    // 上游统一走流式（真实内核形态）；非流式客户端请求由代理聚合为单个 completion JSON
    if (wantStream !== true) {
      mapped.stream = true;
      mapped.stream_options = { include_usage: true };
    }

    // 每次尝试都重签：created-time / X-Sdk-Date / Authorization 随时间失效。
    const signedHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = { ...baseHeaders, "created-time": secIsoZ() };
      // provider 层 sl.sign（真实内核语义：payloadHash=sha256(JSON.stringify(body))，content-type 不参与签名）
      // 加密路径会被 signSimple 覆盖；显式明文调试路径依赖此签名
      const signed = signSl(
        { method: "POST", endpoint: this.chatUrl, data: mapped, headers: { ...headers } },
        getCredentials(),
      );
      return Object.assign(headers, signed);
    };

    // 单次上游发送 + 401 刷新重试；非 2xx 统一转成协议层可归一的代理错误信封。
    const sendOnce = async (): Promise<Response> => {
      const headers = signedHeaders();
      const startMs = Date.now();
      let resp: Response;
      try {
        resp = await this.chatUpstream(headers, mapped);
      } catch (e: any) {
        throw new Error(`upstream_error: ${e?.message ?? String(e)}`);
      }
      this.telemetry.recordChat({
        traceId, spanId, startMs, endMs: Date.now(), otFunction: OT_FUNCTION, modelId: model.modelId,
      });

      if (!resp.ok && resp.status === 401) {
        // STS 过期/失效：尝试强制刷新后重试一次（请求链内刷新与重发均进入四层记录）
        const errText = await resp.text().catch(() => "");
        try {
          await refreshNow(this.fetchImpl);
        } catch (e: any) {
          const reason = extractUpstreamErrorMessage(errText) ?? `upstream 401, refresh failed: ${e?.message ?? e}`;
          return jsonError(401, reason);
        }
        console.log("[openai] 401 → STS 已刷新，重试一次");
        try {
          resp = await this.chatUpstream(signedHeaders(), mapped);
        } catch (e: any) {
          // 刷新成功但重发网络失败：交给上层按瞬时错误处理，不要伪装成 401。
          throw new Error(`upstream_error: ${e?.message ?? String(e)}`);
        }
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        const message = extractUpstreamErrorMessage(text) ?? `upstream ${resp.status}`;
        return jsonError(resp.status, message);
      }
      return resp;
    };

    if (wantStream === true) {
      let resp: Response;
      try {
        resp = await sendOnce();
      } catch (e: any) {
        const message = e?.message ?? String(e);
        return jsonError(classifyUpstreamStatus(message), message);
      }
      if (!resp.ok) return resp; // 已是代理错误信封
      return new Response(resp.body ? normalizeChatSseUsage(resp.body) : resp.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // 非流式：上游 SSE 聚合为单个 chat.completion JSON（服务端对非 stream 请求也回 SSE）。
    // 聚合期间失败时客户端尚未收到任何字节，瞬时错误可安全重试一次。
    let lastMessage = "upstream error";
    let lastStatus = 502;
    for (let attempt = 1; attempt <= NON_STREAM_ATTEMPTS; attempt++) {
      try {
        const resp = await sendOnce();
        if (!resp.ok) return resp;
        const ct = resp.headers.get("content-type") ?? "";
        // 上游对非 stream 请求也回 SSE：聚合为单个 completion JSON。
        if (ct.includes("text/event-stream")) {
          const completion = await aggregateSseToCompletion(resp.body!);
          return new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const text = await resp.text();
        return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (e: any) {
        lastMessage = e?.message ?? String(e);
        lastStatus = classifyUpstreamStatus(lastMessage);
        if (attempt < NON_STREAM_ATTEMPTS && isTransientFailure(lastMessage)) continue;
        break;
      }
    }
    return jsonError(lastStatus, lastMessage);
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: errorTypeForStatus(status), code: null } }), {
    status,
    headers: { "Content-Type": "application/json", [PROXY_ERROR_HEADER]: "proxy" },
  });
}