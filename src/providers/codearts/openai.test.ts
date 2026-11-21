import { test, expect, afterEach } from "bun:test";
import { OpenAIFacade } from "./openai";

const old = { ...process.env };
afterEach(() => {
  process.env = { ...old };
});

test("empty SSE on a non-stream request becomes 502", async () => {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://example.test";

  const snap = {
    chat: async () => new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  } as any;
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry);
  // 避免 HeartbeatManager 的 30s 定时器拖住测试进程
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };

  const resp = await facade.respond(
    { model: "m", messages: [{ role: "user", content: "hi" }] },
    false,
    "session",
  );
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.message).toContain("upstream_error");
});