// 通用 SSE 解析与 OpenAI chat.completion 聚合 — codearts / codebuddy 共享
// 上游事件是标准 OpenAI chunk；同时兼容 delta 与 message 两种帧形态。

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "").trim();
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    const tail = buf.trim();
    if (tail.startsWith("data:")) yield tail.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

export function mapUsage(usage: any): any | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  return {
    prompt_tokens: usage.prompt_tokens ?? 0,
    completion_tokens: usage.completion_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
    prompt_tokens_details: {
      cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      cache_creation_tokens: usage.prompt_tokens_details?.cache_creation_tokens ?? 0,
    },
    completion_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

// 上游可能把错误塞进 HTTP 200 的 SSE（codearts 实测：`{"text":"[DONE]","error_code":"InferHub.…","error_msg":"…"}`）。
// 这种帧没有 choices；若当作空回答处理，客户端会看到一次「什么都没发」的正常结束。
// 判定从严：只认明确带错误字段的形态，避免把上游的心跳/计数帧当成错误。
export function upstreamErrorFromChunk(chunk: any): string | null {
  if (!chunk || typeof chunk !== "object") return null;
  if (Array.isArray(chunk.choices) && chunk.choices.length > 0) return null;
  if (chunk.error && typeof chunk.error === "object") {
    const msg = chunk.error.message ?? chunk.error.msg;
    if (chunk.error.code !== undefined || msg !== undefined)
      return `${chunk.error.code ?? "error"}${msg ? `: ${msg}` : ""}`;
  }
  if (chunk.error_code !== undefined || chunk.error_msg !== undefined)
    return `${chunk.error_code ?? "error"}${chunk.error_msg ? `: ${chunk.error_msg}` : ""}`;
  return null;
}

// 空流与「只有错误帧」的流都归到同一条报错，但把上游原话带出去——
// 通用的一句「no choices」会让调用方查不到任何线索。
export const NO_CHOICES = "no choices in upstream SSE";

export function mapFinishReason(reason: any): string {
  if (reason === "content-filter" || reason === "content_filter") return "content_filter";
  if (reason === "tool_calls" || reason === "function_call" || reason === "tool_call") return "tool_calls";
  if (reason === "stop" || reason === "length" || reason === "content_filter") return reason;
  return reason || "stop";
}

interface Slot {
  content: string;
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
}

// 上游可能把 usage 拆到多帧（codebuddy 实测：prompt 分项与 completion 分项分两帧），
// 归并时按字段合并，不能后帧整体覆盖前帧。
function mergeUsage(prev: any, next: any): any {
  if (!prev) return { ...next };
  const merged: any = { ...prev };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (value === undefined) continue;
    if (key === "prompt_tokens_details" || key === "completion_tokens_details") {
      merged[key] = { ...(merged[key] ?? {}), ...(value as any) };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// OpenAI 规定 include_usage 的 usage 块必须带空 choices；两家的上游都做不到：
// codebuddy 把 usage 挂在最后一个带 finish_reason 的 chunk 上，严格按官方语义解析 usage 的
// SDK 会把这次 usage 连同该 chunk 的增量重复计数。流式透传统一改成「正文块 usage=null，
// 末尾单独一个 choices:[] 的 usage 块」，已合规的上游（codearts）同样收敛成一个 usage 块。
export function normalizeChatSseUsage(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const write = (data: string) => ctrl.enqueue(enc.encode(`data: ${data}\n\n`));
      let meta: { id?: string; model?: string; created?: number } = {};
      let usage: any = null;
      try {
        for await (const data of sseData(body)) {
          if (!data) continue;
          if (data === "[DONE]") break;
          let chunk: any;
          try {
            chunk = JSON.parse(data);
          } catch {
            write(data);
            continue;
          }
          if (typeof chunk?.id === "string") meta.id = chunk.id;
          if (typeof chunk?.model === "string") meta.model = chunk.model;
          if (typeof chunk?.created === "number") meta.created = chunk.created;
          if (chunk?.usage) {
            usage = mergeUsage(usage, chunk.usage);
            const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
            if (choices.length === 0) continue;
            write(JSON.stringify({ ...chunk, usage: null }));
            continue;
          }
          write(data);
        }
        if (usage) {
          write(JSON.stringify({
            id: meta.id ?? `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: meta.created ?? Math.floor(Date.now() / 1000),
            model: meta.model ?? "",
            choices: [],
            usage,
          }));
        }
        write("[DONE]");
      } catch (e) {
        ctrl.error(e);
        return;
      }
      ctrl.close();
    },
  });
}

export async function aggregateSseToCompletion(body: ReadableStream<Uint8Array>): Promise<any> {
  let id = "";
  let model = "";
  let created = 0;
  let finish: string | undefined;
  let usage: any;
  const slots = new Map<number, Slot>();
  let upstreamError: string | null = null;

  for await (const data of sseData(body)) {
    if (!data || data === "[DONE]") continue;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (!id && chunk.id) id = chunk.id;
    if (!model && chunk.model) model = chunk.model;
    if (!created && chunk.created) created = chunk.created;
    upstreamError ??= upstreamErrorFromChunk(chunk);
    if (chunk.usage) {
      const prev = usage ?? {};
      usage = {
        prompt_tokens: chunk.usage.prompt_tokens ?? prev.prompt_tokens,
        completion_tokens: chunk.usage.completion_tokens ?? prev.completion_tokens,
        total_tokens: chunk.usage.total_tokens ?? prev.total_tokens,
        prompt_tokens_details: {
          cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? prev.prompt_tokens_details?.cached_tokens,
          cache_creation_tokens: chunk.usage.prompt_tokens_details?.cache_creation_tokens ?? prev.prompt_tokens_details?.cache_creation_tokens,
        },
        completion_tokens_details: {
          reasoning_tokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? prev.completion_tokens_details?.reasoning_tokens,
        },
      };
    }
    for (const c of chunk.choices ?? []) {
      const idx = c.index ?? 0;
      const slot = slots.get(idx) ?? { content: "", reasoning: "", toolCalls: new Map() };
      const d = c.delta ?? c.message ?? {};
      if (typeof d.content === "string") slot.content += d.content;
      if (typeof d.reasoning_content === "string") slot.reasoning += d.reasoning_content;
      else if (typeof d.reasoning === "string") slot.reasoning += d.reasoning;
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) {
          const ti = tc.index ?? 0;
          const cur = slot.toolCalls.get(ti) ?? { id: "", name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
          slot.toolCalls.set(ti, cur);
        }
      }
      if (c.finish_reason) finish = c.finish_reason;
      slots.set(idx, slot);
    }
  }

  // 空流 / 只有错误事件的流不是成功响应。错误帧优先：它比通用文案更能说明发生了什么。
  if (slots.size === 0) throw new Error(upstreamError ? `${NO_CHOICES}: ${upstreamError}` : NO_CHOICES);

  const choices = [...slots.keys()].sort((a, b) => a - b).map((idx) => {
    const s = slots.get(idx)!;
    const message: any = { role: "assistant", content: s.content };
    if (s.reasoning) message.reasoning_content = s.reasoning;
    const toolCalls = [...s.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc], i) => ({
        id: tc.id || `call_${idx}_${i}`,
        type: "function",
        function: { name: tc.name, arguments: tc.args || "{}" },
      }));
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { index: idx, message, finish_reason: mapFinishReason(finish) };
  });

  return {
    id: id || `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: created || Math.floor(Date.now() / 1000),
    model,
    choices,
    usage: mapUsage(usage),
  };
}