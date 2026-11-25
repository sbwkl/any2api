import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dumpUpstream,
  flushRequestTraces,
  markAbort,
  runWithRequestTrace,
  startRequestTrace,
  traceUpstream,
} from "./trace";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "any2api-trace-"));
  delete process.env.TRACE_CAPTURE_DIR;
  delete process.env.UPSTREAM_DUMP_DIR;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.TRACE_CAPTURE_DIR;
  delete process.env.UPSTREAM_DUMP_DIR;
});

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function capturePath(baseDir: string): string {
  return join(baseDir, `capture-${today()}.jsonl`);
}

function readRecords(baseDir = dir): any[] {
  const file = capturePath(baseDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function inbound(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, init);
}

function jsonRequest(path = "/codearts/v1/chat/completions"): Request {
  return inbound(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const encoder = new TextEncoder();

describe("upstream dump", () => {
  test("is a no-op without UPSTREAM_DUMP_DIR", () => {
    dumpUpstream("codearts", "http://upstream/v2/chat", { model: "m" });
    expect(existsSync(join(dir, "upstream.jsonl"))).toBe(false);
  });

  test("appends one JSONL record per outbound request", () => {
    process.env.UPSTREAM_DUMP_DIR = dir;
    dumpUpstream("codearts", "http://upstream/v2/chat", { model: "m1", temperature: 0.2 });
    dumpUpstream("codebuddy", "http://upstream/v2/chat/completions", { model: "m2" });

    const records = readFileSync(join(dir, "upstream.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records).toHaveLength(2);
    expect(records[0].provider).toBe("codearts");
    expect(records[0].url).toContain("/v2/chat");
    expect(records[0].body.model).toBe("m1");
    expect(records[0].body.temperature).toBe(0.2);
    expect(typeof records[0].ts).toBe("string");
    expect(records[1].provider).toBe("codebuddy");
  });

  test("explicit dir option overrides env", () => {
    const other = mkdtempSync(join(tmpdir(), "any2api-trace-other-"));
    try {
      dumpUpstream("codearts", "http://upstream", { a: 1 }, { dir: other });
      expect(existsSync(join(other, "upstream.jsonl"))).toBe(true);
      expect(existsSync(join(dir, "upstream.jsonl"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("request record (schema 2)", () => {
  test("is disabled without TRACE_CAPTURE_DIR and leaves outbound calls untouched", async () => {
    expect(startRequestTrace(jsonRequest())).toBeNull();

    const fake = async () => Response.json({ ok: true });
    const res = await traceUpstream(
      { method: "POST", url: "https://upstream/v1/chat", headers: { authorization: "Bearer x" }, body: "{}" },
      { fetch: fake },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(capturePath(dir))).toBe(false);
  });

  test("writes one schema 2 record with L1 headers, parsed request and L4 response", async () => {
    const sensitive = {
      authorization: "Bearer super-secret",
      "x-api-key": "key-secret",
      "x-auth-token": "auth-secret",
      "x-refresh-token": "refresh-secret",
      "x-security-token": "security-secret",
      "x-device-token": "device-secret",
      "x-user-id": "user-secret",
      cookie: "session-secret",
      "set-cookie": "server-secret",
    };
    const req = inbound("/codearts/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-envelope-signature": "keep-me",
        ...sensitive,
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

    const trace = startRequestTrace(req, { dir })!;
    const res = Response.json({ ok: true }, { headers: { "content-type": "application/json", "x-upstream-only": "visible" } });
    await trace.finish(res);

    const records = readRecords();
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.schema).toBe(2);
    expect(typeof rec.ts).toBe("string");
    expect(rec.provider).toBe("codearts");
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/codearts/v1/chat/completions");
    expect(rec.headers["content-type"]).toContain("application/json");
    expect(rec.headers["x-envelope-signature"]).toBe("keep-me");
    for (const name of Object.keys(sensitive)) expect(rec.headers[name]).toBe("<redacted>");
    expect(rec.request).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(rec.raw_request).toBeUndefined();
    expect(rec.upstream).toEqual([]);
    expect(rec.response.status).toBe(200);
    expect(rec.response.headers["x-upstream-only"]).toBe("visible");
    expect(rec.response.content_type).toContain("application/json");
    expect(rec.response.body).toContain('"ok":true');
    expect(typeof rec.response.first_byte_ms).toBe("number");
    expect(rec.response.duration_ms).toBeGreaterThanOrEqual(0);
    expect(rec.response.complete).toBe(true);
    expect(rec.response.abort_reason).toBeNull();
    expect(JSON.stringify(rec)).not.toContain("super-secret");
    expect(JSON.stringify(rec)).not.toContain("user-secret");
  });

  test("keeps the raw request text when the body is not JSON", async () => {
    const trace = startRequestTrace(inbound("/v1/messages", { method: "POST", body: "not-json{" }), { dir })!;
    await trace.finish(new Response("boom", { status: 500 }));

    const rec = readRecords()[0];
    expect(rec.request).toBeUndefined();
    expect(rec.raw_request).toBe("not-json{");
    expect(rec.provider).toBe("default");
    expect(rec.response.status).toBe(500);
  });

  test("records an empty request object for a bodyless request", async () => {
    const trace = startRequestTrace(inbound("/v1/models"), { dir })!;
    await trace.finish(Response.json({ data: [] }));

    const rec = readRecords()[0];
    expect(rec.request).toEqual({});
    expect(rec.raw_request).toBeUndefined();
  });

  test("records large bodies in full", async () => {
    const big = "x".repeat(100_000);
    const trace = startRequestTrace(inbound("/v1/messages", { method: "POST", body: JSON.stringify({ text: big }) }), { dir })!;
    await trace.finish(new Response(big));

    const rec = readRecords()[0];
    expect(rec.request.text).toBe(big);
    expect(rec.response.body).toBe(big);
  });

  test("creates the capture file owner-read-write only", async () => {
    const trace = startRequestTrace(jsonRequest(), { dir })!;
    await trace.finish(Response.json({ ok: true }));

    const mode = statSync(capturePath(dir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("write failures stay silent", async () => {
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "not a directory");
    const trace = startRequestTrace(jsonRequest(), { dir: blocked })!;
    await expect(trace.finish(Response.json({ ok: true }))).resolves.toBeUndefined();
  });

  test("marks aborted requests with the recorded reason", async () => {
    const reasons = ["client_disconnect", "upstream_error", "timeout", "proxy_error"] as const;
    for (const [i, reason] of reasons.entries()) {
      const trace = startRequestTrace(jsonRequest(), { dir })!;
      if (i % 2 === 0) trace.abort(reason);
      else markAbort(reason);
      await trace.finish(new Response("", { status: 502 }));
    }
    markAbort("timeout"); // 无上下文时为 no-op，不抛错

    const records = readRecords();
    expect(records).toHaveLength(4);
    expect(records.map((r) => r.response.abort_reason)).toEqual([...reasons]);
    expect(records.every((r) => r.response.complete === false)).toBe(true);
  });
});

describe("streamed outbound response (L4)", () => {
  test("keeps the recombined SSE body and separates first byte from total duration", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        await sleep(30);
        controller.enqueue(encoder.encode('data: {"b":2}\n\n'));
        controller.close();
      },
    });

    const trace = startRequestTrace(jsonRequest(), { dir })!;
    await trace.finish(new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } }));

    const rec = readRecords()[0];
    expect(rec.response.content_type).toBe("text/event-stream; charset=utf-8");
    expect(rec.response.body).toBe('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(rec.response.first_byte_ms).toBeGreaterThanOrEqual(0);
    // 旧缺陷：duration_ms 被记成首字节耗时。现在必须覆盖完整流时长。
    expect(rec.response.duration_ms - (rec.response.first_byte_ms ?? 0)).toBeGreaterThanOrEqual(20);
    expect(rec.response.complete).toBe(true);
  });

  test("uses the header return time as first_byte_ms when the response has no body", async () => {
    const noContent = startRequestTrace(jsonRequest(), { dir })!;
    await noContent.finish(new Response(null, { status: 204 }));
    const empty = startRequestTrace(jsonRequest(), { dir })!;
    await empty.finish(new Response("", { status: 200, headers: { "content-type": "text/plain" } }));

    const [a, b] = readRecords();
    expect(a.response.status).toBe(204);
    expect(a.response.body).toBe("");
    expect(a.response.complete).toBe(true);
    expect(typeof a.response.first_byte_ms).toBe("number");
    expect(a.response.first_byte_ms).toBeGreaterThanOrEqual(0);
    expect(b.response.status).toBe(200);
    expect(b.response.body).toBe("");
    expect(b.response.complete).toBe(true);
    expect(typeof b.response.first_byte_ms).toBe("number");
    expect(b.response.first_byte_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("upstream attempts (L2 + L3)", () => {
  test("appends every attempt in order with redacted headers and plaintext bodies", async () => {
    const trace = startRequestTrace(jsonRequest(), { dir })!;
    const calls: string[] = [];
    let call = 0;
    const fake = async (url: any) => {
      calls.push(String(url));
      call++;
      if (call === 1) {
        return new Response("first-response", { headers: { "content-type": "text/plain", "set-cookie": "secret-cookie" } });
      }
      if (call === 2) throw new Error("upstream down");
      return Response.json({ ok: 3 });
    };

    const first = await traceUpstream(
      {
        method: "POST",
        url: "https://upstream/v2/chat",
        headers: { authorization: "Bearer secret", "x-device-token": "device-secret", "x-request-id": "r1" },
        body: new Uint8Array([1, 2, 3]),
        recordBody: { model: "m1" },
      },
      { fetch: fake },
    );
    expect(await first.text()).toBe("first-response"); // 原响应仍可正常消费

    await expect(
      traceUpstream({ method: "GET", url: "https://upstream/queue", headers: {}, body: null }, { fetch: fake }),
    ).rejects.toThrow("upstream down");

    await traceUpstream(
      { method: "POST", url: "https://upstream/retry", headers: {}, body: JSON.stringify({ retried: true }) },
      { fetch: fake },
    );

    await trace.finish(Response.json({ ok: true }));
    expect(calls).toEqual(["https://upstream/v2/chat", "https://upstream/queue", "https://upstream/retry"]);

    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(3);
    expect(upstream.map((u: any) => u.url)).toEqual([
      "https://upstream/v2/chat",
      "https://upstream/queue",
      "https://upstream/retry",
    ]);
    expect(upstream[0].method).toBe("POST");
    expect(upstream[0].headers.authorization).toBe("<redacted>");
    expect(upstream[0].headers["x-device-token"]).toBe("<redacted>");
    expect(upstream[0].headers["x-request-id"]).toBe("r1");
    expect(upstream[0].body).toEqual({ model: "m1" });
    expect(upstream[0].response.status).toBe(200);
    expect(upstream[0].response.headers["set-cookie"]).toBe("<redacted>");
    expect(upstream[0].response.body).toBe("first-response");
    expect(upstream[0].response.complete).toBe(true);
    expect(upstream[1].response.status).toBe(0);
    expect(upstream[1].response.body).toBe("");
    expect(upstream[1].response.complete).toBe(false);
    expect(upstream[2].body).toEqual({ retried: true });
    expect(upstream[2].response.body).toBe('{"ok":3}');
    expect(upstream[0].t_ms).toBeLessThanOrEqual(upstream[1].t_ms);
    expect(upstream[1].t_ms).toBeLessThanOrEqual(upstream[2].t_ms);
  });

  test("times network chunks from the inbound request start", async () => {
    const fake = async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(encoder.encode("aa"));
            await sleep(15);
            controller.enqueue(encoder.encode("bbb"));
            await sleep(10);
            controller.enqueue(encoder.encode("c"));
            controller.close();
          },
        }),
      );
    const trace = startRequestTrace(jsonRequest(), { dir })!;

    await sleep(20); // 请求开始 20ms 后才发起上游调用
    await traceUpstream({ method: "POST", url: "https://upstream/sse", headers: {}, body: "{}" }, { fetch: fake });
    await trace.finish(Response.json({ ok: true }));

    const attempt = readRecords()[0].upstream[0];
    expect(attempt.t_ms).toBeGreaterThanOrEqual(10);
    expect(attempt.response.chunks.map((c: any) => c.bytes)).toEqual([2, 3, 1]);
    const [a, b, c] = attempt.response.chunks;
    // chunk 与尝试共用入站请求的时间基，而不是各自从 0 开始
    expect(a.t_ms).toBeGreaterThanOrEqual(attempt.t_ms);
    expect(b.t_ms).toBeGreaterThan(a.t_ms);
    expect(c.t_ms).toBeGreaterThanOrEqual(b.t_ms);
    expect(attempt.response.body).toBe("aabbbc");
    expect(attempt.response.complete).toBe(true);
  });
});

describe("request-scoped tracing (runWithRequestTrace)", () => {
  test("is a no-op without TRACE_CAPTURE_DIR and returns the handler response untouched", async () => {
    const res = await runWithRequestTrace(inbound("/v1/models"), () => Response.json({ ok: true }));
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(capturePath(dir))).toBe(false);
  });

  test("establishes the async context and records L2/L3 plus L4 without delaying the response", async () => {
    const res = await runWithRequestTrace(
      jsonRequest(),
      async () => {
        await traceUpstream(
          {
            method: "POST",
            url: "https://upstream/v2/chat",
            headers: { authorization: "Bearer secret", "x-request-id": "r1" },
            body: "{}",
            recordBody: { model: "m" },
          },
          { fetch: async () => Response.json({ ok: 1 }) },
        );
        return Response.json({ done: true });
      },
      { dir },
    );
    expect(await res.json()).toEqual({ done: true });

    // finish 不 await：写盘在后台完成，flush 保证测试确定性
    await flushRequestTraces();
    const rec = readRecords()[0];
    expect(rec.path).toBe("/codearts/v1/chat/completions");
    expect(rec.upstream).toHaveLength(1);
    expect(rec.upstream[0].headers.authorization).toBe("<redacted>");
    expect(rec.upstream[0].body).toEqual({ model: "m" });
    expect(rec.upstream[0].response.body).toBe('{"ok":1}');
    expect(rec.response.status).toBe(200);
    expect(rec.response.body).toBe('{"done":true}');
    expect(rec.response.complete).toBe(true);
    expect(rec.response.abort_reason).toBeNull();
  });

  test("classifies handler exceptions: proxy_error by default, timeout for TimeoutError", async () => {
    await expect(
      runWithRequestTrace(jsonRequest(), () => {
        throw new Error("boom");
      }, { dir }),
    ).rejects.toThrow("boom");
    await expect(
      runWithRequestTrace(jsonRequest(), () => {
        throw new DOMException("slow upstream", "TimeoutError");
      }, { dir }),
    ).rejects.toThrow();

    await flushRequestTraces();
    const records = readRecords();
    expect(records).toHaveLength(2);
    expect(records[0].response.status).toBe(500);
    expect(records[0].response.complete).toBe(false);
    expect(records[0].response.abort_reason).toBe("proxy_error");
    expect(records[1].response.abort_reason).toBe("timeout");
  });

  test("fails the response immediately while an upstream stream is still open", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 兜底：旧实现会等待 pending 上游流；到时释放避免测试挂死
    const safety = setTimeout(() => release(), 1000);
    const upstreamFetch = async () =>
      new Response(
        new ReadableStream({
          async start(c) {
            c.enqueue(encoder.encode("partial"));
            await gate;
            c.close();
          },
        }),
      );

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await runWithRequestTrace(
        jsonRequest(),
        async () => {
          await traceUpstream(
            { method: "POST", url: "https://upstream/sse", headers: {}, body: "{}" },
            { fetch: upstreamFetch },
          );
          throw new Error("boom");
        },
        { dir },
      );
    } catch (error) {
      caught = error;
    }
    const elapsed = Date.now() - startedAt;
    clearTimeout(safety);
    release();

    expect((caught as Error | undefined)?.message).toBe("boom");
    // 不得等待上游 pending 流结束才把异常抛给调用方
    expect(elapsed).toBeLessThan(500);

    await flushRequestTraces();
    const rec = readRecords()[0];
    expect(rec.response.status).toBe(500);
    expect(rec.response.complete).toBe(false);
    expect(rec.response.abort_reason).toBe("proxy_error");
    expect(rec.upstream[0].response.body).toBe("partial");
    expect(rec.upstream[0].response.complete).toBe(true);
  });

  test("marks client_disconnect when the inbound request aborts before the stream ends", async () => {
    const controller = new AbortController();
    const req = inbound("/codearts/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    const res = await runWithRequestTrace(
      req,
      () =>
        new Response(
          new ReadableStream({
            async start(c) {
              c.enqueue(encoder.encode("first-chunk"));
              await sleep(20);
              controller.abort();
              c.enqueue(encoder.encode("last-chunk"));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { dir },
    );
    expect(await res.text()).toBe("first-chunklast-chunk");

    await flushRequestTraces();
    const rec = readRecords()[0];
    expect(rec.response.body).toBe("first-chunklast-chunk");
    expect(rec.response.complete).toBe(false);
    expect(rec.response.abort_reason).toBe("client_disconnect");
  });

  test("marks upstream_error when the outbound stream fails mid-transfer", async () => {
    const res = await runWithRequestTrace(
      jsonRequest(),
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(encoder.encode("partial"));
              setTimeout(() => c.error(new Error("upstream flow broke")), 5);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { dir },
    );
    await res.text().catch(() => {});

    await flushRequestTraces();
    const rec = readRecords()[0];
    expect(rec.response.body).toBe("partial");
    expect(rec.response.complete).toBe(false);
    expect(rec.response.abort_reason).toBe("upstream_error");
  });
});
