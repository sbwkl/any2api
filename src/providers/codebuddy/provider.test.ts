// provider 工厂缝（最高缝）：挂载真实 provider，注入假凭证源与假 fetchImpl，HTTP 驱动整条链路。
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mountProviders } from "../../registry";
import { createCodebuddyProvider } from "./index";
import { staticSource, type CredentialSource } from "./credentials";
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

describe("codebuddy 401 self-heal (T3)", () => {
  // 假上游：/auth/token/refresh 恒非 ok（内置 refreshToken 刷新失败），chat 按脚本应答
  function refreshDenied(): Response {
    return new Response("denied", { status: 401 });
  }

  test("401 with failed built-in refresh reloads a different token and retries once", async () => {
    const newCreds: Credentials = { accessToken: "new", refreshToken: "ref2", uid: "u1", source: "env" };
    let chatCalls = 0;
    const bearerSeen: string[] = [];
    let reloadCalls = 0;
    let current: Credentials = credentials;
    const source: CredentialSource = {
      get: () => current,
      reload: async () => {
        reloadCalls++;
        current = newCreds;
        return newCreds;
      },
      adopt: (next) => { current = next; },
    };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/auth/token/refresh")) return refreshDenied();
      chatCalls++;
      bearerSeen.push(new Headers(init?.headers).get("authorization") ?? "");
      if (chatCalls === 1) return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: source, fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    expect(resp.status).toBe(200);
    expect(chatCalls).toBe(2);
    expect(bearerSeen).toEqual(["Bearer tok", "Bearer new"]);
    expect(reloadCalls).toBe(1);
  });

  test("401 with reload returning the same token returns 401 asking to log in", async () => {
    let chatCalls = 0;
    let reloadCalls = 0;
    const source: CredentialSource = {
      get: () => credentials,
      reload: async () => {
        reloadCalls++;
        return credentials;
      },
      adopt: () => {},
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      if (String(url).includes("/auth/token/refresh")) return refreshDenied();
      chatCalls++;
      return Response.json({ code: 401, msg: "expired" }, { status: 401 });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: source, fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    expect(resp.status).toBe(401);
    const json: any = await resp.json();
    expect(json.error.message).toBe("请登录 CodeBuddy CN");
    expect(json.error.type).toBe("authentication_error");
    expect(json.error.code).toBe("credentials_not_ready");
    expect(chatCalls).toBe(1);
    expect(reloadCalls).toBe(1);
  });

  test("concurrent 401s reload the credential source only once (single-flight)", async () => {
    const newCreds: Credentials = { accessToken: "new", refreshToken: "ref2", uid: "u1", source: "env" };
    // 门闩：reload 卡住直到宏任务放行——微任务排空保证三个请求链都先抵达回源点
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reloadCalls = 0;
    let current: Credentials = credentials;
    const source: CredentialSource = {
      get: () => current,
      reload: async () => {
        reloadCalls++;
        await gate;
        current = newCreds;
        return newCreds;
      },
      adopt: (next) => { current = next; },
    };
    const bearerSeen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/auth/token/refresh")) return refreshDenied();
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      bearerSeen.push(auth);
      if (auth === "Bearer tok") return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: source, fetchImpl }),
    ]);

    const pending = [
      handler(chatRequest()),
      handler(chatRequest()),
      handler(chatRequest()),
    ];
    // 宏任务放行：三个请求链（纯微任务驱动）先全部卡在门闩上，reload 因此只发起一次
    setTimeout(release, 10);
    const responses = await Promise.all(pending);

    expect(reloadCalls).toBe(1);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(bearerSeen.filter((b) => b === "Bearer tok")).toHaveLength(3);
    expect(bearerSeen.filter((b) => b === "Bearer new")).toHaveLength(3);
  });

  test("adopts reloaded credentials when only the uid changed", async () => {
    const sameTokNewUid: Credentials = { accessToken: "tok", refreshToken: "ref", uid: "u2", source: "env" };
    let chatCalls = 0;
    const headersSeen: Array<{ authorization: string; userId: string }> = [];
    let current: Credentials = credentials;
    const source: CredentialSource = {
      get: () => current,
      reload: async () => {
        current = sameTokNewUid;
        return sameTokNewUid;
      },
      adopt: (next) => { current = next; },
    };
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/auth/token/refresh")) return refreshDenied();
      chatCalls++;
      if (chatCalls === 1) return Response.json({ code: 401, msg: "expired" }, { status: 401 });
      const h = new Headers(init?.headers);
      headersSeen.push({ authorization: h.get("authorization") ?? "", userId: h.get("x-user-id") ?? "" });
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: source, fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    // accessToken 未变但 uid 变了也算新凭证：采纳并重试，第二次用新 uid
    expect(resp.status).toBe(200);
    expect(chatCalls).toBe(2);
    expect(headersSeen).toEqual([{ authorization: "Bearer tok", userId: "u2" }]);
  });
});

