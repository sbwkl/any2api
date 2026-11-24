import type { HttpResult } from "../http";
import { httpRequest } from "../http";
import { readDumpSince } from "../dump";
import type { Check } from "../verify";
import { checkErrorEnvelope } from "../verify";
import type { ProviderName } from "../types";

export interface CapturedCall {
  path: string;
  requestBody?: unknown;
  rawBody?: string;
  response: { status: number; contentType: string; text: string };
}

export interface ScenarioContext {
  provider: ProviderName;
  baseUrl: string;
  model: string;
  imageUrl?: string;
  timeoutMs: number;
  dumpDir: string;
  dumpMark: number;
  capture: CapturedCall[];
}

export interface Scenario {
  id: string;
  provider: ProviderName | "all";
  endpoint: string;
  feature: string;
  clause?: string;
  knownDefect?: boolean;
  needsModel?: boolean;
  needsProvider?: boolean;
  needsImageUrl?: boolean;
  run: (ctx: ScenarioContext) => Promise<Verdict>;
}

export type VerdictStatus = "pass" | "fail" | "not-supported";

export interface Verdict {
  status: VerdictStatus;
  detail: string;
}

export const pass = (detail: string): Verdict => ({ status: "pass", detail });
export const fail = (detail: string): Verdict => ({ status: "fail", detail });
export const notSupported = (detail: string): Verdict => ({ status: "not-supported", detail });

export function truncate(s: string, n = 240): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
}

export async function call(
  ctx: ScenarioContext,
  path: string,
  opts: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const res = await httpRequest(ctx.baseUrl, `/${ctx.provider}${path}`, { ...opts, timeoutMs: ctx.timeoutMs });
  ctx.capture.push({
    path,
    requestBody: opts.body,
    rawBody: opts.rawBody,
    response: {
      status: res.status,
      contentType: res.contentType,
      text: res.text.length > 65536 ? `${res.text.slice(0, 65536)}…(truncated)` : res.text,
    },
  });
  return res;
}

export function jsonOf(res: HttpResult): { json?: any; error?: string } {
  try {
    return { json: JSON.parse(res.text) };
  } catch {
    return { error: `响应不是合法 JSON：${truncate(res.text, 120)}` };
  }
}

export function assess(res: HttpResult, check: Check, opts: { status?: number; sse?: boolean } = {}): Verdict {
  const expected = opts.status ?? 200;
  if (res.status !== expected) return fail(`HTTP ${res.status}（期望 ${expected}）：${truncate(res.text)}`);
  if (opts.sse && !res.contentType.includes("text/event-stream")) {
    return fail(`content-type 不是 text/event-stream（${res.contentType || "空"}）`);
  }
  if (!check.ok) return fail(check.issues.join("；"));
  return pass(`HTTP ${res.status}；契约通过`);
}

// 上游显式 4xx 拒绝视为 not-supported；200 但缺特性（静默丢弃）仍判 fail。
// 有些适配层把上游 4xx 映射为 5xx（如 502），但错误消息里保留了上游状态码，同样按显式拒绝处理并注明掩盖。
export function rejectionVerdict(res: HttpResult, kind: "openai" | "anthropic"): Verdict | null {
  if (res.status < 400) return null;
  const { json, error } = jsonOf(res);
  if (error) return fail(`HTTP ${res.status} 且${error}`);
  if (res.status < 500) {
    const env = checkErrorEnvelope(json, kind);
    if (env.ok) return notSupported(`上游显式拒绝（HTTP ${res.status}）：${truncate(res.text)}`);
    return fail(`HTTP ${res.status}，错误信封不合规：${env.issues.join("；")}`);
  }
  const message = String(json?.error?.message ?? "");
  if (json?.error?.type === "upstream_error" && /(?:^|\D)4\d\d(?::|\s|$)/.test(message)) {
    return notSupported(`上游显式拒绝，但状态码被映射为 ${res.status}：${truncate(res.text)}`);
  }
  return fail(`HTTP ${res.status}：${truncate(res.text)}`);
}

export function assessOptional(
  res: HttpResult,
  check: Check,
  kind: "openai" | "anthropic",
  opts: { sse?: boolean } = {},
): Verdict {
  const rejection = rejectionVerdict(res, kind);
  if (rejection) return rejection;
  return assess(res, check, opts);
}

export function chatText(json: any): string {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

export function anthropicText(json: any): string {
  return (json?.content ?? [])
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

export function mentionsRed(text: string): boolean {
  return /\bred\b/i.test(text);
}

export async function upstreamDump(ctx: ScenarioContext): Promise<string> {
  return readDumpSince(ctx.dumpDir, ctx.dumpMark);
}

export function dumpHasImage(dump: string, dataUrl?: string): boolean {
  if (dump.includes("image_url") || dump.includes("input_image")) return true;
  if (dataUrl) {
    const fragment = dataUrl.slice(dataUrl.indexOf(",") + 1, dataUrl.indexOf(",") + 41);
    if (fragment.length >= 20 && dump.includes(fragment)) return true;
  }
  return false;
}
