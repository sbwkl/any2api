import { describe, expect, test } from "bun:test";
import {
  checkAnthropicMessage,
  checkAnthropicStream,
  checkChatChunks,
  checkChatCompletion,
  checkErrorEnvelope,
  checkModels,
  checkResponseObject,
  checkResponsesStream,
} from "./verify";

const validChat = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1,
  model: "m",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "OK" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
};

describe("verify: chat completions", () => {
  test("accepts a contract-faithful completion", () => {
    expect(checkChatCompletion(validChat)).toEqual({ ok: true, issues: [] });
  });

  test("rejects wrong usage arithmetic and missing finish_reason", () => {
    const bad = {
      ...validChat,
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: null }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 8 },
    };
    const check = checkChatCompletion(bad);
    expect(check.ok).toBe(false);
    expect(check.issues.join("\n")).toContain("total_tokens");
    expect(check.issues.join("\n")).toContain("finish_reason");
  });

  test("stream requires [DONE], usage chunk with empty choices", () => {
    const good = [
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}',
      "data: [DONE]",
      "",
    ].join("\n\n");
    expect(checkChatChunks(good, { expectUsage: true })).toEqual({ ok: true, issues: [] });

    const noDone = good.replace("data: [DONE]\n\n", "");
    expect(checkChatChunks(noDone, { expectUsage: true }).issues.join("\n")).toContain("[DONE]");
  });
});

describe("verify: anthropic messages", () => {
  const validMessage = {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "OK" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  };

  test("accepts a contract-faithful message", () => {
    expect(checkAnthropicMessage(validMessage)).toEqual({ ok: true, issues: [] });
  });

  test("stream requires ordered lifecycle events", () => {
    const good = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    expect(checkAnthropicStream(good)).toEqual({ ok: true, issues: [] });

    const noStop = good.replace('event: message_stop\ndata: {"type":"message_stop"}\n\n', "");
    expect(checkAnthropicStream(noStop).issues.join("\n")).toContain("message_stop");
  });
});

describe("verify: responses", () => {
  const validResponse = {
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    model: "m",
    output: [{
      type: "message",
      id: "msg_1",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    }],
    usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
  };

  test("accepts a contract-faithful response object", () => {
    expect(checkResponseObject(validResponse)).toEqual({ ok: true, issues: [] });
  });

  test("stream flags a missing response.output_text.done", () => {
    const missingDone = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"r","object":"response","status":"in_progress"}}',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"i","output_index":0,"content_index":0,"delta":"OK"}',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r","object":"response","status":"completed","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}',
      "",
    ].join("\n\n");
    const check = checkResponsesStream(missingDone);
    expect(check.ok).toBe(false);
    expect(check.issues.join("\n")).toContain("output_text.done");
  });
});

describe("verify: models and errors", () => {
  test("models list shape", () => {
    expect(checkModels({ object: "list", data: [{ id: "m", object: "model" }] })).toEqual({ ok: true, issues: [] });
    expect(checkModels({ object: "list", data: [] }).ok).toBe(false);
  });

  test("error envelope kinds are not interchangeable", () => {
    const openai = { error: { message: "bad", type: "invalid_request_error", param: null, code: null } };
    const anthropic = { type: "error", error: { type: "invalid_request_error", message: "bad" } };
    expect(checkErrorEnvelope(openai, "openai")).toEqual({ ok: true, issues: [] });
    expect(checkErrorEnvelope(anthropic, "openai").ok).toBe(false);
    expect(checkErrorEnvelope(anthropic, "anthropic")).toEqual({ ok: true, issues: [] });
  });
});
