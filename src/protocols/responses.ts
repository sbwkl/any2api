// OpenAI Responses API 适配 — 共享协议层
// 依赖 ChatBackend.respond；能力差异用 ProtocolCapabilities 表达，不感知 provider 名称。
import type { ChatBackend, ProtocolCapabilities } from "./types";
import { pruneDanglingToolChoice, safeRespond } from "./util";
import { classifyUpstreamStatus, errorTypeForStatus, responsesErrorCodeForStatus, PROXY_ERROR_HEADER } from "../shared/errors";
import { sseData, upstreamErrorFromChunk, NO_CHOICES } from "../shared/sse";

// ---- namespace 工具展开 ----
// Codex 会把客户端可执行的工具分组为 `{type:"namespace", name, tools:[function…]}`。
// OpenAI chat 上游只认顶层 function，所以把成员展开为 `<namespace>__<name>`；调用返回时
// 再还原成 Codex 期望的 `{name:<成员名>, namespace:<命名空间>}`。输入里已有的
// `function_call.namespace` 也必须用同一个展开名，否则历史中的工具名对不上。
const MAX_FUNCTION_NAME = 64;
const NS_SEPARATOR = "__";

export interface ResponsesToolRef { name: string; namespace?: string }

export interface ResponsesToolMap {
  /** 输入 function_call 的 namespace+name → 上游函数名 */
  toUpstream(namespace: string, name: string): string;
  /** 上游函数名 → Codex 可见的 name(+namespace) */
  resolve(upstreamName: string): ResponsesToolRef;
  /** 把 Responses tools 展开为 OpenAI chat function tools */
  flatten(): any[];
}

function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).slice(0, 6);
}

function sanitizeFunctionName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function uniqueFunctionName(candidate: string, used: Set<string>): string {
  let base = sanitizeFunctionName(candidate);
  if (base.length > MAX_FUNCTION_NAME)
    base = `${base.slice(0, MAX_FUNCTION_NAME - shortHash(candidate).length - 1)}_${shortHash(candidate)}`;
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const next = `${base.slice(0, MAX_FUNCTION_NAME - suffix.length)}${suffix}`;
    if (!used.has(next)) {
      used.add(next);
      return next;
    }
  }
}

export function buildResponsesToolMap(tools: any[] | undefined): ResponsesToolMap {
  const used = new Set<string>();
  // 顶层 function 先占名，namespace 展开名不得覆盖它们。
  for (const t of tools ?? [])
    if (t?.type === "function" && typeof t.name === "string") used.add(t.name);

  const byNamespace = new Map<string, string>(); // `${ns}\u0000${member}` → upstream
  const byUpstream = new Map<string, ResponsesToolRef>();
  const flattened: any[] = [];

  for (const t of tools ?? []) {
    if (t?.type === "function" && typeof t.name === "string") {
      flattened.push({
        type: "function",
        function: { name: t.name, description: t.description ?? "", parameters: t.parameters ?? { type: "object" } },
      });
      continue;
    }
    if (t?.type !== "namespace" || typeof t.name !== "string" || !Array.isArray(t.tools)) continue;
    for (const member of t.tools) {
      if (member?.type !== "function" || typeof member.name !== "string") continue;
      const upstream = uniqueFunctionName(`${t.name}${NS_SEPARATOR}${member.name}`, used);
      byNamespace.set(`${t.name}\u0000${member.name}`, upstream);
      byUpstream.set(upstream, { name: member.name, namespace: t.name });
      flattened.push({
        type: "function",
        function: {
          name: upstream,
          description: member.description ?? "",
          parameters: member.parameters ?? { type: "object" },
        },
      });
    }
  }

  return {
    toUpstream(namespace, name) {
      return byNamespace.get(`${namespace}\u0000${name}`) ?? name;
    },
    resolve(upstreamName) {
      return byUpstream.get(upstreamName) ?? { name: upstreamName };
    },
    flatten() {
      return flattened;
    },
  };
}

// input_image → OpenAI chat 的 image_url：图片必须真的送达上游，取不到 URL 时留诊断占位符，
// 不能安静丢掉（Responses 客户端的读图结果会变成模型从未见过的内容）。
function inputImagePart(part: any): any {
  const raw = part?.image_url;
  const url = typeof raw === "string" ? raw : typeof raw?.url === "string" ? raw.url : null;
  if (url) return { type: "image_url", image_url: { url } };
  return `[image omitted: input_image without image_url${part?.file_id ? ` (file_id=${part.file_id})` : ""}]`;
}

