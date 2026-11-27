// OpenAI 兼容门面 — spec §7：/v1/models + /v1/chat/completions（stream/non-stream）
import { networkInterfaces } from "os";
import { createId, uuid32, rand16hex } from "../../shared/ids";
import type { SnapClient } from "./snap";
import { HeartbeatManager } from "./snap";
import { signSl } from "./signer";
import { getCredentials } from "./config";
import { refreshNow } from "./refresher";
import type { GatewayConfig, ModelInfo } from "./config";
import type { TelemetrySimulator } from "./telemetry";
import { aggregateSseToCompletion, normalizeChatSseUsage, UpstreamSseError } from "../../shared/sse";
import { classifyUpstreamStatus, errorTypeForStatus, extractUpstreamErrorMessage, PROXY_ERROR_HEADER } from "../../shared/errors";
import { dumpUpstream, type FetchLike } from "../../shared/trace";
import { serviceLogger } from "../../shared/log";
import {
  clientAbortError,
  createRetryBudget,
  createRetryRuntime,
  planFrameRetry,
  retryClassForFrameError,
  waitForRetry,
  type RetryBudget,
  type RetryRuntime,
} from "./retry";

const CLIENT_TYPE = "IDE";
const CLIENT_VERSION = "26.11.200";
const PLUGIN_NAME = "codemate_vscode";
const IDE_NAME = "VSCode";
const OT_FUNCTION = "agent-claw";
const USER_AGENT = process.env.PROXY_USER_AGENT ?? "opencode/126.11.2-20261117200150";
const LANGUAGE = "en-us";
const IDLE_TO_IDLE_MS = 120000; // 无请求 2 分钟后发 idle 收尾

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

/** respond 的单 opts 形状：流式开关、会话 key 与入站取消信号，避免位置参数互换。 */
export interface RespondOptions {
  stream: boolean;
  sessionKey: string;
  signal?: AbortSignal;
}

/** 门面的可注入依赖：401 刷新动作与帧内重试时序（单测注入假实现，不触网、不真实等待）。 */
export interface OpenAIFacadeDeps {
  refresh?: (signal?: AbortSignal) => Promise<unknown>;
  retry?: Partial<RetryRuntime>;
}

export class OpenAIFacade {
  private sessions = new Map<string, SessionState>();
  private heartbeats: HeartbeatManager;
  private chatUrl: string;
  private refreshImpl: (signal?: AbortSignal) => Promise<unknown>;
  private retry: RetryRuntime;

