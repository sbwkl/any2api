import { test, expect, describe } from "bun:test";
import { gunzipSync } from "node:zlib";
import { buildHeaders, gzipBody, postChat, readUpstreamError, refreshAccessToken, type HeaderContext } from "./client";
import type { Credentials, ProductConfig } from "./types";

const config: ProductConfig = {
  endpoint: "https://example.test",
  productName: "CodeBuddy",
  platform: "CodeBuddyIDE",
  deploymentType: "SaaS",
  version: "3.10.0",
  models: [],
  agents: [],
  prompts: [],
};

const credentials: Credentials = {
  accessToken: "tok",
  refreshToken: "ref",
  uid: "u1",
  domain: "www.codebuddy.cn",
  source: "env",
};

const ctx: HeaderContext = {
  credentials,
  config,
  agentIntent: "craft",
  modelId: "hy4flash-free",
  conversationId: "c1",
  requestId: "r1",
  messageId: "m1",
  traceId: "t1",
};

describe("client", () => {
  test("buildHeaders sets the wire header set", () => {
    const h = buildHeaders(ctx);
    expect(h["Authorization"]).toBe("Bearer tok");
    expect(h["X-User-Id"]).toBe("u1");
    expect(h["X-Product"]).toBe("SaaS");
    expect(h["X-Env-ID"]).toBe("production");
    expect(h["X-IDE-Type"]).toBe("CodeBuddyIDE");
    expect(h["X-IDE-Name"]).toBe("CodeBuddyIDE");
    expect(h["X-IDE-Version"]).toBe("1.106.1");
    expect(h["X-Product-Version"]).toBe("3.10.0");
    expect(h["User-Agent"]).toBe("CodeBuddy/3.10.0");
    expect(h["X-Trace-ID"]).toBe("t1");
    expect(h["X-Request-ID"]).toBe("r1");
    expect(h["X-Conversation-ID"]).toBe("c1");
    expect(h["X-Conversation-Request-ID"]).toBe("r1");
    expect(h["X-Conversation-Message-ID"]).toBe("m1");
    expect(h["X-Agent-Intent"]).toBe("craft");
    expect(h["X-Model-ID"]).toBe("hy4flash-free");
    expect(h["X-Domain"]).toBe("www.codebuddy.cn");
    expect(h["X-Device-Token"]).toBeUndefined();
  });

  test("gzipBody round-trips JSON", () => {
    const zipped = gzipBody({ a: 1, b: "two" });
    expect(JSON.parse(gunzipSync(Buffer.from(zipped)).toString("utf8"))).toEqual({ a: 1, b: "two" });
  });

  test("postChat gzips and retries once after 401", async () => {
    let calls = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls++;
      expect(String(url)).toBe("https://example.test/v2/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("content-encoding")).toBe("gzip");
      const body = JSON.parse(gunzipSync(Buffer.from(init!.body as Uint8Array)).toString("utf8"));
      expect(body.model).toBe("m");
      if (calls === 1) return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      return new Response("data: {}\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: { Authorization: "Bearer old" },
      body: { model: "m" },
      fetchImpl,
      onUnauthorized: async () => ({ Authorization: "Bearer new" }),
    });
    expect(resp.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("postChat does not retry when refresh fails", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json({ code: 401, msg: "expired" }, { status: 401 });
    }) as typeof fetch;
    const resp = await postChat({
      url: "https://example.test/v2/chat/completions",
      headers: {},
      body: { model: "m" },
      fetchImpl,
      onUnauthorized: async () => null,
    });
    expect(resp.status).toBe(401);
    expect(calls).toBe(1);
  });

  test("refreshAccessToken posts X-Refresh-Token and returns new credentials", async () => {
    let called = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      called = true;
      expect(String(url)).toBe("https://example.test/v2/plugin/auth/token/refresh");
      const h = new Headers(init?.headers);
      expect(h.get("x-refresh-token")).toBe("ref");
      expect(h.get("x-auth-refresh-source")).toBe("plugin");
      return Response.json({ data: { accessToken: "new", refreshToken: "ref2", uid: "u1", expiresAt: 123 } });
    }) as typeof fetch;
    const next = await refreshAccessToken({ config, credentials, fetchImpl });
    expect(called).toBe(true);
    expect(next?.accessToken).toBe("new");
    expect(next?.refreshToken).toBe("ref2");
    expect(next?.expiresAt).toBe(123);
  });

  test("readUpstreamError extracts displayMsg and code", async () => {
    const resp = Response.json(
      { code: 11101, msg: "Non-stream chat request is currently not supported", displayMsg: { en: "No stream" } },
      { status: 400 },
    );
    const err = await readUpstreamError(resp);
    expect(err.status).toBe(400);
    expect(err.code).toBe(11101);
    expect(err.message).toBe("No stream");
  });
});