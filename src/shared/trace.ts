// 可观测性：入站流量采集（TRACE_CAPTURE_DIR）与上游请求转储（UPSTREAM_DUMP_DIR）。
// 两者均为 opt-in、默认关闭，且不得影响请求主路径。
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_MAX_BODY_BYTES = 256 * 1024;

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-security-token",
  "x-auth-token",
  "x-refresh-token",
  "cookie",
]);

const ALLOWED_HEADERS = new Set([
  "content-type",
  "user-agent",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "x-codebuddy-agent",
  "x-codebuddy-session",
  "x-codearts-session",
]);

export interface TraceCapture {
  finish(res: Response, durationMs: number): Promise<void>;
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function providerHint(path: string): "codearts" | "codebuddy" | "default" {
  if (path === "/codearts" || path.startsWith("/codearts/")) return "codearts";
  if (path === "/codebuddy" || path.startsWith("/codebuddy/")) return "codebuddy";
  return "default";
}

function sanitizeHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) out[lower] = "<redacted>";
    else if (ALLOWED_HEADERS.has(lower)) out[lower] = value;
  }
  return out;
}

function truncate(text: string, max: number): { body: string; body_truncated: boolean } {
  if (text.length <= max) return { body: text, body_truncated: false };
  return { body: text.slice(0, max), body_truncated: true };
}

async function readCapped(res: Response, max: number): Promise<{ body: string; body_truncated: boolean }> {
  if (!res.body) return { body: "", body_truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      body += decoder.decode(value, { stream: true });
      if (body.length > max) {
        body = body.slice(0, max);
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
    if (!truncated) body += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  if (body.length > max) {
    body = body.slice(0, max);
    truncated = true;
  }
  return { body, body_truncated: truncated };
}

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

export function startTraceCapture(
  req: Request,
  opts: { dir?: string; maxBodyBytes?: number } = {},
): TraceCapture | null {
  const dir = opts.dir ?? process.env.TRACE_CAPTURE_DIR;
  if (!dir) return null;
  const max = opts.maxBodyBytes ?? Number(process.env.TRACE_CAPTURE_MAX_BYTES ?? DEFAULT_MAX_BODY_BYTES);
  const started = Date.now();
  const path = new URL(req.url).pathname;
  const method = req.method;
  const headers = sanitizeHeaders(req.headers);
  const requestBody = req.clone().text().catch(() => "");
  const provider = providerHint(path);

  return {
    async finish(res, durationMs = Date.now() - started) {
      let clone: Response | null = null;
      try {
        clone = res.clone();
      } catch {
        clone = null;
      }
      const responseBody = clone
        ? await readCapped(clone, max).catch(() => ({ body: "", body_truncated: false }))
        : { body: "", body_truncated: false };
      const record = {
        ts: new Date().toISOString(),
        method,
        path,
        provider,
        status: res.status,
        duration_ms: durationMs,
        request: { headers, ...truncate(await requestBody, max) },
        response: {
          content_type: res.headers.get("content-type"),
          ...responseBody,
        },
      };
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, `capture-${dayStamp()}.jsonl`), JSON.stringify(record) + "\n");
      } catch {
        // 观测不得影响主路径
      }
    },
  };
}