  constructor(
    private snap: SnapClient,
    private gw: GatewayConfig,
    private telemetry: TelemetrySimulator,
    private fetchImpl: FetchLike = fetch,
    deps: OpenAIFacadeDeps = {},
  ) {
    this.heartbeats = new HeartbeatManager(new URL(this.chatOrigin()).origin, { fetch: this.fetchImpl });
    this.chatUrl = `${this.chatOrigin()}/api/v2/chat/completions`;
    this.refreshImpl = deps.refresh ?? ((signal) => refreshNow(this.fetchImpl, signal));
    this.retry = createRetryRuntime(deps.retry);
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

  private chatUpstream(
    headers: Record<string, string>,
    body: any,
    signal?: AbortSignal,
    budget?: RetryBudget,
    opts: { chargeBudget?: boolean } = {},
  ): Promise<Response> {
    dumpUpstream("codearts", this.chatUrl, body);
    return this.snap.chat(this.chatUrl, headers, body, { signal, budget, chargeBudget: opts.chargeBudget });
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
    // 客户端已断开：不解析请求体、不建立会话、不发上游请求。
    if (req.signal.aborted) return clientAbortResponse();
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages))
      return jsonError(400, "invalid_request: messages is required");
    const sessionKey =
      (req.headers.get("x-codearts-session") || (typeof body.user === "string" && body.user) || "default").slice(0, 128);
    return this.respond(body, { stream: body.stream === true, sessionKey, signal: req.signal });
  }

  // 内部统一管线（协议适配层复用）：body 为 OpenAI chat 形态。
  // opts.stream=true → 透传上游 SSE（OpenAI chunk）；false → 聚合为单个 chat.completion JSON。
  // opts.signal：入站请求的取消信号；一旦中止，立即停止本次请求发起的 chat 调用，且绝不重试。
  async respond(body: any, opts: RespondOptions): Promise<Response> {
    const { stream: wantStream, sessionKey, signal } = opts;
    if (signal?.aborted) return clientAbortResponse();
    if (!body || !Array.isArray(body.messages))
      return jsonError(400, "invalid_request: messages is required");
    // 一次入站请求一份总尝试预算：加密客户端的 HTTP 状态级重试与门面帧内重试共用，
    // 避免分层重试成倍放大最坏 POST 次数；401 刷新后的重发是独立凭证修复动作，不占此预算。
    const retryBudget = createRetryBudget();
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
    // 每个检查点都先看取消信号：取消优先于一切重试/刷新判断。
    const sendOnce = async (): Promise<Response> => {
      if (signal?.aborted) throw clientAbortError();
      const headers = signedHeaders();
      const startMs = Date.now();
      let resp: Response;
      try {
        resp = await this.chatUpstream(headers, mapped, signal, retryBudget);
      } catch (e: any) {
        if (signal?.aborted) throw clientAbortError();
        throw new Error(`upstream_error: ${e?.message ?? String(e)}`);
      }
      this.telemetry.recordChat({
        traceId, spanId, startMs, endMs: Date.now(), otFunction: OT_FUNCTION, modelId: model.modelId,
      });

      if (!resp.ok && resp.status === 401) {
        // 客户端已取消：不刷新凭证、不重发（刷新属于请求链内的凭证修复动作）。
        if (signal?.aborted) throw clientAbortError();
        // STS 过期/失效：尝试强制刷新后重试一次（请求链内刷新与重发均进入四层记录）
        const errText = await resp.text().catch(() => "");
        try {
          await this.refreshImpl(signal);
        } catch (e: any) {
          if (signal?.aborted) throw clientAbortError();
          const reason = extractUpstreamErrorMessage(errText) ?? `upstream 401, refresh failed: ${e?.message ?? e}`;
          return jsonError(401, reason);
        }
        if (signal?.aborted) throw clientAbortError();
        serviceLogger.log("[openai] 401 → STS 已刷新，重试一次");
        try {
          // 凭证修复动作不占瞬时重试预算：预算耗尽也照常重发，但仍然受取消信号约束。
          resp = await this.chatUpstream(signedHeaders(), mapped, signal, retryBudget, { chargeBudget: false });
        } catch (e: any) {
          if (signal?.aborted) throw clientAbortError();
          // 刷新成功但重发网络失败：交给上层按瞬时错误处理，不要伪装成 401。
          throw new Error(`upstream_error: ${e?.message ?? String(e)}`);
        }
      }
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        if (signal?.aborted) throw clientAbortError();
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
        if (signal?.aborted) return clientAbortResponse();
        const message = e?.message ?? String(e);
        return jsonError(classifyUpstreamStatus(message), message);
      }
      if (signal?.aborted) return clientAbortResponse();
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

    // 非流式：上游 SSE 聚合为单个 chat.completion JSON（服务端对 non-stream 请求也回 SSE）。
    // 重试边界收敛到「首字节前」，由共享预算统一裁决：
    // - HTTP 非 2xx 由加密客户端按状态档位重试，门面不再另起尝试循环；
    // - 帧内 Busy（ModelArts.81101）/ 限流码（`.429` 段、`APIG.0308`）按限流档重试；
    // - 帧内其它错误、空响应（NO_CHOICES）、空闲超时与裸网络错误直接上报，不重试。
    for (;;) {
      if (signal?.aborted) return clientAbortResponse();
      let resp: Response;
      try {
        resp = await sendOnce();
      } catch (e: any) {
        if (signal?.aborted) return clientAbortResponse();
        const message = e?.message ?? String(e);
        return jsonError(classifyUpstreamStatus(message), message);
      }
      if (!resp.ok) return resp;
      try {
        if (signal?.aborted) return clientAbortResponse();
        const ct = resp.headers.get("content-type") ?? "";
        // 上游对非 stream 请求也回 SSE：聚合为单个 completion JSON。
        if (ct.includes("text/event-stream")) {
          const completion = await aggregateSseToCompletion(resp.body!);
          return new Response(JSON.stringify(completion), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const text = await resp.text();
        return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
      } catch (e: any) {
        // 读取/聚合阶段被取消：不把 AbortError 当瞬时故障重试。
        if (signal?.aborted) return clientAbortResponse();
        const message = e?.message ?? String(e);
        const frame = e instanceof UpstreamSseError ? e.frame : null;
        const frameClass = retryClassForFrameError(frame);
        // 单一预算同时约束状态级与帧内重试：预算用尽时计划为 null，总尝试次数不会被两层放大。
        const plan = planFrameRetry({
          budget: retryBudget,
          frame,
          now: this.retry.now,
          random: this.retry.random,
        });
        if (!plan)
          return jsonError(frameClass ? 429 : classifyUpstreamStatus(message), message);
        try {
          await waitForRetry(plan, this.retry, signal, `code=${frame?.code ?? "unknown"}`);
        } catch {
          return clientAbortResponse();
        }
      }
    }
  }
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: errorTypeForStatus(status), code: null } }), {
    status,
    headers: { "Content-Type": "application/json", [PROXY_ERROR_HEADER]: "proxy" },
  });
}

/** 客户端取消是终止信号而不是上游故障：不重试、不刷新、不再发新请求。 */
function clientAbortResponse(): Response {
  return new Response(null, { status: 499 });
}