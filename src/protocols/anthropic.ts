// Anthropic Messages API 适配 — 共享协议层
// 依赖 ChatBackend.respond（OpenAI chat 形态）；能力差异用 ProtocolCapabilities 表达，不感知 provider 名称。
import type { ChatBackend, ProtocolCapabilities } from "./types";
import { pruneDanglingToolChoice, safeRespond } from "./util";
import { anthropicErrorTypeForMessage, anthropicErrorTypeForStatus, PROXY_ERROR_HEADER } from "../shared/errors";
import { sseData, upstreamErrorFromChunk, NO_CHOICES } from "../shared/sse";

function systemToMessage(system: any): any | null {
  if (!system) return null;
  if (typeof system === "string") return { role: "system", content: system };
  if (Array.isArray(system))
    return { role: "system", content: system.filter((b) => b?.type === "text").map((b) => b.text).join("\n") };
  return null;
}

// Anthropic image block → OpenAI image_url 值。图片必须真的送达上游：
// 换成「[image omitted]」会让读图工具的结果变成一句空话，模型只能看到「我拿到了一张图」的占位符。
function imageSourceToUrl(source: any): string | null {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string" && source.data)
    return `data:${source.media_type ?? "image/png"};base64,${source.data}`;
  if (source.type === "url" && typeof source.url === "string" && source.url) return source.url;
  return null;
}

// 顶层图片与 tool_result 内嵌图片走同一条路径：能取到 URL 就发 image_url，
// 取不到才写占位文本（带上源类型，便于诊断是哪种未知 source）。
function imagePart(block: any): any {
  const url = imageSourceToUrl(block?.source);
  if (url) return { type: "image_url", image_url: { url } };
  const sourceType = block?.source && typeof block.source === "object" ? block.source.type ?? null : null;
  return `[image omitted: unsupported source ${JSON.stringify(sourceType)}]`;
}

// 一份 content 里的文本与图片按原顺序合并：纯文本压成字符串，含图片时用 parts 数组。
function joinParts(parts: any[]): any {
  if (!parts.some((p) => typeof p !== "string")) return parts.join("\n");
  const out: any[] = [];
  for (const p of parts) {
    if (typeof p !== "string") { out.push(p); continue; }
    const last = out.at(-1);
    if (last?.type === "text") last.text += (last.text ? "\n" : "") + p;
    else out.push({ type: "text", text: p });
  }
  return out;
}

function appendParts(target: any[], value: any): void {
  if (typeof value === "string") { if (value) target.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) appendParts(target, v); return; }
  if (value) target.push(value);
}

// 一次 Anthropic 消息 → 一到多条 OpenAI chat 消息。
//
// 同一轮里文本 + tool_use 必须仍是**一条** assistant 消息：拆成「文本消息 + 仅带 tool_calls 的
// 消息」会让上游把第二条当成预填（prefill），于是模型只学会了「先说一句要做，然后结束」。
function contentToOpenAi(role: string, content: any): any[] {
  if (typeof content === "string") return [{ role, content }];
  const textParts: any[] = [];
  const toolCalls: any[] = [];
  const results: any[] = [];
  let reasoning = "";
  for (const block of content ?? []) {
    switch (block?.type) {
      case "text": appendParts(textParts, block.text ?? ""); break;
      case "thinking":
        if (typeof block.thinking === "string") reasoning += block.thinking;
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id, type: "function",
          function: {
            name: block.name,
            arguments: typeof block.input?._raw === "string" ? block.input._raw : JSON.stringify(block.input ?? {}),
          },
        });
        break;
      case "tool_result": {
        const nested: any[] = [];
        if (typeof block.content === "string") nested.push(block.content);
        else for (const b of block.content ?? []) {
          if (b?.type === "text") nested.push(b.text ?? "");
          else if (b?.type === "image") nested.push(imagePart(b));
        }
        results.push({ role: "tool", tool_call_id: block.tool_use_id, content: joinParts(nested) });
        break;
      }
      case "image": {
        textParts.push(imagePart(block));
        break;
      }
      default: break;
    }
  }
  const out: any[] = [];
  const text = joinParts(textParts);
  if (role === "assistant") {
    const message: any = { role };
    if (text) message.content = text;
    // 用 `reasoning_content` 而不是 `reasoning`：两个上游的 SSE 与仓库自己的聚合层都用这个名字，
    // 换成别的拼写大概率被上游当成未知字段忽略，思考内容在回放里就白丢了。
    if (reasoning) message.reasoning_content = reasoning;
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (message.content !== undefined || message.tool_calls || message.reasoning_content) out.push(message);
    out.push(...results);
  } else {
    out.push(...results);
    if (text) out.push({ role, content: text });
  }
  return out;
}

