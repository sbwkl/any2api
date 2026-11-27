import { test, expect, describe } from "bun:test";
import { gunzipSync } from "node:zlib";
import { CodeBuddyFacade } from "./openai";
import { type CredentialSource } from "./credentials";
import type { Credentials, ProductConfig } from "./types";

const config: ProductConfig = {
  endpoint: "https://example.test",
  productName: "CodeBuddy",
  platform: "CodeBuddyIDE",
  deploymentType: "SaaS",
  version: "3.10.0",
  models: [
    {
      id: "hy4flash-free",
      name: "Hy4 flash",
      maxOutputTokens: 64000,
      maxInputTokens: 960000,
      supportsToolCall: true,
      supportsReasoning: true,
      temperature: 0.9,
    },
  ],
  agents: [],
  prompts: [],
};

const credentials: Credentials = {
  accessToken: "tok",
  refreshToken: "ref",
  uid: "u1",
  source: "env",
};

const SSE = [
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

function chatRequest(body: any): Request {
  return new Request("http://localhost/codebuddy/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function sseResponse(): Response {
  return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

// 本文件统一的假凭证源工厂（staticSource 的同形可变版）：get() 返回当前值，adopt() 采纳新值，set() 供测试直接改写源状态
function sourceWith(initial: Credentials) {
  let current = initial;
  const source: CredentialSource = {
    get: () => current,
    reload: async () => current,
    adopt: (next) => { current = next; },
  };
  return {
    source,
    set(next: Credentials) { current = next; },
  };
}

describe("openai facade", () => {
  test("models lists the configured pool", async () => {
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source);
    const resp = await facade.handleModels();
    const json: any = await resp.json();
    expect(json.object).toBe("list");
    expect(json.data[0].id).toBe("hy4flash-free");
  });

  test("streams upstream SSE when stream=true", async () => {
    let seen = false;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      expect(h.get("x-agent-intent")).toBe("chat");
      expect(h.get("x-model-id")).toBe("hy4flash-free");
      expect(h.get("authorization")).toBe("Bearer tok");
      const body = JSON.parse(gunzipSync(Buffer.from(init!.body as Uint8Array)).toString("utf8"));
      expect(body.model).toBe("hy4flash-free");
      expect(body.stream).toBe(true);
      expect(body.messages[0].role).toBe("user");
      seen = true;
      return sseResponse();
    }) as unknown as typeof fetch;

    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }));
    expect(seen).toBe(true);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("text/event-stream");
    expect(await resp.text()).toContain("Hello");
  });

  test("streaming moves usage into a trailing chunk with empty choices", async () => {
    const fetchImpl = (async () => sseResponse()) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }));
    const text = await resp.text();
    const frames = text
      .split("\n\n")
      .map((f) => f.trim())
      .filter((f) => f.startsWith("data:"))
      .map((f) => f.slice(5).trim())
      .filter((d) => d !== "[DONE]")
      .map((d) => JSON.parse(d));
    const usageFrames = frames.filter((f: any) => f.usage);
    expect(usageFrames).toHaveLength(1);
    expect(usageFrames[0].choices).toEqual([]);
    expect(text.trimEnd().endsWith("[DONE]")).toBe(true);
  });

  test("aggregates upstream SSE when stream=false", async () => {
    const fetchImpl = (async () => sseResponse()) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  test("refreshes the token and retries once on 401", async () => {
    let chatCalls = 0;
    let refreshSeen = false;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/token/refresh")) {
        refreshSeen = true;
        return Response.json({ data: { accessToken: "new", refreshToken: "ref2", uid: "u1" } });
      }
      chatCalls++;
      if (chatCalls === 1) return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer new");
      return sseResponse();
    }) as unknown as typeof fetch;

    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(refreshSeen).toBe(true);
    expect(chatCalls).toBe(2);
    expect(resp.status).toBe(200);
  });

  test("auto refresh can be disabled", async () => {
    const old = process.env.CODEBUDDY_AUTO_REFRESH;
    process.env.CODEBUDDY_AUTO_REFRESH = "0";
    try {
      const urls: string[] = [];
      const fetchImpl = (async (url: string | URL | Request) => {
        urls.push(String(url));
        return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      }) as unknown as typeof fetch;
      const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
      const resp = await facade.handleChat(chatRequest({
        model: "hy4flash-free",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }));
      expect(resp.status).toBe(401);
      expect(urls.some((u) => u.includes("/auth/token/refresh"))).toBe(false);
      const j: any = await resp.json();
      expect(j.error.type).toBe("authentication_error");
    } finally {
      if (old === undefined) delete process.env.CODEBUDDY_AUTO_REFRESH;
      else process.env.CODEBUDDY_AUTO_REFRESH = old;
    }
  });

  test("6020 queue is waited and retried", async () => {
    let chatCalls = 0;
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes("/v2/chat/queue/status")) {
        return Response.json({ data: { retry_after: 0 } });
      }
      chatCalls++;
      if (chatCalls === 1) return Response.json({ code: 6020, data: { retry_after: 0 } });
      return sseResponse();
    }) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(200);
    expect(chatCalls).toBe(2);
  });

  test("network failure becomes a 502 OpenAI error", async () => {
    const fetchImpl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(502);
    const j: any = await resp.json();
    expect(j.error.message).toContain("network down");
    expect(j.error.type).toBe("server_error");
  });

  test("empty upstream stream becomes a 502", async () => {
    const fetchImpl = (async () => new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } })) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(502);
  });

  test("error-only upstream stream becomes a 502", async () => {
    const fetchImpl = (async () =>
      new Response('data: {"error":{"message":"bad"}}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      })) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(502);
  });

  test("malformed messages/tools return 400", async () => {
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source);
    const r1 = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{}],
      stream: false,
    }));
    expect(r1.status).toBe(400);
    expect((await r1.json() as any).error.type).toBe("invalid_request_error");
    const r2 = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      tools: {},
      stream: false,
    }));
    expect(r2.status).toBe(400);
  });

  test("6021 queue full maps to 429", async () => {
    const fetchImpl = (async () => Response.json({ code: 6021, msg: "queue full" })) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(429);
    const j: any = await resp.json();
    expect(j.error.code).toBe(6021);
    expect(j.error.type).toBe("rate_limit_error");
  });

  test("unknown model returns 404 model_not_found", async () => {
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source);
    const resp = await facade.handleChat(chatRequest({
      model: "nope",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(resp.status).toBe(404);
    const j: any = await resp.json();
    expect(j.error.code).toBe("model_not_found");
  });

  test("maps a non-stream upstream rejection to an OpenAI error", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { code: 11101, msg: "Non-stream chat request is currently not supported", displayMsg: { en: "No stream" } },
        { status: 400 },
      )) as unknown as typeof fetch;
    const facade = new CodeBuddyFacade(config, sourceWith(credentials).source, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    }));
    expect(resp.status).toBe(400);
    const json: any = await resp.json();
    expect(json.error.message).toBe("No stream");
    expect(json.error.code).toBe(11101);
  });

  test("reads credentials from the source on each request", async () => {
    const { source, set } = sourceWith({ ...credentials, accessToken: "tok1" });
    const bearerSeen: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      bearerSeen.push(new Headers(init?.headers).get("authorization")!);
      return sseResponse();
    }) as unknown as typeof fetch;

    const facade = new CodeBuddyFacade(config, source, { fetchImpl });
    await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    set({ ...credentials, accessToken: "tok2" });
    await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));

    // 凭证按请求从源读取：源变化后，下一个请求立即使用新值（而非构造时捕获的旧值）
    expect(bearerSeen).toEqual(["Bearer tok1", "Bearer tok2"]);
  });

  test("keeps refreshed credentials for subsequent requests via the source", async () => {
    let refreshCalls = 0;
    let chatCalls = 0;
    const bearerSeen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/auth/token/refresh")) {
        refreshCalls++;
        return Response.json({ data: { accessToken: "new", refreshToken: "ref2", uid: "u1" } });
      }
      chatCalls++;
      bearerSeen.push(new Headers(init?.headers).get("authorization")!);
      if (chatCalls === 1) return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      return sseResponse();
    }) as unknown as typeof fetch;

    const { source } = sourceWith({ ...credentials, accessToken: "tok", refreshToken: "ref" });
    const facade = new CodeBuddyFacade(config, source, { fetchImpl });
    const r1 = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(r1.status).toBe(200);
    const r2 = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(r2.status).toBe(200);

    // 内置刷新采纳的新凭证对后续请求可见：请求 1 = 初试(tok)+401 刷新后重试(new)，
    // 请求 2 直接用 new 且不再触发刷新（refreshCalls 仍为 1）
    expect(refreshCalls).toBe(1);
    expect(bearerSeen).toEqual(["Bearer tok", "Bearer new", "Bearer new"]);
  });
});
