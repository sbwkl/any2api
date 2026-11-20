// opencode 实体 ID 生成器 — 按 spec §4.1 逐字还原
import { randomBytes, randomUUID } from "crypto";

const PREFIX: Record<string, string> = {
  event: "evt", session: "ses", message: "msg", permission: "per", question: "que",
  user: "usr", part: "prt", pty: "pty", tool: "tool", workspace: "wrk",
};

let lastMs = 0;
let counter = 0n;

export function createId(kind: keyof typeof PREFIX | string): string {
  const prefix = PREFIX[kind] ?? kind;
  const ms = Date.now();
  if (ms === lastMs) counter += 1n;
  else { lastMs = ms; counter = 0n; }
  const o = BigInt(ms) * 4096n + counter;
  const hex12 = o.toString(16).slice(-12);
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const rand = randomBytes(14);
  let rand14 = "";
  for (let i = 0; i < 14; i++) rand14 += alphabet[rand[i] % 62];
  return `${prefix}_${hex12}${rand14}`;
}

// uuid 无连字符 32hex（x-ot-trace-id / x-snap-traceid 基值 / OTLP prompt_id）
export function uuid32(): string {
  return randomUUID().replace(/-/g, "");
}

// 16 hex 小写（span / snap 后缀）
export function rand16hex(): string {
  return randomBytes(8).toString("hex");
}
