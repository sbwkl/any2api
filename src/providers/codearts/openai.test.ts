import { test, expect, afterEach } from "bun:test";
import { OpenAIFacade } from "./openai";

const old = { ...process.env };
afterEach(() => {
  process.env = { ...old };
});

function makeFacade(chat: () => Promise<Response>): OpenAIFacade {
  process.env.CODEARTS_CLI_AK = "ak";
  process.env.CODEARTS_CLI_SK = "sk";
  process.env.SNAP_ORIGIN = "https://example.test";
  const snap = { chat } as any;
  const gw = { models: [{ modelId: "m", modelName: "M" }] } as any;
  const telemetry = { recordChat() {} } as any;
  const facade = new OpenAIFacade(snap, gw, telemetry);
  // 避免 HeartbeatManager 的 30s 定时器拖住测试进程
  (facade as any).heartbeats = { startBusy() {}, stopBusy() {} };
  return facade;
}

const body = { model: "m", messages: [{ role: "user", content: "hi" }] };

test("empty SSE on a non-stream request becomes 502", async () => {
  const facade = makeFacade(async () =>
    new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const resp = await facade.respond(body, false, "session");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.message).toContain("upstream_error");
  expect(j.error.type).toBe("upstream_error");
});

test("error-only SSE on a non-stream request becomes 502", async () => {
  const facade = makeFacade(async () =>
    new Response('data: {"error":{"message":"bad"}}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
  const resp = await facade.respond(body, false, "session2");
  expect(resp.status).toBe(502);
  const j: any = await resp.json();
  expect(j.error.type).toBe("upstream_error");
});