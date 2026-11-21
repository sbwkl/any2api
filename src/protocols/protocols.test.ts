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
  const routes = createProtocolRoutes(makeBackend(), { toolChoice: "full", errorShape: "passthrough" });

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
    }), { toolChoice: "full", errorShape: "passthrough" });
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
    }), { toolChoice: "full", errorShape: "passthrough" });
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
    }), { toolChoice: "full", errorShape: "passthrough" });
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
    }), { toolChoice: "full", errorShape: "passthrough" });
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
});