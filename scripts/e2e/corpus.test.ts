import { describe, expect, test } from "bun:test";
import { analyzeCapture, endpointOf, type CaptureRecord } from "./corpus";

function rec(partial: Partial<CaptureRecord> & { path: string; status: number; body?: string }): CaptureRecord {
  const { body, ...rest } = partial;
  return {
    ts: "2026-11-24T00:00:00.000Z",
    method: "POST",
    request: { body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }) },
    response: { content_type: "application/json", body: body ?? "", body_truncated: false },
    ...rest,
  };
}

const validChat = JSON.stringify({
  id: "c",
  object: "chat.completion",
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

describe("corpus", () => {
  test("normalizes provider-prefixed endpoints", () => {
    expect(endpointOf("/codearts/v1/chat/completions")).toBe("/v1/chat/completions");
    expect(endpointOf("/v1/messages")).toBe("/v1/messages");
    expect(endpointOf("/codebuddy/other")).toBeNull();
  });

  test("valid chat completion record passes", () => {
    const r = analyzeCapture(rec({ path: "/v1/chat/completions", status: 200, body: validChat }));
    expect(r.status).toBe("pass");
  });

  test("truncated bodies are skipped, not failed", () => {
    const record = rec({ path: "/v1/chat/completions", status: 200, body: "{\"id\":" });
    record.response!.body_truncated = true;
    expect(analyzeCapture(record).status).toBe("skipped");
  });

  test("error envelope kind follows the endpoint family", () => {
    const openai = rec({ path: "/v1/chat/completions", status: 400, body: JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } }) });
    expect(analyzeCapture(openai).status).toBe("pass");
    const anthropic = rec({ path: "/v1/messages", status: 400, body: JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "bad" } }) });
    expect(analyzeCapture(anthropic).status).toBe("pass");
    const wrong = rec({ path: "/v1/messages", status: 400, body: JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } }) });
    expect(analyzeCapture(wrong).status).toBe("fail");
  });

  test("chat SSE is checked with the stream grammar", () => {
    const sse = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    const record = rec({ path: "/v1/chat/completions", status: 200, body: sse });
    record.response!.content_type = "text/event-stream";
    expect(analyzeCapture(record).status).toBe("pass");
  });

  test("non-matrix endpoints are skipped", () => {
    expect(analyzeCapture(rec({ path: "/healthz", status: 200, body: "{}" })).status).toBe("skipped");
  });
});
