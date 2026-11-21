// Anthropic Messages API 适配 — 共享协议层
// 依赖 ChatBackend.respond（OpenAI chat 形态）；能力差异用 ProtocolCapabilities 表达，不感知 provider 名称。
import type { ChatBackend, ProtocolCapabilities } from "./types";
import { safeRespond } from "./util";
import { errorTypeForStatus } from "../shared/errors";
import { sseData } from "../shared/sse";

function systemToMessage(system: any): any | null {
  if (!system) return null;
  if (typeof system === "string") return { role: "system", content: system };
  if (Array.isArray(system))
    return { role: "system", content: system.filter((b) => b?.type === "text").map((b) => b.text).join("\n") };
  return null;
}

function contentToOpenAi(role: string, content: any): any[] {
  if (typeof content === "string") return [{ role, content }];
  const out: any[] = [];
  let text = "";
  const toolCalls: any[] = [];
  const flushText = () => {
    if (text) { out.push({ role, content: text }); text = ""; }
  };
  for (const block of content ?? []) {
    switch (block?.type) {
      case "text": text += (text ? "\n" : "") + (block.text ?? ""); break;
      case "tool_use":
        flushText();
        toolCalls.push({
          id: block.id, type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input?._raw === "string" ? block.input._raw : JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case "tool_result":
        flushText();
        if (toolCalls.length) out.push({ role: "assistant", tool_calls: toolCalls.splice(0) });
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string"
            ? block.content
            : (block.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"),
        });
        break;
      case "image": text += (text ? "\n" : "") + "[image omitted]"; break;
      case "thinking": break;
      default: break;
    }
  }
  flushText();
  if (toolCalls.length) out.push({ role: "assistant", tool_calls: toolCalls });
  return out;
}

export function anthropicToOpenAi(body: any, caps: ProtocolCapabilities = {}): any {
  const messages: any[] = [];
  const sys = systemToMessage(body.system);
  if (sys) messages.push(sys);
  for (const m of body.messages ?? []) messages.push(...contentToOpenAi(m.role, m.content));
  const out: any = { model: body.model, messages };
  if (body.stream === true) out.stream = true;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length)
    out.tools = body.tools
      .filter((t) => t?.type === "custom" || (!t?.type && t?.name))
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } } }));

  const tc = body.tool_choice;
  if (caps.toolChoice === "auto-only") {
    if (tc?.type === "any" || tc?.type === "tool" || tc?.type === "auto") out.tool_choice = "auto";
    else if (tc?.type === "none") out.tool_choice = "none";
  } else {
    if (tc?.type === "any") out.tool_choice = "required";
    else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
    else if (tc?.type === "auto") out.tool_choice = "auto";
    else if (tc?.type === "none") out.tool_choice = "none";
  }
  return out;
}

const STOP_REASON: Record<string, string> = {
  stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", content_filter: "end_turn",
};

function validateAnthropic(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  if (!Array.isArray(body.messages)) return "messages must be an array";
  if (body.system !== undefined && typeof body.system !== "string" && !Array.isArray(body.system))
    return "system must be a string or array";
  for (const m of body.messages) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return "message must be an object";
    if (typeof m.role !== "string") return "message.role must be a string";
    if (typeof m.content !== "string" && !Array.isArray(m.content))
      return "message.content must be a string or array";
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || typeof block !== "object" || Array.isArray(block)) return "content block must be an object";
      }
    }
  }
  if (body.metadata !== undefined) {
    if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata))
      return "metadata must be an object";
    if (body.metadata.user_id !== undefined && typeof body.metadata.user_id !== "string")
      return "metadata.user_id must be a string";
  }
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be an array";
  return null;
}

export async function handleAnthropicMessages(
  backend: ChatBackend,
  req: Request,
  caps: ProtocolCapabilities = {},
): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return anthroError(400, "invalid JSON body");
  const invalid = validateAnthropic(body);
  if (invalid) return anthroError(400, `invalid request: ${invalid}`);
  const sessionKey = (
    req.headers.get("x-codebuddy-session") ||
    req.headers.get("x-anthropic-session") ||
    body.metadata?.user_id ||
    "default"
  ).slice(0, 128);
  const profile = backend.profileFor?.(req);
  const openaiBody = anthropicToOpenAi(body, caps);
  const thinking = caps.thinking !== false && body.thinking?.type === "enabled";
  const model = body.model ?? undefined;

  if (body.stream !== true) {
    const resp = await safeRespond(backend, openaiBody, { stream: false, sessionKey, profile });
    if (!resp.ok) return await relayErrorIfNeeded(resp, caps);
    return Response.json(completionToAnthropic(await resp.json(), model, thinking));
  }

  const resp = await safeRespond(backend, { ...openaiBody, stream: true }, { stream: true, sessionKey, profile });
  if (!resp.ok || !resp.body) return await relayErrorIfNeeded(resp, caps);
  const sse = await anthropicSse(resp.body, thinking, model);
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function relayErrorIfNeeded(resp: Response, caps: ProtocolCapabilities): Promise<Response> {
  if (caps.normalizeErrors === false) return resp;
  let message = `upstream ${resp.status}`;
  try {
    const j: any = await resp.clone().json();
    message = j?.error?.message ?? j?.message ?? message;
  } catch { /* ignore */ }
  return anthroError(resp.status, message, errorTypeForStatus(resp.status));
}

