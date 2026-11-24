export type SelectionReason = "preference" | "fallback" | "heuristic" | "none";

export interface ModelSelection {
  model?: string;
  reason: SelectionReason;
}

const CHEAP_HINTS: Array<[string, number]> = [
  ["flash", 0],
  ["mini", 1],
  ["lite", 2],
  ["small", 3],
  ["turbo", 4],
];

function rank(id: string): number {
  const lower = id.toLowerCase();
  for (const [hint, score] of CHEAP_HINTS) if (lower.includes(hint)) return score;
  if (/pro|max|opus|ultra/.test(lower)) return 20;
  return 10;
}

// 精确匹配优先；其次容忍偏好里的括号后缀（如 "DeepSeek-v4.1-Flash(1017)" → deepseek-v4.1-flash-1017）。
function match(available: string[], wanted: string): string | undefined {
  const w = wanted.trim().toLowerCase();
  if (!w) return undefined;
  const base = w.replace(/\([^)]*\)\s*$/, "").trim();

  for (const id of available) if (id.toLowerCase() === w) return id;
  if (base && base !== w) for (const id of available) if (id.toLowerCase() === base) return id;
  for (const id of available) {
    const lower = id.toLowerCase();
    if (base && (lower === base || lower.startsWith(`${base}-`))) return id;
  }
  return undefined;
}

export function selectModel(available: string[], preference: string[], fallback?: string): ModelSelection {
  for (const pref of preference) {
    const hit = match(available, pref);
    if (hit) return { model: hit, reason: "preference" };
  }
  if (fallback) {
    const hit = match(available, fallback);
    if (hit) return { model: hit, reason: "fallback" };
  }
  if (available.length) {
    const sorted = [...available].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    return { model: sorted[0], reason: "heuristic" };
  }
  return { reason: "none" };
}
