import { test, expect, describe } from "bun:test";
import { gunzipSync } from "node:zlib";
import { CodeBuddyFacade } from "./openai";
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

describe("openai facade", () => {
  test("models lists the configured pool", async () => {
    const facade = new CodeBuddyFacade(config, credentials);
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
    }) as typeof fetch;

    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
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

  test("aggregates upstream SSE when stream=false", async () => {
    const fetchImpl = (async () => sseResponse()) as typeof fetch;
    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
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
    }) as typeof fetch;

    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
    const resp = await facade.handleChat(chatRequest({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }));
    expect(refreshSeen).toBe(true);
    expect(chatCalls).toBe(2);
    expect(resp.status).toBe(200);
  });

  test("maps a non-stream upstream rejection to an OpenAI error", async () => {
    const fetchImpl = (async () =>
      Response.json(
        { code: 11101, msg: "Non-stream chat request is currently not supported", displayMsg: { en: "No stream" } },
        { status: 400 },
      )) as typeof fetch;
    const facade = new CodeBuddyFacade(config, credentials, { fetchImpl });
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
});