// 一次工具调用没有对应的 tool_result 时补一条合成结果。
// 不补的话上游会看到「assistant 带 tool_calls 之后紧跟 user 文本」，多数后端直接 400，
// 或把整轮工具结果当作从未发生，模型于是重说一遍「我这就去做」。
const MISSING_TOOL_RESULT = "Tool result was not provided by the client; treat the call as failed and continue without its output.";

function anthropicThinkingToEffort(thinking: any): string | undefined {
  if (!thinking || typeof thinking !== "object") return undefined;
  const type = String(thinking.type ?? "").toLowerCase();
  if (type === "disabled" || type === "none" || type === "off") return "off";
  if (type !== "enabled" && type !== "adaptive") return undefined;
  const budget = typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : NaN;
  if (!Number.isFinite(budget)) return "high";
  if (budget <= 2048) return "minimal";
  if (budget <= 8192) return "medium";
  return "high";
}

// 工具调用与工具结果配对修复。两种破损在真实会话里都会出现：
//   - 悬空 tool_use：客户端中断/重试后，下一轮带着未完成的调用直接接 user 文本；
//   - 孤立 tool_result：历史被裁剪或客户端补发，找不到对应的 tool_call。
// 前者会让上游看到非法顺序，后者会以未知 tool_call_id 被拒，两者都表现为「模型忽然只说不做」。
function normalizeToolPairs(messages: any[]): any[] {
  const out: any[] = [];
  // 未闭合的调用按 id 配对（`lastIndexOf`：同一 id 被客户端重试重复提交时，配到最近的一次）。
  let open: string[] = [];
  const closeOpen = () => {
    for (const id of open) out.push({ role: "tool", tool_call_id: id, content: MISSING_TOOL_RESULT });
    open = [];
  };
  for (const m of messages) {
    // tool 消息无条件先处理：调用可能就在它前面一条，不能因为「上一条不是 assistant」而漏配。
    if (m.role === "tool") {
      const at = open.lastIndexOf(m.tool_call_id);
      if (at >= 0) { open.splice(at, 1); out.push(m); continue; }
      closeOpen();
      // 孤立结果降级为用户文本：直接发裸 tool 消息会被上游以未知 tool_call_id 拒绝，
      // 而它承载的内容往往是模型唯一拿得到的线索，不能整条丢掉。
      out.push({ role: "user", content: m.content });
      continue;
    }
    // 任何非 tool 消息打断未闭合的调用：assistant 插话意味着上一轮客户端没交回结果，
    // 不先补齐的话该调用会跨越一条 assistant 悬空，上游看到非法顺序。
    if (open.length) closeOpen();
    out.push(m);
    if (m.role === "assistant" && Array.isArray(m.tool_calls))
      for (const tc of m.tool_calls) if (tc?.id) open.push(tc.id);
  }
  closeOpen();
  return out;
}

// 末尾 user 轮被翻译成空时补回占位内容：以 assistant 结尾的请求会被上游当成预填，
// 直接续写上一句，而不是回答这一轮。
const EMPTY_USER_CONTENT = "(no content)";

function keepTrailingUserTurn(messages: any[], lastRole: string | undefined, lastTurnProduced: boolean): any[] {
  if (lastRole !== "user") return messages;
  const last = messages.at(-1);
  if (last && last.role === "user") return messages;
  // 末轮留下了工具结果：这是工具循环的合法中间态，不能再塞一条 user 文本打断它。
  if (last && last.role === "tool" && lastTurnProduced) return messages;
  return [...messages, { role: "user", content: EMPTY_USER_CONTENT }];
}

