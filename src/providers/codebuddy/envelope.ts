// OpenAI ↔ CodeBuddy 请求体映射 — 对应 RFC-0001 §5.5
import type { ModelInfo } from "./types";

export function normalizeMessages(messages: any[]): any[] {
  if (!Array.isArray(messages)) throw new Error("messages must be an array");
  return messages.map((m) => {
    if (!m || typeof m !== "object") throw new Error("invalid message");
    return m.role === "developer" ? { ...m, role: "system" } : m;
  });
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

export function buildRequestBody(opts: {
  model: ModelInfo;
  messages: any[];
  tools?: any[];
  toolChoice?: any;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  reasoningEffort?: string;
}): any {
  const body: any = { model: opts.model.id, messages: opts.messages, stream: true };
  if (opts.tools?.length) {
    body.tools = opts.tools;
    body.tool_choice = opts.toolChoice ?? "auto";
  }
  const cap = opts.model.maxOutputTokens ?? 128000;
  const requested = opts.maxTokens ?? opts.model.maxOutputTokens ?? 4096;
  const maxTokens = Math.max(1, Math.min(requested, cap));
  if (isMaxCompletionModel(opts.model.id)) body.max_completion_tokens = maxTokens;
  else body.max_tokens = maxTokens;

  const temperature = opts.temperature ?? opts.model.temperature;
  if (typeof temperature === "number") body.temperature = temperature;
  if (typeof opts.topP === "number") body.top_p = opts.topP;
  if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort;
  return body;
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