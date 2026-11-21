import { test, expect, describe } from "bun:test";
import { aggregateSseToCompletion } from "./sse";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const SSE = [
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}`,
  "",
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"lo"}}]}`,
  "",
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}`,
  "",
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"f","arguments":""}}]}}]}`,
  "",
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}`,
  "",
  `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5,"prompt_tokens_details":{"cached_tokens":1},"completion_tokens_details":{"reasoning_tokens":1}}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("sse aggregation", () => {
  test("aggregates content, reasoning, tool calls, finish and usage", async () => {
    const out = await aggregateSseToCompletion(streamOf(SSE));
    expect(out.object).toBe("chat.completion");
    expect(out.id).toBe("1");
    expect(out.model).toBe("m");
    expect(out.choices).toHaveLength(1);
    const c = out.choices[0];
    expect(c.message.content).toBe("Hello");
    expect(c.message.reasoning_content).toBe("think");
    expect(c.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
    ]);
    expect(c.finish_reason).toBe("tool_calls");
    expect(out.usage.prompt_tokens).toBe(3);
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(1);
    expect(out.usage.completion_tokens_details.reasoning_tokens).toBe(1);
  });

  test("handles CRLF and a missing final [DONE]", async () => {
    const text = 'data: {"id":"2","model":"m","created":2,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\r\n\r\n';
    const out = await aggregateSseToCompletion(streamOf(text));
    expect(out.choices[0].message.content).toBe("ok");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  test("handles a final data line without a trailing newline", async () => {
    const text = 'data: {"id":"3","model":"m","created":3,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}';
    const out = await aggregateSseToCompletion(streamOf(text));
    expect(out.choices[0].message.content).toBe("ok");
    expect(out.choices[0].finish_reason).toBe("stop");
  });

  test("empty stream is an error, not a successful empty completion", async () => {
    await expect(aggregateSseToCompletion(streamOf(""))).rejects.toThrow("no choices");
  });

  test("error-only stream is an error", async () => {
    const text = 'data: {"error":{"message":"bad","code":1}}\n\n';
    await expect(aggregateSseToCompletion(streamOf(text))).rejects.toThrow("no choices");
  });
});