import { jsonFrames, parseSseFrames } from "./sse";

export interface Check {
  ok: boolean;
  issues: string[];
}

const CHAT_FINISH_REASONS = new Set(["stop", "length", "tool_calls", "content_filter", "function_call"]);
const ANTHROPIC_STOP_REASONS = new Set(["end_turn", "max_tokens", "stop_sequence", "tool_use", "pause_turn", "refusal"]);

function result(issues: string[]): Check {
  return { ok: issues.length === 0, issues };
}

function need(issues: string[], cond: boolean, msg: string): void {
  if (!cond) issues.push(msg);
}

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function usageIssues(usage: any, issues: string[], prefix = "usage"): void {
  need(issues, !!usage && typeof usage === "object", `${prefix} 缺失`);
  if (!usage || typeof usage !== "object") return;
  need(issues, isNum(usage.prompt_tokens), `${prefix}.prompt_tokens 非数字`);
  need(issues, isNum(usage.completion_tokens), `${prefix}.completion_tokens 非数字`);
  need(issues, isNum(usage.total_tokens), `${prefix}.total_tokens 非数字`);
  if (isNum(usage.prompt_tokens) && isNum(usage.completion_tokens) && isNum(usage.total_tokens)) {
    need(issues, usage.total_tokens === usage.prompt_tokens + usage.completion_tokens,
      `${prefix}.total_tokens 不等于 prompt+completion（${usage.total_tokens} != ${usage.prompt_tokens + usage.completion_tokens}）`);
  }
  if (usage.prompt_tokens_details !== undefined) {
    need(issues, isNum(usage.prompt_tokens_details?.cached_tokens), `${prefix}.prompt_tokens_details.cached_tokens 非数字`);
  }
  if (usage.completion_tokens_details !== undefined && usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    need(issues, isNum(usage.completion_tokens_details.reasoning_tokens), `${prefix}.completion_tokens_details.reasoning_tokens 非数字`);
  }
}

export function checkChatCompletion(json: any): Check {
  const issues: string[] = [];
  need(issues, json?.object === "chat.completion", 'object 应为 "chat.completion"');
  need(issues, typeof json?.id === "string" && json.id.length > 0, "id 缺失");
  need(issues, Array.isArray(json?.choices) && json.choices.length > 0, "choices 为空");
  const choice = json?.choices?.[0];
  need(issues, choice?.index === 0, "choices[0].index 应为 0");
  need(issues, choice?.message?.role === "assistant", 'message.role 应为 "assistant"');
  need(issues, choice?.message?.content === null || typeof choice?.message?.content === "string", "message.content 应为 string 或 null");
  need(issues, CHAT_FINISH_REASONS.has(choice?.finish_reason), `finish_reason 非法或缺失（${String(choice?.finish_reason)}）`);
  usageIssues(json?.usage, issues);
  return result(issues);
}

export function checkChatChunks(text: string, opts: { expectUsage: boolean }): Check {
  const issues: string[] = [];
  const frames = parseSseFrames(text);
  need(issues, frames.length > 0, "SSE 无任何帧");
  need(issues, frames.at(-1)?.data === "[DONE]", "SSE 未以 [DONE] 结束");

  const payloads = jsonFrames(frames.filter((f) => f.data !== "[DONE]"));
  let contentSeen = false;
  let finishSeen = false;
  let usageChunks = 0;
  for (const p of payloads) {
    if (p.error) {
      issues.push(`chunk 不是合法 JSON：${p.error}`);
      continue;
    }
    const c = p.json;
    need(issues, c?.object === "chat.completion.chunk", 'chunk.object 应为 "chat.completion.chunk"');
    need(issues, typeof c?.id === "string", "chunk.id 缺失");
    need(issues, typeof c?.model === "string", "chunk.model 缺失");
    const ch = c?.choices?.[0];
    if (typeof ch?.delta?.content === "string" && ch.delta.content.length > 0) contentSeen = true;
    if (ch?.delta?.role === "assistant") contentSeen = true;
    if (ch?.finish_reason) finishSeen = true;
    if (c?.usage) {
      usageChunks++;
      need(issues, Array.isArray(c.choices) && c.choices.length === 0, "usage 块应带空 choices");
      usageIssues(c.usage, issues, "chunk.usage");
    }
  }
  need(issues, contentSeen, "未观察到任何内容增量");
  need(issues, finishSeen, "未观察到非空 finish_reason");
  if (opts.expectUsage) {
    need(issues, usageChunks === 1, `include_usage 应恰好产生 1 个 usage 块（实际 ${usageChunks}）`);
  }
  return result(issues);
}