function completionToAnthropic(c: any, model?: string, thinking = false): any {
  const content: any[] = [];
  if (thinking && c?.choices?.[0]?.message?.reasoning_content)
    content.push({ type: "thinking", thinking: c.choices[0].message.reasoning_content });
  const text = c?.choices?.[0]?.message?.content ?? "";
  if (text) content.push({ type: "text", text });
  for (const tc of c?.choices?.[0]?.message?.tool_calls ?? [])
    content.push({
      type: "tool_use", id: tc.id, name: tc.function?.name,
      input: safeParse(tc.function?.arguments),
    });
  const usage = c?.usage ?? {};
  return {
    id: `msg_${c?.id ?? crypto.randomUUID().replaceAll("-", "")}`,
    type: "message", role: "assistant",
    model: model ?? c?.model ?? "",
    content,
    stop_reason: STOP_REASON[c?.choices?.[0]?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      cache_read_input_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_input_tokens: usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
    },
  };
}

function safeParse(s: string | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function anthroError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

async function anthropicSse(upstream: ReadableStream<Uint8Array>, thinking: boolean, model?: string): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  let outModel = model ?? "";
  let blockIdx = -1;
  let curBlock: "text" | "thinking" | "tool_use" | null = null;
  let outputTokens = 0;
  const toolCalls = new Map<number, { id: string; name: string }>();
  let stopReason: string | null = null;

  const startBlock = (ctrl: ReadableStreamDefaultController, type: "text" | "thinking" | "tool_use", extra?: any) => {
    blockIdx += 1;
    curBlock = type;
    const start: any = {
      type: "content_block_start", index: blockIdx,
      content_block: { type, ...(type === "text" ? { text: "" } : type === "thinking" ? { thinking: "" } : extra) },
    };
    ctrl.enqueue(enc.encode(`event: content_block_start\ndata: ${JSON.stringify(start)}\n\n`));
  };
  const stopBlock = (ctrl: ReadableStreamDefaultController) => {
    if (!curBlock) return;
    ctrl.enqueue(enc.encode(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: blockIdx })}\n\n`));
    curBlock = null;
  };
  const ev = (ctrl: ReadableStreamDefaultController, type: string, data: any) =>
    ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));

  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        ev(ctrl, "message_start", {
          type: "message_start",
          message: {
            id, type: "message", role: "assistant", model: outModel,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        });
        for await (const data of sseData(upstream)) {
        if (!data || data === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.model && !outModel) outModel = chunk.model;
          if (chunk.usage) outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          if (thinking && typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            if (curBlock !== "thinking") { stopBlock(ctrl); startBlock(ctrl, "thinking"); }
            ev(ctrl, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "thinking_delta", thinking: delta.reasoning_content } });
          }
          if (typeof delta.content === "string" && delta.content) {
            if (curBlock !== "text") { stopBlock(ctrl); startBlock(ctrl, "text"); }
            ev(ctrl, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "text_delta", text: delta.content } });
          }
          for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const idx = tc.index ?? 0;
            let slot = toolCalls.get(idx);
            if (!slot) {
              stopBlock(ctrl);
              slot = { id: tc.id ?? `toolu_${crypto.randomUUID().replaceAll("-", "")}`, name: tc.function?.name ?? "" };
              toolCalls.set(idx, slot);
              startBlock(ctrl, "tool_use", { id: slot.id, name: slot.name, input: "" });
            } else if (tc.function?.name && !slot.name) {
              slot.name = tc.function.name;
            }
            if (typeof tc.function?.arguments === "string" && tc.function.arguments)
              ev(ctrl, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
          }
          if (choice?.finish_reason) stopReason = STOP_REASON[choice.finish_reason] ?? "end_turn";
        }
        stopBlock(ctrl);
        ev(ctrl, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
          usage: { output_tokens: outputTokens },
        });
        ev(ctrl, "message_stop", { type: "message_stop" });
      } catch (e: any) {
        ev(ctrl, "error", { type: "error", error: { type: "api_error", message: e?.message ?? String(e) } });
      } finally {
        ctrl.close();
      }
    },
  });
}