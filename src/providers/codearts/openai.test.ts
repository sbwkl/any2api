import { test, expect, afterEach } from "bun:test";
import { createECDH } from "node:crypto";
import { OpenAIFacade } from "./openai";
import { SnapClient } from "./snap";

const old = { ...process.env };
afterEach(() => {
  process.env = { ...old };
});

/** 假的加密客户端：按真实语义为每次上游尝试扣一次共享预算（帧内重试据此收敛）。 */
function countAttempt(opts: any): void {
  if (opts?.budget) opts.budget.attempts++;
}

/** 记录每次 snap.chat 的入参；chat 收到的第 4 个参数是调用选项（含 signal）。 */
function makeRecordingFacade(
  chat: (...args: any[]) => Promise<Response>,
  opts: { refresh?: () => Promise<unknown> } = {},
): { facade: OpenAIFacade; calls: any[][]; refreshCalls: () => number } {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://example.test";
  const calls: any[][] = [];
  let refreshCount = 0;
  const snap = {
    chat: async (...args: any[]) => {
      calls.push(args);
      countAttempt(args[3]);
      return chat(...args);
    },
  } as any;
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry, fetch, {
    refresh: opts.refresh ? async () => { refreshCount++; return opts.refresh!(); } : undefined,
    retry: { sleep: async () => {}, random: () => 0 },
  });
  // 避免 HeartbeatManager 的 30s 定时器拖住测试进程
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
  return { facade, calls, refreshCalls: () => refreshCount };
}

/** 只关心门面行为的用例：不需要逐一检查 snap.chat 入参。 */
function makeFacade(chat: (...args: any[]) => Promise<Response>): OpenAIFacade {
  return makeRecordingFacade(chat).facade;
}

