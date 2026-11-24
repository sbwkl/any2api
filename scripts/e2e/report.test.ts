import { describe, expect, test } from "bun:test";
import { renderBaselineIndex, renderHtml, summarize, type ScenarioResult } from "./report";

const results: ScenarioResult[] = [
  {
    id: "chat.basic.nonstream", provider: "codearts", endpoint: "/v1/chat/completions",
    feature: "基础非流式", status: "pass", detail: "ok", durationMs: 812, model: "GLM-5.3-Flash",
    clause: "OAI-CHAT-01",
    evidence: {
      inbound: [{
        method: "POST",
        path: "/v1/chat/completions",
        requestBody: { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "say hi" }] },
        response: {
          status: 200,
          contentType: "application/json",
          text: JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        },
      }],
      upstream: [{ url: "https://upstream/v2/chat", body: { model: "GLM-5.3-Flash", injected: true } }],
    },
  },
  {
    id: "responses.image", provider: "codearts", endpoint: "/v1/responses",
    feature: "input_image", status: "fail", detail: "上游未见 image_url <script>alert(1)</script>",
    durationMs: 655, model: "GLM-5.3-Flash", clause: "OAI-RESP-03", knownDefect: true,
    evidence: {
      inbound: [{
        method: "POST",
        path: "/v1/responses",
        requestBody: { model: "GLM-5.3-Flash", input: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }] },
        response: { status: 200, contentType: "application/json", text: "{}" },
      }],
      upstream: [],
    },
  },
  {
    id: "chat.logprobs", provider: "codebuddy", endpoint: "/v1/chat/completions",
    feature: "logprobs", status: "skipped", detail: "skip reason", durationMs: 0,
  },
  {
    id: "healthz.aggregate", provider: "all", endpoint: "/healthz",
    feature: "聚合健康检查", status: "pass", detail: "HTTP 200；2 个 provider", durationMs: 1,
    evidence: {
      inbound: [{
        method: "GET",
        path: "/healthz",
        response: { status: 200, contentType: "application/json", text: JSON.stringify({ ok: true, providers: [] }) },
      }],
      upstream: [],
    },
  },
];

const meta = {
  generatedAt: "2026-11-24T00:00:00.000Z",
  baseUrl: "http://127.0.0.1:1234",
  maxCalls: 60,
  calls: 2,
  providers: ["codearts", "codebuddy"],
  models: { codearts: "GLM-5.3-Flash", codebuddy: "GLM-5.3-Flash" },
};

describe("report", () => {
  test("summarize counts by status", () => {
    expect(summarize(results)).toEqual({ pass: 2, fail: 1, "not-supported": 0, skipped: 1 });
  });

  test("html renders per-provider sections instead of a single table", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain('<section id="codearts">');
    expect(html).toContain('<section id="codebuddy">');
    expect(html).toContain('<section id="global">');
    expect(html).toContain('data-filter="fail"');
    expect(html).toContain('data-filter="not-supported"');
    expect(html).toContain('data-filter="skipped"');
    expect(html).toContain("e2e-baseline.json");
  });

  test("html shows input, upstream request and output evidence", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain("输入");
    expect(html).toContain("上游请求");
    expect(html).toContain("输出");
    expect(html).toContain("say hi");
    expect(html).toContain("injected");
    expect(html).toContain("&quot;content&quot;: &quot;hi&quot;");
  });

  test("html escapes user-controlled text and does not load external assets", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script src=");
    expect(html).not.toContain('<link rel="stylesheet"');
  });

  test("baseline index links artifacts without duplicating the matrix", () => {
    const md = renderBaselineIndex(meta, results);
    expect(md).toContain("# e2e 基线");
    expect(md).toContain("[e2e-baseline.html](e2e-baseline.html)");
    expect(md).toContain("[e2e-baseline.json](e2e-baseline.json)");
    expect(md).toContain("pass 2");
    expect(md).not.toContain("| 场景 |");
  });
});
