import { test, expect, describe } from "bun:test";
import { applyPromptCacheControl } from "./cache";

const long = "x".repeat(1100);

describe("prompt cache control", () => {
  test("adds cache_control to the system and last user message", () => {
    const out = applyPromptCacheControl([
      { role: "system", content: long },
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: long },
    ]);
    const sys: any = out[0];
    expect(Array.isArray(sys.content)).toBe(true);
    expect(sys.content[0].cache_control).toEqual({ type: "ephemeral" });
    const last: any = out[3];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(typeof out[1].content).toBe("string");
  });

  test("leaves short messages unchanged", () => {
    const messages = [
      { role: "system", content: "short" },
      { role: "user", content: "hi" },
    ];
    expect(applyPromptCacheControl(messages)).toEqual(messages);
  });

  test("does not duplicate an explicit cache_control", () => {
    const messages = [
      { role: "system", content: [{ type: "text", text: long, cache_control: { type: "ephemeral" } }] },
      { role: "user", content: "hi" },
    ];
    const out = applyPromptCacheControl(messages);
    expect(out).toEqual(messages);
    expect((out[0] as any).content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("adds cache_control to the longest system, not the short agent prompt", () => {
    const out = applyPromptCacheControl([
      { role: "system", content: "You are an AI coding assistant." },
      { role: "system", content: long },
      { role: "user", content: "hi" },
    ]);
    expect(typeof (out[0] as any).content).toBe("string");
    expect(Array.isArray((out[1] as any).content)).toBe(true);
    expect((out[1] as any).content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  test("an explicit cache_control on one message does not block auto on another", () => {
    const out = applyPromptCacheControl([
      { role: "system", content: long },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok", cache_control: { type: "ephemeral" } }],
      },
    ]);
    expect(Array.isArray((out[0] as any).content)).toBe(true);
    expect((out[0] as any).content[0].cache_control).toEqual({ type: "ephemeral" });
    expect((out[2] as any).content[0].cache_control).toEqual({ type: "ephemeral" });
  });
});