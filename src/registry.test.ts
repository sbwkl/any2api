import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountProviders, type ProviderModule } from "./registry";
import { flushRequestTraces, traceUpstream } from "./shared/trace";

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
      expect(rec.schema).toBe(2);
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
    expect(rec.schema).toBe(2);
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