// Anthropic → OpenAI chat 消息组装的回归测试（真实流量形状）
// 证据见 docs/exec-plans/active/2026-11-24-anthropic-tool-assembly.md
import { test, expect, describe } from "bun:test";
import { anthropicToOpenAi, handleAnthropicMessages } from "./anthropic";
import type { ChatBackend, ProtocolCapabilities } from "./types";

const CAPS: ProtocolCapabilities = { toolChoice: "auto-only", normalizeErrors: true, thinking: true, promptTokensIncludeCache: true };

function backendWith(sse: string): ChatBackend {
  return {
    models: () => [],
    health: () => ({ ok: true }),
    handleChat: () => new Response("no"),
    respond: async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  };
}

async function messagesWith(body: any, sse = "data: [DONE]\n\n"): Promise<any[]> {
  let seen: any;
  const backend = backendWith(sse);
  backend.respond = async (b) => {
    seen = b;
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  await handleAnthropicMessages(backend, new Request("http://localhost/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 16, ...body }),
  }), CAPS);
  return seen.messages;
}

const BASE = { model: "m", max_tokens: 16 };
const TOOL = (id: string, name = "f") => ({ type: "tool_use", id, name, input: { x: 1 } });
const RESULT = (id: string, content: any = "ok") => ({ type: "tool_result", tool_use_id: id, content });
const PNG = { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } };

describe("anthropic contentToOpenAi assembly", () => {
  test("text and tool_use in one assistant turn stay one message", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "hello" }, TOOL("tu1")] },
        { role: "user", content: [RESULT("tu1")] },
      ],
    }, CAPS);
    expect(out.messages[1]).toMatchObject({ role: "assistant", content: "hello" });
    expect(out.messages[1].tool_calls).toHaveLength(1);
    expect(out.messages[1].tool_calls[0].function.name).toBe("f");
    expect(out.messages[2]).toEqual({ role: "tool", tool_call_id: "tu1", content: "ok" });
  });

  test("parallel tool_use blocks share one assistant message and results keep order", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "read both" },
        { role: "assistant", content: [{ type: "text", text: "reading" }, TOOL("tu1"), TOOL("tu2")] },
        { role: "user", content: [RESULT("tu1", "A"), RESULT("tu2", "B")] },
      ],
    }, CAPS);
    expect(out.messages.filter((m: any) => m.role === "assistant")).toHaveLength(1);
    expect(out.messages[1].tool_calls).toHaveLength(2);
    expect(out.messages.slice(2).map((m: any) => m.tool_call_id)).toEqual(["tu1", "tu2"]);
  });

  test("tool results precede user text in the same turn, whatever the block order", () => {
    const withTextFirst = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [TOOL("tu1")] },
        { role: "user", content: [{ type: "text", text: "here it is" }, RESULT("tu1", "A")] },
      ],
    }, CAPS);
    expect(withTextFirst.messages.slice(1).map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);

    const withResultFirst = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [TOOL("tu1")] },
        { role: "user", content: [RESULT("tu1", "A"), { type: "text", text: "now summarise" }] },
      ],
    }, CAPS);
    expect(withResultFirst.messages.slice(1).map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(withResultFirst.messages[3].content).toBe("now summarise");
  });

  test("a dangling tool_use gets a synthetic tool result before the next message", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "read a" },
        { role: "assistant", content: [TOOL("tu1")] },
        { role: "user", content: "try again" },
      ],
    }, CAPS);
    expect(out.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(out.messages[2].tool_call_id).toBe("tu1");
    expect(out.messages[2].content.length).toBeGreaterThan(0);
  });

  test("an orphan tool_result is demoted to user text, never a bare tool message", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "hi" },
        { role: "user", content: [RESULT("missing", "stale")] },
      ],
    }, CAPS);
    expect(out.messages.some((m: any) => m.role === "tool")).toBe(false);
    const last = out.messages.at(-1) as any;
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("stale");
  });

  test("images are preserved as image_url parts instead of '[image omitted]'", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [{ role: "user", content: [{ type: "text", text: "look" }, PNG] }],
    }, CAPS);
    const content = out.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: "text", text: "look" });
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
    expect(JSON.stringify(out.messages)).not.toContain("[image omitted]");
  });

  test("images nested in a tool_result are preserved on the tool message", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "screenshot?" },
        { role: "assistant", content: [TOOL("tu1", "Read")] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: [{ type: "text", text: "shot:" }, PNG] }] },
      ],
    }, CAPS);
    const tool = out.messages.find((m: any) => m.role === "tool");
    expect(Array.isArray(tool.content)).toBe(true);
    expect(tool.content[0]).toEqual({ type: "text", text: "shot:" });
    expect(tool.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } });
  });

  test("thinking blocks are replayed as reasoning on the message they belong to", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking", thinking: "ponder" }, { type: "text", text: "hello" }, TOOL("tu1")] },
        { role: "user", content: [RESULT("tu1")] },
      ],
    }, CAPS);
    expect(out.messages[1].reasoning).toBe("ponder");
    expect(out.messages[1].content).toBe("hello");
    expect(out.messages.filter((m: any) => m.reasoning !== undefined)).toHaveLength(1);
  });

  test("a trailing user turn that maps to nothing keeps the request ending on user", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: [{ type: "thinking", thinking: "x" }] },
      ],
    }, CAPS);
    expect(out.messages.at(-1)?.role).toBe("user");
  });

  test("assistant turn without text still carries its tool calls", () => {
    const out = anthropicToOpenAi({
      ...BASE,
      messages: [{ role: "user", content: "go" }, { role: "assistant", content: [TOOL("tu1")] }],
    }, CAPS);
    expect(out.messages[1].role).toBe("assistant");
    expect(out.messages[1].content).toBeUndefined();
    expect(out.messages[1].tool_calls).toHaveLength(1);
  });
});