export function anthropicToOpenAi(body: any, caps: ProtocolCapabilities = {}): any {
  const messages: any[] = [];
  const sys = systemToMessage(body.system);
  if (sys) messages.push(sys);
  const turns = body.messages ?? [];
  let lastTurnProduced = false;
  for (const turn of turns) {
    const produced = contentToOpenAi(turn.role, turn.content);
    lastTurnProduced = produced.length > 0;
    messages.push(...produced);
  }
  const finalMessages = keepTrailingUserTurn(normalizeToolPairs(messages), turns.at(-1)?.role, lastTurnProduced);
  const out: any = { model: body.model, messages: finalMessages };
  const thinkingEffort =
    caps.thinkingToEffort === false ? undefined : anthropicThinkingToEffort(body.thinking);
  if (thinkingEffort) out.reasoning_effort = thinkingEffort;
  if (body.stream === true) out.stream = true;
  if (body.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools) && body.tools.length) {
    const mapped = body.tools
      .filter((t: any) => t?.type === "custom" || (!t?.type && t?.name))
      .map((t: any) => ({ type: "function", function: { name: t.name, description: t.description ?? "", parameters: t.input_schema ?? { type: "object" } } }));
    if (mapped.length) out.tools = mapped;
  }

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
  return pruneDanglingToolChoice(out);
}

// content_filter 不能映射成 end_turn：那等于告诉客户端「模型正常说完了」，
// Anthropic 侧有独立的 refusal，丢掉它会让被安全策略拦下的回答看起来像一次正常空响应。
const STOP_REASON: Record<string, string> = {
  stop: "end_turn", tool_calls: "tool_use", length: "max_tokens", content_filter: "refusal",
};

function anthropicUsage(usage: any, promptTokensIncludeCache = false): { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } {
  const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreation = usage?.prompt_tokens_details?.cache_creation_tokens ?? 0;
  const totalInput = usage?.prompt_tokens ?? 0;
  return {
    input_tokens: promptTokensIncludeCache ? Math.max(0, totalInput - cacheRead - cacheCreation) : totalInput,
    output_tokens: usage?.completion_tokens ?? 0,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

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
  // adaptive 也是要求思考：翻译层已经把它换成 reasoning_effort，这里不同样开启 thinking 块的话，
  // 上游的推理内容会被整段丢弃，客户端拿到的回答没有任何思考痕迹。
  const thinkingType = String(body.thinking?.type ?? "").toLowerCase();
  const thinking = caps.thinking !== false && (thinkingType === "enabled" || thinkingType === "adaptive");
  const model = body.model ?? undefined;

  if (body.stream !== true) {
    const resp = await safeRespond(backend, openaiBody, { stream: false, sessionKey, profile });
    if (!resp.ok) return await relayErrorIfNeeded(resp, caps);
    return Response.json(completionToAnthropic(await resp.json(), model, thinking, caps.promptTokensIncludeCache === true));
  }

  const resp = await safeRespond(backend, { ...openaiBody, stream: true }, { stream: true, sessionKey, profile });
  if (!resp.ok || !resp.body) return await relayErrorIfNeeded(resp, caps);
  const sse = await anthropicSse(resp.body, thinking, model, caps.promptTokensIncludeCache === true);
  return new Response(sse, {
    status: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });
}

async function relayErrorIfNeeded(resp: Response, caps: ProtocolCapabilities): Promise<Response> {
  if (caps.normalizeErrors === false && resp.headers.get(PROXY_ERROR_HEADER) !== "proxy") return resp;
  let message = `upstream ${resp.status}`;
  try {
    const j: any = await resp.clone().json();
    message = j?.error?.message ?? j?.message ?? message;
  } catch { /* ignore */ }
  return anthroError(resp.status, message, anthropicErrorTypeForStatus(resp.status));
}

function completionToAnthropic(c: any, model?: string, thinking = false, promptTokensIncludeCache = false): any {
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
    usage: anthropicUsage(usage, promptTokensIncludeCache),
  };
}

