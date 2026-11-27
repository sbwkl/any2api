import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createECDH } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountProviders, type ProviderModule } from "./registry";
import { flushRequestTraces, traceUpstream } from "./shared/trace";
import { createProtocolRoutes, type ChatBackend } from "./protocols";
import { OpenAIFacade } from "./providers/codearts/openai";
import { SnapClient } from "./providers/codearts/snap";

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function captureFile(dir: string): string {
  return join(dir, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
}

function captureRecords(dir: string): any[] {
  const file = captureFile(dir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sseStream(chunks: string[], gapMs = 5): Response {
  return new Response(
    new ReadableStream({
      async start(c) {
        for (const chunk of chunks) {
          c.enqueue(encoder.encode(chunk));
          if (gapMs > 0) await sleep(gapMs);
        }
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function postReq(path: string, body: unknown, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

const defaultProvider: ProviderModule = {
  name: "default",
  prefix: "",
  required: true,
  create: async () => ({
    routes: [
      { method: "GET", path: "/v1/models", handle: () => Response.json({ provider: "default" }) },
      { method: "POST", path: "/v1/chat/completions", handle: () => new Response("default-chat") },
    ],
    health: () => ({ ok: true }),
  }),
};

const cbProvider: ProviderModule = {
  name: "cb",
  prefix: "/codebuddy",
  create: async () => ({
    routes: [
      { method: "GET", path: "/v1/models", handle: () => Response.json({ provider: "cb" }) },
    ],
    health: () => ({ ok: true, models: 2 }),
  }),
};

function req(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("provider registry", () => {
  test("routes by prefix and strips the prefix", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const a: any = await (await handler(req("/v1/models"))).json();
    const b: any = await (await handler(req("/codebuddy/v1/models"))).json();
    expect(a.provider).toBe("default");
    expect(b.provider).toBe("cb");
  });

  test("longest prefix wins and respects path boundaries", async () => {
    const a: ProviderModule = {
      name: "a", prefix: "/a",
      create: async () => ({ routes: [{ method: "GET", path: "/x", handle: () => new Response("a") }] }),
    };
    const ab: ProviderModule = {
      name: "ab", prefix: "/a/b",
      create: async () => ({ routes: [{ method: "GET", path: "/x", handle: () => new Response("ab") }] }),
    };
    const handler = await mountProviders([a, ab]);
    expect(await (await handler(req("/a/b/x"))).text()).toBe("ab");
    expect(await (await handler(req("/a/x"))).text()).toBe("a");

    // /codebuddyx must not match /codebuddy
    const withCb = await mountProviders([defaultProvider, cbProvider]);
    expect((await withCb(req("/codebuddyx/v1/models"))).status).toBe(404);
  });

  test("returns 405 for a known path with the wrong method", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const resp = await handler(req("/codebuddy/v1/models", "POST"));
    expect(resp.status).toBe(405);
  });

  test("returns 404 for unknown paths under a provider prefix", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    expect((await handler(req("/codebuddy/nope"))).status).toBe(404);
  });

  test("aggregates provider health", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const resp = await handler(req("/healthz"));
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.providers).toHaveLength(2);
    expect(j.providers.find((p: any) => p.provider === "cb").models).toBe(2);
  });

  test("optional provider failure degrades to 503 for its prefix only", async () => {
    const bad: ProviderModule = {
      name: "bad",
      prefix: "/bad",
      create: async () => { throw new Error("boom"); },
    };
    const handler = await mountProviders([defaultProvider, bad]);
    expect((await handler(req("/v1/models"))).status).toBe(200);
    const resp = await handler(req("/bad/v1/models"));
    expect(resp.status).toBe(503);
    const j: any = await resp.json();
    expect(j.error.type).toBe("provider_unavailable");
    expect(j.error.message).toContain("boom");
  });

  test("required provider failure aborts startup", async () => {
    const requiredBad: ProviderModule = {
      name: "req",
      prefix: "",
      required: true,
      create: async () => { throw new Error("fatal"); },
    };
    await expect(mountProviders([requiredBad])).rejects.toThrow("fatal");
  });

  test("rejects duplicate prefixes", async () => {
    const a: ProviderModule = { ...cbProvider, name: "cb1" };
    const b: ProviderModule = { ...cbProvider, name: "cb2" };
    await expect(mountProviders([a, b])).rejects.toThrow("duplicate provider prefix");
  });

  test("rejects more than one empty prefix", async () => {
    await expect(mountProviders([defaultProvider, { ...cbProvider, prefix: "" }]))
      .rejects.toThrow("empty prefix");
  });

  test("rejects invalid prefix formats", async () => {
    await expect(mountProviders([{ ...cbProvider, prefix: "codebuddy" }]))
      .rejects.toThrow('start with "/"');
    await expect(mountProviders([{ ...cbProvider, prefix: "/codebuddy/" }]))
      .rejects.toThrow('end with "/"');
  });

  test("route exceptions become JSON 500 instead of a bare 500", async () => {
    const boom: ProviderModule = {
      name: "boom",
      prefix: "/boom",
      create: async () => ({
        routes: [{
          method: "GET",
          path: "/x",
          handle: () => { throw new Error("boom"); },
        }],
      }),
    };
    const handler = await mountProviders([boom]);
    const resp = await handler(req("/boom/x"));
    expect(resp.status).toBe(500);
    const j: any = await resp.json();
    expect(j.error.type).toBe("internal_error");
    expect(j.error.message).toContain("boom");
  });

  test("captures traffic when TRACE_CAPTURE_DIR is set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "any2api-registry-trace-"));
    process.env.TRACE_CAPTURE_DIR = dir;
    try {
      const handler = await mountProviders([defaultProvider]);
      const resp = await handler(req("/v1/models"));
      expect(resp.status).toBe(200);

      const file = join(dir, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
      for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((r) => setTimeout(r, 10));
      expect(existsSync(file)).toBe(true);
      const rec = JSON.parse(readFileSync(file, "utf8").trim());
      expect(rec.schema).toBe(3);
      expect(rec.path).toBe("/v1/models");
      expect(rec.response.status).toBe(200);
      expect(rec.provider).toBe("default");
    } finally {
      delete process.env.TRACE_CAPTURE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("four-layer request record wiring", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "any2api-registry-trace4-"));
    process.env.TRACE_CAPTURE_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TRACE_CAPTURE_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes one L1–L4 record for a streamed request with every upstream attempt in order", async () => {
    const upstreamUrls: string[] = [];
    const fakeUpstream = async (url: any) => {
      upstreamUrls.push(String(url));
      if (upstreamUrls.length === 1) {
        return new Response('{"error":"token expired"}', {
          status: 401,
          headers: { "content-type": "application/json", "set-cookie": "sid=secret" },
        });
      }
      return sseStream(['data: {"delta":"a"}\n\n', "data: [DONE]\n\n"]);
    };
    const inboundBody = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const provider: ProviderModule = {
      name: "fake",
      prefix: "/codebuddy",
      create: async () => ({
        routes: [{
          method: "POST",
          path: "/v1/chat/completions",
          handle: async () => {
            const first = await traceUpstream(
              {
                method: "POST",
                url: "https://upstream/v2/chat/completions",
                headers: { authorization: "Bearer secret-1", "x-device-token": "device-secret" },
                body: '{"wire":1}',
                recordBody: inboundBody,
              },
              { fetch: fakeUpstream },
            );
            await first.text();
            const second = await traceUpstream(
              { method: "POST", url: "https://upstream/v2/chat/completions", headers: { authorization: "Bearer secret-2" }, body: '{"wire":2}', recordBody: inboundBody },
              { fetch: fakeUpstream },
            );
            return new Response(second.body, {
              status: second.status,
              headers: { "content-type": "text/event-stream; charset=utf-8" },
            });
          },
        }],
      }),
    };

    const handler = await mountProviders([provider]);
    const inbound = new Request("http://localhost/codebuddy/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer inbound-secret", "x-user-id": "user-1" },
      body: JSON.stringify(inboundBody),
    });
    const resp = await handler(inbound);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');

    await flushRequestTraces();
    const records = captureRecords(dir);
    expect(records).toHaveLength(1);
    const rec = records[0];

    // L1
    expect(rec.schema).toBe(3);
    expect(rec.provider).toBe("codebuddy");
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/codebuddy/v1/chat/completions");
    expect(rec.headers.authorization).toBe("<redacted>");
    expect(rec.headers["x-user-id"]).toBe("<redacted>");
    expect(rec.request).toEqual(inboundBody);

    // L2 + L3：每次尝试按发生顺序单独记录
    expect(rec.upstream).toHaveLength(2);
    expect(rec.upstream.map((u: any) => u.url)).toEqual([
      "https://upstream/v2/chat/completions",
      "https://upstream/v2/chat/completions",
    ]);
    expect(rec.upstream[0].headers.authorization).toBe("<redacted>");
    expect(rec.upstream[0].headers["x-device-token"]).toBe("<redacted>");
    expect(rec.upstream[0].body).toEqual(inboundBody);
    expect(rec.upstream[0].response.status).toBe(401);
    expect(rec.upstream[0].response.headers["set-cookie"]).toBe("<redacted>");
    expect(rec.upstream[0].response.body).toBe('{"error":"token expired"}');
    expect(rec.upstream[0].response.complete).toBe(true);
    expect(rec.upstream[1].response.status).toBe(200);
    expect(rec.upstream[1].response.body).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
    expect(rec.upstream[1].response.complete).toBe(true);

    // L4：完整 drain，首字节与总时长分离，content_type 正确
    expect(rec.response.status).toBe(200);
    expect(rec.response.content_type).toContain("text/event-stream");
    expect(rec.response.body).toBe('data: {"delta":"a"}\n\ndata: [DONE]\n\n');
    expect(rec.response.first_byte_ms).toBeGreaterThanOrEqual(0);
    expect(rec.response.duration_ms).toBeGreaterThanOrEqual(rec.response.first_byte_ms);
    expect(rec.response.complete).toBe(true);
    expect(rec.response.abort_reason).toBeNull();

    expect(JSON.stringify(rec)).not.toContain("secret-1");
    expect(JSON.stringify(rec)).not.toContain("inbound-secret");
    expect(JSON.stringify(rec)).not.toContain("user-1");
  });

  test("records every inbound path, including healthz, 405, 404 and 503, with an empty upstream list", async () => {
    const cb: ProviderModule = {
      name: "cb",
      prefix: "/codebuddy",
      create: async () => ({
        routes: [
          { method: "GET", path: "/v1/models", handle: () => Response.json({ provider: "cb" }) },
          { method: "POST", path: "/v1/messages", handle: () => Response.json({ type: "message" }) },
          { method: "POST", path: "/v1/responses", handle: () => Response.json({ object: "response" }) },
          { method: "GET", path: "/healthz", handle: () => Response.json({ ok: true }) },
        ],
        health: () => ({ ok: true }),
      }),
    };
    const bad: ProviderModule = {
      name: "bad",
      prefix: "/bad",
      create: async () => { throw new Error("boom"); },
    };
    const handler = await mountProviders([defaultProvider, cb, bad]);

    const cases: Array<[string, string, number]> = [
      ["/healthz", "GET", 200],
      ["/v1/models", "GET", 200],
      ["/codebuddy/v1/models", "GET", 200],
      ["/codebuddy/v1/messages", "POST", 200],
      ["/codebuddy/v1/responses", "POST", 200],
      ["/codebuddy/healthz", "GET", 200],
      ["/codebuddy/v1/models", "POST", 405],
      ["/codebuddy/nope", "GET", 404],
      ["/nope", "GET", 404],
      ["/bad/v1/models", "GET", 503],
    ];
    for (const [path, method, status] of cases) {
      expect((await handler(req(path, method))).status).toBe(status);
    }

    await flushRequestTraces();
    const records = captureRecords(dir);
    expect(records).toHaveLength(cases.length);
    for (const [path, method, status] of cases) {
      const rec = records.find((r) => r.path === path && r.method === method && r.response.status === status);
      expect(rec).toBeDefined();
      expect(rec.upstream).toEqual([]);
      expect(rec.request).toEqual({});
    }
  });

  test("marks client_disconnect when the client aborts during a streamed response", async () => {
    const provider: ProviderModule = {
      name: "slow",
      prefix: "",
      create: async () => ({
        routes: [{
          method: "POST",
          path: "/v1/chat/completions",
          handle: () => new Response(
            new ReadableStream({
              async start(c) {
                c.enqueue(encoder.encode("first"));
                await sleep(60);
                c.enqueue(encoder.encode("last"));
                c.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
        }],
      }),
    };
    const handler = await mountProviders([provider]);
    const controller = new AbortController();
    const resp = await handler(postReq("/v1/chat/completions", {}, { signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    expect(await resp.text()).toBe("firstlast");

    await flushRequestTraces();
    const rec = captureRecords(dir)[0];
    expect(rec.response.complete).toBe(false);
    expect(rec.response.abort_reason).toBe("client_disconnect");
  });

  test("marks proxy_error / timeout for handler exceptions and upstream_error for broken streams", async () => {
    const provider: ProviderModule = {
      name: "boom",
      prefix: "",
      create: async () => ({
        routes: [
          { method: "GET", path: "/boom", handle: () => { throw new Error("boom"); } },
          { method: "GET", path: "/slow", handle: () => { throw new DOMException("upstream slow", "TimeoutError"); } },
          {
            method: "GET",
            path: "/flow",
            handle: () => new Response(
              new ReadableStream({
                start(c) {
                  c.enqueue(encoder.encode("partial"));
                  setTimeout(() => c.error(new Error("flow broke")), 5);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
          },
        ],
      }),
    };
    const handler = await mountProviders([provider]);
    expect((await handler(req("/boom"))).status).toBe(500);
    expect((await handler(req("/slow"))).status).toBe(500);
    const flow = await handler(req("/flow"));
    await flow.text().catch(() => {});

    await flushRequestTraces();
    const records = captureRecords(dir);
    const byPath = (path: string) => records.find((r) => r.path === path);
    expect(byPath("/boom").response.status).toBe(500);
    expect(byPath("/boom").response.complete).toBe(false);
    expect(byPath("/boom").response.abort_reason).toBe("proxy_error");
    expect(byPath("/slow").response.abort_reason).toBe("timeout");
    expect(byPath("/flow").response.complete).toBe(false);
    expect(byPath("/flow").response.abort_reason).toBe("upstream_error");
  });

  test("keeps concurrent request records isolated", async () => {
    // 两个请求互相交错：a 的第一次尝试在 b 的两次尝试之间进行，a 的第二次尝试在 b 完成之后。
    const relay = (label: string, plan: Array<{ preDelayMs: number; upstreamDelayMs: number }>) => async () => {
      let lastBody = "";
      for (const [i, step] of plan.entries()) {
        await sleep(step.preDelayMs);
        const upstream = await traceUpstream(
          {
            method: "POST",
            url: `https://upstream/${label}/${i}`,
            headers: { "x-request-id": `${label}-${i}` },
            body: JSON.stringify({ label, attempt: i }),
          },
          {
            fetch: async () => {
              await sleep(step.upstreamDelayMs);
              return new Response(`sse-${label}-${i}`, { headers: { "content-type": "text/event-stream" } });
            },
          },
        );
        lastBody = await upstream.text();
      }
      return new Response(lastBody, { headers: { "content-type": "text/event-stream" } });
    };
    const provider: ProviderModule = {
      name: "iso",
      prefix: "",
      create: async () => ({
        routes: [
          { method: "POST", path: "/a", handle: relay("a", [{ preDelayMs: 10, upstreamDelayMs: 30 }, { preDelayMs: 0, upstreamDelayMs: 5 }]) },
          { method: "POST", path: "/b", handle: relay("b", [{ preDelayMs: 0, upstreamDelayMs: 5 }, { preDelayMs: 20, upstreamDelayMs: 5 }]) },
        ],
      }),
    };
    const handler = await mountProviders([provider]);

    const pa = handler(postReq("/a", { label: "a" })).then((r) => r.text());
    const pb = handler(postReq("/b", { label: "b" })).then((r) => r.text());
    expect(await Promise.all([pa, pb])).toEqual(["sse-a-1", "sse-b-1"]);

    await flushRequestTraces();
    const records = captureRecords(dir);
    expect(records).toHaveLength(2);
    for (const [label, path] of [["a", "/a"], ["b", "/b"]] as const) {
      const rec = records.find((r) => r.path === path);
      expect(rec).toBeDefined();
      expect(rec.request).toEqual({ label });
      expect(rec.upstream).toHaveLength(2);
      expect(rec.upstream.map((u: any) => u.url)).toEqual([
        `https://upstream/${label}/0`,
        `https://upstream/${label}/1`,
      ]);
      for (const [i, attempt] of rec.upstream.entries()) {
        expect(attempt.headers["x-request-id"]).toBe(`${label}-${i}`);
        expect(attempt.body).toEqual({ label, attempt: i });
        expect(attempt.response.body).toBe(`sse-${label}-${i}`);
      }
      expect(rec.response.body).toBe(`sse-${label}-1`);
    }
  });
});

describe("codearts client cancellation (registry integration)", () => {
  const savedEnv = { ...process.env };
  let dir: string | null = null;

  beforeEach(() => {
    process.env.CODEARTS_CLI_AK = "test-ak";
    process.env.CODEARTS_CLI_SK = "test-sk";
    process.env.SNAP_ORIGIN = "https://snap.test";
    delete process.env.TRACE_CAPTURE_DIR;
    delete process.env.UPSTREAM_DUMP_DIR;
    delete process.env.CODEARTS_FORCE_PLAINTEXT;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  type FakeFetch = (input: any, init?: RequestInit) => Promise<Response>;
  interface RecordedUpstream { url: string; init: RequestInit }

  async function mountCodearts(fakeFetch: FakeFetch, retry: { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; now?: () => number; random?: () => number } = { sleep: async () => {} }) {
    const snap = new SnapClient("https://snap.test", fakeFetch, retry);
    const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
    const facade = new OpenAIFacade(snap, gw, { recordChat() {} } as any, fakeFetch, { retry });
    // 心跳不是本测试的对象：替换为 no-op，避免额外上游请求混入断言
    (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
    const backend: ChatBackend = {
      models: () => facade.modelsPayload().data,
      health: () => ({ ok: true }),
      handleChat: (req) => facade.handleChat(req),
      respond: (body, opts) => facade.respond(body, opts.stream, opts.sessionKey, opts.signal),
    };
    const provider: ProviderModule = {
      name: "codearts",
      prefix: "/codearts",
      required: true,
      create: async () => ({
        routes: createProtocolRoutes(backend, { toolChoice: "full", normalizeErrors: false }),
        health: () => ({ ok: true }),
      }),
    };
    return mountProviders([provider]);
  }

  /** 密钥协商立即成功；加密 chat 返回一帧后挂起，直到收到 abort 才失败。 */
  function abortableUpstream(calls: RecordedUpstream[]): FakeFetch {
    const serverPublicKey = createECDH("prime256v1").generateKeys().toString("base64");
    const enc = new TextEncoder();
    return async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (new URL(url).pathname.startsWith("/api/v1/security/key-exchange"))
        return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      return new Response(new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(enc.encode('data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"par"}}]}\n\n'));
          const fail = () => ctrl.error(new DOMException("aborted", "AbortError"));
          const signal = init.signal;
          if (!signal) return; // 没有 signal 会挂住，超时即回归
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail);
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    };
  }

  function chatCalls(calls: RecordedUpstream[]): RecordedUpstream[] {
    return calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v2/chat/completions"));
  }

  test("client disconnect aborts the upstream chat and records client_disconnect with L3 incomplete", async () => {
    dir = mkdtempSync(join(tmpdir(), "any2api-codearts-cancel-"));
    process.env.TRACE_CAPTURE_DIR = dir;
    const calls: RecordedUpstream[] = [];
    const handler = await mountCodearts(abortableUpstream(calls));

    const controller = new AbortController();
    const resp = await handler(postReq("/codearts/v1/chat/completions", {
      model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
    }, { signal: controller.signal }));
    expect(resp.status).toBe(200);

    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await flushRequestTraces();

    // 取消后不再发新请求：上游只收到一次 chat
    expect(chatCalls(calls)).toHaveLength(1);
    expect(chatCalls(calls)[0].init.signal?.aborted).toBe(true);

    const rec = captureRecords(dir)[0];
    expect(rec.provider).toBe("codearts");
    expect(rec.path).toBe("/codearts/v1/chat/completions");
    // 四层观测：客户端断开是第一原因，上游可读响应与出站响应都未完成
    expect(rec.response.abort_reason).toBe("client_disconnect");
    expect(rec.response.complete).toBe(false);
    const chat = rec.upstream.find((u: any) => new URL(u.url).pathname.startsWith("/api/v2/chat/completions"));
    expect(chat).toBeDefined();
    expect(chat.response.complete).toBe(false);
    // 密钥协商属于全局缓存，不跟随取消
    const kx = rec.upstream.find((u: any) => new URL(u.url).pathname.startsWith("/api/v1/security/key-exchange"));
    expect(kx).toBeDefined();
    expect(kx.response.complete).toBe(true);
  });

  test("cancellation still aborts the upstream fetch when observability is off", async () => {
    const calls: RecordedUpstream[] = [];
    const handler = await mountCodearts(abortableUpstream(calls));

    const controller = new AbortController();
    const resp = await handler(postReq("/codearts/v1/chat/completions", {
      model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
    }, { signal: controller.signal }));
    expect(resp.status).toBe(200);

    const reader = resp.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();

    expect(chatCalls(calls)).toHaveLength(1);
    expect(chatCalls(calls)[0].init.signal?.aborted).toBe(true);
  });

  /** 密钥协商成功；第一次 chat 返回 429，第二次返回 200 SSE。 */
  function rateLimitedThenOk(calls: RecordedUpstream[]): FakeFetch {
    const serverPublicKey = createECDH("prime256v1").generateKeys().toString("base64");
    let chatAttempts = 0;
    return async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (new URL(url).pathname.startsWith("/api/v1/security/key-exchange"))
        return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      chatAttempts++;
      if (chatAttempts === 1)
        return new Response('{"error_msg":"Too many requests","error_code":"APIG.0308"}', {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      return new Response(
        'data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    };
  }

  test("a 429 before the first byte is retried and the record shows both upstream attempts", async () => {
    dir = mkdtempSync(join(tmpdir(), "any2api-codearts-retry-"));
    process.env.TRACE_CAPTURE_DIR = dir;
    const calls: RecordedUpstream[] = [];
    const sleeps: number[] = [];
    const handler = await mountCodearts(rateLimitedThenOk(calls), {
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 0,
      random: () => 0,
    });

    const resp = await handler(postReq("/codearts/v1/chat/completions", {
      model: "m", messages: [{ role: "user", content: "hi" }], stream: true,
    }));
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('"content":"ok"');

    // 退避使用注入的假 sleep：一次 500ms，无真实等待
    expect(sleeps).toEqual([500]);
    // 上游调用序列：1 次 chat (429) → 1 次 chat (200)；不重复协商密钥
    expect(calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v2/chat/completions"))).toHaveLength(2);
    expect(calls.filter((c) => new URL(c.url).pathname.startsWith("/api/v1/security/key-exchange"))).toHaveLength(1);

    await flushRequestTraces();
    const rec = captureRecords(dir)[0];
    expect(rec.response.status).toBe(200);
    expect(rec.response.complete).toBe(true);
    expect(rec.response.body).toContain('"content":"ok"');
    // 记录里能看出重试次数：两条 chat 尝试按序记为 429 → 200
    const chatAttempts = rec.upstream.filter((u: any) =>
      new URL(u.url).pathname.startsWith("/api/v2/chat/completions"));
    expect(chatAttempts.map((u: any) => u.response.status)).toEqual([429, 200]);
    expect(chatAttempts[0].response.complete).toBe(true);
    expect(chatAttempts[1].response.complete).toBe(true);
  });
});