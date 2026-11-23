// CodeBuddy 后端会拦截包含竞品客户端标识的 system 提示词。
// 实测：system 为 "You are Claude Code, Anthropic's official CLI for Claude." → 400
// {"error":{"message":"Request blocked. Please send it again"}}；替换为中性句后 200。
// 代理只替换这段 preamble，保留其余系统内容。
const COMPETITOR_PREAMBLE =
  /You\s+are\s+Claude\s+Code,\s+Anthropic['’]s\s+official\s+CLI\s+for\s+Claude\.?/gi;

// 客户端计费指纹（x-anthropic-billing-header: cc_version=...）同样会触发 400 拦截；
// 该行只用于客户端遥测，删除后不影响模型行为。
const BILLING_HEADER = /^[ \t]*x-anthropic-billing-header:.*(?:\r?\n|$)/gim;

// Codex CLI 的自述首句触发上游 400（code 11128 Request blocked）；实测整句精确匹配，
// 改动其中一处即通过。替换为新建 Codex 会话实际使用的短提示词。
const CODEX_PREAMBLE =
  /You are a coding agent running in the Codex CLI,\s*a terminal-based coding assistant\.\s*Codex CLI is an open source project led by OpenAI\.\s*You are expected to be precise, safe, and helpful\.?/gi;
const CODEX_PREAMBLE_REPLACEMENT =
  "You are Codex, a coding agent. You and the user share the same workspace and collaborate to achieve the user's goals.";

// Claude Code 的反馈链接行会触发上游 400（Request blocked）；整行删除。
// 实测：block 2 的最后一行 "- To give feedback, users should report the issue at
// https://github.com/anthropics/claude-code/issues" 单独发送即 400；其余行均 200。
const CLAUDE_CODE_FEEDBACK_LINE = /^.*github\.com\/anthropics\/claude-code.*(?:\r?\n|$)/gim;

export function sanitizeSystemText(text: string): string {
  // 只删已知指纹行，不改动其余文本（包括首尾空白）。
  return text
    .replace(COMPETITOR_PREAMBLE, "You are an AI coding assistant.")
    .replace(CODEX_PREAMBLE, CODEX_PREAMBLE_REPLACEMENT)
    .replace(BILLING_HEADER, "")
    .replace(CLAUDE_CODE_FEEDBACK_LINE, "");
}
