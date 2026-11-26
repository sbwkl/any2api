import { describe, expect, spyOn, test } from "bun:test";
import { serviceLogger } from "./log";

describe("serviceLogger", () => {
  test("prefixes each service log line with an ISO UTC timestamp", () => {
    const calls: unknown[][] = [];
    const logMock = spyOn(console, "log").mockImplementation((...args) => { calls.push(args); });
    try {
      serviceLogger.log("[demo] ready");
    } finally {
      logMock.mockRestore();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(calls[0].slice(1)).toEqual(["[demo] ready"]);
  });

  test("prefixes warn and error with the same ISO UTC shape", () => {
    const warnCalls: unknown[][] = [];
    const errorCalls: unknown[][] = [];
    const warnMock = spyOn(console, "warn").mockImplementation((...args) => { warnCalls.push(args); });
    const errorMock = spyOn(console, "error").mockImplementation((...args) => { errorCalls.push(args); });
    try {
      serviceLogger.warn("[demo] warn");
      serviceLogger.error("[demo] error");
    } finally {
      warnMock.mockRestore();
      errorMock.mockRestore();
    }

    expect(warnCalls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(errorCalls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(warnCalls[0].slice(1)).toEqual(["[demo] warn"]);
    expect(errorCalls[0].slice(1)).toEqual(["[demo] error"]);
  });
});
