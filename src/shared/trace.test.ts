import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dumpUpstream, startTraceCapture } from "./trace";

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

function readRecords(file: string): any[] {
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("upstream dump", () => {
  test("is a no-op without UPSTREAM_DUMP_DIR", () => {
    dumpUpstream("codearts", "http://upstream/v2/chat", { model: "m" });
    expect(existsSync(join(dir, "upstream.jsonl"))).toBe(false);
  });

  test("appends one JSONL record per outbound request", () => {
    process.env.UPSTREAM_DUMP_DIR = dir;
    dumpUpstream("codearts", "http://upstream/v2/chat", { model: "m1", temperature: 0.2 });
    dumpUpstream("codebuddy", "http://upstream/v2/chat/completions", { model: "m2" });

    const records = readRecords(join(dir, "upstream.jsonl"));
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

describe("trace capture", () => {
  test("is disabled without TRACE_CAPTURE_DIR", () => {
    const capture = startTraceCapture(new Request("http://localhost/codearts/v1/chat/completions", { method: "POST" }));
    expect(capture).toBeNull();
  });

  test("captures request/response and redacts credentials", async () => {
    const req = new Request("http://localhost/codearts/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer super-secret-token",
        "x-api-key": "sk-super-secret",
        "x-security-token": "sts-secret",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });

    const capture = startTraceCapture(req, { dir, maxBodyBytes: 64 * 1024 })!;
    expect(capture).not.toBeNull();
    const res = Response.json({ ok: true }, { headers: { "content-type": "application/json", "x-upstream-secret": "nope" } });
    await capture.finish(res, 12);

    const records = readRecords(join(dir, `capture-${today()}.jsonl`));
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/codearts/v1/chat/completions");
    expect(rec.provider).toBe("codearts");
    expect(rec.status).toBe(200);
    expect(rec.duration_ms).toBe(12);
    expect(rec.request.headers["content-type"]).toContain("application/json");
    expect(rec.request.headers.authorization).toBe("<redacted>");
    expect(rec.request.headers["x-api-key"]).toBe("<redacted>");
    expect(rec.request.headers["x-security-token"]).toBe("<redacted>");
    expect(rec.request.body).toContain('"model":"m"');
    expect(rec.response.body).toContain('"ok":true');
    expect(rec.response.content_type).toContain("application/json");
    expect(JSON.stringify(rec)).not.toContain("super-secret");
    expect(JSON.stringify(rec)).not.toContain("sts-secret");
    expect(JSON.stringify(rec)).not.toContain("upstream-secret");
  });

  test("truncates large request and response bodies", async () => {
    const big = "x".repeat(100);
    const req = new Request("http://localhost/codebuddy/v1/chat/completions", { method: "POST", body: big });
    const capture = startTraceCapture(req, { dir, maxBodyBytes: 8 })!;
    await capture.finish(new Response(big), 1);

    const rec = readRecords(join(dir, `capture-${today()}.jsonl`))[0];
    expect(rec.request.body_truncated).toBe(true);
    expect(rec.request.body.length).toBe(8);
    expect(rec.response.body_truncated).toBe(true);
    expect(rec.response.body.length).toBe(8);
    expect(rec.provider).toBe("codebuddy");
  });

  test("captures a streamed SSE response body in full when under cap", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
        controller.enqueue(encoder.encode('data: {"b":2}\n\n'));
        controller.close();
      },
    });
    const req = new Request("http://localhost/v1/messages", { method: "POST", body: "{}" });
    const capture = startTraceCapture(req, { dir })!;
    await capture.finish(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 3);

    const rec = readRecords(join(dir, `capture-${today()}.jsonl`))[0];
    expect(rec.provider).toBe("default");
    expect(rec.response.body).toContain('data: {"a":1}');
    expect(rec.response.body).toContain('data: {"b":2}');
    expect(rec.response.body_truncated).toBe(false);
  });
});
