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

/** 记录每次 snap.chat 的入参；chat 收到的第 4 个参数是调用选项（含 signal）。 */
function makeRecordingFacade(chat: (...args: any[]) => Promise<Response>): { facade: OpenAIFacade; calls: any[][] } {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://example.test";
  const calls: any[][] = [];
  const snap = {
    chat: async (...args: any[]) => {
      calls.push(args);
      return chat(...args);
    },
  } as any;
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry);
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
  return { facade, calls };
}

/** 上游先吐一帧，客户端取消时让流以 AbortError 终止；不取消则永不结束。 */
function abortableSse(signal: AbortSignal): Response {
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(`data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"par"}}]}\n\n`));
      signal.addEventListener("abort", () => ctrl.error(new DOMException("aborted", "AbortError")));
    },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
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

test("empty SSE on a non-stream request becomes 502 without a retry", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, false, "session");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.message).toContain("no choices");
  expect(j.error.type).toBe("server_error");
  // 真空流不是瞬时网络故障：只发一次上游请求
  expect(calls).toBe(1);
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

test("a connection failure is retried by the snap layer only, not again by the facade", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    throw new Error("socket connection was closed");
  });
  const resp = await facade.respond(body, false, "sessionConn");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.type).toBe("server_error");
  // SnapClient 内部已有一次同 key 重试；门面不再叠加预算
  expect(calls).toBe(1);
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

test("handleChat forwards the inbound abort signal to the snap chat call", async () => {
  const controller = new AbortController();
  const { facade, calls } = makeRecordingFacade(async () =>
    new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const req = new Request("http://localhost/codearts/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true }),
    signal: controller.signal,
  });
  const resp = await facade.handleChat(req);
  expect(resp.status).toBe(200);
  await resp.text();
  expect(calls).toHaveLength(1);
  // 第 4 个参数是 snap.chat 的调用选项；它必须与入站请求绑定同一条取消链
  expect(calls[0][3]?.signal).toBeDefined();
  controller.abort();
  expect(calls[0][3].signal.aborted).toBe(true);
});

test("an already-aborted request never calls the upstream chat", async () => {
  const controller = new AbortController();
  controller.abort();
  const { facade, calls } = makeRecordingFacade(async () => Response.json({ ok: true }));
  const resp = await facade.respond(body, false, "sessionAbortEntry", controller.signal);
  expect(resp.status).toBe(499);
  expect(calls).toHaveLength(0);
});

test("aborting during non-stream aggregation stops without retrying or re-requesting", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const { facade, calls } = makeRecordingFacade(async () => {
    started();
    return abortableSse(controller.signal);
  });
  const pending = facade.respond(body, false, "sessionAbortAgg", controller.signal);
  await startedP;
  controller.abort();
  const resp = await pending;
  expect(resp.status).toBe(499);
  // 取消不得触发外层重试，也不得再发第二次上游请求
  expect(calls).toHaveLength(1);
});

test("aborting during a streamed response leaves exactly one upstream request", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const startedP = new Promise<void>((resolve) => { started = resolve; });
  const { facade, calls } = makeRecordingFacade(async () => {
    started();
    return abortableSse(controller.signal);
  });
  const resp = await facade.respond({ ...body, stream: true }, true, "sessionAbortStream", controller.signal);
  await startedP;
  controller.abort();
  await expect(resp.text()).rejects.toBeDefined();
  expect(calls).toHaveLength(1);
});

test("after a 401 response an aborted request does not refresh credentials or resend", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { facade } = makeRecordingFacade(async () => {
    calls++;
    // 上游返回 401 的同时客户端已断开：刷新与重发都必须放弃
    controller.abort();
    return new Response('{"error":"token expired"}', { status: 401, headers: { "Content-Type": "application/json" } });
  });
  const resp = await facade.respond(body, false, "sessionAbort401", controller.signal);
  expect(resp.status).toBe(499);
  expect(calls).toBe(1);
});