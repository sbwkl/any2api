// OpenAI Responses API 适配 — /codebuddy/v1/responses ↔ 内部 OpenAI chat 管线
// 覆盖 Codex CLI 所需子集：instructions、input（message/function_call/function_call_output）、
// tools、流式 SSE（response.created/output_item.added/output_text.delta/response.completed 等）。
import type { CodeBuddyFacade } from "./openai";

// ---- 请求翻译：Responses → OpenAI chat ----
function inputItemsToMessages(input: any): any[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out: any[] = [];
  for (const item of input ?? []) {
    if (item?.type === "message" || (!item?.type && item?.role)) {
      const c = item.content;
      const text = typeof c === "string"
        ? c
        : (c ?? []).map((p: any) => (typeof p === "string" ? p : p?.text ?? "")).join("");
      if (text) out.push({ role: item.role ?? "user", content: text });
    } else if (item?.type === "function_call") {
      out.push({
        role: "assistant",
        tool_calls: [{ id: item.call_id ?? item.id ?? "call_0", type: "function", function: { name: item.name, arguments: item.arguments ?? "{}" } }],
      });
    } else if (item?.type === "function_call_output") {
      out.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    }
    // reasoning / 其他类型忽略
  }
  return out;
}

export function responsesToOpenAi(body: any): any {
  const messages: any[] = [];
  if (typeof body.instructions === "string" && body.instructions) messages.push({ role: "system", content: body.instructions });
  messages.push(...inputItemsToMessages(body.input));
  const out: any = { model: body.model, messages };
  if (body.stream === true) out.stream = true;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (Array.isArray(body.tools) && body.tools.length)
    out.tools = body.tools
      .filter((t) => t?.type === "function")
      .map((t) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object" } } }));
  // CodeBuddy 上游只支持 auto；required/forced function 映射为 auto。
  const tc = body.tool_choice;
  if (tc === "auto" || tc === "required" || tc === "none") out.tool_choice = tc === "required" ? "auto" : tc;
  else if (tc?.type === "function") out.tool_choice = "auto";
  else if (tc?.type === "auto") out.tool_choice = "auto";
  return out;
}

// ---- SSE 读取 ----
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

export async function handleResponses(facade: CodeBuddyFacade, req: Request): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  const sessionKey = (
    req.headers.get("x-codebuddy-session") ||
    req.headers.get("x-responses-session") ||
    body.session_id ||
    body.user ||
    "default"
  ).slice(0, 128);
  const openaiBody = responsesToOpenAi(body);
  const profile = facade.profileFor(req);

  if (body.stream !== true) {
    const resp = await facade.respond(openaiBody, false, sessionKey, profile);
    if (!resp.ok) return await relayError(resp);
    return Response.json(completionToResponse(await resp.json(), body.model));
  }

  const resp = await facade.respond({ ...openaiBody, stream: true }, true, sessionKey, profile);
  if (!resp.ok || !resp.body) return await relayError(resp);
  const sse = await responsesSse(resp.body!, body.model);
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function relayError(resp: Response): Promise<Response> {
  let message = `upstream ${resp.status}`;
  let code: any = resp.status;
  try {
    const j: any = await resp.clone().json();
    message = j?.error?.message ?? j?.message ?? message;
    code = j?.error?.code ?? j?.code ?? code;
  } catch { /* ignore */ }
  return Response.json({ error: { message, type: "upstream_error", code, param: null } }, { status: resp.status });
}

function completionToResponse(c: any, model?: string): any {
  const msg = c?.choices?.[0]?.message ?? {};
  const output: any[] = [];
  if (msg.reasoning_content) output.push({ type: "reasoning", id: `rs_${rid()}`, summary: [{ type: "summary_text", text: msg.reasoning_content }] });
  if (msg.content) output.push({
    type: "message", id: `msg_${rid()}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: msg.content, annotations: [] }],
  });
  for (const tc of msg.tool_calls ?? [])
    output.push({ type: "function_call", id: `fc_${rid()}`, call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? "{}", status: "completed" });
  const usage = c?.usage ?? {};
  return {
    id: `resp_${rid()}`, object: "response", created_at: Math.floor(Date.now() / 1000),
    status: "completed", model: model ?? c?.model ?? "",
    output,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      input_tokens_details: { cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0 },
      output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
    },
    incomplete_details: null, error: null, metadata: {}, store: false,
  };
}

function rid(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 24);
}

// ---- 流式翻译：OpenAI chunk SSE → Responses SSE ----
async function responsesSse(upstream: ReadableStream<Uint8Array>, model?: string): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  const respId = `resp_${rid()}`;
  let outModel = model ?? "";
  let outIndex = -1;
  let msgItemId: string | null = null;
  let seq = 0;
  const outputItems: any[] = [];
  let usage: any = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let finish: string | null = null;

  const ev = (ctrl: ReadableStreamDefaultController, type: string, data: any) =>
    ctrl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify({ ...data, sequence_number: seq++ })}\n\n`));

  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const skeleton = () => ({
        id: respId, object: "response", created_at: Math.floor(Date.now() / 1000),
        status: finish ? "completed" : "in_progress", model: outModel,
        output: outputItems, usage, incomplete_details: null, error: null, metadata: {}, store: false,
      });
      try {
        ev(ctrl, "response.created", { type: "response.created", response: skeleton() });
        for await (const chunk of sseData(upstream)) {
          if (chunk.model && !outModel) outModel = chunk.model;
          if (chunk.usage)
            usage = {
              input_tokens: chunk.usage.prompt_tokens ?? 0,
              output_tokens: chunk.usage.completion_tokens ?? 0,
              total_tokens: chunk.usage.total_tokens ?? 0,
              input_tokens_details: { cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0 },
              output_tokens_details: { reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0 },
            };
          const choice = chunk.choices?.[0];
          const delta = choice?.delta ?? {};

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            let item = outputItems.find((i) => i.type === "reasoning");
            if (!item) {
              outIndex += 1;
              item = { type: "reasoning", id: `rs_${rid()}`, summary: [], _text: "" };
              outputItems.push(item);
              const oi = outputItems.indexOf(item);
              ev(ctrl, "response.output_item.added", { type: "response.output_item.added", output_index: oi, item: { type: "reasoning", id: item.id, summary: [] } });
              ev(ctrl, "response.reasoning_summary_part.added", { type: "response.reasoning_summary_part.added", item_id: item.id, output_index: oi, summary_index: 0, part: { type: "summary_text", text: "" } });
            }
            const oi = outputItems.indexOf(item);
            item._text += delta.reasoning_content;
            ev(ctrl, "response.reasoning_summary_text.delta", { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index: oi, summary_index: 0, delta: delta.reasoning_content });
          }

          if (typeof delta.content === "string" && delta.content) {
            if (!msgItemId) {
              outIndex += 1;
              msgItemId = `msg_${rid()}`;
              const item = { type: "message", id: msgItemId, role: "assistant", status: "in_progress", content: [], _text: "" };
              outputItems.push(item);
              const oi = outputItems.indexOf(item);
              ev(ctrl, "response.output_item.added", { type: "response.output_item.added", output_index: oi, item: { type: "message", id: item.id, role: "assistant", status: "in_progress", content: [] } });
              ev(ctrl, "response.content_part.added", { type: "response.content_part.added", item_id: msgItemId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            }
            const item = outputItems.find((i) => i.id === msgItemId) as any;
            const oi = outputItems.indexOf(item);
            item._text += delta.content;
            ev(ctrl, "response.output_text.delta", { type: "response.output_text.delta", item_id: msgItemId, output_index: oi, content_index: 0, delta: delta.content });
          }

          for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
            const key = `call:${tc.index ?? 0}`;
            let slot = outputItems.find((i) => i._key === key);
            if (!slot) {
              outIndex += 1;
              slot = { type: "function_call", id: `fc_${rid()}`, call_id: tc.id ?? `call_${tc.index ?? 0}`, name: tc.function?.name ?? "", arguments: "", status: "in_progress", _key: key };
              outputItems.push(slot);
              const oi = outputItems.indexOf(slot);
              ev(ctrl, "response.output_item.added", { type: "response.output_item.added", output_index: oi, item: { type: "function_call", id: slot.id, call_id: slot.call_id, name: slot.name, arguments: "", status: "in_progress" } });
            }
            if (tc.function?.name && !slot.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
              slot.arguments += tc.function.arguments;
              const oi = outputItems.indexOf(slot);
              ev(ctrl, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: slot.id, output_index: oi, delta: tc.function.arguments });
            }
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }

        const finalItems = outputItems.map((item: any) => {
          if (item.type === "reasoning")
            return { type: "reasoning", id: item.id, summary: item._text ? [{ type: "summary_text", text: item._text }] : [] };
          if (item.type === "message")
            return { type: "message", id: item.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: item._text ?? "", annotations: [] }] };
          return { type: "function_call", id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments, status: "completed" };
        });
        outputItems.forEach((item: any, oi: number) => {
          if (item.type === "message") {
            ev(ctrl, "response.content_part.done", { type: "response.content_part.done", item_id: item.id, output_index: oi, content_index: 0, part: { type: "output_text", text: item._text ?? "", annotations: [] } });
          }
          if (item.type === "function_call") {
            ev(ctrl, "response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: item.id, output_index: oi, arguments: item.arguments });
          }
          ev(ctrl, "response.output_item.done", { type: "response.output_item.done", output_index: oi, item: finalItems[oi] });
        });
        ev(ctrl, "response.completed", {
          type: "response.completed",
          response: { ...skeleton(), status: "completed", output: finalItems },
        });
      } catch (e: any) {
        ev(ctrl, "error", { type: "error", code: "api_error", message: e?.message ?? String(e), param: null, sequence_number: seq++ });
      } finally {
        ctrl.close();
      }
    },
  });
}