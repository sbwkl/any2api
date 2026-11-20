import { test, expect, describe } from "bun:test";
import { handleResponses, responsesToOpenAi } from "./responses";
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
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4,"prompt_tokens_details":{"cached_tokens":1},"completion_tokens_details":{"reasoning_tokens":0}}}`,
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

function facadeWith(sse: string): CodeBuddyFacade {
  const fetchImpl = (async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } })) as typeof fetch;
  return new CodeBuddyFacade(config, credentials, { fetchImpl });
}

function respReq(body: any): Request {
  return new Request("http://localhost/codebuddy/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("responses adapter", () => {
  test("responsesToOpenAi maps instructions, input items, tools and options", () => {
    const out = responsesToOpenAi({
      model: "hy4flash-free",
      instructions: "sys",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "c1", name: "f", arguments: '{"x":1}' },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tools: [{ type: "function", name: "f", description: "d", parameters: { type: "object" } }],
      max_output_tokens: 100,
      reasoning: { effort: "high" },
      tool_choice: "required",
    });
    expect(out.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(out.messages[1]).toEqual({ role: "user", content: "hi" });
    expect(out.messages[2].tool_calls[0].function.name).toBe("f");
    expect(out.messages[3]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
    expect(out.tools[0]).toEqual({ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } });
    expect(out.max_tokens).toBe(100);
    expect(out.reasoning_effort).toBe("high");
    expect(out.tool_choice).toBe("auto");
  });

  test("non-stream text response becomes a Responses object", async () => {
    const facade = facadeWith(SSE_TEXT);
    const resp = await handleResponses(facade, respReq({ model: "hy4flash-free", input: "hi" }));
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.object).toBe("response");
    expect(j.output[0].type).toBe("message");
    expect(j.output[0].content[0].text).toBe("Hello");
    expect(j.usage.input_tokens).toBe(3);
    expect(j.usage.input_tokens_details.cached_tokens).toBe(1);
  });

  test("non-stream tool call becomes a function_call item", async () => {
    const facade = facadeWith(SSE_TOOL);
    const resp = await handleResponses(facade, respReq({ model: "hy4flash-free", input: "weather?" }));
    const j: any = await resp.json();
    const fc = j.output.find((o: any) => o.type === "function_call");
    expect(fc.name).toBe("get_weather");
    expect(fc.arguments).toBe('{"city":"Paris"}');
  });

  test("streaming response emits Responses SSE events", async () => {
    const facade = facadeWith(SSE_TEXT);
    const resp = await handleResponses(facade, respReq({ model: "hy4flash-free", input: "hi", stream: true }));
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain("Hello");
    expect(text).toContain("event: response.completed");
  });

  test("streaming tool call emits function_call_arguments.delta", async () => {
    const facade = facadeWith(SSE_TOOL);
    const resp = await handleResponses(facade, respReq({ model: "hy4flash-free", input: "weather?", stream: true }));
    const text = await resp.text();
    expect(text).toContain("event: response.function_call_arguments.delta");
    expect(text).toContain("Paris");
    expect(text).toContain("event: response.completed");
  });

  test("upstream errors become Responses error envelopes", async () => {
    const fetchImpl = (async () => Response.json({ code: 11101, msg: "No stream" }, { status: 400 })) as typeof fetch;
    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
    const resp = await handleResponses(facade, respReq({ model: "hy4flash-free", input: "hi" }));
    expect(resp.status).toBe(400);
    const j: any = await resp.json();
    expect(j.error.message).toBe("No stream");
  });
});