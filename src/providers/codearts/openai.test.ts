import { test, expect, afterEach } from "bun:test";
import { OpenAIFacade } from "./openai";

const old = { ...process.env };
afterEach(() => {
  process.env = { ...old };
});

function makeFacade(chat: () => Promise<Response>): OpenAIFacade {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://example.test";
  const snap = { chat } as any;
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry);
  // 避免 HeartbeatManager 的 30s 定时器拖住测试进程
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
  return facade;
}

const body = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("empty SSE on a non-stream request becomes 502", async () => {
  const facade = makeFacade(async () =>
    new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const resp = await facade.respond(body, false, "session");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.message).toContain("upstream_error");
  expect(j.error.type).toBe("upstream_error");
});

test("error-only SSE on a non-stream request becomes 502", async () => {
  const facade = makeFacade(async () =>
    new Response('data: {"error":{"message":"bad"}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
  const resp = await facade.respond(body, false, "session2");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.type).toBe("upstream_error");
});

test("unknown model is rejected with 404 instead of falling back to models[0]", async () => {
  let upstreamCalled = false;
  const facade = makeFacade(async () => {
    upstreamCalled = true;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const resp = await facade.respond(
    { model: "zzz-no-such", messages: [{ role: "user", content: "hi" }] },
    false,
    "session3",
  );
  expect(upstreamCalled).toBe(false);
  expect(resp.status).toBe(404);
  expect(resp.headers.get("x-any2api-error-source")).toBe("proxy");
  const j: any = await resp.json();
  expect(j.error.type).toBe("invalid_request_error");
  expect(j.error.message).toContain("model_not_found");
});

test("streaming response moves usage off the finish chunk", async () => {
  const sse = [
    `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}`,
    "",
    `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`,
    "",
    "data:[DONE]",
    "",
  ].join("\n");
  const facade = makeFacade(async () =>
    new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const resp = await facade.respond(body, true, "session4");
  expect(resp.status).toBe(200);
  const text = await resp.text();
  const frames = text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d));
  const usageFrames = frames.filter((f: any) => f.usage);
  expect(usageFrames).toHaveLength(1);
  expect(usageFrames[0].choices).toEqual([]);
  const finish = frames.find((f: any) => f.choices?.[0]?.finish_reason === "stop");
  expect(finish.usage ?? null).toBeNull();
});