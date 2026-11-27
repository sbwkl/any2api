// CodeArts 状态级重试策略 — 档位判定、退避计算、单一预算扣减，与官方内核重试表对齐。
// 预算语义：一次入站请求一个总尝试计数器（含换密钥重发）；阈值与总尝试次数比较。

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
  const cls = retryClassForStatus(input.status);
  if (!cls) return null;
  const max = RETRY_LIMITS[cls];
  if (input.budget.attempts >= max) return null;
  return {
    cls,
    max,
    attempt: input.budget.attempts,
    delayMs: retryDelayMs(input.budget.attempts, input.headers, { now: input.now, random: input.random }),
  };
}

// 帧内错误只认结构化的错误码：模型正文里出现「429」「Busy」不算限流，
// 只有上游把错误塞进 HTTP 200 SSE 的错误帧（`error.code` / `error_code`）才进入判定。
const FRAME_BUSY_CODE = /(?:^|\.)ModelArts\.81101(?:\.|$)/;
const FRAME_RATE_LIMIT_CODE = /(?:^|\.)429(?:\.|$)/;

/** 帧内错误的档位：Busy（`ModelArts.81101`）与 429 归限流档，其它错误一律不可重试。 */
export function retryClassForFrameError(frame: { code?: string } | null | undefined): RetryClass | null {
  const code = frame?.code;
  if (typeof code !== "string" || code === "") return null;
  return FRAME_BUSY_CODE.test(code) || FRAME_RATE_LIMIT_CODE.test(code) ? "rate_limit" : null;
}

/** 帧内错误的重试计划：与状态级重试共用同一份预算，但上游没有可靠的 retry-after。 */
export function planFrameRetry(input: {
  budget: RetryBudget;
  frame: { code?: string } | null;
  now?: () => number;
  random?: () => number;
}): RetryPlan | null {
  const cls = retryClassForFrameError(input.frame);
  if (!cls) return null;
  const max = RETRY_LIMITS[cls];
  if (input.budget.attempts >= max) return null;
  return {
    cls,
    max,
    attempt: input.budget.attempts,
    delayMs: retryDelayMs(input.budget.attempts, undefined, { now: input.now, random: input.random }),
  };
}

function abortError(): Error {
  const err = new Error("client disconnected");
  err.name = "AbortError";
  return err;
}

/** 可被取消信号打断的等待；中止时以 AbortError 拒绝，调用方据此终止重试且不再消耗预算。 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
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