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
    },
    completion_tokens_details: {
      reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    },
  };
}

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

export async function aggregateSseToCompletion(body: ReadableStream<Uint8Array>): Promise<any> {
  let id = "";
  let model = "";
  let created = 0;
  let finish: string | undefined;
  let usage: any;
  const slots = new Map<number, Slot>();

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
    if (chunk.usage) usage = chunk.usage;
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

  // 空流 / 只有错误事件的流不是成功响应
  if (slots.size === 0) throw new Error("no choices in upstream SSE");

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