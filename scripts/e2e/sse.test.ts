import { describe, expect, test } from "bun:test";
import { parseSseFrames, jsonFrames } from "./sse";

describe("sse parser", () => {
  test("parses data-only frames and the [DONE] sentinel", () => {
    const frames = parseSseFrames('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(frames).toHaveLength(2);
    expect(frames[1].data).toBe("[DONE]");
  });

  test("parses event names, CRLF, multi-line data, comments", () => {
    const text = ": ping\r\nevent: content_block_delta\r\ndata: {\"x\":\r\ndata: 1}\r\n\r\n";
    const frames = parseSseFrames(text);
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("content_block_delta");
    expect(frames[0].data).toBe('{"x":\n1}');
  });

  test("keeps a trailing frame without a blank line", () => {
    const frames = parseSseFrames("event: message_stop\ndata: {}");
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("message_stop");
  });

  test("jsonFrames parses JSON payloads and preserves event names", () => {
    const parsed = jsonFrames(parseSseFrames('event: a\ndata: {"n":1}\n\nevent: b\ndata: [DONE]\n\n'));
    expect(parsed[0]).toEqual({ event: "a", json: { n: 1 } });
    expect(parsed[1].error).toBeTruthy();
    expect(parsed[1].json).toBeUndefined();
  });
});
