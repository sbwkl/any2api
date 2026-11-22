import { test, expect, describe } from "bun:test";
import { sanitizeSystemText } from "./system";

describe("sanitizeSystemText", () => {
  test("removes the competitor preamble across whitespace/apostrophe variants", () => {
    const variants = [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      "You are Claude Code,  Anthropic's official CLI for Claude.",
      "You are Claude Code,\nAnthropic's official CLI for Claude.",
      "You are Claude Code,\tAnthropic's official CLI for Claude.",
      "You are Claude Code, Anthropic’s official CLI for Claude.",
      "You are Claude Code, Anthropic's official CLI for Claude",
      "You  are  Claude  Code,  Anthropic's  official  CLI  for  Claude.",
    ];
    for (const text of variants) {
      const out = sanitizeSystemText(text);
      expect(out).not.toContain("official CLI");
      expect(out).toContain("You are an AI coding assistant.");
    }
  });

  test("keeps unrelated system text unchanged", () => {
    const text = "You are a helpful assistant. Be concise.";
    expect(sanitizeSystemText(text)).toBe(text);
  });

  test("removes the Anthropic billing header line", () => {
    const text = "You are a helpful assistant.\nx-anthropic-billing-header: cc_version=1.0\nBe concise.";
    expect(sanitizeSystemText(text)).not.toContain("x-anthropic-billing-header");
  });
});