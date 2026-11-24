#!/usr/bin/env bun
// 手动语料评估：读取 TRACE_CAPTURE_DIR 产出的入站 JSONL，按端点契约做 L1 校验。
// 用法：bun run e2e:corpus [dir]（默认 env E2E_CORPUS_DIR 或 e2e/corpus）
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSseFrames } from "./sse";
import {
  checkAnthropicMessage,
  checkAnthropicStream,
  checkChatChunks,
  checkChatCompletion,
  checkErrorEnvelope,
  checkModels,
  checkResponseObject,
  checkResponsesStream,
} from "./verify";

export interface CaptureRecord {
  ts?: string;
  method?: string;
  path: string;
  status: number;
  request?: { body?: string };
  response?: { content_type?: string | null; body?: string; body_truncated?: boolean };
}

export type CorpusStatus = "pass" | "fail" | "skipped";

export interface CorpusResult {
  endpoint: string;
  status: CorpusStatus;
  detail: string;
}

const ENDPOINTS = ["/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models"];

export function endpointOf(path: string): string | null {
  const match = path.match(/^(?:\/(?:codearts|codebuddy))?(\/v1\/[^/]+(?:\/[^/]+)?)$/);
  if (!match) return null;
  return ENDPOINTS.includes(match[1]) ? match[1] : null;
}

function envelopeKind(endpoint: string): "openai" | "anthropic" {
  return endpoint === "/v1/messages" ? "anthropic" : "openai";
}

function isSse(record: CaptureRecord): boolean {
  return (record.response?.content_type ?? "").includes("text/event-stream");
}

function expectUsage(record: CaptureRecord): boolean {
  try {
    const body = JSON.parse(record.request?.body ?? "");
    return body?.stream_options?.include_usage === true;
  } catch {
    return false;
  }
}

export function analyzeCapture(record: CaptureRecord): CorpusResult {
  const endpoint = endpointOf(record.path);
  if (!endpoint) return { endpoint: record.path, status: "skipped", detail: "非矩阵端点" };
  const body = record.response?.body ?? "";
  if (record.response?.body_truncated) return { endpoint, status: "skipped", detail: "响应体被截断，未做契约校验" };
  if (!body) return { endpoint, status: "skipped", detail: "响应体为空" };

  if (record.status >= 400) {
    const kind = envelopeKind(endpoint);
    let json: any;
    try {
      json = JSON.parse(body);
    } catch {
      return { endpoint, status: "fail", detail: `HTTP ${record.status} 响应不是 JSON` };
    }
    const check = checkErrorEnvelope(json, kind);
    return { endpoint, status: check.ok ? "pass" : "fail", detail: check.ok ? `HTTP ${record.status} 错误信封合规` : check.issues.join("；") };
  }

  if (isSse(record)) {
    if (endpoint === "/v1/chat/completions") {
      // 只做语法层面的裸帧检查，避免把无 usage 的合法流判错。
      if (parseSseFrames(body).length === 0) return { endpoint, status: "fail", detail: "SSE 无任何帧" };
      const check = checkChatChunks(body, { expectUsage: expectUsage(record) });
      return { endpoint, status: check.ok ? "pass" : "fail", detail: check.ok ? "SSE 契约通过" : check.issues.join("；") };
    }
    const check = endpoint === "/v1/messages" ? checkAnthropicStream(body) : checkResponsesStream(body);
    return { endpoint, status: check.ok ? "pass" : "fail", detail: check.ok ? "SSE 契约通过" : check.issues.join("；") };
  }

  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return { endpoint, status: "fail", detail: "响应不是 JSON" };
  }
  const check =
    endpoint === "/v1/chat/completions" ? checkChatCompletion(json)
      : endpoint === "/v1/messages" ? checkAnthropicMessage(json)
        : endpoint === "/v1/responses" ? checkResponseObject(json)
          : checkModels(json);
  return { endpoint, status: check.ok ? "pass" : "fail", detail: check.ok ? "契约通过" : check.issues.join("；") };
}

function loadRecords(dir: string): CaptureRecord[] {
  const records: CaptureRecord[] = [];
  for (const name of readdirSync(dir)) {
    if (!/^capture-.*\.jsonl$/.test(name)) continue;
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // 跳过损坏行
      }
    }
  }
  return records;
}

export function runCorpus(dir: string): { results: Array<CorpusResult & { line: number }>; counts: Record<CorpusStatus, number> } {
  const records = loadRecords(dir);
  const results = records.map((r, i) => ({ ...analyzeCapture(r), line: i + 1 }));
  const counts: Record<CorpusStatus, number> = { pass: 0, fail: 0, skipped: 0 };
  for (const r of results) counts[r.status]++;
  return { results, counts };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? process.env.E2E_CORPUS_DIR ?? "e2e/corpus";
  try {
    const { results, counts } = runCorpus(dir);
    console.log(`[corpus] 目录 ${dir}：${results.length} 条记录`);
    for (const r of results.filter((x) => x.status === "fail")) {
      console.log(`[corpus] FAIL #${r.line} ${r.endpoint}: ${r.detail}`);
    }
    console.log(`[corpus] 汇总：pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}`);
    if (counts.fail > 0) process.exitCode = 1;
  } catch (e: any) {
    console.error(`[corpus] 读取失败：${e?.message ?? e}（提示：先用 TRACE_CAPTURE_DIR 采集）`);
    process.exit(1);
  }
}
