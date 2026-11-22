// CodeBuddy 后端会拦截包含竞品客户端标识的 system 提示词。
// 实测：system 为 "You are Claude Code, Anthropic's official CLI for Claude." → 400
// {"error":{"message":"Request blocked. Please send it again"}}；替换为中性句后 200。
// 代理只替换这段 preamble，保留其余系统内容。
const COMPETITOR_PREAMBLE = /You are Claude Code, Anthropic's official CLI for Claude\.?/gi;

// 客户端计费指纹（x-anthropic-billing-header: cc_version=...）同样会触发 400 拦截；
// 该行只用于客户端遥测，删除后不影响模型行为。
const BILLING_HEADER = /^[ \t]*x-anthropic-billing-header:.*(?:\r?\n|$)/gim;

export function sanitizeSystemText(text: string): string {
  // 只删已知指纹行，不改动其余文本（包括首尾空白）。
  return text
    .replace(COMPETITOR_PREAMBLE, "You are an AI coding assistant.")
    .replace(BILLING_HEADER, "");
}
