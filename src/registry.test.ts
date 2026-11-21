import { test, expect, describe } from "bun:test";
import { mountProviders, type ProviderModule } from "./registry";

const defaultProvider: ProviderModule = {
  name: "default",
  prefix: "",
  required: true,
  create: async () => ({
    routes: [
      { method: "GET", path: "/v1/models", handle: () => Response.json({ provider: "default" }) },
      { method: "POST", path: "/v1/chat/completions", handle: () => new Response("default-chat") },
    ],
    health: () => ({ ok: true }),
  }),
};

const cbProvider: ProviderModule = {
  name: "cb",
  prefix: "/codebuddy",
  create: async () => ({
    routes: [
      { method: "GET", path: "/v1/models", handle: () => Response.json({ provider: "cb" }) },
    ],
    health: () => ({ ok: true, models: 2 }),
  }),
};

function req(path: string, method = "GET"): Request {
  return new Request(`http://localhost${path}`, { method });
}

describe("provider registry", () => {
  test("routes by prefix and strips the prefix", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const a: any = await (await handler(req("/v1/models"))).json();
    const b: any = await (await handler(req("/codebuddy/v1/models"))).json();
    expect(a.provider).toBe("default");
    expect(b.provider).toBe("cb");
  });

  test("longest prefix wins and respects path boundaries", async () => {
    const a: ProviderModule = {
      name: "a", prefix: "/a",
      create: async () => ({ routes: [{ method: "GET", path: "/x", handle: () => new Response("a") }] }),
    };
    const ab: ProviderModule = {
      name: "ab", prefix: "/a/b",
      create: async () => ({ routes: [{ method: "GET", path: "/x", handle: () => new Response("ab") }] }),
    };
    const handler = await mountProviders([a, ab]);
    expect(await (await handler(req("/a/b/x"))).text()).toBe("ab");
    expect(await (await handler(req("/a/x"))).text()).toBe("a");

    // /codebuddyx must not match /codebuddy
    const withCb = await mountProviders([defaultProvider, cbProvider]);
    expect((await withCb(req("/codebuddyx/v1/models"))).status).toBe(404);
  });

  test("returns 405 for a known path with the wrong method", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const resp = await handler(req("/codebuddy/v1/models", "POST"));
    expect(resp.status).toBe(405);
  });

  test("returns 404 for unknown paths under a provider prefix", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    expect((await handler(req("/codebuddy/nope"))).status).toBe(404);
  });

  test("aggregates provider health", async () => {
    const handler = await mountProviders([defaultProvider, cbProvider]);
    const resp = await handler(req("/healthz"));
    expect(resp.status).toBe(200);
    const j: any = await resp.json();
    expect(j.ok).toBe(true);
    expect(j.providers).toHaveLength(2);
    expect(j.providers.find((p: any) => p.provider === "cb").models).toBe(2);
  });

  test("optional provider failure degrades to 503 for its prefix only", async () => {
    const bad: ProviderModule = {
      name: "bad",
      prefix: "/bad",
      create: async () => { throw new Error("boom"); },
    };
    const handler = await mountProviders([defaultProvider, bad]);
    expect((await handler(req("/v1/models"))).status).toBe(200);
    const resp = await handler(req("/bad/v1/models"));
    expect(resp.status).toBe(503);
    const j: any = await resp.json();
    expect(j.error.type).toBe("provider_unavailable");
    expect(j.error.message).toContain("boom");
  });

  test("required provider failure aborts startup", async () => {
    const requiredBad: ProviderModule = {
      name: "req",
      prefix: "",
      required: true,
      create: async () => { throw new Error("fatal"); },
    };
    await expect(mountProviders([requiredBad])).rejects.toThrow("fatal");
  });
});