describe("codebuddy credentials-not-ready state", () => {
  // 凭证未就绪的空源：get/reload 均无凭证（模拟「进程先启动、还没登录」）
  const emptySource: CredentialSource = {
    get: () => null,
    reload: async () => null,
    adopt: () => {},
  };

  test("mounts without credentials; healthz reports credentialsReady:false instead of a mount failure", async () => {
    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: emptySource }),
    ]);
    const resp = await handler(new Request("http://localhost/healthz"));

    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.providers).toEqual([
      { provider: "codebuddy", ok: false, credentialsReady: false, models: 1 },
    ]);
  });

  test("chat while not ready returns 401 asking to log in CodeBuddy CN, not 503", async () => {
    let upstreamCalls = 0;
    const fetchImpl = (async () => {
      upstreamCalls++;
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: emptySource, fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    expect(resp.status).toBe(401);
    const json: any = await resp.json();
    expect(json.error.message).toBe("请登录 CodeBuddy CN");
    expect(json.error.type).toBe("authentication_error");
    expect(upstreamCalls).toBe(0);
  });

  test("/v1/models still serves the model list while not ready", async () => {
    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: emptySource }),
    ]);
    const resp = await handler(new Request("http://localhost/codebuddy/v1/models"));

    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.object).toBe("list");
    expect(json.data.map((m: any) => m.id)).toContain("hy4flash-free");
  });

  test("next request succeeds after credentials appear on disk, no remount needed", async () => {
    const upstreamAuths: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      upstreamAuths.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    // 模拟磁盘凭证源：内存值与磁盘分离，reload() 代表按需读盘
    let onDisk: Credentials | null = null;
    let current: Credentials | null = null;
    let reloadCalls = 0;
    const lazyDiskSource: CredentialSource = {
      get: () => current,
      reload: async () => {
        reloadCalls++;
        current = onDisk;
        return onDisk;
      },
      adopt: (next) => { current = next; },
    };

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: lazyDiskSource, fetchImpl }),
    ]);

    const beforeLogin = await handler(chatRequest());
    expect(beforeLogin.status).toBe(401);
    expect(upstreamAuths.length).toBe(0);
    expect(reloadCalls).toBe(1);

    // 模拟用户在 CodeBuddy CN 登录：凭证落盘
    onDisk = credentials;

    const afterLogin = await handler(chatRequest());
    expect(afterLogin.status).toBe(200);
    expect(upstreamAuths).toEqual(["Bearer tok"]);
    expect(reloadCalls).toBe(2);
  });

  test("default credential source mounts without credentials (not ready, not failed)", async () => {
    // CODEBUDDY_TOKEN 已设但缺 CODEBUDDY_UID → loadCredentials 抛错；默认源应吞错进入未就绪态而非 create 失败
    delete process.env.CODEBUDDY_SESSION_JSON;
    process.env.CODEBUDDY_TOKEN = "tok-without-uid";

    const handler = await mountProviders([createCodebuddyProvider()]);
    const resp = await handler(new Request("http://localhost/healthz"));

    expect(resp.status).toBe(200);
    const json: any = await resp.json();
    expect(json.ok).toBe(false);
    expect(json.providers).toEqual([
      { provider: "codebuddy", ok: false, credentialsReady: false, models: 1 },
    ]);
  });

  test("requests with ready credentials do not reload the credential source", async () => {
    let upstreamCalls = 0;
    let reloadCalls = 0;
    const readySource: CredentialSource = {
      get: () => credentials,
      reload: async () => {
        reloadCalls++;
        return credentials;
      },
      adopt: () => {},
    };
    const fetchImpl = (async () => {
      upstreamCalls++;
      return new Response(SSE, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as unknown as typeof fetch;

    const handler = await mountProviders([
      createCodebuddyProvider({ credentialSource: readySource, fetchImpl }),
    ]);
    const resp = await handler(chatRequest());

    expect(resp.status).toBe(200);
    expect(upstreamCalls).toBe(1);
    expect(reloadCalls).toBe(0);
  });
});
