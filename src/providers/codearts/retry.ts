// CodeArts 状态级重试策略 — 档位判定、退避计算、单一预算扣减，与官方内核重试表对齐。
// 预算语义：一次入站请求一个总尝试计数器（含换密钥重发）；阈值与总尝试次数比较。
import { serviceLogger } from "../../shared/log";

export type RetryClass = "rate_limit" | "gateway" | "server";

const RETRY_LIMITS: Record<RetryClass, number> = {
  rate_limit: 10, // 429 / 406
  gateway: 10, // 502
  server: 3, // 500 / 503 / 504 / 407
};

export interface RetryBudget {
  /** 本次入站请求已发出的上游 chat 尝试数（跨层共享） */
  attempts: number;
}

export function createRetryBudget(): RetryBudget {
  return { attempts: 0 };
}

export function retryClassForStatus(status: number): RetryClass | null {
  if (status === 429 || status === 406) return "rate_limit";
  if (status === 502) return "gateway";
  if (status === 500 || status === 503 || status === 504 || status === 407) return "server";
  return null;
}

export interface RetryPlan {
  cls: RetryClass;
  /** 该类别的总尝试次数上限 */
  max: number;
  /** 刚完成的那次尝试在总预算中的序号 */
  attempt: number;
  /** 下一次尝试前的等待时长 */
  delayMs: number;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;
const MAX_RETRY_AFTER_MS = 30000;
const JITTER_MAX_MS = 200;

/** 优先尊重上游的 retry-after-ms / retry-after（秒或 HTTP-date）；不可用时返回 null。 */
export function retryAfterMs(headers: Headers | undefined, now: () => number = Date.now): number | null {
  if (!headers) return null;
  const ms = headers.get("retry-after-ms");
  if (ms !== null) {
    const n = Number(ms);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  const after = headers.get("retry-after");
  if (after !== null) {
    const raw = after.trim();
    if (raw !== "") {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n * 1000;
      const date = Date.parse(raw);
      if (!Number.isNaN(date)) return Math.max(0, date - now());
    }
  }
  return null;
}

/** 指数退避：500ms ×2，单次上限 5s，再叠加 0-200ms jitter；上游 hint 优先并钳制在 30s。 */
export function retryDelayMs(
  attemptsMade: number,
  headers?: Headers,
  opts: { now?: () => number; random?: () => number } = {},
): number {
  const hinted = retryAfterMs(headers, opts.now ?? Date.now);
  if (hinted !== null) return Math.min(hinted, MAX_RETRY_AFTER_MS);
  const exponential = Math.min(BASE_DELAY_MS * 2 ** Math.max(0, attemptsMade - 1), MAX_DELAY_MS);
  const jitter = Math.floor((opts.random ?? Math.random)() * (JITTER_MAX_MS + 1));
  return exponential + jitter;
}

/** 从档位判定到重试计划：状态级与帧内错误共用同一份预算与上限语义。 */
function planForClass(
  cls: RetryClass | null,
  budget: RetryBudget,
  headers: Headers | undefined,
  opts: { now?: () => number; random?: () => number },
): RetryPlan | null {
  if (!cls) return null;
  const max = RETRY_LIMITS[cls];
  if (budget.attempts >= max) return null;
  return {
    cls,
    max,
    attempt: budget.attempts,
    delayMs: retryDelayMs(budget.attempts, headers, opts),
  };
}

/**
 * 判定一次失败是否值得重试。budget.attempts 是「已发出的尝试数」，
 * 因此 attempts >= max 表示总次数已用尽，不得再重试。
 */
export function planRetry(input: {
  budget: RetryBudget;
  status: number;
  headers?: Headers;
  now?: () => number;
  random?: () => number;
}): RetryPlan | null {
  return planForClass(retryClassForStatus(input.status), input.budget, input.headers, {
    now: input.now,
    random: input.random,
  });
}

// 帧内错误只认结构化的错误码：模型正文里出现「429」「Busy」不算限流，
// 只有上游把错误塞进 HTTP 200 SSE 的错误帧（`error.code` / `error_code`）才进入判定。
// `APIG.0308` 来自 HTTP 429 的实测观测，帧内形态尚无真实样本（执行计划 §5.4 待验证）。
const FRAME_BUSY_CODE = /(?:^|\.)ModelArts\.81101(?:\.|$)/;
const FRAME_RATE_LIMIT_CODE = /(?:^|\.)429(?:\.|$)/;
const FRAME_APIG_RATE_LIMIT_CODE = /(?:^|\.)APIG\.0308(?:\.|$)/;

/** 帧内错误的档位：Busy（`ModelArts.81101`）与限流码（独立 `.429` 段 / `APIG.0308`）归限流档，其它错误一律不可重试。 */
export function retryClassForFrameError(frame: { code?: string } | null | undefined): RetryClass | null {
  const code = frame?.code;
  if (typeof code !== "string" || code === "") return null;
  return FRAME_BUSY_CODE.test(code) || FRAME_RATE_LIMIT_CODE.test(code) || FRAME_APIG_RATE_LIMIT_CODE.test(code)
    ? "rate_limit"
    : null;
}

/** 帧内错误的重试计划：与状态级重试共用同一份预算，但上游没有可靠的 retry-after。 */
export function planFrameRetry(input: {
  budget: RetryBudget;
  frame: { code?: string } | null;
  now?: () => number;
  random?: () => number;
}): RetryPlan | null {
  return planForClass(retryClassForFrameError(input.frame), input.budget, undefined, {
    now: input.now,
    random: input.random,
  });
}

/** 客户端取消是终止信号而不是网络故障：重试链、加密客户端与门面共用同一个错误形状。 */
export function clientAbortError(): Error {
  const err = new Error("client disconnected");
  err.name = "AbortError";
  return err;
}

/** 可被取消信号打断的等待；中止时以 AbortError 拒绝，调用方据此终止重试且不再消耗预算。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(clientAbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(clientAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 可注入的时序依赖：单测用假 sleep / now / random 消除真实等待。 */
export interface RetryRuntime {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  random: () => number;
}

export function createRetryRuntime(partial: Partial<RetryRuntime> = {}): RetryRuntime {
  return { sleep, now: () => Date.now(), random: () => Math.random(), ...partial };
}

// 重试日志只有一个前缀与一套字段：类别、attempt/max、delay。
// 状态级（SnapClient）与帧内（门面）重试走同一格式，避免 [snap] / [openai] 两套前缀。
const RETRY_LOG_PREFIX = "[codearts]";

export function retryLogLine(plan: RetryPlan, detail?: string): string {
  return `${RETRY_LOG_PREFIX} 重试 class=${plan.cls} attempt=${plan.attempt}/${plan.max} delay=${plan.delayMs}ms${detail ? ` ${detail}` : ""}`;
}

/** 换密钥重发不是瞬时重试档位：沿用同一日志格式，类别记 `key_expired`。 */
export function logKeyExpiredResend(attempt: number): void {
  serviceLogger.warn(`${RETRY_LOG_PREFIX} 重试 class=key_expired attempt=${attempt} max=- delay=0ms（换密钥重发）`);
}

/** 共享的重试执行尾段：记日志 → 可取消等待。取消语义由调用方决定（抛错或返回 499）。 */
export async function waitForRetry(
  plan: RetryPlan,
  runtime: RetryRuntime,
  signal?: AbortSignal,
  detail?: string,
): Promise<void> {
  serviceLogger.warn(retryLogLine(plan, detail));
  await runtime.sleep(plan.delayMs, signal);
}