function messageContentToOpenAi(content: any): any {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: any[] = [];
  for (const part of content) {
    if (typeof part === "string") { parts.push(part); continue; }
    if (part?.type === "input_image") { parts.push(inputImagePart(part)); continue; }
    if (typeof part?.text === "string") parts.push(part.text);
  }
  if (!parts.some((p) => typeof p !== "string")) return parts.join("");
  const out: any[] = [];
  for (const p of parts) {
    if (typeof p !== "string") { out.push(p); continue; }
    if (!p) continue;
    const last = out.at(-1);
    if (last?.type === "text") last.text += p;
    else out.push({ type: "text", text: p });
  }
  return out;
}

function inputItemsToMessages(input: any, toolMap: ResponsesToolMap): any[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const out: any[] = [];
  let pending: any[] = [];
  const flush = () => {
    if (!pending.length) return;
    out.push({ role: "assistant", tool_calls: pending });
    pending = [];
  };
  for (const item of input ?? []) {
    if (item?.type === "function_call") {
      // 连续的 function_call 合并为一条 assistant 消息的 tool_calls 数组（OpenAI chat 语义）
      const name = typeof item.namespace === "string" ? toolMap.toUpstream(item.namespace, item.name) : item.name;
      pending.push({
        id: item.call_id ?? item.id ?? `call_${pending.length}`,
        type: "function",
        function: { name, arguments: item.arguments ?? "{}" },
      });
      continue;
    }
    if (item?.type === "function_call_output") {
      flush();
      out.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
      continue;
    }
    if (item?.type === "message" || (!item?.type && item?.role)) {
      flush();
      const content = messageContentToOpenAi(item.content);
      const empty = typeof content === "string" ? !content : content.length === 0;
      if (!empty) out.push({ role: item.role ?? "user", content });
      continue;
    }
    // reasoning / 其他类型：忽略，不打断连续 function_call 分组
  }
  flush();
  return out;
}

export function responsesToOpenAi(body: any, caps: ProtocolCapabilities = {}, toolMap?: ResponsesToolMap): any {
  const map = toolMap ?? buildResponsesToolMap(body.tools);
  const messages: any[] = [];
  if (typeof body.instructions === "string" && body.instructions) messages.push({ role: "system", content: body.instructions });
  messages.push(...inputItemsToMessages(body.input, map));
  const out: any = { model: body.model, messages };
  if (body.stream === true) out.stream = true;
  if (body.max_output_tokens !== undefined) out.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.reasoning?.effort) out.reasoning_effort = body.reasoning.effort;
  if (body.parallel_tool_calls !== undefined) out.parallel_tool_calls = body.parallel_tool_calls;
  if (body.metadata !== undefined) out.metadata = body.metadata;
  if (Array.isArray(body.tools) && body.tools.length) {
    const mapped = map.flatten();
    if (mapped.length) out.tools = mapped;
  }

  const tc = body.tool_choice;
  if (caps.toolChoice === "auto-only") {
    if (tc === "required") out.tool_choice = "auto";
    else if (tc === "auto" || tc === "none") out.tool_choice = tc;
    else if (tc?.type === "function" || tc?.type === "auto") out.tool_choice = "auto";
  } else {
    if (typeof tc === "string") out.tool_choice = tc;
    else if (tc?.type === "function") {
      const name = typeof tc.namespace === "string" ? map.toUpstream(tc.namespace, tc.name) : tc.name;
      out.tool_choice = { type: "function", function: { name } };
    }
  }
  return pruneDanglingToolChoice(out);
}

function validateResponses(body: any): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be an object";
  if (body.input !== undefined && typeof body.input !== "string" && !Array.isArray(body.input))
    return "input must be a string or array";
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return "input item must be an object";
      // 只有 message 项需要校验 content；reasoning 等项的 content 可为 null/任意值，直接忽略。
      const isMessage = item.type === "message" || (!item.type && item.role);
      if (isMessage && item.content !== undefined && item.content !== null) {
        if (typeof item.content !== "string" && !Array.isArray(item.content))
          return "input.content must be a string or array";
        if (Array.isArray(item.content)) {
          for (const part of item.content) {
            if (typeof part !== "string" && (!part || typeof part !== "object" || Array.isArray(part)))
              return "input.content[] must be strings or objects";
          }
        }
      }
    }
  }
  if (body.session_id !== undefined && typeof body.session_id !== "string") return "session_id must be a string";
  if (body.user !== undefined && typeof body.user !== "string") return "user must be a string";
  if (body.instructions !== undefined && typeof body.instructions !== "string") return "instructions must be a string";
  if (body.tools !== undefined && !Array.isArray(body.tools)) return "tools must be an array";
  return null;
}

