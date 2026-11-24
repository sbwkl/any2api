import { test, expect, describe } from "bun:test";
import { aggregateSseToCompletion, normalizeChatSseUsage, upstreamErrorFromChunk } from "./sse";

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

const SSE_WITH_CACHE_CREATION = [
  `data: {"id":"2","model":"m","created":2,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":6,"cache_creation_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

const SSE_MULTIFRAME_USAGE = [
  `data: {"id":"2","model":"m","created":2,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":6,"cache_creation_tokens":2},"completion_tokens_details":{"reasoning_tokens":1}}}`,
  "",
  `data: {"id":"2","model":"m","created":2,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":3}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

describe("sse aggregation", () => {
  test("merges usage fields across multiple chunks", async () => {
    const out = await aggregateSseToCompletion(streamOf(SSE_MULTIFRAME_USAGE));
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 3,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 6, cache_creation_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  test("preserves cache creation tokens in mapped usage", async () => {
    const out = await aggregateSseToCompletion(streamOf(SSE_WITH_CACHE_CREATION));
    expect(out.usage.prompt_tokens_details.cache_creation_tokens).toBe(2);
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(6);
  });

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

  test("an error frame's own message survives into the thrown error", async () => {
    const text = 'data: {"text":"[DONE]","error_code":"InferHub.001001014.406","error_msg":"Tool type is invalid"}\n\n';
    await expect(aggregateSseToCompletion(streamOf(text))).rejects.toThrow("Tool type is invalid");
  });

  test("upstreamErrorFromChunk ignores frames that carry choices", () => {
    expect(upstreamErrorFromChunk({ choices: [{ delta: { content: "x" } }], error_code: "nope" })).toBeNull();
    expect(upstreamErrorFromChunk({ error_code: "E1", error_msg: "boom" })).toBe("E1: boom");
    expect(upstreamErrorFromChunk({ error: { code: "E2", message: "kaput" } })).toBe("E2: kaput");
    expect(upstreamErrorFromChunk({ text: "[DONE]" })).toBeNull();
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

function dataFrames(text: string): any[] {
  return text
    .split("\n\n")
    .map((f) => f.trim())
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .filter((d) => d !== "[DONE]")
    .map((d) => JSON.parse(d));
}

describe("chat SSE usage normalization", () => {
  test("moves usage off a chunk that still carries choices", async () => {
    const input = [
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"content":"Hi"}}]}`,
      "",
      `data: {"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const out = await collect(normalizeChatSseUsage(streamOf(input)));
    const frames = dataFrames(out);
    const withUsage = frames.filter((f) => f.usage);
    expect(withUsage).toHaveLength(1);
    expect(withUsage[0].choices).toEqual([]);
    expect(withUsage[0].id).toBe("1");
    expect(withUsage[0].model).toBe("m");
    const finish = frames.find((f) => f.choices?.[0]?.finish_reason === "stop");
    expect(finish.usage ?? null).toBeNull();
    expect(out.trimEnd().endsWith("[DONE]")).toBe(true);
    expect(out.match(/\[DONE\]/g)).toHaveLength(1);
  });

  test("keeps an already conforming usage chunk without duplicating it", async () => {
    const input = [
      `data: {"id":"2","model":"m","created":2,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
      "",
      `data: {"id":"2","model":"m","created":2,"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const frames = dataFrames(await collect(normalizeChatSseUsage(streamOf(input))));
    expect(frames.filter((f) => f.usage)).toHaveLength(1);
  });

  test("merges partial usage sent across multiple chunks", async () => {
    const input = [
      `data: {"id":"4","model":"m","created":4,"choices":[{"index":0,"delta":{"content":"Hi"}}]}`,
      "",
      `data: {"id":"4","model":"m","created":4,"choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":31,"prompt_tokens_details":{"cached_tokens":7}}}`,
      "",
      `data: {"id":"4","model":"m","created":4,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":5}}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const frames = dataFrames(await collect(normalizeChatSseUsage(streamOf(input))));
    const usageFrames = frames.filter((f) => f.usage);
    expect(usageFrames).toHaveLength(1);
    expect(usageFrames[0].usage).toEqual({
      prompt_tokens: 31,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 7 },
    });
    expect(usageFrames[0].choices).toEqual([]);
  });

  test("appends [DONE] when upstream omits it", async () => {
    const input = `data: {"id":"3","model":"m","created":3,"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n`;
    const out = await collect(normalizeChatSseUsage(streamOf(input)));
    expect(out.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  test("passes non-JSON data lines through unchanged", async () => {
    const input = 'data: {"text":"[DONE]","error_code":"E1","error_msg":"boom"}\n\ndata: [DONE]\n\n';
    const out = await collect(normalizeChatSseUsage(streamOf(input)));
    expect(out).toContain('"error_code":"E1"');
    expect(out.match(/\[DONE\]/g)).toHaveLength(2);
  });
});