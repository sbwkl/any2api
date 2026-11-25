import { test, expect, describe } from "bun:test";
import { MsgCenterPoller } from "./msgcenter";
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
const credentials: Credentials = { accessToken: "tok", uid: "u1", domain: "www.codebuddy.cn", source: "env" };

describe("msg center poller", () => {
  test("tick calls the summary endpoint with auth headers", async () => {
    let seen: { url: string; headers: Headers } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), headers: new Headers(init?.headers) };
      return Response.json({ data: { total: 2 } });
    }) as unknown as typeof fetch;
    const poller = new MsgCenterPoller({ config, getCredentials: () => credentials, fetchImpl });
    await poller.tick();
    expect(seen!.url).toBe("https://example.test/v2/msg-center/message/summary");
    expect(seen!.headers.get("authorization")).toBe("Bearer tok");
    expect(seen!.headers.get("x-user-id")).toBe("u1");
    expect(seen!.headers.get("x-domain")).toBe("www.codebuddy.cn");
  });

  test("tick swallows non-OK responses", async () => {
    const fetchImpl = (async () => Response.json({ code: 500 }, { status: 500 })) as unknown as typeof fetch;
    const poller = new MsgCenterPoller({ config, getCredentials: () => credentials, fetchImpl });
    await expect(poller.tick()).resolves.toBeUndefined();
  });

  test("start/stop polls on the interval", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return Response.json({ data: { total: 0 } });
    }) as unknown as typeof fetch;
    const poller = new MsgCenterPoller({ config, getCredentials: () => credentials, fetchImpl, intervalMs: 10 });
    poller.start();
    await new Promise((r) => setTimeout(r, 40));
    poller.stop();
    expect(calls).toBeGreaterThan(0);
  });
});