export function checkAnthropicMessage(json: any): Check {
  const issues: string[] = [];
  need(issues, json?.type === "message", 'type 应为 "message"');
  need(issues, json?.role === "assistant", 'role 应为 "assistant"');
  need(issues, typeof json?.id === "string", "id 缺失");
  need(issues, typeof json?.model === "string", "model 缺失");
  need(issues, Array.isArray(json?.content), "content 应为数组");
  need(issues, ANTHROPIC_STOP_REASONS.has(json?.stop_reason), `stop_reason 非法或缺失（${String(json?.stop_reason)}）`);
  for (const [i, block] of (json?.content ?? []).entries()) {
    need(issues, typeof block?.type === "string", `content[${i}].type 缺失`);
    if (block?.type === "text") need(issues, typeof block.text === "string", `content[${i}].text 缺失`);
    if (block?.type === "tool_use") {
      need(issues, typeof block.id === "string" && typeof block.name === "string" && typeof block.input === "object",
        `content[${i}] tool_use 字段不全`);
    }
  }
  const u = json?.usage;
  need(issues, isNum(u?.input_tokens), "usage.input_tokens 非数字");
  need(issues, isNum(u?.output_tokens), "usage.output_tokens 非数字");
  return result(issues);
}

export function checkAnthropicStream(text: string): Check {
  const issues: string[] = [];
  const parsed = jsonFrames(parseSseFrames(text));
  for (const p of parsed) if (p.error) issues.push(`SSE 帧解析失败：${p.error}`);
  const ev = parsed.filter((p) => !p.error);
  need(issues, ev.length > 0, "SSE 无任何事件");
  need(issues, ev[0]?.event === "message_start", "首个事件应为 message_start");
  need(issues, ev.at(-1)?.event === "message_stop", "最后事件应为 message_stop");

  const start = ev.find((e) => e.event === "message_start")?.json;
  need(issues, start?.message?.role === "assistant", "message_start.message.role 应为 assistant");
  need(issues, start?.message?.stop_reason === null, "message_start.message.stop_reason 应为 null");
  need(issues, isNum(start?.message?.usage?.input_tokens), "message_start 缺少 usage.input_tokens");

  const started = new Set<number>();
  const stopped = new Set<number>();
  let deltaSeen = false;
  for (const e of ev) {
    if (e.event === "content_block_start") started.add(e.json?.index);
    if (e.event === "content_block_delta") {
      deltaSeen = true;
      if (!started.has(e.json?.index)) issues.push(`delta 引用了未开始的 index ${e.json?.index}`);
    }
    if (e.event === "content_block_stop") stopped.add(e.json?.index);
    if (e.event === "error") issues.push(`流中出现 error 事件：${JSON.stringify(e.json?.error ?? e.json)}`);
  }
  need(issues, started.size > 0, "没有任何 content_block_start");
  const sorted = [...started].sort((a, b) => a - b);
  need(issues, sorted.every((v, i) => v === i), `content block index 不连续（${sorted.join(",")}）`);
  need(issues, sorted.every((v) => stopped.has(v)), "存在未收到 content_block_stop 的 block");
  need(issues, deltaSeen, "未观察到 content_block_delta");

  const msgDelta = ev.find((e) => e.event === "message_delta")?.json;
  need(issues, ANTHROPIC_STOP_REASONS.has(msgDelta?.delta?.stop_reason), "message_delta.delta.stop_reason 非法或缺失");
  need(issues, isNum(msgDelta?.usage?.output_tokens), "message_delta 缺少 usage.output_tokens");
  return result(issues);
}

