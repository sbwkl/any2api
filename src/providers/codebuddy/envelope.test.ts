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

  test("normalizeMessages drops null and empty-array content", () => {
    const out = normalizeMessages([
      { role: "user", content: "hi" },
      { role: "user", content: null },
      { role: "user", content: [] },
      { role: "user", content: "" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].content).toBe("hi");
    expect(out[1].content).toBe("");
  });

  test("normalizeMessages sanitizes every occurrence of the preamble", () => {
    const out = normalizeMessages([
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude. A. You are Claude Code, Anthropic's official CLI for Claude. B.",
      },
    ]);
    expect(out[0].content).not.toContain("Anthropic's official CLI");
    expect(out[0].content).toContain("You are an AI coding assistant. A.");
  });

  test("normalizeMessages keeps tool messages with null or empty-array content", () => {
    const out = normalizeMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [] },
      { role: "tool", tool_call_id: "c2", content: null },
    ]);
    const tools = out.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0].content).toBe("");
    expect(tools[1].content).toBe("");
  });

  test("normalizeMessages drops the client billing header block", () => {
    const out = normalizeMessages([
      {
        role: "system",
        content: [
          { type: "text", text: "x-anthropic-billing-header: cc_version=2.1.319.b5f; cc_entrypoint=sdk-cli;" },
          { type: "text", text: "Be brief." },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toEqual([{ type: "text", text: "Be brief." }]);
  });

  test("normalizeMessages drops a system message that only holds the billing header", () => {
    const out = normalizeMessages([
      { role: "system", content: "x-anthropic-billing-header: cc_version=2.1.319.b5f; cc_entrypoint=sdk-cli;" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  test("normalizeMessages keeps leading and trailing whitespace when no billing header is present", () => {
    const out = normalizeMessages([{ role: "system", content: "  keep me  " }]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("  keep me  ");
  });

  test("normalizeMessages keeps a pre-existing empty text block and its cache_control", () => {
    const block = { type: "text", text: "", cache_control: { type: "ephemeral" } };
    const out = normalizeMessages([{ role: "system", content: [block, { type: "text", text: "Be brief." }] }]);
    expect(out).toHaveLength(1);
    expect((out[0].content as any[])[0]).toEqual(block);
  });

  test("normalizeMessages keeps a pre-existing empty system message", () => {
    const out = normalizeMessages([
      { role: "system", content: "" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("system");
    expect(out[0].content).toBe("");
  });

  // R30：content 为 null / 空数组的非 tool 消息一律丢弃，system/developer 也不例外。
  test("normalizeMessages drops a system message whose content is an empty array", () => {
    const out = normalizeMessages([
      { role: "system", content: [] },
      { role: "developer", content: [] },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  test("normalizeMessages drops a system message whose content is null", () => {
    const out = normalizeMessages([
      { role: "system", content: null },
      { role: "user", content: "hi" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  test("normalizeMessages strips a CRLF billing header line and keeps the rest", () => {
    const out = normalizeMessages([
      { role: "system", content: "x-anthropic-billing-header: cc_version=1\r\nBe brief.\r\n" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("Be brief.\r\n");
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

  test("buildRequestBody passes through OpenAI fields", () => {
    const body = buildRequestBody({
      model,
      messages: [{ role: "user", content: "hi" }],
      frequencyPenalty: 0.5,
      presencePenalty: 0.2,
      stop: ["\n"],
      seed: 42,
      responseFormat: { type: "json_object" },
      parallelToolCalls: false,
      streamOptions: { include_usage: true },
      metadata: { a: 1 },
      store: true,
      user: "u1",
      serviceTier: "auto",
      maxCompletionTokens: 123,
    });
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.presence_penalty).toBe(0.2);
    expect(body.stop).toEqual(["\n"]);
    expect(body.seed).toBe(42);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.parallel_tool_calls).toBe(false);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.metadata).toEqual({ a: 1 });
    expect(body.store).toBe(true);
    expect(body.user).toBe("u1");
    expect(body.service_tier).toBe("auto");
    expect(body.max_completion_tokens).toBe(123);
    expect(body.max_tokens).toBeUndefined();
  });

  test("buildRequestBody clamps reasoning effort to supported efforts", () => {
    const withSupport = { ...model, supportedEfforts: ["high"] };
    const minimal = buildRequestBody({ model: withSupport, messages: [{ role: "user", content: "hi" }], reasoningEffort: "minimal" });
    expect(minimal.reasoning_effort).toBe("high");

    const offWithSupport = buildRequestBody({ model: withSupport, messages: [{ role: "user", content: "hi" }], reasoningEffort: "off" });
    expect(offWithSupport.reasoning_effort).toBe("high");

    const withoutSupport = { ...model, supportedEfforts: undefined };
    const off = buildRequestBody({ model: withoutSupport, messages: [{ role: "user", content: "hi" }], reasoningEffort: "off" });
    expect(off.reasoning_effort).toBe("low");
  });

  test("normalizeMessages drops messages without content or tool_calls", () => {
    const out = normalizeMessages([
      { role: "user", content: "hi" },
      { role: "assistant" },
      { role: "assistant", content: "" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe("user");
    expect(out[1].content).toBe("");
  });

  test("mapFinishReason maps tool_calls and content filter", () => {
    expect(mapFinishReason("tool_calls")).toBe("tool_calls");
    expect(mapFinishReason("content-filter")).toBe("content_filter");
    expect(mapFinishReason("stop")).toBe("stop");
    expect(mapFinishReason("")).toBe("stop");
  });
});