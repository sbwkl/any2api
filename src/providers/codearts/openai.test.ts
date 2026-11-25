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

const okSse = [
  `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"}}]}`,
  "",
  `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`,
  "",
  "data:[DONE]",
  "",
].join("\n");

/** 上游先吐一点内容，再以连接重置终止 */
function resetStream(): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"par"}}]}\n\n`));
      ctrl.error(new Error("ECONNRESET: The socket connection was closed unexpectedly."));
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

test("empty SSE on a non-stream request becomes 502", async () => {
  const facade = makeFacade(async () =>
    new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const resp = await facade.respond(body, false, "session");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.message).toContain("no choices");
  expect(j.error.type).toBe("server_error");
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
  expect(j.error.type).toBe("server_error");
});

test("an embedded 429 inside a 200 SSE becomes a 429 rate_limit error", async () => {
  const facade = makeFacade(async () =>
    new Response('data: {"error":{"code":"InferHub.ModelArts.81101.429","message":"Too many requests"}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
  const resp = await facade.respond(body, false, "session429");
  expect(resp.status).toBe(429);
  expect(resp.headers.get("x-any2api-error-source")).toBe("proxy");
  const j: any = await resp.json();
  expect(j.error.type).toBe("rate_limit_error");
  expect(j.error.message).toContain("429");
});

test("an embedded 400 inside a 200 SSE is not retried and becomes a 400", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return new Response('data: {"error":{"code":"InferHub.001001005.400","message":"request param is invalid"}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  });
  const resp = await facade.respond(body, false, "session400");
  expect(resp.status).toBe(400);
  const j: any = await resp.json();
  expect(j.error.type).toBe("invalid_request_error");
  expect(calls).toBe(1);
});

test("a non-2xx upstream status becomes a proxy error with the upstream message", async () => {
  const facade = makeFacade(async () =>
    new Response(JSON.stringify({ error_msg: "Backend timeout", error_code: "APIG.0203" }), {
      status: 504,
      headers: { "Content-Type": "application/json" },
    }));
  const resp = await facade.respond(body, false, "session504");
  expect(resp.status).toBe(504);
  expect(resp.headers.get("x-any2api-error-source")).toBe("proxy");
  const j: any = await resp.json();
  expect(j.error.message).toBe("Backend timeout");
  expect(j.error.type).toBe("server_error");
});

test("a transient reset during non-stream aggregation is retried once", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return calls === 1
      ? resetStream()
      : new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, false, "sessionRetry");
  expect(resp.status).toBe(200);
  const j: any = await resp.json();
  expect(j.choices[0].message.content).toBe("OK");
  expect(calls).toBe(2);
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
  expect(j.error.type).toBe("not_found_error");
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