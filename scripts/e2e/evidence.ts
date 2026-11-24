import { parseSseFrames } from "./sse";
import type { ScenarioResult, UpstreamRequestEvidence } from "./report";

export interface EvidenceCallView {
  method: string;
  path: string;
  request?: unknown;
  response: {
    status: number;
    contentType: string;
    textTruncated?: boolean;
    summary: unknown;
  };
}

export interface EvidenceView {
  calls: EvidenceCallView[];
  upstream: { url: string; body: unknown }[];
}

export function cutString(s: string, max = 160): string {
  if (s.length <= max) return s;
  const oneLine = s.replace(/\s+/g, " ").trim();
  return `${oneLine.slice(0, max)}…(len=${s.length})`;
}

export function summarizeValue(value: unknown, maxString = 160): unknown {
  if (typeof value === "string") return cutString(value, maxString);
  if (Array.isArray(value)) {
    const items = value.slice(0, 30).map((item) => summarizeValue(item, maxString));
    if (value.length > 30) items.push(`…(共 ${value.length} 项)`);
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = summarizeValue(item, maxString);
    return out;
  }
  return value;
}

export function capJsonBody(body: unknown, max = 65536): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return { __unserializable: true, type: typeof body };
  }
  if (serialized === undefined) return body;
  if (serialized.length <= max) return body;
  return { __truncated: true, bytes: serialized.length, preview: serialized.slice(0, max) };
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function arr<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function isSse(text: string, contentType: string): boolean {
  if (contentType.includes("text/event-stream")) return true;
  const head = text.trimStart();
  return head.startsWith("event:") || head.startsWith("data:");
}

function compress(names: string[]): string {
  const out: { name: string; n: number }[] = [];
  for (const name of names) {
    const last = out.at(-1);
    if (last && last.name === name) last.n++;
    else out.push({ name, n: 1 });
  }
  return out.map((item) => (item.n > 1 ? `${item.name} ×${item.n}` : item.name)).join(" → ");
}

function summarizeChatSse(text: string): unknown {
  const frames = parseSseFrames(text).filter((frame) => frame.data !== "[DONE]");
  const chunks = frames.map((frame) => parseJson(frame.data)).filter(Boolean);
  const choice = (chunk: any) => chunk?.choices?.[0] ?? {};
  const content = chunks.map((chunk) => choice(chunk)?.delta?.content ?? "").join("");
  const reasoning = chunks.map((chunk) => choice(chunk)?.delta?.reasoning_content ?? "").join("");
  const toolCalls = chunks
    .flatMap((chunk) => arr(choice(chunk)?.delta?.tool_calls))
    .map((tool: any) => tool?.function?.name)
    .filter(Boolean);
  let finishReason: unknown;
  for (const chunk of chunks) {
    const reason = choice(chunk)?.finish_reason;
    if (reason) finishReason = reason;
  }
  const usageChunks = chunks.filter((chunk) => chunk.usage);
  const usage = usageChunks.at(-1)?.usage;
  const nonEmptyUsageChoices = usageChunks.filter((chunk) => Array.isArray(chunk.choices) && chunk.choices.length > 0).length;
  return {
    sse_frames: frames.length,
    content: cutString(content, 500),
    reasoning_content: reasoning ? cutString(reasoning, 500) : undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
    finish_reason: finishReason,
    usage,
    usage_chunks_with_nonempty_choices: nonEmptyUsageChoices || undefined,
  };
}

function summarizeAnthropicSse(text: string): unknown {
  const events = parseSseFrames(text)
    .map((frame) => {
      const json = parseJson(frame.data);
      return { event: frame.event ?? json?.type, json };
    })
    .filter((item) => item.event);
  const names = events.map((item) => String(item.event));
  const textParts: string[] = [];
  const toolCalls: { name?: string; id?: string }[] = [];
  let stopReason: unknown;
  let usage: Record<string, unknown> | undefined;
  for (const item of events) {
    if (item.event === "message_start") usage = item.json?.message?.usage;
    if (item.event === "content_block_start" && item.json?.content_block?.type === "tool_use") {
      toolCalls.push({ name: item.json.content_block.name, id: item.json.content_block.id });
    }
    if (item.event === "content_block_delta" && item.json?.delta?.type === "text_delta") {
      textParts.push(item.json.delta.text ?? "");
    }
    if (item.event === "message_delta") {
      stopReason = item.json?.delta?.stop_reason;
      usage = { ...(usage ?? {}), ...(item.json?.usage ?? {}) };
    }
  }
  return {
    event_sequence: compress(names),
    content: cutString(textParts.join(""), 500),
    tool_calls: toolCalls.length ? toolCalls : undefined,
    stop_reason: stopReason,
    usage,
  };
}

