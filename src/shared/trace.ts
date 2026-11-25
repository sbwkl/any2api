// 可观测性：四层请求记录（schema 2）与上游请求转储（UPSTREAM_DUMP_DIR）。
// 两者均为 opt-in、默认关闭，且不得影响请求主路径。
//
// 一次入站请求对应一条 JSONL 记录：L1 入站请求、upstream[] 为请求上下文内
// 每次上游尝试的 L2 请求 + L3 原始响应、L4 出站响应。请求结束时一次性追加。
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REDACTED = "<redacted>";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-auth-token",
  "x-refresh-token",
  "x-security-token",
  "x-device-token",
  "x-user-id",
  "cookie",
  "set-cookie",
]);

/** 请求中断原因（schema 2 允许的取值） */
export type AbortReason = "client_disconnect" | "upstream_error" | "timeout" | "proxy_error";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** 一次上游调用的描述：L2 记录加密 / gzip 前的明文，发送用 wire body */
export interface UpstreamRequest {
  method: string;
  url: string;
  headers?: HeadersInit;
  /** 实际发送的请求体（gzip / 加密后的 wire body） */
  body?: BodyInit | null;
  /** 加密 / gzip 前的明文请求体；仅用于记录，缺省时按 body 推断 */
  recordBody?: unknown;
  signal?: AbortSignal;
}

export interface TraceUpstreamOptions {
  /** 可注入 fetch 以便单测；默认全局 fetch */
  fetch?: FetchLike;
}

export interface TraceOptions {
  dir?: string;
}

export interface RequestTrace {
  /** 标记中断原因；finish 时写入 complete:false + abort_reason */
  abort(reason: AbortReason): void;
  /** 请求结束：读取 L4、等待上游旁路读完，然后一次性追加记录 */
  finish(response: Response, durationMs?: number): Promise<void>;
}

/** 旧版采集接口（registry 过渡期兼容）；行为等价 startRequestTrace */
export interface TraceCapture {
  finish(res: Response, durationMs?: number): Promise<void>;
}

interface UpstreamAttemptRecord {
  t_ms: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  response: {
    status: number;
    headers: Record<string, string>;
    body: string;
    chunks: Array<{ t_ms: number; bytes: number }>;
    complete: boolean;
  };
}

interface InboundBody {
  request?: unknown;
  raw_request?: string;
}

interface TraceState {
  dir: string;
  startedAt: number;
  provider: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  upstream: UpstreamAttemptRecord[];
  requestBody: Promise<InboundBody>;
  pending: Set<Promise<unknown>>;
  abortReason: AbortReason | null;
  finished: boolean;
}

const traceStorage = new AsyncLocalStorage<TraceState | undefined>();

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function providerHint(path: string): "codearts" | "codebuddy" | "default" {
  if (path === "/codearts" || path.startsWith("/codearts/")) return "codearts";
  if (path === "/codebuddy" || path.startsWith("/codebuddy/")) return "codebuddy";
  return "default";
}

function headerEntries(input: HeadersInit): Array<[string, string]> {
  if (input instanceof Headers) return [...input.entries()];
  if (Array.isArray(input)) return input.map(([name, value]) => [String(name), String(value)]);
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(input)) out.push([name, String(value)]);
  return out;
}

/** L1–L4 头集合：全量保留头名与顺序，敏感值脱敏 */
function redactHeaders(input: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input) return out;
  for (const [name, value] of headerEntries(input)) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

function parseInboundBody(text: string): InboundBody {
  if (!text.trim()) return { request: {} };
  try {
    return { request: JSON.parse(text) };
  } catch {
    return { raw_request: text };
  }
}

function readInboundBody(req: Request): Promise<InboundBody> {
  let text: Promise<string>;
  try {
    text = req.clone().text();
  } catch {
    return Promise.resolve({ request: {} });
  }
  return text.then(parseInboundBody, () => ({ request: {} }));
}

function inferredRecordBody(body: BodyInit | null | undefined): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return null;
}

function createTraceState(req: Request, dir: string): TraceState {
  const path = new URL(req.url).pathname;
  return {
    dir,
    startedAt: Date.now(),
    provider: providerHint(path),
    method: req.method,
    path,
    headers: redactHeaders(req.headers),
    upstream: [],
    requestBody: readInboundBody(req),
    pending: new Set(),
    abortReason: null,
    finished: false,
  };
}

/** 首个可确定的中断原因获胜：后续标记不覆盖已记录原因 */
function markStateAbort(state: TraceState, reason: AbortReason): void {
  state.abortReason ??= reason;
}