export async function handleResponses(
  backend: ChatBackend,
  req: Request,
  caps: ProtocolCapabilities = {},
): Promise<Response> {
  const body = await req.json().catch(() => null);
  if (!body) return Response.json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, { status: 400 });
  const invalid = validateResponses(body);
  if (invalid) {
    return Response.json({ error: { message: `invalid request: ${invalid}`, type: "invalid_request_error" } }, { status: 400 });
  }
  const sessionKey = (
    req.headers.get("x-codebuddy-session") ||
    req.headers.get("x-responses-session") ||
    body.session_id ||
    body.user ||
    "default"
  ).slice(0, 128);
  const profile = backend.profileFor?.(req);
  const toolMap = buildResponsesToolMap(body.tools);
  const openaiBody = responsesToOpenAi(body, caps, toolMap);

  if (body.stream !== true) {
    const resp = await safeRespond(backend, openaiBody, { stream: false, sessionKey, profile, signal: req.signal });
    if (!resp.ok) return await relayErrorIfNeeded(resp, caps);
    return Response.json(completionToResponse(await resp.json(), body.model, toolMap));
  }

  const resp = await safeRespond(backend, { ...openaiBody, stream: true }, { stream: true, sessionKey, profile, signal: req.signal });
  if (!resp.ok || !resp.body) return await relayErrorIfNeeded(resp, caps);
  const sse = await responsesSse(resp.body, body.model, toolMap);
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function relayErrorIfNeeded(resp: Response, caps: ProtocolCapabilities): Promise<Response> {
  if (caps.normalizeErrors === false && resp.headers.get(PROXY_ERROR_HEADER) !== "proxy") return resp;
  let message = `upstream ${resp.status}`;
  let code: any = resp.status;
  try {
    const j: any = await resp.clone().json();
    message = j?.error?.message ?? j?.message ?? message;
    code = j?.error?.code ?? j?.code ?? code;
  } catch { /* ignore */ }
  return Response.json({ error: { message, type: errorTypeForStatus(resp.status), code, param: null } }, { status: resp.status });
}

function resolveToolRef(toolMap: ResponsesToolMap | undefined, upstreamName: string): ResponsesToolRef {
  return toolMap?.resolve(upstreamName) ?? { name: upstreamName };
}

/** 输出形状统一在这里生成：非流式 tool_call、流式 output_item.added/done 共用一个还原路径。 */
function functionCallItem(
  ref: ResponsesToolRef, callId: string, args: string, status: "in_progress" | "completed", id = `fc_${rid()}`,
): any {
  return {
    type: "function_call", id, call_id: callId, name: ref.name,
    ...(ref.namespace ? { namespace: ref.namespace } : {}),
    arguments: args, status,
  };
}

