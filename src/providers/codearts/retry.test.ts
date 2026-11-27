import { describe, expect, test } from "bun:test";
import { createRetryBudget, planFrameRetry, planRetry, retryClassForFrameError, retryClassForStatus, sleep } from "./retry";

describe("state-level retry classes", () => {
  test("429 / 406 and 502 use the long ladder; 500 / 503 / 504 / 407 use the short one", () => {
    expect(retryClassForStatus(429)).toBe("rate_limit");
    expect(retryClassForStatus(406)).toBe("rate_limit");
    expect(retryClassForStatus(502)).toBe("gateway");
    expect(retryClassForStatus(500)).toBe("server");
    expect(retryClassForStatus(503)).toBe("server");
    expect(retryClassForStatus(504)).toBe("server");
    expect(retryClassForStatus(407)).toBe("server");
    for (const status of [400, 401, 403, 404, 405, 408, 409, 415, 505, 529]) {
      expect(retryClassForStatus(status)).toBeNull();
    }
  });

  test("the total attempt count decides the shared budget, including mixed classes", () => {
    const budget = createRetryBudget();
    expect(budget.attempts).toBe(0);

    budget.attempts = 1;
    expect(planRetry({ budget, status: 429 })?.max).toBe(10);
    budget.attempts = 9;
    expect(planRetry({ budget, status: 429 })).not.toBeNull();
    budget.attempts = 10;
    expect(planRetry({ budget, status: 429 })).toBeNull();

    budget.attempts = 2;
    expect(planRetry({ budget, status: 503 })?.max).toBe(3);
    budget.attempts = 3;
    expect(planRetry({ budget, status: 503 })).toBeNull();

    // 429 已用掉 6 次总尝试后再遇 503：总次数 6 ≥ 3，短阶梯不再重试；
    // 同一总次数仍在 429 的长阶梯内（阈值与总尝试次数比较，而不是每类各计各的）。
    budget.attempts = 6;
    expect(planRetry({ budget, status: 503 })).toBeNull();
    expect(planRetry({ budget, status: 429 })).not.toBeNull();
    expect(planRetry({ budget, status: 502 })).not.toBeNull();
  });

  test("statuses outside the retry table are never retried", () => {
    const budget = createRetryBudget();
    for (const status of [400, 401, 404, 408, 415, 505]) {
      expect(planRetry({ budget, status })).toBeNull();
    }
  });
});

describe("embedded frame errors", () => {
  test("only structured Busy / 429 error codes map to the rate-limit tier", () => {
    // 上游把限流塞进 HTTP 200 SSE 的形态（error.code / error_code 结构化错误码）：
    // Busy = ModelArts.81101；429 以内嵌状态段出现。
    expect(retryClassForFrameError({ code: "ModelArts.81101" })).toBe("rate_limit");
    expect(retryClassForFrameError({ code: "InferHub.ModelArts.81101" })).toBe("rate_limit");
    expect(retryClassForFrameError({ code: "InferHub.ModelArts.81101.429" })).toBe("rate_limit");
    expect(retryClassForFrameError({ code: "InferHub.Some.429" })).toBe("rate_limit");
    // HTTP 429 观测到的 APIG.0308 同样是限流信号（结构化 `error.code` / 顶层 `error_code`）；
    // 尚无真实帧内 429 样本，见执行计划 §5.4「待验证」。
    expect(retryClassForFrameError({ code: "APIG.0308" })).toBe("rate_limit");
    expect(retryClassForFrameError({ code: "InferHub.APIG.0308" })).toBe("rate_limit");
    // 非限流错误码、缺失错误码、相似但不同的错误码都不重试。
    expect(retryClassForFrameError({ code: "InferHub.001001005.400" })).toBeNull();
    expect(retryClassForFrameError({ code: "ModelArts.81102" })).toBeNull();
    expect(retryClassForFrameError({ code: "InferHub.1429" })).toBeNull();
    expect(retryClassForFrameError({})).toBeNull();
    expect(retryClassForFrameError(null)).toBeNull();
  });

  test("frame retries share the rate-limit cap with status-level retries", () => {
    const budget = createRetryBudget();
    budget.attempts = 9;
    // 指数分量在 9 次后已封顶 5s；random=()=>0 消除 jitter。
    expect(planFrameRetry({ budget, frame: { code: "ModelArts.81101" }, random: () => 0 })?.delayMs).toBe(5000);
    budget.attempts = 10;
    expect(planFrameRetry({ budget, frame: { code: "ModelArts.81101" } })).toBeNull();
    // 非限流帧即使预算充裕也不产生重试计划。
    budget.attempts = 1;
    expect(planFrameRetry({ budget, frame: { code: "InferHub.001001005.400" } })).toBeNull();
  });
});

describe("backoff", () => {
  function delayAfter(attemptsMade: number, headers?: Headers, random: () => number = () => 0) {
    return planRetry({ budget: { attempts: attemptsMade }, status: 429, headers, random })!.delayMs;
  }

  test("exponential 500ms x2, capped at 5s, plus 0-200ms jitter", () => {
    // 期望值来自 spec：基数 500ms、倍率 2、单次上限 5s。
    expect([1, 2, 3, 4, 5, 6, 7].map((attempts) => delayAfter(attempts))).toEqual([
      500, 1000, 2000, 4000, 5000, 5000, 5000,
    ]);
    // jitter 上界：random 接近 1 时最多 +200ms。
    expect(delayAfter(1, undefined, () => 1 - Number.EPSILON)).toBe(700);
    // jitter 始终落在 0-200ms，不改变指数分量。
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const delay = delayAfter(2, undefined, () => r);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1200);
    }
  });

  test("retry-after / retry-after-ms override backoff and clamp at 30s", () => {
    const h = (entries: Record<string, string>) => new Headers(entries);
    expect(delayAfter(1, h({ "retry-after": "2" }))).toBe(2000);
    expect(delayAfter(1, h({ "retry-after-ms": "1500" }))).toBe(1500);
    // retry-after-ms 优先于 retry-after
    expect(delayAfter(1, h({ "retry-after": "9", "retry-after-ms": "1200" }))).toBe(1200);
    // 单次等待钳制在 30s
    expect(delayAfter(1, h({ "retry-after": "60" }))).toBe(30000);
    expect(delayAfter(1, h({ "retry-after-ms": "45000" }))).toBe(30000);
    // HTTP-date 形态按注入的 now 计算
    const now = () => Date.parse("2026-11-27T00:00:00Z");
    expect(
      planRetry({
        budget: { attempts: 1 },
        status: 429,
        headers: h({ "retry-after": "Fri, 27 Nov 2026 00:00:02 GMT" }),
        now,
      })!.delayMs,
    ).toBe(2000);
    // 不可解析 / 负数回落到指数退避
    expect(delayAfter(1, h({ "retry-after": "soon" }))).toBe(500);
    expect(delayAfter(1, h({ "retry-after-ms": "-5" }))).toBe(500);
  });
});

describe("cancellable backoff wait", () => {
  test("an already-aborted signal rejects without waiting", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(60_000, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  test("abort interrupts an in-flight wait", async () => {
    const controller = new AbortController();
    const pending = sleep(60_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});