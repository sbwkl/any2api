// 出站调用四层记录：codebuddy client / msgcenter 的 L2+L3 记录契约。
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { startRequestTrace, type RequestTrace } from "../../shared/trace";
import { fetchQueueStatus, postChat, refreshAccessToken } from "./client";
import { MsgCenterPoller } from "./msgcenter";
import type { Credentials, ProductConfig } from "./types";

const config: ProductConfig = {
  endpoint: "https://example.test",
  productName: "CodeBuddy",
  platform: "CodeBuddyIDE",
  deploymentType: "SaaS",
  version: "3.10.0",
  models: [],
  agents: [],
  prompts: [],
};

const credentials: Credentials = {
  accessToken: "tok",
  refreshToken: "ref",
  uid: "u1",
  domain: "www.codebuddy.cn",
  source: "env",
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "any2api-codebuddy-trace-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TRACE_CAPTURE_DIR;
});

function captureFile(): string {
  return join(dir, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function readRecords(): any[] {
  const file = captureFile();
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function traceRequest(): RequestTrace {
  const req = new Request("http://localhost/codebuddy/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  return startRequestTrace(req, { dir })!;
}

describe("postChat trace records", () => {
  test("records the 401 attempt, then the retried attempt with replaced headers", async () => {
    const requestBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const wire: Array<{ encoding: string | null; body: string }> = [];
    let calls = 0;
    const sseText = 'data: {"id":"1"}\n\ndata: [DONE]\n\n';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      calls++;
      const headers = new Headers(init?.headers);
      wire.push({
        encoding: headers.get("content-encoding"),
        body: gunzipSync(Buffer.from(init!.body as Uint8Array)).toString("utf8"),
      });
      if (calls === 1) {
        return new Response(JSON.stringify({ code: 401, msg: "expired" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Set-Cookie": "session=secret" },
        });
      }
      return new Response(sseText, {
        status: 200,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      });
    }) as unknown as typeof fetch;

    const trace = traceRequest();
    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: { Authorization: "Bearer old", "X-Request-ID": "r1", "Content-Type": "application/json" },
      body: requestBody,
      fetchImpl,
      onUnauthorized: async () => ({ Authorization: "Bearer new", "X-Device-Token": "dev-secret" }),
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(sseText);
    await trace.finish(Response.json({ ok: true }));

    const rec = readRecords()[0];
    expect(rec.schema).toBe(2);
    expect(rec.provider).toBe("codebuddy");
    expect(rec.upstream).toHaveLength(2);

    // wire body 仍是 gzip，记录的是压缩前明文对象
    expect(wire.map((w) => w.encoding)).toEqual(["gzip", "gzip"]);
    expect(wire.map((w) => JSON.parse(w.body))).toEqual([requestBody, requestBody]);

    const [first, second] = rec.upstream;
    expect(first.method).toBe("POST");
    expect(first.url).toBe("https://example.test/v2/chat/completions");
    expect(first.body).toEqual(requestBody);
    expect(second.body).toEqual(requestBody);

    // 每次尝试记录该次实际发送的头；401 后是刷新返回的整组头
    expect(first.headers["Authorization"]).toBe("<redacted>");
    expect(first.headers["X-Request-ID"]).toBe("r1");
    expect(first.headers["Content-Encoding"]).toBe("gzip");
    expect(second.headers["Authorization"]).toBe("<redacted>");
    expect(second.headers["X-Device-Token"]).toBe("<redacted>");
    expect(second.headers["X-Request-ID"]).toBeUndefined();

    // L3 原始文本完整、响应头脱敏、chunk 有到达时间与字节数
    expect(first.response.status).toBe(401);
    expect(first.response.headers["set-cookie"]).toBe("<redacted>");
    expect(first.response.body).toBe('{"code":401,"msg":"expired"}');
    expect(second.response.status).toBe(200);
    expect(second.response.body).toBe(sseText);
    expect(first.response.complete).toBe(true);
    expect(second.response.complete).toBe(true);
    expect(first.response.chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of [...first.response.chunks, ...second.response.chunks]) {
      expect(typeof chunk.t_ms).toBe("number");
      expect(typeof chunk.bytes).toBe("number");
    }
    expect(first.t_ms).toBeLessThanOrEqual(second.t_ms);
  });

  test("records queue status and the 6020 retry as ordered attempts", async () => {
    const trace = traceRequest();
    const visited: string[] = [];
    let chatCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      visited.push(String(url));
      if (String(url).endsWith("/v2/chat/queue/status")) {
        return Response.json({ data: { retry_after: 0, queue_position: 1, queue_size: 4 } });
      }
      chatCalls++;
      if (chatCalls === 1) return Response.json({ code: 6020, data: { retry_after: 0 } });
      return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: { Authorization: "Bearer tok" },
      body: { model: "m" },
      fetchImpl,
      onQueue: async () => {
        const status = await fetchQueueStatus({ config, credentials, model: "m", requestId: "r1", fetchImpl });
        return status !== null;
      },
    });
    expect(resp.status).toBe(200);
    await trace.finish(Response.json({ ok: true }));

    expect(visited).toEqual([
      "https://example.test/v2/chat/completions",
      "https://example.test/v2/chat/queue/status",
      "https://example.test/v2/chat/completions",
    ]);
    const upstream = readRecords()[0].upstream;
    expect(upstream.map((u: any) => u.url)).toEqual(visited);
    expect(upstream[0].response.body).toBe('{"code":6020,"data":{"retry_after":0}}');
    expect(upstream[1].body).toEqual({ model: "m" });
    expect(upstream[1].response.body).toBe('{"data":{"retry_after":0,"queue_position":1,"queue_size":4}}');
    expect(upstream[2].body).toEqual({ model: "m" });
    expect(upstream[2].response.body).toBe("data: {}\n\n");
  });
});

describe("auxiliary request-scoped calls", () => {
  test("refreshAccessToken records its attempt with redacted credentials", async () => {
    const trace = traceRequest();
    const fetchImpl = (async () => Response.json({ data: { accessToken: "new", refreshToken: "ref2" } })) as unknown as typeof fetch;
    const next = await refreshAccessToken({ config, credentials, fetchImpl });
    expect(next?.accessToken).toBe("new");
    await trace.finish(Response.json({ ok: true }));

    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(1);
    expect(upstream[0].method).toBe("POST");
    expect(upstream[0].url).toBe("https://example.test/v2/plugin/auth/token/refresh");
    expect(upstream[0].headers["X-Refresh-Token"]).toBe("<redacted>");
    expect(upstream[0].headers["X-User-Id"]).toBe("<redacted>");
    expect(upstream[0].body).toEqual({});
    expect(upstream[0].response.status).toBe(200);
    expect(upstream[0].response.body).toBe('{"data":{"accessToken":"new","refreshToken":"ref2"}}');
    expect(upstream[0].response.complete).toBe(true);
  });

  test("records every L3 stream chunk with bytes and arrival times", async () => {
    const encoder = new TextEncoder();
    const parts = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', "data: [DONE]\n\n"];
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            for (const part of parts) {
              controller.enqueue(encoder.encode(part));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      )) as unknown as typeof fetch;
    const trace = traceRequest();
    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: {},
      body: { model: "m" },
      fetchImpl,
    });
    expect(resp.status).toBe(200);
    await trace.finish(Response.json({ ok: true }));

    const attempt = readRecords()[0].upstream[0];
    expect(attempt.response.body).toBe(parts.join(""));
    expect(attempt.response.chunks.map((c: any) => c.bytes)).toEqual(
      parts.map((p) => encoder.encode(p).byteLength),
    );
    expect(attempt.response.complete).toBe(true);
    const [a, b, c] = attempt.response.chunks;
    expect(b.t_ms).toBeGreaterThanOrEqual(a.t_ms);
    expect(c.t_ms).toBeGreaterThanOrEqual(b.t_ms);
  });
});

describe("background and context-free calls", () => {
  test("postChat without a request context writes nothing and keeps behavior", async () => {
    process.env.TRACE_CAPTURE_DIR = dir;
    const fetchImpl = (async () =>
      new Response("data: {}\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: {},
      body: { model: "m" },
      fetchImpl,
    });
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("data: {}\n\n");
    expect(existsSync(captureFile())).toBe(false);
  });

  test("msg-center background polling never enters a request record", async () => {
    process.env.TRACE_CAPTURE_DIR = dir;
    const fetchImpl = (async () => Response.json({ data: { total: 1 } })) as unknown as typeof fetch;
    // 启动期创建：定时器回调不继承任何入站请求上下文
    const poller = new MsgCenterPoller({ config, getCredentials: () => credentials, fetchImpl });
    const trace = traceRequest();
    await trace.finish(Response.json({ ok: true }));
    await poller.tick();
    poller.stop();

    const records = readRecords();
    expect(records).toHaveLength(1);
    expect(records[0].upstream).toEqual([]);
  });
});
