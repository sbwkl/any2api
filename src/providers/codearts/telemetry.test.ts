import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRequestTrace, type FetchLike } from "../../shared/trace";
import { TelemetrySimulator } from "./telemetry";

const old = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "any2api-codearts-tel-"));
  process.env.CODEARTS_CLI_AK = "test-ak";
  process.env.CODEARTS_CLI_SK = "test-sk";
  delete process.env.TRACE_CAPTURE_DIR;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...old };
});

function inbound(): Request {
  return new Request("http://localhost/codearts/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

function readRecords(): any[] {
  const file = join(dir, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(2);
  }
}

test("telemetry flushes inside a request context never enter the request record", async () => {
  const calls: string[] = [];
  const fake = (async (input: any) => {
    calls.push(String(input));
    return Response.json({ ok: true });
  }) as FetchLike;

  const trace = startRequestTrace(inbound(), { dir })!;
  const sim = new TelemetrySimulator(true, "codeagent-kernel", fake);
  try {
    // 批量满 30 条会在请求上下文内同步触发 flush（5s 定时器路径同样直接用原始 fetch）
    for (let i = 0; i < 30; i++) {
      sim.recordChat({
        traceId: "t",
        spanId: "s",
        startMs: Date.now(),
        endMs: Date.now(),
        otFunction: "agent-claw",
        modelId: "m",
      });
    }
    await waitFor(() => calls.length >= 2);
  } finally {
    clearInterval((sim as any).timer);
    await trace.finish(Response.json({ ok: true }));
  }

  expect(calls).toHaveLength(2);
  expect(calls.every((u) => u.startsWith("https://collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/"))).toBe(true);
  const rec = readRecords()[0];
  expect(rec.upstream).toEqual([]);
});
