import { buildEvidenceView, type EvidenceView } from "./evidence";

export type ScenarioStatus = "pass" | "fail" | "not-supported" | "skipped";

export interface InboundCallEvidence {
  method: "GET" | "POST";
  path: string;
  requestBody?: unknown;
  rawBody?: string;
  response: {
    status: number;
    contentType: string;
    text: string;
    textTruncated?: boolean;
  };
}

export interface UpstreamRequestEvidence {
  ts?: string;
  provider?: string;
  url: string;
  body: unknown;
}

export interface ScenarioEvidence {
  inbound: InboundCallEvidence[];
  upstream: UpstreamRequestEvidence[];
}

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
  evidence?: ScenarioEvidence;
}

export interface ScenarioSetEntry {
  id: string;
  endpoint: string;
  feature: string;
  clause?: string;
  knownDefect?: boolean;
}

export interface ProviderCoverage {
  provider: string;
  expected: number;
  actual: number;
  missing: string[];
  extra: string[];
  orderMatches: boolean;
}

export interface ReportMeta {
  generatedAt: string;
  baseUrl: string;
  maxCalls: number;
  calls: number;
  providers: string[];
  models: Record<string, string | undefined>;
  scenarioSet?: ScenarioSetEntry[];
  coverage?: ProviderCoverage[];
}

export interface ReportData {
  schema: "any2api-e2e-report/v1";
  meta: ReportMeta;
  results: ScenarioResult[];
}

export function summarize(results: ScenarioResult[]): Record<ScenarioStatus, number> {
  const counts: Record<ScenarioStatus, number> = { pass: 0, fail: 0, "not-supported": 0, skipped: 0 };
  for (const result of results) counts[result.status]++;
  return counts;
}

export function scenarioSetFromResults(results: ScenarioResult[]): ScenarioSetEntry[] {
  const seen = new Set<string>();
  const entries: ScenarioSetEntry[] = [];
  for (const result of results) {
    if (result.provider === "all" || seen.has(result.id)) continue;
    seen.add(result.id);
    entries.push({
      id: result.id,
      endpoint: result.endpoint,
      feature: result.feature,
      clause: result.clause,
      knownDefect: result.knownDefect,
    });
  }
  return entries;
}

export function computeCoverage(
  scenarioSet: ScenarioSetEntry[],
  results: ScenarioResult[],
  providers: string[],
): ProviderCoverage[] {
  const expected = scenarioSet.map((entry) => entry.id);
  return providers.map((provider) => {
    const actual = results.filter((result) => result.provider === provider).map((result) => result.id);
    return {
      provider,
      expected: expected.length,
      actual: actual.length,
      missing: expected.filter((id) => !actual.includes(id)),
      extra: actual.filter((id) => !expected.includes(id)),
      orderMatches:
        actual.length === expected.length && actual.every((id, index) => id === expected[index]),
    };
  });
}

