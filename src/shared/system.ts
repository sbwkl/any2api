// CodeBuddy 后端会拦截包含竞品客户端标识的 system 提示词。
// 实测：system 为 "You are Claude Code, Anthropic's official CLI for Claude." → 400
// {"error":{"message":"Request blocked. Please send it again"}}；替换为中性句后 200。
// 代理只替换这段 preamble，保留其余系统内容。
const COMPETITOR_PREAMBLE = /You are Claude Code, Anthropic's official CLI for Claude\.?/gi;

export function sanitizeSystemText(text: string): string {
  return text.replace(COMPETITOR_PREAMBLE, "You are an AI coding assistant.");
}