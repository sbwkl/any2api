import { test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRequestTrace, type FetchLike } from "../../shared/trace";
import { fetchPolicyModels } from "./config";

const old = { ...process.env };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "any2api-codearts-cfg-"));
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

function recordedHeader(headers: Record<string, string>, name: string): string | null {
  const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : null;
}

const creds = { ak: "test-ak", sk: "test-sk", securityToken: "" };

test("policy/bundle discovery uses the injected fetch and the shared request entry", async () => {
  const calls: string[] = [];
  const fake = (async (input: any) => {
    calls.push(String(input));
    return Response.json({
      plugin_config: [{ config: [{ user_model_list: [{ model_id: "glm-x", model_name: "GLM-X", input_length: 128000 }] }] }],
    });
  }) as FetchLike;

  const trace = startRequestTrace(inbound(), { dir })!;
  let models: Awaited<ReturnType<typeof fetchPolicyModels>> = [];
  try {
    models = await fetchPolicyModels(creds, fake);
  } finally {
    await trace.finish(Response.json({ ok: true }));
  }

  expect(calls).toHaveLength(1);
  expect(models).toEqual([{ modelId: "glm-x", modelName: "GLM-X", endpoint: "", inputLength: 128000 }]);

  const upstream = readRecords()[0].upstream;
  expect(upstream).toHaveLength(1);
  expect(upstream[0].method).toBe("POST");
  expect(upstream[0].url.endsWith("/v1/policy/bundle")).toBe(true);
  expect(upstream[0].body.plugin_name).toBe("snap_vscode");
  expect(recordedHeader(upstream[0].headers, "authorization")).toBe("<redacted>");
  expect(upstream[0].response.status).toBe(200);
});
