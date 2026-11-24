import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config";

describe("e2e config", () => {
  test("defaults match the plan", () => {
    const c = loadConfig({}, []);
    expect(c.maxCalls).toBe(40);
    expect(c.providers).toEqual(["codearts", "codebuddy"]);
    expect(c.modelPreference).toEqual(["GLM-5.3-Flash", "DeepSeek-v4.1-Flash(1017)"]);
    expect(c.modelFallback).toBeUndefined();
    expect(c.record).toBe(false);
    expect(c.baseline).toBe(false);
    expect(c.timeoutMs).toBe(120000);
    expect(c.port).toBe(0);
    expect(c.fixturesDir).toBe("e2e/fixtures");
    expect(c.reportsDir).toBe("e2e/reports");
    expect(c.imageUrl).toBeUndefined();
    expect(c.only).toBeUndefined();
  });

  test("env overrides", () => {
    const c = loadConfig(
      {
        E2E_MAX_CALLS: "7",
        E2E_PROVIDERS: "codearts",
        E2E_MODEL_PREFERENCE: "A, B",
        E2E_MODEL_FALLBACK: "C",
        E2E_TIMEOUT_MS: "5000",
        E2E_PORT: "19999",
        E2E_FIXTURES_DIR: "tmp/fx",
        E2E_REPORTS_DIR: "tmp/rp",
        E2E_IMAGE_URL: "https://example.com/x.png",
        E2E_ONLY: "image",
      },
      [],
    );
    expect(c.maxCalls).toBe(7);
    expect(c.providers).toEqual(["codearts"]);
    expect(c.modelPreference).toEqual(["A", "B"]);
    expect(c.modelFallback).toBe("C");
    expect(c.timeoutMs).toBe(5000);
    expect(c.port).toBe(19999);
    expect(c.fixturesDir).toBe("tmp/fx");
    expect(c.reportsDir).toBe("tmp/rp");
    expect(c.imageUrl).toBe("https://example.com/x.png");
    expect(c.only).toBe("image");
  });

  test("flags enable record and baseline", () => {
    const c = loadConfig({ E2E_RECORD: "1" }, ["--baseline"]);
    expect(c.record).toBe(true);
    expect(c.baseline).toBe(true);
  });

  test("rejects invalid max calls and provider names", () => {
    expect(() => loadConfig({ E2E_MAX_CALLS: "0" }, [])).toThrow("E2E_MAX_CALLS");
    expect(() => loadConfig({ E2E_MAX_CALLS: "abc" }, [])).toThrow("E2E_MAX_CALLS");
    expect(() => loadConfig({ E2E_PROVIDERS: "codearts,nope" }, [])).toThrow("E2E_PROVIDERS");
  });
});