/** 建立入站请求的异步上下文；开关关闭时返回 null 且不建立任何上下文 */
export function startRequestTrace(req: Request, opts: TraceOptions = {}): RequestTrace | null {
  const dir = opts.dir ?? process.env.TRACE_CAPTURE_DIR;
  if (!dir) return null;
  const state = createTraceState(req, dir);
  // enterWith：让同一请求异步链上的上游调用继承上下文，不要求调用方改造控制流。
  // 注意：enterWith 会改写当前异步链的 store，并发请求可能互相覆盖；挂载处理器请使用
  // runWithRequestTrace（run 语义，上下文按调用链隔离）。本入口仅保留向后兼容。
  traceStorage.enterWith(state);
  return {
    abort(reason) {
      markStateAbort(state, reason);
    },
    finish(response, durationMs) {
      return finishTrace(state, response, durationMs);
    },
  };
}

/** 标记当前请求上下文的中断原因；无上下文时 no-op */
export function markAbort(reason: AbortReason): void {
  const state = traceStorage.getStore();
  if (state) markStateAbort(state, reason);
}

/** 异常 → 中断原因：超时类异常（如 AbortSignal.timeout）记 timeout，其余代理内部异常记 proxy_error */
export function abortReasonForError(error: unknown): AbortReason {
  return (error as { name?: unknown } | null | undefined)?.name === "TimeoutError" ? "timeout" : "proxy_error";
}

const pendingFinishes = new Set<Promise<void>>();

/** 等待所有进行中的请求记录写完；采集本身不 await finish，测试 / 退出前用它对齐 */
export async function flushRequestTraces(): Promise<void> {
  while (pendingFinishes.size > 0) await Promise.allSettled([...pendingFinishes]);
}

/**
 * 挂载处理器入口：为一次入站请求建立独立的异步上下文（ALS.run 语义，按调用链隔离，
 * 并发请求互不串上下文），请求处理结束后组装 L4 并旁路写盘。
 * finish 不 await：采集不改变响应内容与延迟；客户端断开监听在 finish 后移除。
 */
export async function runWithRequestTrace(
  req: Request,
  fn: () => Response | Promise<Response>,
  opts: TraceOptions = {},
): Promise<Response> {
  const dir = opts.dir ?? process.env.TRACE_CAPTURE_DIR;
  if (!dir) return fn();
  const state = createTraceState(req, dir);
  const signal = req.signal;
  const onAbort = () => markStateAbort(state, "client_disconnect");
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort);
  }

  let response: Response;
  try {
    response = await traceStorage.run(state, fn);
  } catch (error) {
    markStateAbort(state, abortReasonForError(error));
    // 处理器抛出时 Bun 会返回 500；补一条带中断标记的记录后原样抛出。
    await finishTrace(state, new Response("", { status: 500 }));
    signal?.removeEventListener("abort", onAbort);
    throw error;
  }

  const done = finishTrace(state, response);
  pendingFinishes.add(done);
  // finish 结束（成功或失败）后移除断开监听，避免请求已结束仍持有引用
  const cleanup = () => {
    pendingFinishes.delete(done);
    signal?.removeEventListener("abort", onAbort);
  };
  void done.then(cleanup, cleanup);
  return response;
}

function requestInit(request: UpstreamRequest): RequestInit {
  const init: RequestInit = { method: request.method };
  if (request.headers) init.headers = request.headers;
  if (request.body !== undefined) init.body = request.body;
  if (request.signal) init.signal = request.signal;
  return init;
}

/**
 * 出站记录入口：包裹一次上游调用（一个尝试）。
 * 无请求上下文时完全 no-op，直接透传 fetch；有上下文时旁路读取响应，
 * 记录 L2 请求与 L3 原始响应，原 Response 立即返回给调用方。
 */
export function traceUpstream(request: UpstreamRequest, opts: TraceUpstreamOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetch ?? fetch;
  const state = traceStorage.getStore();
  if (!state) return fetchImpl(request.url, requestInit(request));
  return recordUpstreamAttempt(state, request, fetchImpl);
}