/** HTTP 200 + SSE 帧：非流式聚合看到的帧内错误。 */
function sseResponse(...frames: string[]): Response {
  return new Response(frames.map((f) => `data: ${f}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

const BUSY_FRAME = `{"error":{"code":"ModelArts.81101","message":"The model is busy, please retry later."}}`;
const RATE_LIMIT_FRAME = `{"error":{"code":"InferHub.ModelArts.81101.429","message":"Too many requests"}}`;

type UpstreamStep = { status: number; body?: string; headers?: Record<string, string> };

/**
 * 真 SnapClient + 脚本化假 fetch：状态级重试与门面帧内重试共用一份预算。
 * sleep/now/random 全部注入，测试不触网、不真实等待。
 */
function makeScriptedFacade(
  script: UpstreamStep[],
  opts: { refresh?: () => Promise<unknown> } = {},
): { facade: OpenAIFacade; chatCalls: string[]; refreshCalls: () => number; refreshSignals: () => unknown[] } {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://snap.test";
  const serverPublicKey = createECDH("prime256v1").generateKeys().toString("base64");
  const chatCalls: string[] = [];
  const refreshSignals: unknown[] = [];
  let refreshCount = 0;
  let index = 0;
  const fetchImpl: any = async (input: any) => {
    const url = String(input);
    if (url.endsWith("/api/v1/security/key-exchange"))
      return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
    chatCalls.push(url);
    const step = script[index++];
    if (!step) throw new Error("unscripted chat attempt");
    return new Response(step.body ?? "", { status: step.status, headers: step.headers });
  };
  const snap = new SnapClient("https://snap.test", fetchImpl, {
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
  });
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry, fetchImpl, {
    refresh: opts.refresh
      ? async (signal?: AbortSignal) => { refreshCount++; refreshSignals.push(signal); return opts.refresh!(); }
      : undefined,
    retry: { sleep: async () => {}, now: () => 0, random: () => 0 },
  });
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
  return { facade, chatCalls, refreshCalls: () => refreshCount, refreshSignals: () => refreshSignals };
}

function sseStep(...frames: string[]): UpstreamStep {
  return {
    status: 200,
    body: frames.map((f) => `data: ${f}\n\n`).join(""),
    headers: { "Content-Type": "text/event-stream" },
  };
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

const OK_SSE_STEP: UpstreamStep = { status: 200, body: okSse, headers: { "Content-Type": "text/event-stream" } };

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
  const resp = await facade.respond(body, { stream: false, sessionKey: "session" });
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
  const resp = await facade.respond(body, { stream: false, sessionKey: "session2" });
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
  const resp = await facade.respond(body, { stream: false, sessionKey: "session429" });
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
  const resp = await facade.respond(body, { stream: false, sessionKey: "session400" });
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
  const resp = await facade.respond(body, { stream: false, sessionKey: "session504" });
  expect(resp.status).toBe(504);
  expect(resp.headers.get("x-any2api-error-source")).toBe("proxy");
  const j: any = await resp.json();
  expect(j.error.message).toBe("Backend timeout");
  expect(j.error.type).toBe("server_error");
});

test("a reset during non-stream aggregation is reported without a replay", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return resetStream();
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionReset" });
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.type).toBe("server_error");
  // 裸网络故障不重试；聚合层不再有独立的一次尝试
  expect(calls).toBe(1);
});

test("an embedded Busy frame is retried with the rate-limit tier and can recover", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return calls === 1
      ? sseResponse(BUSY_FRAME)
      : new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionBusyRecover" });
  expect(resp.status).toBe(200);
  const j: any = await resp.json();
  expect(j.choices[0].message.content).toBe("OK");
  expect(calls).toBe(2);
});

test("the rate-limit ladder for an embedded Busy frame stops at ten total attempts", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return sseResponse(BUSY_FRAME);
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionBusyExhausted" });
  expect(resp.status).toBe(429);
  const j: any = await resp.json();
  expect(j.error.type).toBe("rate_limit_error");
  expect(j.error.message).toContain("ModelArts.81101");
  expect(calls).toBe(10);
});

test("force-plaintext frame retries also stop at ten upstream attempts", async () => {
  // 明文早退路径同样扣共享预算：否则帧内重试没有任何上界。
  process.env.CODEARTS_FORCE_PLAINTEXT = "1";
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://snap.test";
  let calls = 0;
  const fetchImpl: any = async () => {
    calls++;
    // 预算未扣时会无限重发：越过上限立即抛错，让用例快速失败而不是挂死
    if (calls > 20) throw new Error("unbounded plaintext retry");
    return sseResponse(BUSY_FRAME);
  };
  const snap = new SnapClient("https://snap.test", fetchImpl, {
    sleep: async () => {},
    now: () => 0,
    random: () => 0,
  });
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry, fetchImpl, {
    retry: { sleep: async () => {}, now: () => 0, random: () => 0 },
  });
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };

  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionPlainBudget" });

  expect(resp.status).toBe(429);
  expect(calls).toBe(10);
});

test("an embedded 429 frame is retried with the rate-limit tier", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return calls === 1
      ? sseResponse(RATE_LIMIT_FRAME)
      : new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionFrame429" });
  expect(resp.status).toBe(200);
  expect(calls).toBe(2);
});

test("an embedded APIG.0308 frame (top-level error_code) uses the rate-limit tier", async () => {
  // HTTP 429 观测到的 APIG.0308 也按结构化帧内错误码识别；不做正文关键词匹配。
  const apigFrame = `{"text":"[DONE]","error_code":"APIG.0308","error_msg":"Too many requests"}`;
  const { facade, chatCalls } = makeScriptedFacade([sseStep(apigFrame), OK_SSE_STEP]);
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionApigFrame" });
  expect(resp.status).toBe(200);
  expect(chatCalls).toHaveLength(2);
});

test("a need-switch-model header on a 429 stops retries with an explicit non-retryable error", async () => {
  const { facade, chatCalls } = makeScriptedFacade([
    { status: 429, body: "APIG.0308", headers: { "need-switch-model": "true" } },
    OK_SSE_STEP,
  ]);
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionNeedSwitch" });
  // 上游要求切换模型：不得被 429 长阶梯继续重试
  expect(chatCalls).toHaveLength(1);
  expect(resp.status).toBe(409);
  const j: any = await resp.json();
  expect(j.error.type).toBe("invalid_request_error");
  expect(j.error.message).toContain("need-switch-model");
  expect(j.error.message).toContain("does not support automatic model switching");
});

test("a need-switch-model header on a 2xx response is not treated as success", async () => {
  const { facade, chatCalls } = makeScriptedFacade([
    { status: 200, body: "ignored", headers: { "need-switch-model": "true" } },
  ]);
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionNeedSwitch200" });
  expect(chatCalls).toHaveLength(1);
  expect(resp.status).toBe(409);
  const j: any = await resp.json();
  expect(j.error.message).toContain("need-switch-model");
});

test("an embedded non-rate-limit error is reported without a retry", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return sseResponse(`{"error":{"code":"InferHub.001001005.400","message":"request param is invalid"}}`);
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionFrame400" });
  expect(resp.status).toBe(400);
  const j: any = await resp.json();
  expect(j.error.message).toContain("request param is invalid");
  expect(calls).toBe(1);
});

test("model content containing 429 or Busy is not mistaken for a frame error", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return new Response(
      [
        `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"got 429 Busy, retrying"}}]}`,
        "",
        `data:{"id":"1","created":1,"object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
        "",
        "data:[DONE]",
        "",
      ].join("\n"),
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionContentBuzz" });
  expect(resp.status).toBe(200);
  const j: any = await resp.json();
  expect(j.choices[0].message.content).toBe("got 429 Busy, retrying");
  expect(calls).toBe(1);
});

