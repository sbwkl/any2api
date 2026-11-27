// provider 工厂缝（最高缝）：挂载真实 provider，注入假凭证源与假 fetchImpl，HTTP 驱动整条链路。
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountProviders } from "../../registry";
import { createCodebuddyProvider } from "./index";
import { staticSource } from "./credentials";
import type { Credentials } from "./types";

const oldEnv = { ...process.env };
afterEach(() => {
  process.env = { ...oldEnv };
});

beforeEach(() => {
  // 隔离本机 CodeBuddy 安装：产品配置走回退模型，不读真实 state.vscdb / product.json
  const absentHome = join(mkdtempSync(join(tmpdir(), "any2api-codebuddy-t1-")), "absent");
  process.env.CODEBUDDY_GENIE_HOME = absentHome;
  process.env.CODEBUDDY_STATE_DB = join(absentHome, "state.vscdb");
});

const credentials: Credentials = { accessToken: "tok", refreshToken: "ref", uid: "u1", source: "env" };

const SSE = [
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"}}]}`,
  "",
  `data: {"id":"1","model":"hy4flash-free","created":1,"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  "",
  "data: [DONE]",
  "",
].join("\n");

function chatRequest(): Request {
  return new Request("http://localhost/codebuddy/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "hy4flash-free",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    }),
  });
}

describe("codebuddy provider with injected deps", () => {
  test("serves chat through the real provider with an injected credential source and fetchImpl", async () => {
    let chatCalls = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      chatCalls++;
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: staticSource(credentials), fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.choices[0].message.content).toBe("Hello");
    expect(chatCalls).toBe(1);
  });

  test("healthz reports the injected credential source and uid", async () => {
    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: staticSource(credentials) }),
    ]);
    const resp = await handler(new Request("http://localhost/healthz"));

    const json: any = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.providers).toEqual([
      { provider: "codebuddy", ok: true, models: 1, credentialSource: "env", uid: "u1..." },
    ]);
  });

  test("default provider mounts via real loadCredentials (env priority)", async () => {
    process.env.CODEBUDDY_TOKEN = "env-tok";
    process.env.CODEBUDDY_UID = "env-u1";

    const handler = await mountProviders([createCodebuddyProvider()]);
    const resp = await handler(new Request("http://localhost/healthz"));

    const json: any = await resp.json();
    expect(json.ok).toBe(true);
    expect(json.providers).toEqual([
      { provider: "codebuddy", ok: true, models: 1, credentialSource: "env", uid: "env-u1..." },
    ]);
  });
});
