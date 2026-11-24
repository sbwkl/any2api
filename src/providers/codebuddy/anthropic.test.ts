import { test, expect, describe } from "bun:test";
import { anthropicToOpenAi, handleAnthropicMessages } from "../../protocols/anthropic";
import type { ChatBackend, ProtocolCapabilities } from "../../protocols/types";
import { CodeBuddyFacade } from "./openai";
import type { Credentials, ProductConfig } from "./types";

const CAPS: ProtocolCapabilities = { toolChoice: "auto-only", normalizeErrors: true, promptTokensIncludeCache: true };

const config: ProductConfig = {
  endpoint: "https://example.test",
  productName: "CodeBuddy",
  platform: "CodeBuddyIDE",
  deploymentType: "SaaS",
  version: "3.10.0",
  models: [{ id: "hy4flash-free", name: "Hy4 flash", maxOutputTokens: 64000, maxInputTokens: 960000, supportsToolCall: true, supportsReasoning: true, temperature: 0.9 }],
  agents: [],
  prompts: [],
};
const credentials: Credentials = { accessToken: "tok", refreshToken: "ref", uid: "u1", source: "env" };

const SSE_TEXT = [
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const SSE_TOOL = [
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"Paris\\"}"}}]}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const SSE_THINK = [
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

function facadeWith(sse: string): CodeBuddyFacade {
  const fetchImpl = (async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  return new CodeBuddyFacade(config, credentials, { fetchImpl });
}

function backendFor(facade: CodeBuddyFacade): ChatBackend {
  return {
    models: () => facade.modelsPayload().data,
    health: () => facade.healthPayload(),
    profileFor: (req) => facade.profileFor(req),
    handleChat: (req) => facade.handleChat(req),
    respond: (body, opts) => facade.respond(body, opts.stream, opts.sessionKey, (opts.profile as any) ?? "chat"),
  };
}

function anthroReq(body: any): Request {
  return new Request("http://localhost/codebuddy/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("anthropic adapter", () => {
  test("anthropicToOpenAi maps system, blocks, tools and tool_choice", () => {
    const out = anthropicToOpenAi({
      model: "hy4flash-free",
      max_tokens: 100,
      system: "sys",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "tu1", name: "f", input: { x: 1 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] },
      ],
      tools: [{ name: "f", description: "d", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    }, CAPS);
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    // 同一轮的文本与 tool_calls 必须仍是同一条 assistant 消息
    expect(out.messages[2].content).toBe("hello");
    expect(out.messages[2].tool_calls[0].function.name).toBe("f");
    expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "tu1", content: "ok" });
    expect(out.tools[0].function.parameters).toEqual({ type: "object" });
    expect(out.tool_choice).toBe("auto");
  });

  test("full tool_choice supports required and forced function", () => {
    const base = {
      model: "hy4flash-free",
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "f", input_schema: { type: "object" } }],
    };
    expect(anthropicToOpenAi({ ...base, tool_choice: { type: "any" } }, { toolChoice: "full" }).tool_choice).toBe("required");
    expect(anthropicToOpenAi({ ...base, tool_choice: { type: "tool", name: "f" } }, { toolChoice: "full" }).tool_choice)
      .toEqual({ type: "function", function: { name: "f" } });
  });

  test("non-stream text response becomes an Anthropic message", async () => {
    const backend = backendFor(facadeWith(SSE_TEXT));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.type).toBe("message");
    expect(j.role).toBe("assistant");
    expect(j.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(j.stop_reason).toBe("end_turn");
    expect(j.usage.input_tokens).toBe(3);
  });

  test("thinking block is only emitted when the client enables thinking", async () => {
    const req = (thinking?: any) => anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      ...(thinking ? { thinking } : {}),
      messages: [{ role: "user", content: "hi" }],
    });

    const plain: any = await (await handleAnthropicMessages(backendFor(facadeWith(SSE_THINK)), req(), CAPS)).json();
    expect(plain.content.some((b: any) => b.type === "thinking")).toBe(false);

    const withThinking: any = await (await handleAnthropicMessages(
      backendFor(facadeWith(SSE_THINK)),
      req({ type: "enabled", budget_tokens: 1024 }),
      CAPS,
    )).json();
    expect(withThinking.content.some((b: any) => b.type === "thinking" && b.thinking === "think")).toBe(true);
  });

  test("non-stream tool call becomes tool_use blocks", async () => {
    const backend = backendFor(facadeWith(SSE_TOOL));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather?" }],
    }), CAPS);
    const j: any = await resp.json();
    expect(j.stop_reason).toBe("tool_use");
    expect(j.content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } });
  });

  test("streaming response emits Anthropic SSE events", async () => {
    const backend = backendFor(facadeWith(SSE_TEXT));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"text_delta"');
    expect(text).toContain("Hello");
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
  });

  test("streaming message_delta carries upstream input and cache tokens", async () => {
    const sse = [
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}`,
      "",
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"completion_tokens":5,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":7,"cache_creation_tokens":2}}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendFor(facadeWith(sse)), anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    const text = await resp.text();
    const line = text.split("\n").find((l) => l.startsWith('data: {"type":"message_delta"'));
    expect(line).toBeDefined();
    const j = JSON.parse(line!.slice("data: ".length));
    expect(j.usage.input_tokens).toBe(22);
    expect(j.usage.cache_read_input_tokens).toBe(7);
    expect(j.usage.cache_creation_input_tokens).toBe(2);
    expect(j.usage.output_tokens).toBe(5);
  });

  test("non-stream usage excludes cached tokens from input_tokens", async () => {
    const sse = [
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"}}]}`,
      "",
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":31,"completion_tokens":5,"total_tokens":36,"prompt_tokens_details":{"cached_tokens":7,"cache_creation_tokens":2}}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendFor(facadeWith(sse)), anthroReq({
      model: "hy4flash-free", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    const j: any = await resp.json();
    expect(j.usage.input_tokens).toBe(22);
    expect(j.usage.cache_read_input_tokens).toBe(7);
    expect(j.usage.cache_creation_input_tokens).toBe(2);
    expect(j.usage.output_tokens).toBe(5);
  });

  test("streaming usage merges fields across multiple chunks", async () => {
    const sse = [
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"content":"Hi"}}]}`,
      "",
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":31,"prompt_tokens_details":{"cached_tokens":7,"cache_creation_tokens":2}}}`,
      "",
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":5}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendFor(facadeWith(sse)), anthroReq({
      model: "hy4flash-free", max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    const text = await resp.text();
    const line = text.split("\n").find((l) => l.startsWith('data: {"type":"message_delta"'));
    expect(line).toBeDefined();
    const j = JSON.parse(line!.slice("data: ".length));
    expect(j.usage).toEqual({ input_tokens: 22, output_tokens: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 });
  });

  test("Anthropic input_tokens clamps to zero when cached tokens exceed prompt tokens", async () => {
    const sse = [
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"content":"Hi"}}]}`,
      "",
      `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":7}}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const resp = await handleAnthropicMessages(backendFor(facadeWith(sse)), anthroReq({
      model: "hy4flash-free", max_tokens: 64, messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    const j: any = await resp.json();
    expect(j.usage.input_tokens).toBe(0);
    expect(j.usage.cache_read_input_tokens).toBe(7);
  });

  test("streaming tool call emits input_json_delta", async () => {
    const backend = backendFor(facadeWith(SSE_TOOL));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    }), CAPS);
    const text = await resp.text();
    expect(text).toContain('"tool_use"');
    expect(text).toContain('"input_json_delta"');
    expect(text).toContain("Paris");
  });

  test("upstream errors become Anthropic error envelopes", async () => {
    const fetchImpl = (async () => Response.json({ code: 11101, msg: "No stream" }, { status: 400 })) as typeof fetch;
    const backend = backendFor(new CodeBuddyFacade(config, credentials, { fetchImpl }));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }), CAPS);
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toBe("No stream");
  });

  test("passthrough error shape returns the provider response unchanged", async () => {
    const fetchImpl = (async () => Response.json({ code: 11101, msg: "No stream" }, { status: 400 })) as typeof fetch;
    const backend = backendFor(new CodeBuddyFacade(config, credentials, { fetchImpl }));
    const resp = await handleAnthropicMessages(backend, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }), { toolChoice: "auto-only", normalizeErrors: false });
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    // passthrough：保留 provider 的 OpenAI 错误结构，不包 Anthropic 的 {type:"error"} 信封
    expect(j.type).toBeUndefined();
    expect(j.error.code).toBe(11101);
    expect(j.error.message).toBe("No stream");
  });

  test("anthropic thinking maps to reasoning_effort", () => {
    const base = { model: "hy4flash-free", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    const effort = (thinking: any) => anthropicToOpenAi({ ...base, thinking }).reasoning_effort;
    expect(effort({ type: "enabled", budget_tokens: 1024 })).toBe("minimal");
    expect(effort({ type: "enabled", budget_tokens: 4096 })).toBe("medium");
    expect(effort({ type: "enabled", budget_tokens: 10000 })).toBe("high");
    expect(effort({ type: "disabled" })).toBe("off");
  });
});