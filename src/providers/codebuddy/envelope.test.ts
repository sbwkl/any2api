import { test, expect, describe } from "bun:test";
import {
  normalizeMessages,
  mergeAgentPrompt,
  mapTools,
  buildRequestBody,
  mapUsage,
  mapFinishReason,
} from "./envelope";

const model = {
  id: "hy4flash-free",
  name: "Hy4 flash",
  maxOutputTokens: 64000,
  maxInputTokens: 960000,
  supportsToolCall: true,
  supportsReasoning: true,
  temperature: 0.9,
};

describe("envelope", () => {
  test("developer role is normalized to system", () => {
    const out = normalizeMessages([
      { role: "developer", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    expect(out[0].role).toBe("system");
    expect(out[1].role).toBe("user");
  });

  test("normalizeMessages sanitizes competitor system preambles", () => {
    const out = normalizeMessages([
      { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude. Be brief." },
    ]);
    expect(out[0].content).toContain("You are an AI coding assistant.");
    expect(out[0].content).not.toContain("Anthropic's official CLI");
  });

  test("mergeAgentPrompt prepends the agent system message", () => {
    const out = mergeAgentPrompt([{ role: "user", content: "hi" }], "<system_prompt>X</system_prompt>");
    expect(out[0]).toEqual({ role: "system", content: "<system_prompt>X</system_prompt>" });
    expect(out[1].role).toBe("user");
  });

  test("mapTools keeps function tools and drops unsupported fields", () => {
    const out = mapTools([
      {
        type: "function",
        function: { name: "f", description: "d", parameters: { type: "object" }, strict: true },
      },
      { type: "other" },
    ]);
    expect(out).toEqual([
      { type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } },
    ]);
    expect(mapTools([])).toBeUndefined();
  });

  test("buildRequestBody uses max_tokens and model temperature", () => {
    const body = buildRequestBody({ model, messages: [{ role: "user", content: "hi" }] });
    expect(body.model).toBe("hy4flash-free");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(64000);
    expect(body.temperature).toBe(0.9);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  test("buildRequestBody uses max_completion_tokens for gpt-5", () => {
    const gpt = { ...model, id: "gpt-5.4", name: "GPT-5.4", temperature: undefined };
    const body = buildRequestBody({ model: gpt, messages: [{ role: "user", content: "hi" }] });
    expect(body.max_completion_tokens).toBe(64000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  test("buildRequestBody clamps client max_tokens and adds tools", () => {
    const body = buildRequestBody({
      model,
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "f", parameters: {} } }],
      toolChoice: "auto",
      maxTokens: 1000000,
    });
    expect(body.max_tokens).toBe(64000);
    expect(body.tools).toHaveLength(1);
    expect(body.tool_choice).toBe("auto");
  });

  test("mapUsage maps cache and reasoning tokens", () => {
    const usage = mapUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 4 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.prompt_tokens_details.cached_tokens).toBe(4);
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(3);
  });

  test("mapFinishReason maps tool_calls and content filter", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("content-filter")).toBe("content_filter");
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("")).toBe("stop");
  });
});