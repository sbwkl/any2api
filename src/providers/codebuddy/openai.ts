// OpenAI 兼容门面 — /v1/models、/v1/chat/completions
// 内部 respond() 是跨协议（OpenAI Chat / Anthropic Messages / Responses）的共享管线。
import { newId, SessionRegistry } from "./ids";
import { buildHeaders, postChat, readUpstreamError, refreshAccessToken, fetchQueueStatus, sleep } from "./client";
import { buildAgentPrompt, resolveModel } from "./config";
import { buildRequestBody, mapTools, mergeAgentPrompt, normalizeMessages } from "./envelope";
import { aggregateSseToCompletion, normalizeChatSseUsage } from "../../shared/sse";
import { applyPromptCacheControl } from "../../shared/cache";
import { errorTypeForStatus } from "../../shared/errors";
import type { CredentialSource } from "./credentials";
import type { Credentials, ProductConfig, Profile } from "./types";

const PROFILES = new Set<Profile>(["chat", "ask", "craft"]);

function jsonError(status: number, message: string, code?: any): Response {
  return new Response(JSON.stringify({ error: { message, type: errorTypeForStatus(status), code: code ?? null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class CodeBuddyFacade {
  private sessions = new SessionRegistry();
  private source: CredentialSource;
  // 回源单飞：进行中的 reload 由并发请求共享，settle 后清空以便下次按需重新回源
  private reloadPromise: Promise<Credentials | null> | null = null;

  constructor(
    private config: ProductConfig,
    source: CredentialSource,
    private opts: { deviceToken?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.source = source;
  }

  // 当前凭证：按请求从凭证源读取；凭证未就绪时为 null。
  private currentCredentials(): Credentials | null {
    return this.source.get();
  }

  // 按需回源（单飞合并）：并发请求同时触发时共享同一次 reload()
  private reloadOnce(): Promise<Credentials | null> {
    if (!this.reloadPromise) {
      this.reloadPromise = this.source.reload().finally(() => {
        this.reloadPromise = null;
      });
    }
    return this.reloadPromise;
  }

  modelsPayload() {
    return {
      object: "list",
      data: this.config.models.map((m) => ({
        id: m.id,
        object: "model",
        created: 0,
        owned_by: "codebuddy",
        ...(m.contextLength ? { context_length: m.contextLength } : {}),
      })),
    };
  }

  healthPayload() {
    const credentials = this.currentCredentials();
    if (!credentials) {
      // 凭证未就绪：降级态而非服务故障，healthz 不抛错。
      return {
        ok: false,
        provider: "codebuddy",
        credentialsReady: false,
        models: this.config.models.length,
      };
    }
    return {
      ok: true,
      provider: "codebuddy",
      models: this.config.models.length,
      credentialSource: credentials.source,
      uid: `${credentials.uid.slice(0, 8)}...`,
    };
  }

  getCredentials(): Credentials | null {
    return this.currentCredentials();
  }

  async handleModels(): Promise<Response> {
    return Response.json(this.modelsPayload());
  }

  profileFor(req: Request): Profile {
    const raw = (req.headers.get("x-codebuddy-agent") || process.env.CODEBUDDY_AGENT || "chat").toLowerCase();
    return (PROFILES.has(raw as Profile) ? raw : "chat") as Profile;
  }

  async handleChat(req: Request): Promise<Response> {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return jsonError(400, "invalid JSON body");
    }
    if (!body || !Array.isArray(body.messages)) return jsonError(400, "messages is required");
    for (const m of body.messages) {
      if (!m || typeof m !== "object" || Array.isArray(m) || typeof m.role !== "string") {
        return jsonError(400, "invalid message");
      }
    }
    if (body.tools !== undefined && !Array.isArray(body.tools)) return jsonError(400, "tools must be an array");

    let messages: any[];
    try {
      messages = normalizeMessages(body.messages);
    } catch (e: any) {
      return jsonError(400, e?.message ?? "invalid messages");
    }

    const sessionKey = (
      req.headers.get("x-codebuddy-session") ||
      (typeof body.user === "string" ? body.user : "") ||
      "default"
    ).slice(0, 128);

    return this.respond(
      { ...body, messages },
      body.stream === true,
      sessionKey,
      this.profileFor(req),
    );
  }

  // 跨协议共享管线：body 为 OpenAI chat 形态；wantStream 决定响应格式（上游始终流式）。
  async respond(body: any, wantStream: boolean, sessionKey: string, profile: Profile): Promise<Response> {
    try {
      return await this.respondInner(body, wantStream, sessionKey, profile);
    } catch (e: any) {
      return jsonError(502, `upstream_error: ${e?.message ?? String(e)}`);
    }
  }

  private async respondInner(body: any, wantStream: boolean, sessionKey: string, profile: Profile): Promise<Response> {
    // 按需回源（惰性）：当前无凭证时先读一次凭证源再判定，登录后下一个请求即恢复、无需重启。
    let creds = this.currentCredentials();
    if (!creds) creds = await this.reloadOnce();
    if (!creds) return jsonError(401, "请登录 CodeBuddy CN", "credentials_not_ready");

    let messages: any[];
    try {
      messages = normalizeMessages(body.messages ?? []);
    } catch (e: any) {
      return jsonError(400, e?.message ?? "invalid messages");
    }
    const model = resolveModel(this.config.models, typeof body.model === "string" ? body.model : undefined);
    if (!model) {
      return jsonError(404, `model_not_found: ${typeof body.model === "string" && body.model ? body.model : "(missing)"}`, "model_not_found");
    }
    const conversationId = this.sessions.conversationFor(sessionKey);
    const { requestId } = this.sessions.requestIdFor(conversationId, messages);
    const messageId = newId();
    const traceId = newId();

    const agentPrompt = buildAgentPrompt(this.config, profile, model);
    const merged = mergeAgentPrompt(messages, agentPrompt);
    const cacheControlled = applyPromptCacheControl(merged);
    const tools = mapTools(body.tools);

    const requestBody = buildRequestBody({
      model,
      messages: cacheControlled,
      tools,
      toolChoice: body.tool_choice,
      maxTokens: typeof body.max_tokens === "number"
        ? body.max_tokens
        : typeof body.max_completion_tokens === "number"
          ? body.max_completion_tokens
          : undefined,
      temperature: typeof body.temperature === "number" ? body.temperature : undefined,
      topP: typeof body.top_p === "number" ? body.top_p : undefined,
      reasoningEffort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : undefined,
      frequencyPenalty: typeof body.frequency_penalty === "number" ? body.frequency_penalty : undefined,
      presencePenalty: typeof body.presence_penalty === "number" ? body.presence_penalty : undefined,
      stop: body.stop,
      seed: typeof body.seed === "number" ? body.seed : undefined,
      responseFormat: body.response_format,
      parallelToolCalls: typeof body.parallel_tool_calls === "boolean" ? body.parallel_tool_calls : undefined,
      streamOptions: body.stream_options,
      metadata: body.metadata,
      store: typeof body.store === "boolean" ? body.store : undefined,
      user: body.user,
      serviceTier: body.service_tier,
      maxCompletionTokens: typeof body.max_completion_tokens === "number" ? body.max_completion_tokens : undefined,
    });

    const makeHeaders = (creds: Credentials) => buildHeaders({
      credentials: creds,
      config: this.config,
      agentIntent: profile,
      modelId: model.id,
      conversationId,
      requestId,
      messageId,
      traceId,
      deviceToken: this.opts.deviceToken,
    });

    const url = `${this.config.endpoint}/v2/chat/completions`;
    // 本次发送所用凭证：401 后的内置刷新与回源判定都以它为基线，而非 401 时刻的源现值——
    // 并发交错下另一请求可能已采纳新凭证，若与源现值比对，会把「本次所用旧 token + 回源同一新 token」误判为无新凭证而放弃本可成功的重试。
    const sent = creds;
    // 内置刷新失败后经回源判定仍无新凭证（含磁盘无凭证）→ 401 终态指向「请登录 CodeBuddy CN」
    let reauthStale = false;
    const resp = await postChat({
      url,
      headers: makeHeaders(creds),
      body: requestBody,
      fetchImpl: this.opts.fetchImpl,
      onUnauthorized: process.env.CODEBUDDY_AUTO_REFRESH === "0"
        ? undefined
        : async () => {
          const next = await refreshAccessToken({
            config: this.config,
            credentials: sent,
            fetchImpl: this.opts.fetchImpl,
          });
          if (!next) {
            // 内置 refreshToken 刷新失败 → 按需回源：读到的 accessToken 或 uid 与本次发送所用凭证不同才算新凭证，重试一次（reload 内部已写回，无需再 adopt）
            const reloaded = await this.reloadOnce();
            if (reloaded && (reloaded.accessToken !== sent.accessToken || reloaded.uid !== sent.uid)) {
              return makeHeaders(reloaded);
            }
            reauthStale = true;
            return null;
          }
          this.source.adopt(next);
          return makeHeaders(next);
        },
      onQueue: async (peek) => {
        const creds = this.currentCredentials();
        if (!creds) return false;
        const timeout = Number(process.env.CODEBUDDY_QUEUE_TIMEOUT_MS ?? 120000);
        const retryAfterMs = Number(peek?.data?.retry_after ?? peek?.retry_after ?? 5) * 1000;
        const status = await fetchQueueStatus({
          config: this.config,
          credentials: creds,
          model: model.id,
          requestId,
          fetchImpl: this.opts.fetchImpl,
        });
        const waitMs = Math.min(status?.retryAfterMs ?? retryAfterMs, timeout);
        if (waitMs >= timeout) return false;
        await sleep(waitMs);
        return true;
      },
    });

    if (resp.ok && (resp.headers.get("content-type") ?? "").includes("application/json")) {
      const peek = await resp.clone().json().catch(() => null);
      if (peek?.code === 6020) return jsonError(429, "queue wait timeout", 6020);
      if (peek?.code === 6021) return jsonError(429, peek.msg ?? "queue full", 6021);
      if (peek?.code === 6022) return jsonError(429, peek.msg ?? "user limit", 6022);
      if (peek?.code === 14003) return jsonError(429, peek.msg ?? "model resource limit", 14003);
    }

    if (!resp.ok) {
      const err = await readUpstreamError(resp);
      if (resp.status === 401) {
        if (reauthStale) return jsonError(401, "请登录 CodeBuddy CN", "credentials_not_ready");
        return jsonError(401, `CodeBuddy 鉴权失败，请重新登录或更新凭证：${err.message}`, err.code);
      }
      if (resp.status === 429) return jsonError(429, err.message, err.code);
      if (resp.status >= 400 && resp.status < 500) return jsonError(resp.status, err.message, err.code);
      return jsonError(502, err.message, err.code);
    }

    if (wantStream) {
      return new Response(resp.body ? normalizeChatSseUsage(resp.body) : resp.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    if (!resp.body) return jsonError(502, "upstream returned an empty body");
    const completion = await aggregateSseToCompletion(resp.body);
    return new Response(JSON.stringify(completion), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
}