#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { dumpSize } from "./dump";
import { selectModel } from "./models";
import { renderMarkdown, summarize, type ScenarioResult } from "./report";
import { buildScenarios, type Scenario, type ScenarioContext, type Verdict } from "./scenarios";
import { startServer } from "./server";

const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;

async function healthyProviders(baseUrl: string): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/healthz`);
  const json: any = await res.json();
  return new Set(
    (json?.providers ?? [])
      .filter((p: any) => p?.ok !== false)
      .map((p: any) => p.provider)
      .filter((p: any) => typeof p === "string"),
  );
}

async function listModels(baseUrl: string, provider: string): Promise<string[]> {
  const res = await fetch(`${baseUrl}/${provider}/v1/models`);
  if (!res.ok) return [];
  const json: any = await res.json().catch(() => null);
  return Array.isArray(json?.data)
    ? json.data.map((m: any) => m?.id).filter((id: any) => typeof id === "string" && id.length > 0)
    : [];
}

export async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[e2e] 预算 E2E_MAX_CALLS=${cfg.maxCalls}；provider: ${cfg.providers.join(", ")}`);
  const server = await startServer({ port: cfg.port });
  console.log(`[e2e] 服务已启动：${server.baseUrl}`);

  try {
    const healthy = await healthyProviders(server.baseUrl);
    const selected: Record<string, string | undefined> = {};
    for (const provider of cfg.providers) {
      if (!healthy.has(provider)) {
        console.warn(`[e2e] ${provider} 不可用（健康检查未列出），相关场景将标记 skipped`);
        continue;
      }
      const ids = await listModels(server.baseUrl, provider);
      const sel = selectModel(ids, cfg.modelPreference, cfg.modelFallback);
      selected[provider] = sel.model;
      console.log(`[e2e] ${provider}: ${ids.length} 个模型，选择 ${sel.model ?? "(无)"}（${sel.reason}）`);
    }

    const scenarios = buildScenarios(cfg.providers).filter((s) => !cfg.only || s.id.includes(cfg.only));
    const results: ScenarioResult[] = [];
    let calls = 0;
    let fixtureBytes = 0;
    let fixtureWarning = false;

    for (const scenario of scenarios) {
      const provider = scenario.provider === "all" ? cfg.providers[0] : scenario.provider;
      const skip = skipReason(scenario, provider, healthy, selected, cfg.maxCalls, calls, cfg.imageUrl);
      if (skip) {
        results.push(toResult(scenario, selected, "skipped", skip, 0));
        console.log(`[e2e] ${"SKIP".padEnd(13)} ${scenario.provider}/${scenario.id} ${skip}`);
        continue;
      }

      const costsCall = scenario.needsModel !== false;
      if (costsCall) calls++;

      const started = Date.now();
      const ctx: ScenarioContext = {
        provider,
        baseUrl: server.baseUrl,
        model: selected[provider] ?? "",
        imageUrl: cfg.imageUrl,
        timeoutMs: cfg.timeoutMs,
        dumpDir: server.dumpDir,
        dumpMark: await dumpSize(server.dumpDir),
        capture: [],
      };

      let verdict: Verdict;
      try {
        verdict = await scenario.run(ctx);
      } catch (e: any) {
        verdict = { status: "fail", detail: `调用异常：${e?.message ?? e}` };
      }
      const result = toResult(scenario, selected, verdict.status, verdict.detail, Date.now() - started);
      results.push(result);
      console.log(`[e2e] ${verdict.status.toUpperCase().padEnd(13)} ${scenario.provider}/${scenario.id} (${result.durationMs}ms) ${verdict.detail}`);

      if (cfg.record) {
        const payload = JSON.stringify(
          { scenario: scenario.id, provider, model: ctx.model, capturedAt: new Date().toISOString(), calls: ctx.capture },
          null,
          2,
        );
        const bytes = Buffer.byteLength(payload);
        if (fixtureBytes + bytes > MAX_FIXTURE_BYTES) {
          if (!fixtureWarning) {
            console.warn(`[e2e] fixture 体积将超过 2MB，后续场景不再记录`);
            fixtureWarning = true;
          }
        } else {
          mkdirSync(cfg.fixturesDir, { recursive: true });
          writeFileSync(join(cfg.fixturesDir, `${provider}.${scenario.id}.json`), payload);
          fixtureBytes += bytes;
        }
      }
    }

    const meta = {
      generatedAt: new Date().toISOString(),
      baseUrl: server.baseUrl,
      maxCalls: cfg.maxCalls,
      calls,
      providers: cfg.providers,
      models: selected,
    };
    const markdown = renderMarkdown(meta, results);
    mkdirSync(cfg.reportsDir, { recursive: true });
    writeFileSync(join(cfg.reportsDir, "latest.md"), markdown);
    writeFileSync(join(cfg.reportsDir, "latest.json"), JSON.stringify({ meta, results }, null, 2));
    if (cfg.baseline) {
      mkdirSync("docs/generated", { recursive: true });
      writeFileSync("docs/generated/e2e-baseline.md", markdown);
      console.log(`[e2e] 基线已写入 docs/generated/e2e-baseline.md`);
    }

    const counts = summarize(results);
    console.log(
      `[e2e] 汇总：pass=${counts.pass} fail=${counts.fail} not-supported=${counts["not-supported"]} skipped=${counts.skipped}；模型调用 ${calls}/${cfg.maxCalls}`,
    );
    const failed = results.filter((r) => r.status === "fail");
    if (failed.length) {
      console.log("[e2e] 失败场景：");
      for (const r of failed) console.log(`  - ${r.provider}/${r.id}: ${r.detail}`);
    }
    console.log(`[e2e] 报告：${join(cfg.reportsDir, "latest.md")}`);
  } finally {
    await server.stop();
  }
}

function skipReason(
  scenario: Scenario,
  provider: string,
  healthy: Set<string>,
  selected: Record<string, string | undefined>,
  maxCalls: number,
  calls: number,
  imageUrl: string | undefined,
): string | null {
  if (scenario.needsProvider !== false && !healthy.has(provider)) return "provider 不可用";
  if (scenario.needsModel !== false && !selected[provider]) return "未选择到可用模型";
  if (scenario.needsImageUrl && !imageUrl) return "未设置 E2E_IMAGE_URL";
  if (scenario.needsModel !== false && calls >= maxCalls) return `预算用尽（E2E_MAX_CALLS=${maxCalls}）`;
  return null;
}

function toResult(
  scenario: Scenario,
  selected: Record<string, string | undefined>,
  status: ScenarioResult["status"],
  detail: string,
  durationMs: number,
): ScenarioResult {
  const provider = scenario.provider === "all" ? "all" : scenario.provider;
  return {
    id: scenario.id,
    provider,
    endpoint: scenario.endpoint,
    feature: scenario.feature,
    status,
    detail,
    durationMs,
    model: scenario.needsModel === false ? undefined : selected[provider],
    clause: scenario.clause,
    knownDefect: scenario.knownDefect,
  };
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`[e2e] 运行失败：${e?.stack ?? e}`);
    process.exit(1);
  });
}
