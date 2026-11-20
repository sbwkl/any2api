import { test, expect, describe } from "bun:test";
import { anthropicToOpenAi, handleAnthropicMessages } from "./anthropic";
import { CodeBuddyFacade } from "./openai";
import type { Credentials, ProductConfig } from "./types";

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
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[2]).toEqual({ role: "assistant", content: "hello" });
    expect(out.messages[3].tool_calls[0].function.name).toBe("f");
    expect(out.messages[4]).toEqual({ role: "tool", tool_call_id: "tu1", content: "ok" });
    expect(out.tools[0].function.parameters).toEqual({ type: "object" });
    expect(out.tool_choice).toBe("auto");
  });

  test("non-stream text response becomes an Anthropic message", async () => {
    const facade = facadeWith(SSE_TEXT);
    const resp = await handleAnthropicMessages(facade, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }));
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

    const plain: any = await (await handleAnthropicMessages(facadeWith(SSE_THINK), req())).json();
    expect(plain.content.some((b: any) => b.type === "thinking")).toBe(false);

    const withThinking: any = await (await handleAnthropicMessages(
      facadeWith(SSE_THINK),
      req({ type: "enabled", budget_tokens: 1024 }),
    )).json();
    expect(withThinking.content.some((b: any) => b.type === "thinking" && b.thinking === "think")).toBe(true);
  });

  test("non-stream tool call becomes tool_use blocks", async () => {
    const facade = facadeWith(SSE_TOOL);
    const resp = await handleAnthropicMessages(facade, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "weather?" }],
    }));
    const j: any = await resp.json();
    expect(j.stop_reason).toBe("tool_use");
    expect(j.content[0]).toMatchObject({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } });
  });

  test("streaming response emits Anthropic SSE events", async () => {
    const facade = facadeWith(SSE_TEXT);
    const resp = await handleAnthropicMessages(facade, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_start");
    expect(text).toContain('"text_delta"');
    expect(text).toContain("Hello");
    expect(text).toContain("event: message_delta");
    expect(text).toContain("event: message_stop");
  });

  test("streaming tool call emits input_json_delta", async () => {
    const facade = facadeWith(SSE_TOOL);
    const resp = await handleAnthropicMessages(facade, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "weather?" }],
    }));
    const text = await resp.text();
    expect(text).toContain('"tool_use"');
    expect(text).toContain('"input_json_delta"');
    expect(text).toContain("Paris");
  });

  test("upstream errors become Anthropic error envelopes", async () => {
    const fetchImpl = (async () => Response.json({ code: 11101, msg: "No stream" }, { status: 400 })) as typeof fetch;
    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
    const resp = await handleAnthropicMessages(facade, anthroReq({
      model: "hy4flash-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }));
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    expect(j.type).toBe("error");
    expect(j.error.type).toBe("invalid_request_error");
    expect(j.error.message).toBe("No stream");
  });
});