function summarizeResponsesSse(text: string): unknown {
  const events = parseSseFrames(text)
    .map((frame) => {
      const json = parseJson(frame.data);
      return { event: frame.event ?? json?.type, json };
    })
    .filter((item) => item.event);
  const textParts: string[] = [];
  for (const item of events) {
    if (item.event === "response.output_text.delta") textParts.push(item.json?.delta ?? "");
  }
  const completed = events.find((item) => item.event === "response.completed")?.json?.response;
  return {
    event_sequence: compress(events.map((item) => String(item.event))),
    content: cutString(textParts.join(""), 500),
    output_text_done: events.some((item) => item.event === "response.output_text.done"),
    status: completed?.status,
    usage: completed?.usage,
  };
}

function summarizeSse(text: string): unknown {
  const frames = parseSseFrames(text);
  const first = frames.map((frame) => parseJson(frame.data)).find(Boolean);
  if (first?.object === "chat.completion.chunk") return summarizeChatSse(text);
  if (first?.type === "message_start" || frames.some((frame) => frame.event?.startsWith("message_"))) {
    return summarizeAnthropicSse(text);
  }
  if (first?.type === "response.created" || frames.some((frame) => frame.event?.startsWith("response."))) {
    return summarizeResponsesSse(text);
  }
  return { sse_frames: frames.length };
}

function summarizeJson(endpoint: string, json: any): unknown {
  if (json?.error) {
    return {
      error: {
        type: json.error.type,
        code: json.error.code,
        message: cutString(String(json.error.message ?? ""), 500),
      },
    };
  }
  if (endpoint.endsWith("/chat/completions")) {
    return {
      id: json?.id,
      model: json?.model,
      choices: arr(json?.choices).map((choice: any) => ({
        index: choice?.index,
        message: {
          role: choice?.message?.role,
          content: choice?.message?.content === null ? null : cutString(String(choice?.message?.content ?? ""), 500),
          reasoning_content: choice?.message?.reasoning_content
            ? cutString(choice.message.reasoning_content, 500)
            : undefined,
          tool_calls: arr(choice?.message?.tool_calls).map((tool: any) => ({
            name: tool?.function?.name,
            arguments: cutString(String(tool?.function?.arguments ?? ""), 300),
          })),
        },
        finish_reason: choice?.finish_reason,
      })),
      usage: json?.usage,
    };
  }
  if (endpoint.endsWith("/messages")) {
    return {
      id: json?.id,
      type: json?.type,
      model: json?.model,
      content: arr(json?.content).map((block: any) => ({
        type: block?.type,
        text: block?.text !== undefined ? cutString(String(block.text), 500) : undefined,
        id: block?.id,
        name: block?.name,
        input: block?.input !== undefined ? summarizeValue(block.input) : undefined,
      })),
      stop_reason: json?.stop_reason,
      usage: json?.usage,
    };
  }
  if (endpoint.endsWith("/responses")) {
    return {
      id: json?.id,
      object: json?.object,
      status: json?.status,
      model: json?.model,
      output: arr(json?.output).map((item: any) => ({
        type: item?.type,
        role: item?.role,
        content: arr(item?.content).map((part: any) => ({
          type: part?.type,
          text: part?.text !== undefined ? cutString(String(part.text), 500) : undefined,
          annotations: part?.annotations,
        })),
        name: item?.name,
        arguments: item?.arguments !== undefined ? cutString(String(item.arguments), 300) : undefined,
      })),
      usage: json?.usage,
    };
  }
  if (endpoint.endsWith("/models")) {
    return {
      object: json?.object,
      data_count: json?.data?.length,
      models: arr(json?.data).slice(0, 10).map((model: any) => model?.id),
    };
  }
  if (endpoint.endsWith("/healthz")) {
    return { ok: json?.ok, providers: json?.providers };
  }
  return summarizeValue(json);
}

export function summarizeResponse(endpoint: string, text: string, contentType: string): unknown {
  if (isSse(text, contentType)) return summarizeSse(text);
  const json = parseJson(text);
  if (json === undefined) return { unparsed: cutString(text, 500) };
  return summarizeJson(endpoint, json);
}

export function buildEvidenceView(result: ScenarioResult): EvidenceView {
  const evidence = result.evidence ?? { inbound: [], upstream: [] };
  return {
    calls: evidence.inbound.map((call) => ({
      method: call.method,
      path: call.path,
      request:
        call.requestBody !== undefined
          ? summarizeValue(call.requestBody)
          : call.rawBody !== undefined
            ? cutString(call.rawBody, 300)
            : undefined,
      response: {
        status: call.response.status,
        contentType: call.response.contentType,
        textTruncated: call.response.textTruncated,
        summary: summarizeResponse(result.endpoint, call.response.text, call.response.contentType),
      },
    })),
    upstream: evidence.upstream.map((record: UpstreamRequestEvidence) => ({
      url: record.url,
      body: summarizeValue(record.body),
    })),
  };
}
