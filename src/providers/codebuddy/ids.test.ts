import { test, expect, describe } from "bun:test";
import { newId, SessionRegistry } from "./ids";

describe("ids", () => {
  test("newId is 32 lowercase hex", () => {
    for (let i = 0; i < 20; i++) {
      expect(newId()).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  test("conversationId is reused per session key", () => {
    const r = new SessionRegistry();
    const a = r.conversationFor("s1");
    const b = r.conversationFor("s1");
    const c = r.conversationFor("s2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });

  test("requestId changes on a new user message, reuses for tool results", () => {
    const r = new SessionRegistry();
    const cid = r.conversationFor("s1");
    const t1 = r.requestIdFor(cid, [{ role: "user", content: "hi" }]);
    expect(t1.newTurn).toBe(true);
    const t2 = r.requestIdFor(cid, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", tool_calls: [] },
      { role: "tool", content: "ok", tool_call_id: "x" },
    ]);
    expect(t2.newTurn).toBe(false);
    expect(t2.requestId).toBe(t1.requestId);
    const t3 = r.requestIdFor(cid, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "next" },
    ]);
    expect(t3.newTurn).toBe(true);
    expect(t3.requestId).not.toBe(t1.requestId);
  });
});