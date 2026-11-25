import { test, expect, describe } from "bun:test";
import { createProtocolRoutes } from "../../protocols";
import { CODEARTS_PROTOCOL_CAPABILITIES } from "./protocol-capabilities";
import type { ChatBackend } from "../../protocols/types";

const completion = {
  id: "1", model: "m", created: 1,
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const usage = {
  prompt_tokens: 31,
  completion_tokens: 5,
  total_tokens: 36,
  prompt_tokens_details: { cached_tokens: 7, cache_creation_tokens: 2 },
};

function makeBackend(overrides: Partial<ChatBackend> = {}): ChatBackend {
  return {
    models: () => [{ id: "m" }],
    health: () => ({ ok: true }),
    handleChat: async () => new Response("chat"),
    respond: async () => Response.json({ ...completion, usage }),
    ...overrides,
  };
}

function messageDeltaUsage(text: string): any {
  const line = text.split("\n").find((l) => l.startsWith('data: {"type":"message_delta"'));
  if (!line) throw new Error("no message_delta frame");
  return JSON.parse(line.slice("data: ".length)).usage;
}

describe("CodeArts protocol capabilities", () => {
  const body = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };

  test("CodeArts capability declares promptTokensIncludeCache = true", () => {
    expect(CODEARTS_PROTOCOL_CAPABILITIES.promptTokensIncludeCache).toBe(true);
  });

  test("CodeArts non-stream Anthropic usage reports uncached input_tokens and preserves cache parts", async () => {
    const routes = createProtocolRoutes(makeBackend(), CODEARTS_PROTOCOL_CAPABILITIES);
    const route = routes.find((r) => r.path === "/v1/messages" && r.method === "POST")!;
    const resp = await route.handle(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    const j: any = await resp.json();
    expect(j.usage.input_tokens).toBe(22);
    expect(j.usage.cache_read_input_tokens).toBe(7);
    expect(j.usage.cache_creation_input_tokens).toBe(2);
  });

  test("CodeArts streaming merges multi-frame usage without zeroing cache parts", async () => {
    const frames = [
      `data: ${JSON.stringify({
        id: "1", model: "m", created: 1,
        choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 31, prompt_tokens_details: { cached_tokens: 7, cache_creation_tokens: 0 } },
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "1", model: "m", created: 1,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 31, prompt_tokens_details: { cached_tokens: 7, cache_creation_tokens: 2 } },
      })}`,
      "",
      "data: [DONE]",
      "",
    ];
    const routes = createProtocolRoutes(makeBackend({
      respond: async () => new Response(frames.join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    }), CODEARTS_PROTOCOL_CAPABILITIES);
    const route = routes.find((r) => r.path === "/v1/messages" && r.method === "POST")!;
    const resp = await route.handle(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
    }));
    const text = await resp.text();
    const u = messageDeltaUsage(text);
    expect(u.input_tokens).toBe(22);
    expect(u.cache_read_input_tokens).toBe(7);
    expect(u.cache_creation_input_tokens).toBe(2);
  });
});