import { describe, expect, test } from "bun:test";
import {
  buildEvidenceView,
  capJsonBody,
  summarizeResponse,
  summarizeValue,
} from "./evidence";
import type { ScenarioResult } from "./report";

const frame = (lines: string[]) => lines.join("\n");

describe("summarizeValue", () => {
  test("truncates long strings and records original length", () => {
    const value = summarizeValue({ text: "x".repeat(500), nested: { data: "y".repeat(30) } }) as any;
    expect(value.text).toBe(`x`.repeat(160) + `…(len=500)`);
    expect(value.nested.data).toBe("y".repeat(30));
  });

  test("caps long arrays", () => {
    const value = summarizeValue(Array.from({ length: 35 }, (_, i) => i)) as any[];
    expect(value).toHaveLength(31);
    expect(value.at(-1)).toBe("…(共 35 项)");
  });
});

describe("summarizeResponse", () => {
  test("chat JSON extracts content, finish reason and usage", () => {
    const summary = summarizeResponse(
      "/v1/chat/completions",
      JSON.stringify({
        id: "c1",
        model: "m",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "OK", reasoning_content: "think" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
      "application/json",
    ) as any;
    expect(summary.choices[0].message.content).toBe("OK");
    expect(summary.choices[0].message.reasoning_content).toBe("think");
    expect(summary.choices[0].finish_reason).toBe("stop");
    expect(summary.usage.total_tokens).toBe(3);
  });

  test("chat SSE summarizes content, finish and usage", () => {
    const text = frame([
      `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}`,
      "",
      `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}`,
      "",
      `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
      "",
      `data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}`,
      "",
      "data: [DONE]",
      "",
    ]);
    const summary = summarizeResponse("/v1/chat/completions", text, "text/event-stream") as any;
    expect(summary.content).toBe("OK");
    expect(summary.finish_reason).toBe("stop");
    expect(summary.usage.total_tokens).toBe(3);
    expect(summary.usage_chunks_with_nonempty_choices).toBeUndefined();
  });

  test("chat SSE exposes usage chunks that are not empty", () => {
    const text = frame([
      `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"}}]}`,
      "",
      `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{}}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
      "",
      "data: [DONE]",
      "",
    ]);
    const summary = summarizeResponse("/v1/chat/completions", text, "text/event-stream") as any;
    expect(summary.usage_chunks_with_nonempty_choices).toBe(1);
  });

  test("anthropic SSE summarizes event sequence, text and usage", () => {
    const text = frame([
      "event: message_start",
      `data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}`,
      "",
      "event: content_block_start",
      `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
      "",
      "event: content_block_delta",
      `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`,
      "",
      "event: content_block_stop",
      `data: {"type":"content_block_stop","index":0}`,
      "",
      "event: message_delta",
      `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}`,
      "",
      "event: message_stop",
      `data: {"type":"message_stop"}`,
      "",
    ]);
    const summary = summarizeResponse("/v1/messages", text, "text/event-stream") as any;
    expect(summary.event_sequence).toContain("message_start");
    expect(summary.event_sequence).toContain("content_block_delta");
    expect(summary.content).toBe("Hi");
    expect(summary.stop_reason).toBe("end_turn");
    expect(summary.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  });

  test("responses SSE marks a missing output_text.done", () => {
    const text = frame([
      "event: response.created",
      `data: {"type":"response.created","response":{"status":"in_progress"}}`,
      "",
      "event: response.output_text.delta",
      `data: {"type":"response.output_text.delta","delta":"OK"}`,
      "",
      "event: response.completed",
      `data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}`,
      "",
    ]);
    const summary = summarizeResponse("/v1/responses", text, "text/event-stream") as any;
    expect(summary.content).toBe("OK");
    expect(summary.output_text_done).toBe(false);
    expect(summary.status).toBe("completed");
  });

  test("error envelope is preserved", () => {
    const summary = summarizeResponse(
      "/v1/chat/completions",
      JSON.stringify({ error: { type: "rate_limit_error", code: "429", message: "slow down" } }),
      "application/json",
    ) as any;
    expect(summary.error).toEqual({ type: "rate_limit_error", code: "429", message: "slow down" });
  });
});

describe("buildEvidenceView", () => {
  test("includes inbound calls and every upstream request", () => {
    const result: ScenarioResult = {
      id: "chat.basic.nonstream",
      provider: "codearts",
      endpoint: "/v1/chat/completions",
      feature: "基础",
      status: "pass",
      detail: "ok",
      durationMs: 10,
      evidence: {
        inbound: [{
          method: "POST",
          path: "/v1/chat/completions",
          requestBody: { model: "m", messages: [{ role: "user", content: "hi" }] },
          response: {
            status: 200,
            contentType: "application/json",
            text: JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] }),
          },
        }],
        upstream: [
          { url: "https://upstream/v2/chat", body: { model: "m", messages: [{ role: "user", content: "hi" }] } },
          { url: "https://upstream/v2/chat", body: { model: "m", retry: true } },
        ],
      },
    };
    const view = buildEvidenceView(result);
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0].method).toBe("POST");
    expect(view.calls[0].request).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(view.upstream).toHaveLength(2);
    expect(view.upstream[1].body).toEqual({ model: "m", retry: true });
  });

  test("returns empty arrays when a scenario has no evidence", () => {
    const result: ScenarioResult = {
      id: "x", provider: "codearts", endpoint: "/v1/models", feature: "x",
      status: "skipped", detail: "未设置 E2E_IMAGE_URL", durationMs: 0,
    };
    expect(buildEvidenceView(result)).toEqual({ calls: [], upstream: [] });
  });
});

describe("capJsonBody", () => {
  test("keeps small bodies intact", () => {
    expect(capJsonBody({ a: 1 })).toEqual({ a: 1 });
  });

  test("replaces oversized bodies with a truncated preview", () => {
    const capped = capJsonBody({ text: "x".repeat(70000) }, 100) as any;
    expect(capped.__truncated).toBe(true);
    expect(capped.bytes).toBeGreaterThan(70000);
    expect(capped.preview).toHaveLength(100);
  });
});