function safeParse(s: string | undefined): any {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

function anthroError(status: number, message: string, type = "invalid_request_error"): Response {
  return Response.json({ type: "error", error: { type, message } }, { status });
}

async function anthropicSse(upstream: ReadableStream<Uint8Array>, thinking: boolean, model?: string, promptTokensIncludeCache = false): Promise<ReadableStream<Uint8Array>> {
  const enc = new TextEncoder();
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  let outModel = model ?? "";
  let blockIdx = -1;
  let curBlock: "text" | "thinking" | "tool_use" | null = null;
  let outputTokens = 0;
  let promptTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  const toolCalls = new Map<number, { id: string; name: string }>();
  let stopReason: string | null = null;
  let sawChoice = false;

  const startBlock = (ctrl: ReadableStreamDefaultController, type: "text" | "thinking" | "tool_use", extra?: any) => {
    blockIdx += 1;
    curBlock = type;
    const start: any = {
      type: "content_block_start", index: blockIdx,
      content_block: { type, ...(type === "text" ? { text: "" } : type === "thinking" ? { thinking: "" } : { input: {}, ...extra }) },
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
          // 上游把错误塞进 200 的 SSE 时，帧里没有 choices。当成正常空回答收尾，
          // 客户端只会看到一次「什么都没说就 end_turn」，于是重试同一句话——这正是「只宣布不执行」的来源。
          const upstreamError = upstreamErrorFromChunk(chunk);
          if (upstreamError) throw new Error(`upstream error: ${upstreamError}`);
          if (chunk.usage) {
            if (chunk.usage.prompt_tokens !== undefined) promptTokens = chunk.usage.prompt_tokens;
            if (chunk.usage.completion_tokens !== undefined) outputTokens = chunk.usage.completion_tokens;
            if (chunk.usage.prompt_tokens_details?.cached_tokens !== undefined)
              cacheReadTokens = chunk.usage.prompt_tokens_details.cached_tokens;
            if (chunk.usage.prompt_tokens_details?.cache_creation_tokens !== undefined)
              cacheCreationTokens = chunk.usage.prompt_tokens_details.cache_creation_tokens;
            const parsed = anthropicUsage(
              { prompt_tokens: promptTokens, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cacheReadTokens, cache_creation_tokens: cacheCreationTokens } },
              promptTokensIncludeCache,
            );
            inputTokens = parsed.input_tokens;
          }
          const choice = chunk.choices?.[0];
          if (choice) sawChoice = true;
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
              startBlock(ctrl, "tool_use", { id: slot.id, name: slot.name });
            } else if (tc.function?.name && !slot.name) {
              slot.name = tc.function.name;
            }
            if (typeof tc.function?.arguments === "string" && tc.function.arguments)
              ev(ctrl, "content_block_delta", { type: "content_block_delta", index: blockIdx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
          }
          if (choice?.finish_reason) stopReason = STOP_REASON[choice.finish_reason] ?? "end_turn";
        }
        // 一个 choice 都没有的流不是「模型什么也没说」，而是上游没给出回答。
        // 报成 end_turn + 空 content 会让客户端把这次失败当成正常回合收下。
        // HTTP 200 的 SSE 头已经发出去了，这里只能用 error 事件（与 R43 一致）。
        if (!sawChoice) throw new Error(NO_CHOICES);
        stopBlock(ctrl);
        ev(ctrl, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason ?? "end_turn", stop_sequence: null },
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_read_input_tokens: cacheReadTokens,
            cache_creation_input_tokens: cacheCreationTokens,
          },
        });
        ev(ctrl, "message_stop", { type: "message_stop" });
      } catch (e: any) {
        const message = e?.message ?? String(e);
        // 上游错误文本里带着 400/429/超时等语义；流式已无法改 HTTP 状态，
        // 至少把 error type 选对，让客户端能区分限流与参数错。
        ev(ctrl, "error", { type: "error", error: { type: anthropicErrorTypeForMessage(message), message } });
      } finally {
        ctrl.close();
      }
    },
  });
}