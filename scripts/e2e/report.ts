export type ScenarioStatus = "pass" | "fail" | "not-supported" | "skipped";

export interface ScenarioResult {
  id: string;
  provider: string;
  endpoint: string;
  feature: string;
  status: ScenarioStatus;
  detail: string;
  durationMs: number;
  model?: string;
  clause?: string;
  knownDefect?: boolean;
  evidence?: string;
}

export interface ReportMeta {
  generatedAt: string;
  baseUrl?: string;
  maxCalls: number;
  calls: number;
  providers: string[];
  models: Record<string, string | undefined>;
}

export function summarize(results: ScenarioResult[]): Record<ScenarioStatus, number> {
  const counts: Record<ScenarioStatus, number> = { pass: 0, fail: 0, "not-supported": 0, skipped: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n+/g, " ");
}

export function renderMarkdown(meta: ReportMeta, results: ScenarioResult[]): string {
  const counts = summarize(results);
  const lines: string[] = [
    "# e2e 相似度报告",
    "",
    `- 生成时间：${meta.generatedAt}`,
  ];
  if (meta.baseUrl) lines.push(`- 目标：${meta.baseUrl}`);
  lines.push(
    `- 预算：${meta.calls}/${meta.maxCalls} 次上游调用`,
    `- provider：${meta.providers.join(", ")}`,
  );
  for (const [provider, model] of Object.entries(meta.models)) {
    lines.push(`  - ${provider}: ${model ?? "未选择（相关场景跳过）"}`);
  }
  lines.push(
    `- 汇总：总计 ${results.length} · pass ${counts.pass} · fail ${counts.fail} · not-supported ${counts["not-supported"]} · skipped ${counts.skipped}`,
    "",
    "| 场景 | provider | endpoint | 特性 | 状态 | 条款 | 说明 |",
    "|---|---|---|---|---|---|---|",
  );
  for (const r of results) {
    const status = r.knownDefect && r.status === "fail" ? "fail（已知缺陷）" : r.status;
    lines.push(
      `| ${cell(r.id)} | ${cell(r.provider)} | ${cell(r.endpoint)} | ${cell(r.feature)} | ${status} | ${cell(r.clause ?? "-")} | ${cell(r.detail)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