test("an idle-timeout failure during non-stream aggregation is not retried", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.error(new Error("upstream idle timeout after 180000ms")); },
    }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionIdleTimeout" });
  expect(resp.status).toBe(504);
  const j: any = await resp.json();
  expect(j.error.message).toContain("idle timeout");
  expect(calls).toBe(1);
});

test("a bare connection failure is not retried by the facade", async () => {
  let calls = 0;
  const facade = makeFacade(async () => {
    calls++;
    throw new Error("socket connection was closed");
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionConn" });
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.type).toBe("server_error");
  // 裸网络错误由 SnapClient 判不可重试；门面也不再叠加预算
  expect(calls).toBe(1);
});

test("one retry budget is shared by every snap call of a single inbound request", async () => {
  let calls = 0;
  const { facade, calls: recordings } = makeRecordingFacade(async () => {
    calls++;
    return calls === 1
      ? sseResponse(BUSY_FRAME)
      : new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionBudget" });
  expect(resp.status).toBe(200);
  expect(recordings).toHaveLength(2);
  const budget = recordings[0][3]?.budget;
  expect(budget).toBeDefined();
  expect(typeof budget.attempts).toBe("number");
  // 门面内层帧内重试与上游重试共用同一份预算，不会每次 chat 各起一份
  expect(recordings[1][3]?.budget).toBe(budget);
});

test("streaming requests also carry the shared budget to the snap client", async () => {
  const { facade, calls } = makeRecordingFacade(async () =>
    new Response(okSse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const resp = await facade.respond({ ...body, stream: true }, { stream: true, sessionKey: "sessionBudgetStream" });
  await resp.text();
  expect(calls).toHaveLength(1);
  expect(calls[0][3]?.budget).toBeDefined();
});

test("unknown model is rejected with 404 instead of falling back to models[0]", async () => {
  let upstreamCalled = false;
  const facade = makeFacade(async () => {
    upstreamCalled = true;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const resp = await facade.respond(
    { model: "zzz-no-such", messages: [{ role: "user", content: "hi" }] },
    { stream: false, sessionKey: "session3" },
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
  const resp = await facade.respond(body, { stream: true, sessionKey: "session4" });
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
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionAbortEntry", signal: controller.signal });
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
  const pending = facade.respond(body, { stream: false, sessionKey: "sessionAbortAgg", signal: controller.signal });
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
  const resp = await facade.respond({ ...body, stream: true }, { stream: true, sessionKey: "sessionAbortStream", signal: controller.signal });
  await startedP;
  controller.abort();
  await expect(resp.text()).rejects.toBeDefined();
  expect(calls).toHaveLength(1);
});

test("after a 401 response an aborted request does not refresh credentials or resend", async () => {
  const controller = new AbortController();
  let calls = 0;
  const { facade, refreshCalls } = makeRecordingFacade(
    async () => {
      calls++;
      // 上游返回 401 的同时客户端已断开：刷新与重发都必须放弃
      controller.abort();
      return new Response('{"error":"token expired"}', { status: 401, headers: { "Content-Type": "application/json" } });
    },
    { refresh: async () => ({}) },
  );
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionAbort401", signal: controller.signal });
  expect(resp.status).toBe(499);
  expect(calls).toBe(1);
  // 刷新前已中止 → 不发起令牌交换
  expect(refreshCalls()).toBe(0);
});

test("a 401 refresh resends once without consuming the transient retry budget", async () => {
  // 8×429 用掉长阶梯的 8 次；401 刷新后的重发不占预算，
  // 因此重发遇到的帧内 Busy 仍能在第 10 次总尝试内恢复。
  const script: UpstreamStep[] = [
    ...Array.from({ length: 8 }, () => ({ status: 429, body: "APIG.0308" }) as UpstreamStep),
    { status: 401, body: '{"error":"token expired"}' },
    sseStep(BUSY_FRAME),
    OK_SSE_STEP,
  ];
  const { facade, chatCalls, refreshCalls } = makeScriptedFacade(script, { refresh: async () => ({}) });

  const resp = await facade.respond(body, { stream: false, sessionKey: "session401Budget" });

  expect(resp.status).toBe(200);
  expect(refreshCalls()).toBe(1);
  // 8 次 429 + 1 次 401 + 1 次免费重发 + 1 次预算内重试
  expect(chatCalls).toHaveLength(11);
});

test("a 401 refresh still fires when the retry budget is exhausted", async () => {
  const script: UpstreamStep[] = [
    ...Array.from({ length: 9 }, () => ({ status: 429, body: "APIG.0308" }) as UpstreamStep),
    { status: 401, body: '{"error":"token expired"}' },
    OK_SSE_STEP,
  ];
  const { facade, chatCalls, refreshCalls } = makeScriptedFacade(script, { refresh: async () => ({}) });

  const resp = await facade.respond(body, { stream: false, sessionKey: "session401Exhausted" });

  expect(resp.status).toBe(200);
  expect(refreshCalls()).toBe(1);
  // 第 10 次尝试（预算已用满）返回 401，刷新后的重发仍然发出
  expect(chatCalls).toHaveLength(11);
});

test("a 401 refresh interrupted by a client abort still completes and does not resend", async () => {
  const controller = new AbortController();
  const { facade, chatCalls, refreshCalls, refreshSignals } = makeScriptedFacade(
    [{ status: 401, body: '{"error":"token expired"}' }],
    {
      refresh: async () => {
        // 客户端在令牌交换期间断开：刷新不接收入站信号，仍然完成并回写轮换后的 refresh_token
        controller.abort();
        return {};
      },
    },
  );

  const resp = await facade.respond(body, { stream: false, sessionKey: "session401AbortRefresh", signal: controller.signal });

  expect(resp.status).toBe(499);
  expect(refreshCalls()).toBe(1);
  // 刷新签名不再有 signal 参数：中止会让已轮换的 refresh_token 无法回写
  expect(refreshSignals()).toEqual([undefined]);
  // 刷新完成后已中止：不重发上游 chat
  expect(chatCalls).toHaveLength(1);
});

test("non-stream HTTP 429 / embedded Busy use the ten-attempt rate-limit tier", async () => {
  // 真 SnapClient：429 由加密客户端在共享预算内重试到长阶梯上限
  const http429 = makeScriptedFacade(Array.from({ length: 10 }, () => ({ status: 429, body: "APIG.0308" })));
  const resp429 = await http429.facade.respond(body, { stream: false, sessionKey: "sessionHttp429Tier" });
  expect(resp429.status).toBe(429);
  expect(http429.chatCalls).toHaveLength(10);

  // 帧内 Busy：门面在同一份预算内重试，同样是 10 次总尝试（不分层放大）
  const busy = makeScriptedFacade(Array.from({ length: 10 }, () => sseStep(BUSY_FRAME)));
  const respBusy = await busy.facade.respond(body, { stream: false, sessionKey: "sessionBusyTier" });
  expect(respBusy.status).toBe(429);
  const j: any = await respBusy.json();
  expect(j.error.type).toBe("rate_limit_error");
  expect(j.error.message).toContain("ModelArts.81101");
  expect(busy.chatCalls).toHaveLength(10);
});

test("non-stream HTTP 503 uses the three-attempt server tier", async () => {
  const { facade, chatCalls } = makeScriptedFacade(
    Array.from({ length: 3 }, () => ({ status: 503, body: "APIG.0613" })),
  );
  const resp = await facade.respond(body, { stream: false, sessionKey: "session503Tier" });
  expect(resp.status).toBe(503);
  // 短阶梯 3 次总尝试；门面不叠加独立重试，最坏请求次数不会变成 6
  expect(chatCalls).toHaveLength(3);
});

test("mixed HTTP and frame retries stop at the same ten total attempts", async () => {
  // 3 次 HTTP 429 之后连续 7 次帧内 Busy：预算用尽即停，总尝试次数不被分层放大。
  const { facade, chatCalls } = makeScriptedFacade([
    { status: 429, body: "APIG.0308" },
    { status: 429, body: "APIG.0308" },
    { status: 429, body: "APIG.0308" },
    ...Array.from({ length: 7 }, () => sseStep(BUSY_FRAME)),
  ]);
  const resp = await facade.respond(body, { stream: false, sessionKey: "sessionMixedTier" });
  expect(resp.status).toBe(429);
  expect(chatCalls).toHaveLength(10);
});

test("streaming retries non-2xx before any byte reaches the client", async () => {
  const { facade, chatCalls } = makeScriptedFacade([
    { status: 503, body: "APIG.0613" },
    { status: 503, body: "APIG.0613" },
    OK_SSE_STEP,
  ]);
  const resp = await facade.respond({ ...body, stream: true }, { stream: true, sessionKey: "sessionStreamPreByte" });
  expect(resp.status).toBe(200);
  await resp.text();
  expect(chatCalls).toHaveLength(3);
});

test("streaming surfaces a mid-stream failure without replaying after bytes", async () => {
  let calls = 0;
  const { facade } = makeRecordingFacade(async () => {
    calls++;
    return resetStream();
  });
  const resp = await facade.respond({ ...body, stream: true }, { stream: true, sessionKey: "sessionStreamPostByte" });
  expect(resp.status).toBe(200);
  // 首帧已经到达客户端；读取失败只上报，不再发第二次上游请求
  await expect(resp.text()).rejects.toBeDefined();
  expect(calls).toBe(1);
});