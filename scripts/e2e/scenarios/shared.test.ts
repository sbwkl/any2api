import { describe, expect, test } from "bun:test";
import type { HttpResult } from "../http";
import { rejectionVerdict } from "./shared";

function res(status: number, body: unknown): HttpResult {
  return {
    status,
    contentType: "application/json",
    headers: new Headers(),
    text: JSON.stringify(body),
    durationMs: 1,
  };
}

describe("rejectionVerdict", () => {
  test("returns null for successful responses", () => {
    expect(rejectionVerdict(res(200, {}), "openai")).toBeNull();
  });

  test("4xx with a valid envelope is an explicit rejection", () => {
    const v = rejectionVerdict(res(400, { error: { message: "bad", type: "invalid_request_error" } }), "openai");
    expect(v?.status).toBe("not-supported");
  });

  test("4xx with the wrong envelope shape fails", () => {
    const v = rejectionVerdict(res(400, { type: "error", error: { message: "bad", type: "invalid_request_error" } }), "openai");
    expect(v?.status).toBe("fail");
  });

  test("upstream 4xx masked as 5xx still counts as an explicit rejection", () => {
    const v = rejectionVerdict(
      res(502, { error: { message: "upstream_error: InferHub.001001005.400: The request param is invalid", type: "upstream_error", code: null } }),
      "openai",
    );
    expect(v?.status).toBe("not-supported");
    expect(v?.detail).toContain("502");
  });

  test("plain 5xx is a failure, not a rejection", () => {
    const v = rejectionVerdict(res(500, { error: { message: "internal_error: boom", type: "internal_error", code: null } }), "openai");
    expect(v?.status).toBe("fail");
  });
});