function completionToResponse(c: any, model?: string, toolMap?: ResponsesToolMap): any {
  const msg = c?.choices?.[0]?.message ?? {};
  const output: any[] = [];
  if (msg.reasoning_content) output.push({ type: "reasoning", id: `rs_${rid()}`, summary: [{ type: "summary_text", text: msg.reasoning_content }] });
  if (msg.content) output.push({
    type: "message", id: `msg_${rid()}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: msg.content, annotations: [] }],
  });
  for (const tc of msg.tool_calls ?? []) {
    output.push(functionCallItem(resolveToolRef(toolMap, tc.function?.name ?? ""), tc.id, tc.function?.arguments ?? "{}", "completed"));
  }
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

async function responsesSse(upstream: ReadableStream<Uint8Array>, model?: string, toolMap?: ResponsesToolMap): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  const respId = `resp_${rid()}`;
  let outModel = model ?? "";
  let msgItemId: string | null = null;
  let seq = 0;
  const outputItems: any[] = [];
  let usage: any = {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  };
  let finish: string | null = null;
  let sawChoice = false;

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
        for await (const data of sseData(upstream)) {
        if (!data || data === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
          // 上游把业务错误塞进 200 的 SSE 时没有 choices；当成正常空响应会让客户端
          // 收到一个「成功但什么都没做」的回合。与 Anthropic 路径一致，按错误收尾。
          const upstreamError = upstreamErrorFromChunk(chunk);
          if (upstreamError) throw new Error(`upstream error: ${upstreamError}`);
          if (chunk.model && !outModel) outModel = chunk.model;
          if (chunk.usage) {
            usage = {
              input_tokens: chunk.usage.prompt_tokens ?? usage.input_tokens,
              output_tokens: chunk.usage.completion_tokens ?? usage.output_tokens,
              total_tokens: chunk.usage.total_tokens ?? usage.total_tokens,
              input_tokens_details: {
                cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens,
              },
              output_tokens_details: {
                reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? usage.output_tokens_details?.reasoning_tokens,
              },
            };
          }
          const choice = chunk.choices?.[0];
          if (choice) sawChoice = true;
          const delta = choice?.delta ?? {};

          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            let item = outputItems.find((i) => i.type === "reasoning");
            if (!item) {
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
              const ref = resolveToolRef(toolMap, tc.function?.name ?? "");
              slot = {
                type: "function_call", id: `fc_${rid()}`, call_id: tc.id ?? `call_${tc.index ?? 0}`,
                name: ref.name, namespace: ref.namespace, arguments: "", status: "in_progress", _key: key, _added: false,
              };
              outputItems.push(slot);
            }
            if (tc.function?.name && !slot.name) {
              const ref = resolveToolRef(toolMap, tc.function.name);
              slot.name = ref.name;
              slot.namespace = ref.namespace;
            }
            // added 只能发一次：名称未到就发会留下空 name 且永不更正，客户端无法路由。
            if (!slot._added && slot.name) {
              slot._added = true;
              const oi = outputItems.indexOf(slot);
              ev(ctrl, "response.output_item.added", {
                type: "response.output_item.added", output_index: oi,
                item: functionCallItem(slot, slot.call_id, "", "in_progress", slot.id),
              });
              // 名称到达前缓冲的参数一次补发，保持 added 在 delta 之前
              if (slot.arguments)
                ev(ctrl, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: slot.id, output_index: oi, delta: slot.arguments });
            }
            if (typeof tc.function?.arguments === "string" && tc.function.arguments) {
              slot.arguments += tc.function.arguments;
              if (slot._added) {
                const oi = outputItems.indexOf(slot);
                ev(ctrl, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: slot.id, output_index: oi, delta: tc.function.arguments });
              }
            }
          }
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
        if (!sawChoice) throw new Error(NO_CHOICES);

        // 名称始终未到的工具调用也补发 added，保证 added/done 成对
        for (const item of outputItems) {
          if (item.type !== "function_call" || item._added) continue;
          item._added = true;
          const oi = outputItems.indexOf(item);
          ev(ctrl, "response.output_item.added", {
            type: "response.output_item.added", output_index: oi,
            item: functionCallItem(item, item.call_id, "", "in_progress", item.id),
          });
          if (item.arguments)
            ev(ctrl, "response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: item.id, output_index: oi, delta: item.arguments });
        }

        const finalItems = outputItems.map((item: any) => {
          if (item.type === "reasoning")
            return { type: "reasoning", id: item.id, summary: item._text ? [{ type: "summary_text", text: item._text }] : [] };
          if (item.type === "message")
            return { type: "message", id: item.id, role: "assistant", status: "completed", content: [{ type: "output_text", text: item._text ?? "", annotations: [] }] };
          return functionCallItem(item, item.call_id, item.arguments, "completed", item.id);
        });
        outputItems.forEach((item: any, oi: number) => {
          if (item.type === "message") {
            ev(ctrl, "response.output_text.done", { type: "response.output_text.done", item_id: item.id, output_index: oi, content_index: 0, text: item._text ?? "" });
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
        const message = e?.message ?? String(e);
        // Responses 的 error.code 词汇与 HTTP 状态不同；分类见共享错误模块。
        const status = classifyUpstreamStatus(message);
        const code = responsesErrorCodeForStatus(status);
        ev(ctrl, "error", { type: "error", code, message, param: null, sequence_number: seq++ });
      } finally {
        ctrl.close();
      }
    },
  });
}