import { describe, expect, test } from "bun:test";
import {
  computeCoverage,
  renderBaselineIndex,
  renderHtml,
  summarize,
  type ReportMeta,
  type ScenarioResult,
  type ScenarioSetEntry,
} from "./report";

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
    id: "chat.basic.nonstream", provider: "codebuddy", endpoint: "/v1/chat/completions",
    feature: "基础非流式", status: "pass", detail: "ok", durationMs: 770, model: "GLM-5.3-Flash",
    clause: "OAI-CHAT-01",
    evidence: {
      inbound: [{
        method: "POST",
        path: "/v1/chat/completions",
        requestBody: { model: "GLM-5.3-Flash", messages: [{ role: "user", content: "say hi" }] },
        response: { status: 200, contentType: "application/json", text: "{}" },
      }],
      upstream: [],
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
    id: "responses.image", provider: "codebuddy", endpoint: "/v1/responses",
    feature: "input_image", status: "fail", detail: "上游未见 image_url", durationMs: 610,
    model: "GLM-5.3-Flash", clause: "OAI-RESP-03", knownDefect: true,
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
    id: "chat.logprobs", provider: "codearts", endpoint: "/v1/chat/completions",
    feature: "logprobs", status: "skipped", detail: "未设置 E2E_IMAGE_URL", durationMs: 0,
  },
  {
    id: "chat.logprobs", provider: "codebuddy", endpoint: "/v1/chat/completions",
    feature: "logprobs", status: "skipped", detail: "未设置 E2E_IMAGE_URL", durationMs: 0,
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

const scenarioSet: ScenarioSetEntry[] = [
  { id: "chat.basic.nonstream", endpoint: "/v1/chat/completions", feature: "基础非流式", clause: "OAI-CHAT-01" },
  { id: "responses.image", endpoint: "/v1/responses", feature: "input_image", clause: "OAI-RESP-03", knownDefect: true },
  { id: "chat.logprobs", endpoint: "/v1/chat/completions", feature: "logprobs" },
];

const meta: ReportMeta = {
  generatedAt: "2026-11-24T00:00:00.000Z",
  baseUrl: "http://127.0.0.1:1234",
  maxCalls: 60,
  calls: 2,
  providers: ["codearts", "codebuddy"],
  models: { codearts: "GLM-5.3-Flash", codebuddy: "GLM-5.3-Flash" },
  scenarioSet,
  coverage: computeCoverage(scenarioSet, results, ["codearts", "codebuddy"]),
};

describe("report", () => {
  test("summarize counts by status", () => {
    expect(summarize(results)).toEqual({ pass: 3, fail: 2, "not-supported": 0, skipped: 2 });
  });

  test("coverage is identical for both providers when every scenario ran", () => {
    expect(computeCoverage(scenarioSet, results, ["codearts", "codebuddy"])).toEqual([
      { provider: "codearts", expected: 3, actual: 3, missing: [], extra: [], orderMatches: true },
      { provider: "codebuddy", expected: 3, actual: 3, missing: [], extra: [], orderMatches: true },
    ]);
  });

  test("html renders one cross-provider matrix instead of duplicate provider tables", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain('<section id="matrix">');
    expect(html).toContain("<th>codearts</th>");
    expect(html).toContain("<th>codebuddy</th>");
    expect(html).toContain('data-statuses="pass pass"');
    expect(html).toContain('data-statuses="fail fail"');
    expect(html).toContain('data-statuses="skipped skipped"');
    expect(html).not.toContain('<section id="codearts">');
    expect(html).toContain("场景集一致");
    expect(html).toContain("codearts 3/3");
  });

  test("every matrix cell links to its own provider evidence", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain('<section id="evidence-codearts">');
    expect(html).toContain('<section id="evidence-codebuddy">');
    expect(html).toContain('href="#ev-codearts-0"');
    expect(html).toContain('href="#ev-codebuddy-0"');
    expect(html).toContain('id="ev-codearts-0"');
    expect(html).toContain('id="ev-codebuddy-0"');
    expect(html).toContain("输入");
    expect(html).toContain("上游请求");
    expect(html).toContain("输出");
    expect(html).toContain("say hi");
    expect(html).toContain("injected");
    expect(html).toContain("&quot;content&quot;: &quot;hi&quot;");
  });

  test("global healthz stays in its own section outside provider columns", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain('<section id="global">');
    expect(html).toContain("全局接口");
    expect(html).toContain('id="ev-global-0"');
  });

  test("filters count scenario rows by any-provider status", () => {
    const html = renderHtml(meta, results, { dataFile: "e2e-baseline.json" });
    expect(html).toContain('data-filter="all" class="active">全部 <span class="n">4</span>');
    expect(html).toContain('data-filter="fail">fail <span class="n">1</span>');
    expect(html).toContain('data-filter="not-supported">not-supported <span class="n">0</span>');
    expect(html).toContain('data-filter="skipped">skipped <span class="n">1</span>');
  });

  test("a missing provider scenario is shown as missing and breaks coverage", () => {
    const missingResults = results.filter((result) => !(result.provider === "codebuddy" && result.id === "chat.logprobs"));
    const missingMeta: ReportMeta = {
      ...meta,
      coverage: computeCoverage(scenarioSet, missingResults, ["codearts", "codebuddy"]),
    };
    const html = renderHtml(missingMeta, missingResults, { dataFile: "e2e-baseline.json" });
    expect(html).toContain("场景集不一致");
    expect(html).toContain("缺 chat.logprobs");
    expect(html).toContain("缺失");
    expect(html).toContain('data-statuses="skipped missing"');
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
    expect(md).toContain("pass 3");
    expect(md).toContain("场景集：");
    expect(md).not.toContain("| 场景 |");
  });
});
