import { describe, expect, test } from "bun:test";
import { renderMarkdown, summarize, type ScenarioResult } from "./report";

const results: ScenarioResult[] = [
  {
    id: "chat.basic.nonstream", provider: "codearts", endpoint: "/v1/chat/completions",
    feature: "基础非流式", status: "pass", detail: "ok", durationMs: 812, model: "GLM-5.3-Flash",
    clause: "OAI-CHAT-01",
  },
  {
    id: "responses.image", provider: "codearts", endpoint: "/v1/responses",
    feature: "input_image", status: "fail", detail: "上游未见 image_url", durationMs: 655,
    model: "GLM-5.3-Flash", clause: "OAI-RESP-03", knownDefect: true,
  },
  {
    id: "chat.logprobs", provider: "codebuddy", endpoint: "/v1/chat/completions",
    feature: "logprobs", status: "skipped", detail: "skip reason", durationMs: 0,
  },
];

describe("report", () => {
  test("summarize counts by status", () => {
    expect(summarize(results)).toEqual({ pass: 1, fail: 1, "not-supported": 0, skipped: 1 });
  });

  test("markdown contains meta, counts and one row per scenario", () => {
    const md = renderMarkdown(
      {
        generatedAt: "2026-11-24T00:00:00.000Z",
        maxCalls: 40,
        calls: 2,
        providers: ["codearts", "codebuddy"],
        models: { codearts: "GLM-5.3-Flash" },
      },
      results,
    );
    expect(md).toContain("# e2e 相似度报告");
    expect(md).toContain("pass 1");
    expect(md).toContain("fail 1");
    expect(md).toContain("skipped 1");
    for (const r of results) expect(md).toContain(r.id);
    expect(md).toContain("已知缺陷");
    expect(md).toContain("OAI-RESP-03");
  });
});
