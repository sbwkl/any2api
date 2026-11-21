import { test, expect, describe } from "bun:test";
import { createProtocolRoutes } from "./index";
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
});