function recordUpstreamAttempt(
  state: TraceState,
  request: UpstreamRequest,
  fetchImpl: FetchLike,
): Promise<Response> {
  const attempt: UpstreamAttemptRecord = {
    t_ms: Math.round(Date.now() - state.startedAt),
    method: request.method,
    url: request.url,
    headers: redactHeaders(request.headers),
    body: request.recordBody !== undefined ? request.recordBody : inferredRecordBody(request.body),
    response: { status: 0, headers: {}, body: "", chunks: [], complete: false },
  };
  state.upstream.push(attempt);

  return fetchImpl(request.url, requestInit(request)).then(
    (response) => {
      attempt.response.status = response.status;
      // 响应头在被旁路消费前快照（修复 content_type 恒 null）
      attempt.response.headers = redactHeaders(response.headers);
      let clone: Response;
      try {
        clone = response.clone();
      } catch {
        attempt.response.complete = false;
        return response;
      }
      const drain = drainUpstream(state, attempt, clone).catch(() => {
        attempt.response.complete = false;
      });
      state.pending.add(drain);
      void drain.finally(() => state.pending.delete(drain));
      return response;
    },
    (error) => {
      attempt.response.complete = false;
      throw error;
    },
  );
}

async function drainUpstream(state: TraceState, attempt: UpstreamAttemptRecord, response: Response): Promise<void> {
  if (!response.body) {
    attempt.response.complete = true;
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      attempt.response.chunks.push({
        t_ms: Math.round(Date.now() - state.startedAt),
        bytes: value.byteLength,
      });
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    attempt.response.body = body;
    attempt.response.complete = true;
  } catch (error) {
    attempt.response.body = body;
    attempt.response.complete = false;
    throw error;
  }
}

async function finishTrace(state: TraceState, response: Response, durationMsOverride?: number): Promise<void> {
  if (state.finished) return;
  state.finished = true;
  try {
    // 先快照出站响应元数据，再消费 body。
    const status = response.status;
    const headers = redactHeaders(response.headers);
    const contentType = response.headers.get("content-type");

    let body = "";
    let firstByte: number | null = null;
    let complete = true;
    let clone: Response | null = null;
    try {
      clone = response.clone();
    } catch {
      complete = false;
    }
    if (clone?.body) {
      try {
        const reader = clone.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          if (firstByte === null) firstByte = Math.round(Date.now() - state.startedAt);
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } catch {
        // 出站流在转发中失败：能确定是上游流转发失败，标 upstream_error
        complete = false;
        markStateAbort(state, "upstream_error");
      }
    }

    // 等待上游旁路读完，保证 L3 完整；等待 L1 请求体解析完成。
    while (state.pending.size > 0) await Promise.allSettled([...state.pending]);
    const inbound = await state.requestBody;

    const abortReason = state.abortReason;
    if (abortReason) complete = false;
    const record = {
      schema: 2 as const,
      ts: new Date().toISOString(),
      provider: state.provider,
      method: state.method,
      path: state.path,
      headers: state.headers,
      ...inbound,
      upstream: state.upstream,
      response: {
        status,
        headers,
        content_type: contentType,
        body,
        first_byte_ms: firstByte,
        duration_ms: durationMsOverride ?? Math.round(Date.now() - state.startedAt),
        complete,
        abort_reason: abortReason,
      },
    };
    writeRecord(state.dir, record);
  } catch {
    // 采集不得影响请求主路径
  } finally {
    // 兼容旧 enterWith 入口：当前上下文仍是本请求时清除；run 语义下由 ALS 自动恢复
    if (traceStorage.getStore() === state) traceStorage.enterWith(undefined);
  }
}

function writeRecord(dir: string, record: unknown): void {
  try {
    const line = JSON.stringify(record);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `capture-${dayStamp()}.jsonl`), line + "\n", { mode: 0o600 });
  } catch {
    // 写入失败静默：观测不得影响主路径
  }
}

/** 上游请求转储（e2e 依赖，行为保持不变） */
export function dumpUpstream(provider: string, url: string, body: unknown, opts: { dir?: string } = {}): void {
  const dir = opts.dir ?? process.env.UPSTREAM_DUMP_DIR;
  if (!dir) return;
  let record: Record<string, unknown>;
  try {
    record = { ts: new Date().toISOString(), provider, url, body };
    JSON.stringify(record);
  } catch {
    record = { ts: new Date().toISOString(), provider, url, body: "<unserializable>" };
  }
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "upstream.jsonl"), JSON.stringify(record) + "\n");
  } catch {
    // 观测不得影响主路径
  }
}

/** 旧版采集入口：委托 schema 2 记录器，供 registry 过渡期使用 */
export function startTraceCapture(
  req: Request,
  opts: { dir?: string; /** @deprecated v2 不截断正文 */ maxBodyBytes?: number } = {},
): TraceCapture | null {
  const trace = startRequestTrace(req, { dir: opts.dir });
  if (!trace) return null;
  return {
    finish(res, durationMs) {
      return trace.finish(res, durationMs);
    },
  };
}
