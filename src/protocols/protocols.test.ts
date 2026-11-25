import { test, expect, describe } from "bun:test";
import { createProtocolRoutes } from "./index";
import { responsesToOpenAi } from "./responses";
import { PROXY_ERROR_HEADER } from "../shared/errors";
import type { ChatBackend } from "./types";

const completion = {
  id: "1", model: "m", created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

function makeBackend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    models: () => [{ id: "m" }],
    health: () => ({ ok: true, custom: 1 }),
    handleChat: () => new Response("chat"),
    respond: async () => Response.json(completion),
    ...overrides,
  };
}

function dispatch(routes: ReturnType<typeof createProtocolRoutes>, path: string, method: string, body?: any): Promise<Response> {
  const route = routes.find((r) => r.path === path && r.method === method);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return Promise.resolve(route.handle(req));
}

describe("shared protocol routes (codearts capabilities)", () => {
  const routes = createProtocolRoutes(makeBackend(), { toolChoice: "full", normalizeErrors: false });

  test("GET /v1/models returns the backend model list", async () => {
    const resp = await dispatch(routes, "/v1/models", "GET");
    const j: any = await resp.json();
    expect(j.object).toBe("list");
    expect(j.data[0].id).toBe("m");
  });

  test("Anthropic any tool_choice maps to required and returns a message", async () => {
    let seen: any;
    const local = createProtocolRoutes(makeBackend({
      respond: async (body) => { seen = body; return Response.json(completion); },
    }), { toolChoice: "full", normalizeErrors: false });
    const resp = await dispatch(local, "/v1/messages", "POST", {
      model: "m",
      max_tokens: 10,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "f", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    });
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.type).toBe("message");
    expect(seen.tool_choice).toBe("required");
  });

  test("Anthropic passthrough returns the provider error unchanged", async () => {
    const local = createProtocolRoutes(makeBackend({
      respond: async () => Response.json({ code: 123, msg: "bad" }, { status: 400 }),
    }), { toolChoice: "full", normalizeErrors: false });
    const resp = await dispatch(local, "/v1/messages", "POST", {
      model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    expect(j.code).toBe(123);
  });

  test("proxy-generated errors are normalized for Anthropic even when normalizeErrors is false", async () => {
    const local = createProtocolRoutes(makeBackend({
      respond: async () => Response.json(
        { error: { message: "model_not_found: nope", type: "invalid_request_error", code: null } },
        { status: 404, headers: { [PROXY_ERROR_HEADER]: "proxy" } },
      ),
    }), { toolChoice: "full", normalizeErrors: false });
    const resp = await dispatch(local, "/v1/messages", "POST", {
      model: "nope", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(404);
    const j: any = await resp.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toContain("model_not_found");
  });

  test("Responses full tool_choice supports required and returns a response", async () => {
    let seen: any;
    const local = createProtocolRoutes(makeBackend({
      respond: async (body) => { seen = body; return Response.json(completion); },
    }), { toolChoice: "full", normalizeErrors: false });
    const resp = await dispatch(local, "/v1/responses", "POST", {
      model: "m",
      input: "hi",
      tools: [{ type: "function", name: "f", parameters: { type: "object" } }],
      tool_choice: "required",
    });
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.object).toBe("response");
    expect(seen.tool_choice).toBe("required");
  });

  test("Responses passthrough returns the provider error unchanged", async () => {
    const local = createProtocolRoutes(makeBackend({
      respond: async () => Response.json({ code: 123, msg: "bad" }, { status: 400 }),
    }), { toolChoice: "full", normalizeErrors: false });
    const resp = await dispatch(local, "/v1/responses", "POST", { model: "m", input: "hi" });
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    expect(j.code).toBe(123);
  });

  test("GET /healthz returns backend health", async () => {
    const resp = await dispatch(routes, "/healthz", "GET");
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.custom).toBe(1);
  });

  test("backend exceptions become 502 on Anthropic and Responses", async () => {
    const local = createProtocolRoutes(makeBackend({
      respond: async () => { throw new Error("network down"); },
    }), { toolChoice: "full", normalizeErrors: true });
    const a = await dispatch(local, "/v1/messages", "POST", {
      model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }],
    });
    expect(a.status).toBe(502);
    const r = await dispatch(local, "/v1/responses", "POST", { model: "m", input: "hi" });
    expect(r.status).toBe(502);
  });

  test("malformed Anthropic and Responses bodies return 400", async () => {
    const local = createProtocolRoutes(makeBackend(), { normalizeErrors: true });
    const a1 = await dispatch(local, "/v1/messages", "POST", { model: "m", max_tokens: 1, messages: {} });
    expect(a1.status).toBe(400);
    const a2 = await dispatch(local, "/v1/messages", "POST", {
      model: "m", max_tokens: 1, messages: [{ role: "user", content: 123 }],
    });
    expect(a2.status).toBe(400);
    const a3 = await dispatch(local, "/v1/messages", "POST", {
      model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }], metadata: { user_id: 123 },
    });
    expect(a3.status).toBe(400);
    const r1 = await dispatch(local, "/v1/responses", "POST", { model: "m", input: {} });
    expect(r1.status).toBe(400);
    const r2 = await dispatch(local, "/v1/responses", "POST", { model: "m", input: "hi", session_id: 123 });
    expect(r2.status).toBe(400);
    const r3 = await dispatch(local, "/v1/responses", "POST", {
      model: "m", input: [{ type: "message", role: "user", content: 123 }],
    });
    expect(r3.status).toBe(400);
    const r4 = await dispatch(local, "/v1/responses", "POST", {
      model: "m", input: [{ type: "message", role: "user", content: [123] }],
    });
    expect(r4.status).toBe(400);
  });

  test("normalized errors use status-aligned types", async () => {
    const make = (status: number) => createProtocolRoutes(makeBackend({
      respond: async () => Response.json({ code: status, msg: "x" }, { status }),
    }), { normalizeErrors: true });

    const a = await dispatch(make(400), "/v1/messages", "POST", {
      model: "m", max_tokens: 1, messages: [{ role: "user", content: "hi" }],
    });
    expect(a.status).toBe(400);
    expect((await a.json() as any).error.type).toBe("invalid_request_error");

    const r = await dispatch(make(429), "/v1/responses", "POST", { model: "m", input: "hi" });
    expect((await r.json() as any).error.type).toBe("rate_limit_error");

    const s = await dispatch(make(502), "/v1/responses", "POST", { model: "m", input: "hi" });
    expect((await s.json() as any).error.type).toBe("upstream_error");
  });

  test("a single Responses function_call stays one assistant message with one tool_call", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
    });
    expect(out.messages.map((m: any) => m.role)).toEqual(["assistant", "tool"]);
    expect(out.messages[0].tool_calls).toHaveLength(1);
    expect(out.messages[0].tool_calls[0]).toMatchObject({
      id: "c1",
      type: "function",
      function: { name: "f", arguments: '{"x":1}' },
    });
    expect(out.messages[1].tool_call_id).toBe("c1");
  });

  test("Responses input_image becomes an image_url part", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "color?" },
          { type: "input_image", image_url: "data:image/png;base64,QUJD", detail: "auto" },
        ],
      }],
    });
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "color?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
    ]);
  });

  test("Responses text-only content stays a plain string", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_text", text: "a" }, { type: "input_text", text: "b" }] }],
    });
    expect(out.messages[0].content).toBe("ab");
  });

  test("Responses input_image without a URL keeps a diagnostic placeholder", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_image", file_id: "file-1" }] }],
    });
    expect(JSON.stringify(out.messages[0].content)).toContain("[image omitted");
  });

  test("Responses stream emits output_text.done before content_part.done", async () => {
    const sse = 'data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}\n\n';
    const local = createProtocolRoutes(makeBackend({
      respond: async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }), { normalizeErrors: true });
    const resp = await dispatch(local, "/v1/responses", "POST", { model: "m", input: "hi", stream: true });
    const text = await resp.text();
    const doneAt = text.indexOf("event: response.output_text.done");
    const partAt = text.indexOf("event: response.content_part.done");
    expect(doneAt).toBeGreaterThanOrEqual(0);
    expect(partAt).toBeGreaterThan(doneAt);
    expect(text).toContain('"text":"hi"');
  });

  test("consecutive Responses function_call items merge into one assistant message", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok1" },
        { type: "function_call_output", call_id: "c2", output: "ok2" },
      ],
    });
    expect(out.messages.map((m: any) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect(out.messages[0].tool_calls.map((tc: any) => tc.id)).toEqual(["c1", "c2"]);
    expect(out.messages[1].tool_call_id).toBe("c1");
    expect(out.messages[2].tool_call_id).toBe("c2");
  });

  test("reasoning between function_call items does not split the tool-call group", () => {
    const out = responsesToOpenAi({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "f", arguments: "{}" },
        { type: "reasoning", id: "rs", summary: [] },
        { type: "function_call", call_id: "c2", name: "g", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "function_call_output", call_id: "c2", output: "ok" },
      ],
    });
    expect(out.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(out.messages[0].tool_calls).toHaveLength(2);
  });

  test("Responses accepts reasoning content null and ignores non-message content", async () => {
    const local = createProtocolRoutes(makeBackend(), { normalizeErrors: true });

    const reasoning = await dispatch(local, "/v1/responses", "POST", {
      model: "m",
      input: [
        { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "think" }], content: null, encrypted_content: null },
        { type: "message", role: "user", content: "hi" },
      ],
    });
    expect(reasoning.status).toBe(200);

    const messageNull = await dispatch(local, "/v1/responses", "POST", {
      model: "m",
      input: [{ type: "message", role: "user", content: null }],
    });
    expect(messageNull.status).toBe(200);

    const nonMessageBad = await dispatch(local, "/v1/responses", "POST", {
      model: "m",
      input: [{ type: "reasoning", content: 123 }],
    });
    expect(nonMessageBad.status).toBe(200);
  });

  test("thinking mapping can be disabled per provider", async () => {
    let seen: any;
    const local = createProtocolRoutes(makeBackend({
      respond: async (body) => {
        seen = body;
        return Response.json(completion);
      },
    }), { normalizeErrors: true, thinkingToEffort: false });

    const resp = await dispatch(local, "/v1/messages", "POST", {
      model: "m",
      max_tokens: 10,
      thinking: { type: "enabled", budget_tokens: 4096 },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(resp.status).toBe(200);
    expect(seen.reasoning_effort).toBeUndefined();
  });

  test("thinking output can be disabled per provider", async () => {
    const withReasoning = {
      id: "1",
      model: "m",
      created: 1,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi", reasoning_content: "think" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const make = (caps: ProtocolCapabilities) =>
      createProtocolRoutes(makeBackend({ respond: async () => Response.json(withReasoning) }), caps);
    const body = {
      model: "m",
      max_tokens: 10,
      thinking: { type: "enabled", budget_tokens: 1024 },
      messages: [{ role: "user", content: "hi" }],
    };

    const withThinking = await dispatch(make({ normalizeErrors: true, thinking: true }), "/v1/messages", "POST", body);
    expect((await withThinking.json() as any).content.some((b: any) => b.type === "thinking")).toBe(true);

    const without = await dispatch(make({ normalizeErrors: true, thinking: false }), "/v1/messages", "POST", body);
    expect((await without.json() as any).content.some((b: any) => b.type === "thinking")).toBe(false);
  });

  test("Anthropic streaming handles a final chunk without a newline", async () => {
    const sse = 'data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}';
    const local = createProtocolRoutes(makeBackend({
      respond: async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }), { normalizeErrors: true });
    const resp = await dispatch(local, "/v1/messages", "POST", {
      model: "m", max_tokens: 10, stream: true, messages: [{ role: "user", content: "hi" }],
    });
    const text = await resp.text();
    expect(text).toContain("hi");
  });

  test("Anthropic usage only subtracts cached tokens with promptTokensIncludeCache", async () => {
    const withCache = {
      ...completion,
      usage: { prompt_tokens: 31, completion_tokens: 5, total_tokens: 36, prompt_tokens_details: { cached_tokens: 7 } },
    };
    const backend = makeBackend({ respond: async () => Response.json(withCache) });
    const plain = createProtocolRoutes(backend, { toolChoice: "full", normalizeErrors: false });
    const withCap = createProtocolRoutes(backend, { toolChoice: "auto-only", normalizeErrors: true, promptTokensIncludeCache: true });
    const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const a: any = await (await dispatch(plain, "/v1/messages", "POST", body)).json();
    const b: any = await (await dispatch(withCap, "/v1/messages", "POST", body)).json();
    expect(a.usage.input_tokens).toBe(31);
    expect(b.usage.input_tokens).toBe(24);
  });
});

// 共享路由 usage 映射（provider 无关）：能力位用内联对象，
// prompt_tokens=31 / cached=7 / creation=2 时 input_tokens=22；流式最终 usage 同语义。
describe("shared Anthropic usage mapping", () => {
  const usage = {
    prompt_tokens: 31,
    completion_tokens: 5,
    total_tokens: 36,
    prompt_tokens_details: { cached_tokens: 7, cache_creation_tokens: 2 },
  };
  const withUsage = { ...completion, usage };
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
  const caps = { toolChoice: "full" as const, normalizeErrors: false, promptTokensIncludeCache: true };

  function messageDeltaUsage(text: string): any {
    const line = text.split("\n").find((l) => l.startsWith('data: {"type":"message_delta"'));
    if (!line) throw new Error("no message_delta frame");
    return JSON.parse(line.slice("data: ".length)).usage;
  }

  test("non-stream usage reports uncached input_tokens and preserves cache parts", async () => {
    const local = createProtocolRoutes(makeBackend({ respond: async () => Response.json(withUsage) }), caps);
    const j: any = await (await dispatch(local, "/v1/messages", "POST", body)).json();
    expect(j.usage.input_tokens).toBe(22);
    expect(j.usage.cache_read_input_tokens).toBe(7);
    expect(j.usage.cache_creation_input_tokens).toBe(2);
  });

  test("streaming final usage reports the same uncached input_tokens semantics", async () => {
    const local = createProtocolRoutes(makeBackend({
      respond: async () => new Response([
        `data: ${JSON.stringify({ id: "1", model: "m", created: 1, choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}`,
        "",
        `data: ${JSON.stringify({ id: "1", model: "m", created: 1, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}`,
        "",
        "data: [DONE]",
        "",
      ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }), caps);
    const text = await (await dispatch(local, "/v1/messages", "POST", { ...body, stream: true })).text();
    const u = messageDeltaUsage(text);
    expect(u.input_tokens).toBe(22);
    expect(u.cache_read_input_tokens).toBe(7);
    expect(u.cache_creation_input_tokens).toBe(2);
  });
});