export function checkResponseObject(json: any): Check {
  const issues: string[] = [];
  need(issues, json?.object === "response", 'object 应为 "response"');
  need(issues, typeof json?.id === "string", "id 缺失");
  need(issues, json?.status === "completed", `非流式 status 应为 completed（${String(json?.status)}）`);
  need(issues, typeof json?.model === "string", "model 缺失");
  need(issues, Array.isArray(json?.output), "output 应为数组");

  const message = (json?.output ?? []).find((o: any) => o?.type === "message");
  need(issues, !!message, "output 中缺少 message 项");
  const textPart = (message?.content ?? []).find((c: any) => c?.type === "output_text");
  need(issues, !!textPart, "message.content 中缺少 output_text");
  need(issues, typeof textPart?.text === "string", "output_text.text 缺失");
  need(issues, Array.isArray(textPart?.annotations), "output_text.annotations 应为数组");

  const u = json?.usage;
  need(issues, isNum(u?.input_tokens), "usage.input_tokens 非数字");
  need(issues, isNum(u?.output_tokens), "usage.output_tokens 非数字");
  need(issues, isNum(u?.total_tokens), "usage.total_tokens 非数字");
  if (isNum(u?.input_tokens) && isNum(u?.output_tokens) && isNum(u?.total_tokens)) {
    need(issues, u.total_tokens === u.input_tokens + u.output_tokens,
      `usage.total_tokens != input+output（${u.total_tokens} != ${u.input_tokens + u.output_tokens}）`);
  }
  return result(issues);
}

export function checkResponsesStream(text: string): Check {
  const issues: string[] = [];
  const parsed = jsonFrames(parseSseFrames(text));
  for (const p of parsed) if (p.error) issues.push(`SSE 帧解析失败：${p.error}`);
  const ev = parsed.filter((p) => !p.error);
  need(issues, ev.length > 0, "SSE 无任何事件");
  need(issues, ev[0]?.event === "response.created", "首个事件应为 response.created");
  need(issues, ev.at(-1)?.event === "response.completed", "最后事件应为 response.completed");

  const created = ev.find((e) => e.event === "response.created")?.json;
  need(issues, created?.response?.object === "response", "response.created 缺少 response 对象");
  need(issues, ev.some((e) => e.event === "response.output_text.delta"), "缺少 response.output_text.delta");
  need(issues, ev.some((e) => e.event === "response.output_text.done"), "缺少 response.output_text.done");
  need(issues, !ev.some((e) => e.event === "response.failed" || e.event === "error"), "流中出现失败/错误事件");

  const done = ev.find((e) => e.event === "response.completed")?.json;
  need(issues, done?.response?.status === "completed", "response.completed.status 应为 completed");
  const u = done?.response?.usage;
  need(issues, isNum(u?.input_tokens) && isNum(u?.output_tokens) && isNum(u?.total_tokens), "completed 缺少完整 usage");
  if (isNum(u?.input_tokens) && isNum(u?.output_tokens) && isNum(u?.total_tokens)) {
    need(issues, u.total_tokens === u.input_tokens + u.output_tokens, "usage.total_tokens != input+output");
  }
  return result(issues);
}

export function checkModels(json: any): Check {
  const issues: string[] = [];
  need(issues, json?.object === "list", 'object 应为 "list"');
  need(issues, Array.isArray(json?.data) && json.data.length > 0, "data 为空");
  for (const [i, m] of (json?.data ?? []).entries()) {
    need(issues, typeof m?.id === "string" && m.id.length > 0, `data[${i}].id 缺失`);
    need(issues, m?.object === "model", `data[${i}].object 应为 "model"`);
  }
  return result(issues);
}

export function checkErrorEnvelope(json: any, kind: "openai" | "anthropic"): Check {
  const issues: string[] = [];
  if (kind === "openai") {
    need(issues, json?.type !== "error", "错误信封是 Anthropic 形状（顶层 type=error），不是 OpenAI 形状");
    need(issues, typeof json?.error?.message === "string", "错误信封缺少 error.message");
    need(issues, typeof json?.error?.type === "string", "错误信封缺少 error.type");
  } else {
    need(issues, json?.type === "error", 'Anthropic 错误信封 type 应为 "error"');
    need(issues, typeof json?.error?.type === "string", "错误信封缺少 error.type");
    need(issues, typeof json?.error?.message === "string", "错误信封缺少 error.message");
  }
  return result(issues);
}
