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
    expect(applyPromptCacheControl(messages)).toBe(messages);
  });
});