import { test, expect } from "bun:test";
import {
  anthropicErrorTypeForStatus,
  classifyUpstreamStatus,
  errorTypeForStatus,
  extractUpstreamErrorMessage,
} from "./errors";

test("OpenAI error types stay within OpenAI's documented vocabulary", () => {
  expect(errorTypeForStatus(400)).toBe("invalid_request_error");
  expect(errorTypeForStatus(401)).toBe("authentication_error");
  expect(errorTypeForStatus(429)).toBe("rate_limit_error");
  expect(errorTypeForStatus(500)).toBe("server_error");
  expect(errorTypeForStatus(502)).toBe("server_error");
});

test("Anthropic error types use Anthropic's documented vocabulary", () => {
  expect(anthropicErrorTypeForStatus(400)).toBe("invalid_request_error");
  expect(anthropicErrorTypeForStatus(401)).toBe("authentication_error");
  expect(anthropicErrorTypeForStatus(403)).toBe("permission_error");
  expect(anthropicErrorTypeForStatus(404)).toBe("not_found_error");
  expect(anthropicErrorTypeForStatus(413)).toBe("request_too_large");
  expect(anthropicErrorTypeForStatus(429)).toBe("rate_limit_error");
  expect(anthropicErrorTypeForStatus(529)).toBe("overloaded_error");
  expect(anthropicErrorTypeForStatus(502)).toBe("api_error");
  expect(anthropicErrorTypeForStatus(504)).toBe("api_error");
});

test("embedded upstream status codes win over keyword heuristics", () => {
  expect(classifyUpstreamStatus("no choices in upstream SSE: InferHub.001001005.400: The request param is invalid, Please check it")).toBe(400);
  expect(classifyUpstreamStatus("no choices in upstream SSE: InferHub.ModelArts.81101.429: Too many requests, the rate limit is 2500 per minute.")).toBe(429);
  expect(classifyUpstreamStatus("no choices in upstream SSE: TM.00009999: 415 Unsupported Media Type")).toBe(415);
});

test("network and timeout wording classifies retryable failures", () => {
  expect(classifyUpstreamStatus("ECONNRESET: The socket connection was closed unexpectedly.")).toBe(502);
  expect(classifyUpstreamStatus("socket connection was closed")).toBe(502);
  expect(classifyUpstreamStatus("Backend timeout")).toBe(504);
  expect(classifyUpstreamStatus("APIG.0203: Backend timeout")).toBe(504);
});

test("empty or unknown failures fall back to 502 without inventing 4xx", () => {
  expect(classifyUpstreamStatus("no choices in upstream SSE")).toBe(502);
  expect(classifyUpstreamStatus("something odd happened")).toBe(502);
});

test("extractUpstreamErrorMessage reads JSON and plain-text error bodies", () => {
  expect(extractUpstreamErrorMessage('{"error":{"message":"bad body"}}')).toBe("bad body");
  expect(extractUpstreamErrorMessage('{"error_msg":"参数校验失败","error_code":"TM.00001001"}')).toBe("参数校验失败");
  expect(extractUpstreamErrorMessage('{"message":"plain"}')).toBe("plain");
  expect(extractUpstreamErrorMessage("Backend timeout")).toBe("Backend timeout");
  expect(extractUpstreamErrorMessage("")).toBeNull();
});