// 传输层：头集合、gzip、401 刷新重试 — 对应 RFC-0001 §5.2/§5.7/§5.9
import { gzipSync } from "node:zlib";
import { dumpUpstream, traceUpstream } from "../../shared/trace";
import type { Credentials, ProductConfig } from "./types";

export interface HeaderContext {
  credentials: Credentials;
  config: ProductConfig;
  agentIntent: string;
  modelId: string;
  conversationId: string;
  requestId: string;
  messageId: string;
  traceId: string;
  deviceToken?: string;
}

const IDE_VERSION = process.env.CODEBUDDY_IDE_VERSION ?? "1.106.1";
const IDE_TYPE = process.env.CODEBUDDY_IDE_TYPE ?? "CodeBuddyIDE";
const ENV_ID = process.env.CODEBUDDY_ENV_ID ?? "production";

export function buildHeaders(ctx: HeaderContext): Record<string, string> {
  const version = ctx.config.version || "3.10.0";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "Authorization": `Bearer ${ctx.credentials.accessToken}`,
    "X-User-Id": ctx.credentials.uid,
    "X-Product": ctx.config.deploymentType || "SaaS",
    "X-Env-ID": ENV_ID,
    "X-IDE-Type": IDE_TYPE,
    "X-IDE-Name": ctx.config.platform || "CodeBuddyIDE",
    "X-IDE-Version": IDE_VERSION,
    "X-Product-Version": version,
    "User-Agent": `CodeBuddy/${version}`,
    "X-Trace-ID": ctx.traceId,
    "X-Request-ID": ctx.requestId,
    "X-Conversation-ID": ctx.conversationId,
    "X-Conversation-Request-ID": ctx.requestId,
    "X-Conversation-Message-ID": ctx.messageId,
    "X-Agent-Intent": ctx.agentIntent,
    "X-Model-ID": ctx.modelId,
  };
  if (ctx.credentials.domain) headers["X-Domain"] = ctx.credentials.domain;
  if (ctx.deviceToken) headers["X-Device-Token"] = ctx.deviceToken;
  return headers;
}

export function gzipBody(body: any): Uint8Array {
  return gzipSync(JSON.stringify(body));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 排队状态：POST /v2/chat/queue/status（model + X-Conversation-Request-ID）
export async function fetchQueueStatus(opts: {
  config: ProductConfig;
  credentials: Credentials;
  model: string;
  requestId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ retryAfterMs: number; queuePosition?: number; queueSize?: number } | null> {
  const version = opts.config.version || "3.10.0";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${opts.credentials.accessToken}`,
    "X-User-Id": opts.credentials.uid,
    "X-Product": opts.config.deploymentType || "SaaS",
    "X-Product-Version": version,
    "User-Agent": `CodeBuddy/${version}`,
    "X-Conversation-Request-ID": opts.requestId,
  };
  if (opts.credentials.domain) headers["X-Domain"] = opts.credentials.domain;
  const body = { model: opts.model };
  const resp = await traceUpstream(
    {
      method: "POST",
      url: `${opts.config.endpoint}/v2/chat/queue/status`,
      headers,
      body: JSON.stringify(body),
      recordBody: body,
    },
    { fetch: opts.fetchImpl ?? fetch },
  );
  if (!resp.ok) {
    await resp.text().catch(() => {});
    return null;
  }
  const json: any = await resp.json().catch(() => null);
  const data = json?.data ?? {};
  const retryAfter = Number(data.retry_after ?? data.retryAfter ?? json?.retry_after ?? 5);
  return {
    retryAfterMs: Math.max(0, retryAfter * 1000),
    queuePosition: data.queue_position,
    queueSize: data.queue_size,
  };
}

export async function postChat(opts: {
  url: string;
  headers: Record<string, string>;
  body: any;
  fetchImpl?: typeof fetch;
  onUnauthorized?: () => Promise<Record<string, string> | null>;
  /** 收到 6020 排队中时调用；返回 true 表示已等待并允许重试一次 */
  onQueue?: (peek: any) => Promise<boolean>;
}): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  dumpUpstream("codebuddy", opts.url, opts.body);
  const payload = gzipBody(opts.body);
  // 每次实际发送是一次独立尝试；L2 body 记 gzip 前明文，wire body 仍是 gzip。
  let headers = { ...opts.headers, "Content-Encoding": "gzip" };
  let resp = await traceUpstream(
    { method: "POST", url: opts.url, headers, body: payload, recordBody: opts.body },
    { fetch: fetchImpl },
  );
  if (resp.status === 401 && opts.onUnauthorized) {
    const refreshed = await opts.onUnauthorized();
    if (refreshed) {
      headers = { ...refreshed, "Content-Encoding": "gzip" };
      resp = await traceUpstream(
        { method: "POST", url: opts.url, headers, body: payload, recordBody: opts.body },
        { fetch: fetchImpl },
      );
    }
  }
  if (opts.onQueue && resp.ok) {
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const peek = await resp.clone().json().catch(() => null);
      if (peek?.code === 6020) {
        const retry = await opts.onQueue(peek);
        if (retry) {
          resp = await traceUpstream(
            { method: "POST", url: opts.url, headers, body: payload, recordBody: opts.body },
            { fetch: fetchImpl },
          );
        }
      }
    }
  }
  return resp;
}

// POST /v2/plugin/auth/token/refresh（RFC-0001 §5.7）
export async function refreshAccessToken(opts: {
  config: ProductConfig;
  credentials: Credentials;
  fetchImpl?: typeof fetch;
}): Promise<Credentials | null> {
  if (!opts.credentials.refreshToken) return null;
  const url = `${opts.config.endpoint}/v2/plugin/auth/token/refresh`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Refresh-Token": opts.credentials.refreshToken,
    "X-Auth-Refresh-Source": "plugin",
    "X-User-Id": opts.credentials.uid,
    "X-Product": opts.config.deploymentType || "SaaS",
    "X-Product-Version": opts.config.version || "3.10.0",
    "User-Agent": `CodeBuddy/${opts.config.version || "3.10.0"}`,
  };
  if (opts.credentials.domain) headers["X-Domain"] = opts.credentials.domain;
  try {
    const resp = await traceUpstream(
      { method: "POST", url, headers, body: "{}", recordBody: {} },
      { fetch: opts.fetchImpl ?? fetch },
    );
    if (!resp.ok) return null;
    const json: any = await resp.json();
    const data = json?.data;
    if (!data?.accessToken) return null;
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? opts.credentials.refreshToken,
      uid: data.uid ?? opts.credentials.uid,
      domain: data.domain ?? opts.credentials.domain,
      expiresAt: data.expiresAt,
      source: opts.credentials.source,
    };
  } catch {
    return null;
  }
}

export interface UpstreamError {
  status: number;
  message: string;
  code?: number;
}

export async function readUpstreamError(resp: Response): Promise<UpstreamError> {
  let body: any = null;
  try {
    const text = await resp.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 500) };
    }
  } catch {
    // ignore
  }
  const message = body?.displayMsg?.en ?? body?.msg ?? body?.message ?? `upstream ${resp.status}`;
  return { status: resp.status, message, code: body?.code ?? body?.error?.code };
}