// OpenAI 兼容门面 — /v1/models、/v1/chat/completions
// 内部 respond() 是跨协议（OpenAI Chat / Anthropic Messages / Responses）的共享管线。
import { newId, SessionRegistry } from "./ids";
import { buildHeaders, postChat, readUpstreamError, refreshAccessToken, fetchQueueStatus, sleep } from "./client";
import { buildAgentPrompt, resolveModel } from "./config";
import { buildRequestBody, mapTools, mergeAgentPrompt, normalizeMessages } from "./envelope";
import { aggregateSseToCompletion } from "../../shared/sse";
import type { Credentials, ProductConfig, Profile } from "./types";

const PROFILES = new Set<Profile>(["chat", "ask", "craft"]);

function jsonError(status: number, message: string, code?: any): Response {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code: code ?? null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class CodeBuddyFacade {
  private sessions = new SessionRegistry();
  private credentials: Credentials;

  constructor(
    private config: ProductConfig,
    credentials: Credentials,
    private opts: { deviceToken?: string; fetchImpl?: typeof fetch } = {},
  ) {
    this.credentials = credentials;
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
    return {
      ok: true,
      provider: "codebuddy",
      models: this.config.models.length,
      credentialSource: this.credentials.source,
      uid: `${this.credentials.uid.slice(0, 8)}...`,
    };
  }

  getCredentials(): Credentials {
    return this.credentials;
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
    let messages: any[];
    try {
      messages = normalizeMessages(body.messages ?? []);
    } catch (e: any) {
      return jsonError(400, e?.message ?? "invalid messages");
    }
    const model = resolveModel(this.config.models, typeof body.model === "string" ? body.model : undefined);
    const conversationId = this.sessions.conversationFor(sessionKey);
    const { requestId } = this.sessions.requestIdFor(conversationId, messages);
    const messageId = newId();
    const traceId = newId();

    const agentPrompt = buildAgentPrompt(this.config, profile, model);
    const merged = mergeAgentPrompt(messages, agentPrompt);
    const tools = mapTools(body.tools);

    const requestBody = buildRequestBody({
      model,
      messages: merged,
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
    const resp = await postChat({
      url,
      headers: makeHeaders(this.credentials),
      body: requestBody,
      fetchImpl: this.opts.fetchImpl,
      onUnauthorized: process.env.CODEBUDDY_AUTO_REFRESH === "0"
        ? undefined
        : async () => {
          const next = await refreshAccessToken({
            config: this.config,
            credentials: this.credentials,
            fetchImpl: this.opts.fetchImpl,
          });
          if (!next) return null;
          this.credentials = next;
          return makeHeaders(next);
        },
      onQueue: async (peek) => {
        const timeout = Number(process.env.CODEBUDDY_QUEUE_TIMEOUT_MS ?? 120000);
        const retryAfterMs = Number(peek?.data?.retry_after ?? peek?.retry_after ?? 5) * 1000;
        const status = await fetchQueueStatus({
          config: this.config,
          credentials: this.credentials,
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
        return jsonError(401, `CodeBuddy 鉴权失败，请重新登录或更新凭证：${err.message}`, err.code);
      }
      if (resp.status === 429) return jsonError(429, err.message, err.code);
      if (resp.status >= 400 && resp.status < 500) return jsonError(resp.status, err.message, err.code);
      return jsonError(502, err.message, err.code);
    }

    if (wantStream) {
      return new Response(resp.body, {
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