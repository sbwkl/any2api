import { test, expect, describe } from "bun:test";
import { buildResponsesToolMap, handleResponses, responsesToOpenAi } from "./responses";
import type { ChatBackend } from "./types";

const namespaceTools = [
  { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
  {
    type: "namespace",
    name: "mcp__codex_app",
    description: "app tools",
    tools: [
      { type: "function", name: "automation_update", description: "update", parameters: { type: "object", properties: { x: { type: "string" } } } },
      { type: "function", name: "automation_delete", description: "delete", parameters: { type: "object" } },
    ],
  },
];

const UPSTREAM_AUTOMATION = "mcp__codex_app__automation_update";

function respReq(body: any): Request {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function backend(respond: ChatBackend["respond"], seen?: { body?: any }): ChatBackend {
  return {
    models: () => [],
    health: () => ({ ok: true }),
    handleChat: () => new Response(""),
    respond: async (body, opts) => {
      if (seen) seen.body = body;
      return respond(body, opts);
    },
  };
}

describe("Responses namespace tools", () => {
  test("namespace members are flattened into upstream function tools", () => {
    const map = buildResponsesToolMap(namespaceTools);
    const out = responsesToOpenAi({ model: "m", input: "hi", tools: namespaceTools }, {}, map);

    expect(out.tools.map((t: any) => t.function.name)).toEqual([
      "exec_command",
      UPSTREAM_AUTOMATION,
      "mcp__codex_app__automation_delete",
    ]);
    // 参数 schema 与描述原样保留
    expect(out.tools[1].function.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(map.resolve(UPSTREAM_AUTOMATION)).toEqual({ name: "automation_update", namespace: "mcp__codex_app" });
  });

  test("input function_call items use the same flattened name", () => {
    const map = buildResponsesToolMap(namespaceTools);
    const out = responsesToOpenAi({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "automation_update", namespace: "mcp__codex_app", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tools: namespaceTools,
    }, {}, map);

    expect(out.messages[0].tool_calls[0].function.name).toBe(UPSTREAM_AUTOMATION);
    expect(out.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  test("a namespaced tool_choice is rewritten instead of dangling", () => {
    const map = buildResponsesToolMap(namespaceTools);
    const out = responsesToOpenAi({
      model: "m",
      input: "hi",
      tools: namespaceTools,
      tool_choice: { type: "function", name: "automation_update", namespace: "mcp__codex_app" },
    }, {}, map);

    expect(out.tool_choice).toEqual({ type: "function", function: { name: UPSTREAM_AUTOMATION } });
  });

  test("non-stream output restores name and namespace", async () => {
    const seen: { body?: any } = {};
    const completion = {
      id: "1", model: "m", created: 1,
      choices: [{
        index: 0,
        message: {
          role: "assistant", content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: UPSTREAM_AUTOMATION, arguments: '{"x":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const resp = await handleResponses(
      backend(async () => Response.json(completion), seen),
      respReq({ model: "m", input: "hi", tools: namespaceTools }),
      {},
    );

    expect(seen.body.tools.map((t: any) => t.function.name)).toContain(UPSTREAM_AUTOMATION);
    const j: any = await resp.json();
    const call = j.output.find((o: any) => o.type === "function_call");
    expect(call.name).toBe("automation_update");
    expect(call.namespace).toBe("mcp__codex_app");
    expect(call.arguments).toBe('{"x":1}');
  });

  test("stream output restores name and namespace on both added and done events", async () => {
    const seen: { body?: any } = {};
    const sse = [
      `data:{"id":"1","model":"m","created":1,"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"${UPSTREAM_AUTOMATION}","arguments":"{\\"x\\":1}"}}]},"finish_reason":"tool_calls"}]}`,
      "",
      "data:[DONE]",
      "",
    ].join("\n");

    const resp = await handleResponses(
      backend(async () => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }), seen),
      respReq({ model: "m", input: "hi", tools: namespaceTools, stream: true }),
      {},
    );

    expect(seen.body.tools.map((t: any) => t.function.name)).toContain(UPSTREAM_AUTOMATION);
    const text = await resp.text();
    const added = text.split("\n").find((l) => l.includes('"type":"response.output_item.added"')) ?? "";
    const done = text.split("\n").find((l) => l.includes('"type":"response.output_item.done"')) ?? "";
    expect(added).toContain('"name":"automation_update"');
    expect(added).toContain('"namespace":"mcp__codex_app"');
    expect(done).toContain('"name":"automation_update"');
    expect(done).toContain('"namespace":"mcp__codex_app"');
  });

  test("long names are truncated to 64 chars and still round-trip", () => {
    const ns = "n".repeat(50);
    const member = "f".repeat(50);
    const map = buildResponsesToolMap([
      { type: "namespace", name: ns, tools: [{ type: "function", name: member, parameters: { type: "object" } }] },
    ]);
    const out = responsesToOpenAi({
      model: "m", input: "hi",
      tools: [{ type: "namespace", name: ns, tools: [{ type: "function", name: member, parameters: { type: "object" } }] }],
    }, {}, map);

    const upstream = out.tools[0].function.name;
    expect(upstream.length).toBeLessThanOrEqual(64);
    expect(map.resolve(upstream)).toEqual({ name: member, namespace: ns });
  });

  test("same member name in different namespaces stays distinct", () => {
    const tools = [
      { type: "namespace", name: "ns_a", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
      { type: "namespace", name: "ns_b", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
    ];
    const map = buildResponsesToolMap(tools);
    const out = responsesToOpenAi({ model: "m", input: "hi", tools }, {}, map);
    const names = out.tools.map((t: any) => t.function.name);
    expect(new Set(names).size).toBe(2);
    expect(map.resolve(names[0])).toEqual({ name: "run", namespace: "ns_a" });
    expect(map.resolve(names[1])).toEqual({ name: "run", namespace: "ns_b" });
  });
});