function scenarioEntries(meta: ReportMeta, results: ScenarioResult[]): ScenarioSetEntry[] {
  return meta.scenarioSet?.length ? meta.scenarioSet : scenarioSetFromResults(results);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pretty(value: unknown): string {
  if (value === undefined) return "（无）";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function block(value: unknown): string {
  return `<pre>${escapeHtml(pretty(value))}</pre>`;
}

function statusLabel(result: ScenarioResult): string {
  return result.status === "fail" && result.knownDefect ? "fail（已知缺陷）" : result.status;
}

function badgeClass(status: ScenarioStatus): string {
  if (status === "not-supported") return "ns";
  return status;
}

function countLine(results: ScenarioResult[]): string {
  const counts = summarize(results);
  return `pass ${counts.pass} · fail ${counts.fail} · not-supported ${counts["not-supported"]} · skipped ${counts.skipped}`;
}

function shortText(value: string, max = 120): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function evidenceId(provider: string, index: number): string {
  return `ev-${provider}-${index}`;
}

function renderEvidence(result: ScenarioResult): string {
  if (result.status === "skipped" && !result.evidence) {
    return `<p class="muted">未执行：${escapeHtml(result.detail)}</p>`;
  }
  const view: EvidenceView = buildEvidenceView(result);
  if (!view.calls.length && !view.upstream.length) {
    return `<p class="muted">未采集入站请求或上游请求（判定：${escapeHtml(result.detail)}）</p>`;
  }

  const inputs = view.calls.length
    ? view.calls
        .map((call, index) => {
          const label = view.calls.length > 1 ? `<p class="call-label">调用 ${index + 1}/${view.calls.length}</p>` : "";
          return `<div class="call">${label}<p class="call-line"><code>${escapeHtml(call.method)} ${escapeHtml(call.path)}</code></p>${
            call.request === undefined ? '<p class="muted">（无请求体）</p>' : block(call.request)
          }</div>`;
        })
        .join("")
    : '<p class="muted">（无入站请求）</p>';

  const outputs = view.calls.length
    ? view.calls
        .map((call, index) => {
          const label = view.calls.length > 1 ? `<p class="call-label">响应 ${index + 1}/${view.calls.length}</p>` : "";
          return `<div class="call">${label}<p class="call-line">HTTP ${call.response.status} · ${escapeHtml(
            call.response.contentType || "unknown",
          )}${call.response.textTruncated ? " · 已截断" : ""}</p>${block(call.response.summary)}</div>`;
        })
        .join("")
    : '<p class="muted">（无响应）</p>';

  const upstream = view.upstream.length
    ? view.upstream
        .map(
          (record, index) =>
            `<div class="call"><p class="call-label">上游 ${index + 1}/${view.upstream.length}</p><p class="call-line"><code>${escapeHtml(
              record.url,
            )}</code></p>${block(record.body)}</div>`,
        )
        .join("")
    : '<p class="muted">（无上游请求转储）</p>';

  return `<div class="evidence-grid">
<section><h4>输入</h4>${inputs}</section>
<section><h4>上游请求</h4>${upstream}</section>
<section><h4>输出</h4>${outputs}</section>
</div>`;
}

function renderEvidenceList(provider: string, results: ScenarioResult[]): string {
  return results
    .map((result, index) => {
      const id = evidenceId(provider, index);
      return `<details class="evidence" id="${escapeHtml(id)}" data-status="${result.status}">
<summary><span class="badge ${badgeClass(result.status)}">${escapeHtml(statusLabel(result))}</span> <code>${escapeHtml(
        result.id,
      )}</code> <span class="muted">${escapeHtml(result.endpoint)} · ${result.durationMs}ms</span></summary>
${renderEvidence(result)}
</details>`;
    })
    .join("\n");
}

function renderMatrixCell(provider: string, result: ScenarioResult | undefined, index: number): string {
  if (!result) {
    return `<td class="provider-cell missing" data-label="${escapeHtml(provider)}"><span class="badge missing">缺失</span><span class="cell-note">该 provider 无此场景结果</span></td>`;
  }
  const target = evidenceId(provider, index);
  return `<td class="provider-cell" data-label="${escapeHtml(provider)}"><a class="status-link" href="#${escapeHtml(
    target,
  )}" data-target="${escapeHtml(target)}" aria-label="查看 ${escapeHtml(provider)} 的 ${escapeHtml(
    result.id,
  )} 场景证据"><span class="badge ${badgeClass(result.status)}">${escapeHtml(statusLabel(result))}</span></a><span class="cell-note" title="${escapeHtml(
    shortText(result.detail, 300),
  )}">${escapeHtml(shortText(result.detail))}</span></td>`;
}

function renderMatrix(meta: ReportMeta, results: ScenarioResult[]): string {
  const providers = meta.providers.filter((provider) => results.some((result) => result.provider === provider));
  const entries = scenarioEntries(meta, results);
  const byProvider = new Map(
    providers.map((provider) => [provider, results.filter((result) => result.provider === provider)]),
  );
  const rows = entries
    .map((entry) => {
      const cells: string[] = [];
      const statuses: string[] = [];
      for (const provider of providers) {
        const list = byProvider.get(provider) ?? [];
        const index = list.findIndex((result) => result.id === entry.id);
        const result = index >= 0 ? list[index] : undefined;
        statuses.push(result?.status ?? "missing");
        cells.push(renderMatrixCell(provider, result, index));
      }
      return `<tr class="scenario" data-statuses="${escapeHtml(statuses.join(" "))}">
<td data-label="场景"><code>${escapeHtml(entry.id)}</code></td>
<td data-label="接口">${escapeHtml(entry.endpoint)}</td>
<td data-label="特性">${escapeHtml(entry.feature)}</td>
${cells.join("")}
<td class="col-clause" data-label="条款">${escapeHtml(entry.clause ?? "—")}</td>
</tr>`;
    })
    .join("\n");
  const header = `<tr><th>场景</th><th>接口</th><th>特性</th>${providers
    .map((provider) => `<th>${escapeHtml(provider)}</th>`)
    .join("")}<th class="col-clause">条款</th></tr>`;
  return `<div class="table-wrap"><table class="matrix">
<thead>${header}</thead>
<tbody>
${rows}
</tbody>
</table></div>
<p class="hint">同一行是两个 provider 的同一场景；点击状态展开对应 provider 的场景证据。</p>`;
}

function renderEvidenceSection(provider: string, results: ScenarioResult[]): string {
  return `<section id="evidence-${escapeHtml(provider)}">
<h2>${escapeHtml(provider)} 场景证据 <span class="muted">${results.length} 场景</span></h2>
<p class="counts">${countLine(results)}</p>
<div class="evidence-list">
${renderEvidenceList(provider, results)}
</div>
</section>`;
}

function renderGlobalTable(results: ScenarioResult[]): string {
  const rows = results
    .map((result, index) => {
      const target = evidenceId("global", index);
      return `<tr class="scenario" data-statuses="${result.status}">
<td data-label="场景"><code>${escapeHtml(result.id)}</code></td>
<td data-label="接口">${escapeHtml(result.endpoint)}</td>
<td data-label="特性">${escapeHtml(result.feature)}</td>
<td data-label="状态"><a class="status-link" href="#${escapeHtml(target)}" data-target="${escapeHtml(
        target,
      )}" aria-label="查看 ${escapeHtml(result.id)} 场景证据"><span class="badge ${badgeClass(result.status)}">${escapeHtml(
        statusLabel(result),
      )}</span></a></td>
<td class="col-clause" data-label="条款">${escapeHtml(result.clause ?? "—")}</td>
<td class="detail" data-label="说明">${escapeHtml(result.detail)}</td>
</tr>`;
    })
    .join("\n");
  return `<div class="table-wrap"><table>
<thead><tr><th>场景</th><th>接口</th><th>特性</th><th>状态</th><th class="col-clause">条款</th><th>说明</th></tr></thead>
<tbody>
${rows}
</tbody>
</table></div>`;
}

function renderGlobalSection(results: ScenarioResult[]): string {
  return `<section id="global">
<h2>全局接口 <span class="muted">${results.length} 场景</span></h2>
<p class="counts">${countLine(results)}</p>
${renderGlobalTable(results)}
<h3>场景证据</h3>
<div class="evidence-list">
${renderEvidenceList("global", results)}
</div>
</section>`;
}

function renderOverview(results: ScenarioResult[]): string {
  const groups = new Map<string, ScenarioResult[]>();
  for (const result of results) {
    const key = result.provider === "all" ? "global" : result.provider;
    const list = groups.get(key) ?? [];
    list.push(result);
    groups.set(key, list);
  }
  const cards = [...groups.entries()]
    .map(([key, list]) => {
      const counts = summarize(list);
      return `<div class="card"><h3>${escapeHtml(key === "global" ? "全局" : key)}</h3><p class="card-total">${list.length} 场景</p><p class="counts">${countLine(
        list,
      )}</p></div>`;
    })
    .join("");
  const counts = summarize(results);
  return `<div class="cards">${cards}<div class="card total"><h3>合计</h3><p class="card-total">${results.length} 场景</p><p class="counts">pass ${counts.pass} · fail ${counts.fail} · not-supported ${counts["not-supported"]} · skipped ${counts.skipped}</p></div></div>`;
}

function rowStatusCounts(meta: ReportMeta, results: ScenarioResult[]): Record<ScenarioStatus, number> {
  const providers = meta.providers.filter((provider) => results.some((result) => result.provider === provider));
  const rows: ScenarioStatus[][] = scenarioEntries(meta, results).map((entry) => {
    const statuses: ScenarioStatus[] = [];
    for (const provider of providers) {
      const result = results.find((item) => item.provider === provider && item.id === entry.id);
      if (result) statuses.push(result.status);
    }
    return statuses;
  });
  for (const result of results) {
    if (!meta.providers.includes(result.provider)) rows.push([result.status]);
  }
  const counts: Record<ScenarioStatus, number> = { pass: 0, fail: 0, "not-supported": 0, skipped: 0 };
  for (const statuses of rows) {
    for (const status of new Set(statuses)) counts[status]++;
  }
  return counts;
}

function renderFilters(meta: ReportMeta, results: ScenarioResult[]): string {
  const counts = rowStatusCounts(meta, results);
  const globalCount = results.filter((result) => !meta.providers.includes(result.provider)).length;
  const total = scenarioEntries(meta, results).length + globalCount;
  return `<div class="filters" role="group" aria-label="按状态过滤">
<span class="filter-label">过滤</span>
<button type="button" data-filter="all" class="active">全部 <span class="n">${total}</span></button>
<button type="button" data-filter="fail">fail <span class="n">${counts.fail}</span></button>
<button type="button" data-filter="not-supported">not-supported <span class="n">${counts["not-supported"]}</span></button>
<button type="button" data-filter="skipped">skipped <span class="n">${counts.skipped}</span></button>
</div>`;
}

function renderCoverage(meta: ReportMeta): string {
  const coverage = meta.coverage;
  if (!coverage?.length) return "";
  const ok = coverage.every(
    (item) => item.orderMatches && item.missing.length === 0 && item.extra.length === 0,
  );
  const detail = coverage
    .map((item) => {
      if (item.missing.length === 0 && item.extra.length === 0 && item.orderMatches) {
        return `${item.provider} ${item.actual}/${item.expected}`;
      }
      const parts = [`${item.provider} ${item.actual}/${item.expected}`];
      if (item.missing.length) parts.push(`缺 ${item.missing.join("、")}`);
      if (item.extra.length) parts.push(`多 ${item.extra.join("、")}`);
      if (!item.orderMatches) parts.push("顺序不一致");
      return parts.join("，");
    })
    .join(" · ");
  return `<p class="coverage ${ok ? "ok" : "bad"}">场景集${ok ? "一致" : "不一致"}：${escapeHtml(detail)}</p>`;
}

const STYLE = `
:root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1c2024; --muted:#69707a; --line:#d9dde3; --card:#fff; --accent:#1f6feb; --pass:#1a7f37; --fail:#b42318; --ns:#6b7280; --skip:#8a5a00; }
@media (prefers-color-scheme: dark) { :root { --bg:#14171a; --fg:#e6e9ed; --muted:#9aa3ad; --line:#30363d; --card:#1c2126; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px; background:var(--bg); color:var(--fg); font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
.page-head h1 { margin:0 0 4px; font-size:22px; }
.sub { margin:0; color:var(--muted); overflow-wrap:anywhere; }
.coverage { margin:6px 0 0; font-size:12px; font-weight:600; overflow-wrap:anywhere; }
.coverage.ok { color:var(--pass); }
.coverage.bad { color:var(--fail); }
.overview { margin:20px 0; }
.cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:12px 14px; }
.card h3 { margin:0; font-size:14px; }
.card-total { margin:2px 0; font-size:20px; font-weight:600; }
.counts { margin:0; color:var(--muted); font-size:12px; }
.card.total { border-color:var(--accent); }
.filters { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin:20px 0 8px; }
.filter-label { color:var(--muted); font-size:12px; }
.filters button { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:999px; padding:4px 12px; cursor:pointer; font:inherit; font-size:12px; }
.filters button.active { border-color:var(--accent); color:var(--accent); }
.filters .n { color:var(--muted); }
section { margin:24px 0; }
h2 { margin:0 0 2px; font-size:18px; }
h3 { font-size:15px; margin:20px 0 8px; }
h4 { margin:0 0 8px; font-size:13px; }
.muted { color:var(--muted); font-weight:normal; }
.table-wrap { overflow-x:auto; background:var(--card); border:1px solid var(--line); border-radius:8px; margin-top:12px; }
table { border-collapse:collapse; width:100%; min-width:680px; font-size:13px; }
table.matrix { min-width:900px; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:12px; white-space:nowrap; }
tbody tr:last-child td { border-bottom:0; }
tr.scenario:hover { background:color-mix(in srgb, var(--accent) 8%, transparent); }
td.detail { max-width:360px; overflow-wrap:anywhere; }
td.provider-cell { min-width:170px; }
.status-link { color:inherit; text-decoration:none; }
.status-link:hover .badge { border-color:var(--accent); color:var(--accent); }
.status-link:focus-visible { outline:2px solid var(--accent); outline-offset:2px; border-radius:999px; }
.cell-note { display:block; margin-top:3px; color:var(--muted); font-size:11px; line-height:1.4; max-width:240px; overflow-wrap:anywhere; }
.badge { display:inline-block; padding:1px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid currentColor; white-space:nowrap; }
.badge.pass { color:var(--pass); }
.badge.fail { color:var(--fail); }
.badge.ns { color:var(--ns); }
.badge.skipped { color:var(--skip); }
.badge.missing { color:var(--muted); border-style:dashed; }
.hint { color:var(--muted); font-size:12px; }
.evidence-list { display:grid; gap:10px; }
.evidence { background:var(--card); border:1px solid var(--line); border-radius:8px; }
.evidence summary { cursor:pointer; padding:10px 12px; }
.evidence-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:16px; padding:0 12px 12px; }
.evidence-grid section { margin:0; min-width:0; }
pre { margin:0; padding:8px; background:color-mix(in srgb, var(--fg) 5%, transparent); border-radius:6px; overflow:auto; max-height:320px; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere; }
.call + .call { margin-top:10px; padding-top:8px; border-top:1px dashed var(--line); }
.call-label { margin:0; color:var(--muted); font-size:11px; }
.call-line { margin:0 0 6px; overflow-wrap:anywhere; }
code { font-size:12px; }
footer { margin-top:28px; color:var(--muted); font-size:12px; overflow-wrap:anywhere; }
footer a { color:var(--accent); }
@media (max-width:640px) { body { padding:14px; } table, thead, tbody, tr, td { display:block; width:100%; } thead { display:none; } table, table.matrix { min-width:0; } .table-wrap { overflow:visible; } tbody tr.scenario { padding:10px 12px; border-bottom:1px solid var(--line); } tbody tr.scenario:last-child { border-bottom:0; } td { border:0; padding:2px 0; overflow-wrap:anywhere; } td::before { content:attr(data-label) "："; color:var(--muted); font-size:11px; } td.col-clause { display:none; } td.detail { max-width:none; margin-top:4px; } td.provider-cell { padding-top:6px; } .cell-note { max-width:none; } }
`;

const SCRIPT = `
(function () {
  var buttons = document.querySelectorAll("[data-filter]");
  function apply(filter) {
    buttons.forEach(function (button) { button.classList.toggle("active", button.getAttribute("data-filter") === filter); });
    document.querySelectorAll("tr.scenario").forEach(function (row) {
      var statuses = (row.getAttribute("data-statuses") || "").split(/\\s+/);
      row.hidden = filter !== "all" && statuses.indexOf(filter) === -1;
    });
    document.querySelectorAll("details.evidence").forEach(function (item) {
      item.hidden = filter !== "all" && item.getAttribute("data-status") !== filter;
    });
  }
  buttons.forEach(function (button) {
    button.addEventListener("click", function () { apply(button.getAttribute("data-filter") || "all"); });
  });
  document.querySelectorAll("a.status-link").forEach(function (link) {
    link.addEventListener("click", function (event) {
      var target = document.getElementById(link.getAttribute("data-target") || "");
      if (!target) return;
      event.preventDefault();
      if (target.hidden) apply("all");
      target.open = true;
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });
})();
`;

export function renderHtml(meta: ReportMeta, results: ScenarioResult[], opts: { dataFile?: string } = {}): string {
  const providers = meta.providers.filter((provider) => results.some((result) => result.provider === provider));
  const globalResults = results.filter((result) => !meta.providers.includes(result.provider));
  const modelText = meta.providers
    .map((provider) => `${provider}=${meta.models[provider] ?? "未记录"}`)
    .join(" · ");
  const dataFile = opts.dataFile ?? "e2e-report.json";
  const entries = scenarioEntries(meta, results);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any2api e2e 兼容性报告</title>
<style>${STYLE}</style>
</head>
<body>
<header class="page-head">
<h1>any2api e2e 兼容性报告</h1>
<p class="sub">生成于 ${escapeHtml(meta.generatedAt)} · 目标 ${escapeHtml(meta.baseUrl)} · 调用预算 ${meta.calls}/${meta.maxCalls} · 模型 ${escapeHtml(
    modelText,
  )}</p>
${renderCoverage(meta)}
</header>
<section class="overview" aria-label="总览">${renderOverview(results)}</section>
${renderFilters(meta, results)}
<main>
<section id="matrix">
<h2>场景对照矩阵 <span class="muted">${entries.length} 场景 × ${providers.length} providers</span></h2>
<p class="counts">同一场景模板按相同顺序对每个 provider 执行；列内是该 provider 的实际结果。</p>
${renderMatrix(meta, results)}
</section>
${providers
  .map((provider) => renderEvidenceSection(provider, results.filter((result) => result.provider === provider)))
  .join("\n")}
${globalResults.length ? renderGlobalSection(globalResults) : ""}
</main>
<footer>机器可读原始数据：<a href="${escapeHtml(dataFile)}">${escapeHtml(
    dataFile,
  )}</a>（含入站请求、上游请求与响应原文；HTML 仅含展示摘要）。</footer>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

export function renderBaselineIndex(meta: ReportMeta, results: ScenarioResult[]): string {
  const counts = summarize(results);
  const models = meta.providers.map((provider) => `${provider}=${meta.models[provider] ?? "未记录"}`).join("，");
  const coverage = meta.coverage?.length
    ? meta.coverage
        .map((item) => {
          const parts = [`${item.provider} ${item.actual}/${item.expected}`];
          if (item.missing.length) parts.push(`缺 ${item.missing.join("、")}`);
          if (item.extra.length) parts.push(`多 ${item.extra.join("、")}`);
          if (!item.orderMatches) parts.push("顺序不一致");
          return parts.join("，");
        })
        .join("；")
    : "未记录";
  return `# e2e 基线

- 生成时间：${meta.generatedAt}
- 目标：${meta.baseUrl}
- 调用预算：${meta.calls}/${meta.maxCalls}
- 模型：${models}
- 场景集：${coverage}
- 汇总：pass ${counts.pass} / fail ${counts.fail} / not-supported ${counts["not-supported"]} / skipped ${counts.skipped}
- 人类可读报告：[e2e-baseline.html](e2e-baseline.html)（下载后用浏览器打开；GitHub 不渲染 HTML）
- 机器可读数据：[e2e-baseline.json](e2e-baseline.json)（含入站请求、上游请求与响应原文）
- 再生成：\`E2E_MAX_CALLS=60 E2E_RECORD=1 bun run e2e --baseline\`

本文件只是入口；场景明细与证据见 HTML/JSON，不在此重复矩阵。
`;
}
