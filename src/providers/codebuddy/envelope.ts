// OpenAI ↔ CodeBuddy 请求体映射 — 对应 RFC-0001 §5.5
import type { ModelInfo } from "./types";
import { sanitizeSystemText } from "../../shared/system";

function isTextBlock(block: any): boolean {
  return !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string";
}

function isEmptyText(text: string): boolean {
  return text.trim() === "";
}

// 清洗前是否有内容：空串/纯空白/空数组都算没有。
function hasContent(content: any): boolean {
  if (typeof content === "string") return !isEmptyText(content);
  if (Array.isArray(content)) return content.length > 0;
  return content !== undefined && content !== null;
}

function sanitizeSystemContent(content: any): any {
  if (typeof content === "string") return sanitizeSystemText(content);
  if (Array.isArray(content)) {
    const out: any[] = [];
    for (const block of content) {
      if (!isTextBlock(block)) {
        out.push(block);
        continue;
      }
      const text = sanitizeSystemText(block.text);
      // 只丢弃「清洗前非空、清洗后变空」的块；本来就空的块原样保留
      if (isEmptyText(text) && !isEmptyText(block.text)) continue;
      out.push({ ...block, text });
    }
    return out;
  }
  return content;
}

export function normalizeMessages(messages: any[]): any[] {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  return messages
    .filter((m) => {
      if (!m || typeof m !== "object") throw new Error("invalid message");
      // tool 消息（role=tool 或带 tool_call_id）始终保留，空内容归一为 ""
      const isToolMessage = m.role === "tool" || m.tool_call_id !== undefined;
      const hasBody =
        m.content !== undefined &&
        m.content !== null &&
        !(Array.isArray(m.content) && m.content.length === 0);
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
      return isToolMessage || hasBody || hasToolCalls;
    })
    .map((m) => {
      const isToolMessage = m.role === "tool" || m.tool_call_id !== undefined;
      if (isToolMessage) {
        const empty =
          m.content === undefined ||
          m.content === null ||
          (Array.isArray(m.content) && m.content.length === 0);
        return empty ? { ...m, content: "" } : m;
      }
      if (m.role === "developer" || m.role === "system") {
        const content = sanitizeSystemContent(m.content);
        // 只丢弃「清洗前有内容、清洗后为空」的消息；其他 system 内容保持不变
        const emptied = hasContent(m.content) && !hasContent(content);
        return emptied ? null : { ...m, role: "system", content };
      }
      return m;
    })
    .filter((m) => m !== null);
}

// 有 agent 提示词时放在最前面；客户端自带 system 消息保留（API 用户依赖它）。
export function mergeAgentPrompt(messages: any[], agentPrompt?: string): any[] {
  if (!agentPrompt) return messages;
  return [{ role: "system", content: agentPrompt }, ...messages];
}

export function mapTools(tools: any): any[] | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const out: any[] = [];
  for (const t of tools) {
    if (t?.type !== "function" || !t.function?.name) continue;
    out.push({
      type: "function",
      function: {
        name: t.function.name,
        description: t.function.description ?? "",
        parameters: t.function.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out.length ? out : undefined;
}

function isMaxCompletionModel(modelId: string): boolean {
  return /^(gpt-5|o1|o3|o4|gpt-4\.1)/i.test(modelId);
}

const EFFORT_RANK: Record<string, number> = {
  none: 0, off: 0, no_think: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 5,
};

function pickEffort(requested: string, supported?: string[]): string {
  if (!supported?.length) {
    return requested === "off" || requested === "none" || requested === "no_think" ? "low" : requested;
  }
  const exact = supported.find((s) => s.toLowerCase() === requested.toLowerCase());
  if (exact) return exact;
  const rank = EFFORT_RANK[requested.toLowerCase()];
  if (rank === undefined) return supported[0];
  let best = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const s of supported) {
    const r = EFFORT_RANK[s.toLowerCase()];
    if (r === undefined) continue;
    const distance = Math.abs(r - rank);
    if (distance < bestDistance || (distance === bestDistance && r > (EFFORT_RANK[best.toLowerCase()] ?? -1))) {
      best = s;
      bestDistance = distance;
    }
  }
  return best;
}

export function buildRequestBody(opts: {
  model: ModelInfo;
  messages: any[];
  tools?: any[];
  toolChoice?: any;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
  frequencyPenalty?: number;
  presencePenalty?: number;
  stop?: any;
  seed?: number;
  responseFormat?: any;
  parallelToolCalls?: boolean;
  streamOptions?: any;
  metadata?: any;
  store?: boolean;
  user?: any;
  serviceTier?: string;
  maxCompletionTokens?: number;
}): any {
  const body: any = { model: opts.model.id, messages: opts.messages, stream: true };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  const cap = opts.model.maxOutputTokens ?? 128000;
  const requested = opts.maxTokens ?? opts.model.maxOutputTokens ?? 4096;
  const maxTokens = Math.max(1, Math.min(requested, cap));
  // max_tokens 与 max_completion_tokens 互斥：客户端给了 max_completion_tokens 就不再写 max_tokens。
  if (opts.maxCompletionTokens !== undefined) {
    body.max_completion_tokens = opts.maxCompletionTokens;
  } else if (isMaxCompletionModel(opts.model.id)) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  const temperature = opts.temperature ?? opts.model.temperature;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof opts.topP === "number") body.top_p = opts.topP;
  if (opts.reasoningEffort) body.reasoning_effort = pickEffort(opts.reasoningEffort, opts.model.supportedEfforts);
  if (opts.frequencyPenalty !== undefined) body.frequency_penalty = opts.frequencyPenalty;
  if (opts.presencePenalty !== undefined) body.presence_penalty = opts.presencePenalty;
  if (opts.stop !== undefined) body.stop = opts.stop;
  if (opts.seed !== undefined) body.seed = opts.seed;
  if (opts.responseFormat !== undefined) body.response_format = opts.responseFormat;
  if (opts.parallelToolCalls !== undefined) body.parallel_tool_calls = opts.parallelToolCalls;
  if (opts.streamOptions !== undefined) body.stream_options = opts.streamOptions;
  if (opts.metadata !== undefined) body.metadata = opts.metadata;
  if (opts.store !== undefined) body.store = opts.store;
  if (opts.user !== undefined) body.user = opts.user;
  if (opts.serviceTier !== undefined) body.service_tier = opts.serviceTier;
  return body;
}

export { mapUsage, mapFinishReason } from "../../shared/sse";