describe("anthropic streaming edge cases", () => {
  const SSE_TEXT = [
    `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}]}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  test("tool_use block starts with an empty object input", async () => {
    const sse = [
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":""}}]}}]}`,
      "",
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendWith(sse), new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BASE, stream: true, messages: [{ role: "user", content: "go" }] }),
    }), CAPS);
    const text = await resp.text();
    const start = text.split("\n").find((l) => l.startsWith('data: {"type":"content_block_start"'));
    expect(start).toBeDefined();
    const j = JSON.parse(start!.slice("data: ".length));
    expect(j.content_block).toMatchObject({ type: "tool_use", input: {} });
  });

  test("adaptive thinking emits thinking blocks", async () => {
    const sse = [
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"reasoning_content":"think"},"finish_reason":"stop"}]}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendWith(sse), new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BASE, stream: true, max_tokens: 64, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] }),
    }), CAPS);
    const text = await resp.text();
    expect(text).toContain('"thinking_delta"');
    expect(text).toContain("think");
  });

  test("content_filter is reported as refusal, not a normal end_turn", async () => {
    const sse = [
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"content_filter"}]}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendWith(sse), new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BASE, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }), CAPS);
    const text = await resp.text();
    expect(text).toContain('"stop_reason":"refusal"');
  });

  test("an in-band upstream error becomes an Anthropic error event", async () => {
    const sse = 'data:{"text":"[DONE]","error_code":"InferHub.001001014.406","error_msg":"Tool type is invalid"}\n\n';
    const resp = await handleAnthropicMessages(backendWith(sse), new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BASE, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }), CAPS);
    const text = await resp.text();
    expect(text).toContain("event: error");
    expect(text).toContain("Tool type is invalid");
    expect(text).not.toContain('"stop_reason":"end_turn"');
  });

  test("an empty upstream stream is an error event, not an empty end_turn", async () => {
    const resp = await handleAnthropicMessages(backendWith("data: [DONE]\n\n"), new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...BASE, stream: true, messages: [{ role: "user", content: "hi" }] }),
    }), CAPS);
    const text = await resp.text();
    expect(text).toContain("event: error");
    expect(text).not.toContain('"stop_reason":"end_turn"');
  });
});