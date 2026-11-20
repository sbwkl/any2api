// Anthropic Messages API 适配 — /v1/messages ↔ 内部 OpenAI chat 管线
// 覆盖 Claude Code / Claude Desktop 所需子集：system、text/thinking/tool_use/tool_result 块、
// tools、tool_choice、流式 SSE（message_start/content_block_*/message_delta/message_stop）。
import type { OpenAIFacade } from "./openai";

// ---- 请求翻译：Anthropic → OpenAI chat ----
function systemToMessage(system: any): any | null {
  if (!system) return null;
  if (typeof system === "string") return { role: "system", content: system };
  if (Array.isArray(system))
    return { role: "system", content: system.filter((b) => b?.type === "text").map((b) => b.text).join("\n") };
  return null;
}

function contentToOpenAi(role: string, content: any): any[] {
  // 返回 0..n 条 OpenAI 消息（tool_result 会被拆成独立 tool 消息）
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
        // input 含 _raw 时为无效 JSON 的原始分片，直接透传字符串，避免二次序列化污染工具历史
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
        if (toolCalls.length) { out.push({ role: "assistant", tool_calls: toolCalls.splice(0) }); }
        out.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: typeof block.content === "string"
            ? block.content
            : (block.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n"),
        });
        break;
      case "image": text += (text ? "\n" : "") + "[image omitted]"; break;
      case "thinking": break; // 上游自行产生推理，不回注
      default: break;
    }
  }
  flushText();
  if (toolCalls.length) out.push({ role: "assistant", tool_calls: toolCalls });
  return out;
}

export function anthropicToOpenAi(body: any): any {
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
  if (tc?.type === "any") out.tool_choice = "required";
  else if (tc?.type === "tool") out.tool_choice = { type: "function", function: { name: tc.name } };
  else if (tc?.type === "auto") out.tool_choice = "auto";
  return out;
}

// ---- SSE 读取：逐帧产出 data payload ----
async function* sseData(stream: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try { yield JSON.parse(payload); } catch { /* 忽略坏帧 */ }
    }
  }
}

const STOP_REASON: Record<string, string> = {
  stop: "end_turn", tool_calls: "tool_use", length: "max_tokens",
};

export async function handleAnthropicMessages(facade: OpenAIFacade, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return anthroError(400, "invalid JSON body");
  const sessionKey = (req.headers.get("x-anthropic-session") || body.metadata?.user_id || "default").slice(0, 128);
  const openaiBody = anthropicToOpenAi(body);
  const thinking = body.thinking?.type === "enabled";
  const model = body.model ?? undefined;

  if (body.stream !== true) {
    const resp = await facade.respond(openaiBody, false, sessionKey);
    if (!okJson(resp)) return resp;
    return Response.json(completionToAnthropic(await resp.json(), model));
  }

  const resp = await facade.respond({ ...openaiBody, stream: true }, true, sessionKey);
  if (!resp.ok || !resp.body) return resp;
  const sse = await anthropicSse(resp.body!, thinking, model);
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function okJson(resp: Response): Promise<boolean> {
  if (!resp.ok) return false;
  return !(resp.headers.get("content-type") ?? "").includes("text/event-stream");
}

function completionToAnthropic(c: any, model?: string): any {
  const content: any[] = [];
  if (c?.choices?.[0]?.message?.reasoning_content)
    content.push({ type: "thinking", thinking: c.choices[0].message.reasoning_content });
  const text = c?.choices?.[0]?.message?.content ?? "";
  if (text) content.push({ type: "text", text });
  for (const tc of c?.choices?.[0]?.message?.tool_calls ?? [])
    content.push({
      type: "tool_use", id: tc.id, name: tc.function?.name,
      input: safeParse(tc.function?.arguments),
    });
  return {
    id: `msg_${c?.id ?? crypto.randomUUID().replaceAll("-", "")}`,
    type: "message", role: "assistant",
    model: model ?? c?.model ?? "",
    content,
    stop_reason: STOP_REASON[c?.choices?.[0]?.finish_reason ?? "stop"] ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: c?.usage?.prompt_tokens ?? 0,
      output_tokens: c?.usage?.completion_tokens ?? 0,
    },
  };
}

function safeParse(s: string | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function anthroError(status: number, message: string): Response {
  return Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status });
}

// ---- 流式翻译：OpenAI chunk SSE → Anthropic message SSE ----
async function anthropicSse(upstream: ReadableStream<Uint8Array>, thinking: boolean, model?: string): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  let id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  let outModel = model ?? "";
  let blockIdx = -1;
  let curBlock: "text" | "thinking" | "tool_use" | null = null;
  let inputTokens = 0, outputTokens = 0;
  const toolCalls = new Map<number, { id: string; name: string; opened: boolean }>();
  let stopReason: string | null = null;

  const startBlock = (ctrl: ReadableStreamDefaultController, type: "text" | "thinking" | "tool_use", extra?: any) => {
    blockIdx += 1;
    curBlock = type;
    const start: any = { type: "content_block_start", index: blockIdx, content_block: { type, ...(type === "text" ? { text: "" } : type === "thinking" ? { thinking: "" } : extra) } };
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
        for await (const chunk of sseData(upstream)) {
          if (chunk.model && !outModel) outModel = chunk.model;
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};
          // 推理增量（客户端开启 thinking 时输出 thinking 块）
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            if (thinking && curBlock !== "thinking") { stopBlock(ctrl); startBlock(ctrl, "thinking"); }
            if (thinking)
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
              slot = { id: tc.id ?? `toolu_${crypto.randomUUID().replaceAll("-", "")}`, name: tc.function?.name ?? "", opened: true };
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
