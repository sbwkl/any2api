import { test, expect, describe } from "bun:test";
import { handleResponses } from "./responses";
import type { ChatBackend } from "./types";

// S1：所有断言都经共享 Responses 路由，只观察「发给上游的请求」与「回给客户端的响应」。
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
    handleChat: async () => new Response(""),
    respond: async (body, opts) => {
      if (seen) seen.body = body;
      return respond(body, opts);
    },
  };
}

function completion(toolCalls: any[], content = "") {
  return {
    id: "1", object: "chat.completion", created: 1, model: "m",
    choices: [{
      index: 0,
      message: { role: "assistant", content, tool_calls: toolCalls },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolCall(name: string, args = "{}") {
  return { id: "call_1", type: "function", function: { name, arguments: args } };
}

function sseResponse(frames: any[]): Response {
  const sse = frames.map((f) => `data:${JSON.stringify(f)}\n\n`).join("") + "data:[DONE]\n\n";
  return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function sseChunk(delta: any, finishReason?: string) {
  return { id: "1", model: "m", created: 1, choices: [{ index: 0, delta, finish_reason: finishReason ?? null }] };
}

async function callNonStream(body: any, respond?: ChatBackend["respond"], seen?: { body?: any }) {
  const resp = await handleResponses(
    backend(respond ?? (async () => Response.json(completion([]))), seen),
    respReq({ model: "m", input: "hi", ...body }),
    {},
  );
  return { resp, json: await resp.json() };
}

async function callStream(body: any, frames: any[], seen?: { body?: any }) {
  const resp = await handleResponses(
    backend(async () => sseResponse(frames), seen),
    respReq({ model: "m", input: "hi", stream: true, ...body }),
    {},
  );
  return await resp.text();
}

function eventLine(text: string, type: string): string {
  return text.split("\n").find((l) => l.includes(`"type":"${type}"`)) ?? "";
}

function eventPayload(text: string, type: string): any {
  const line = eventLine(text, type);
  return line ? JSON.parse(line.slice("data: ".length)) : null;
}

describe("Responses namespace tools", () => {
  test("namespace members are flattened into upstream function tools", async () => {
    const seen: { body?: any } = {};
    await callNonStream({ tools: namespaceTools }, undefined, seen);

    expect(seen.body.tools.map((t: any) => t.function.name)).toEqual([
      "exec_command",
      UPSTREAM_AUTOMATION,
      "mcp__codex_app__automation_delete",
    ]);
    // 参数 schema 与描述原样保留
    expect(seen.body.tools[1].function.parameters).toEqual({ type: "object", properties: { x: { type: "string" } } });
    expect(seen.body.tools[1].function.description).toBe("update");
  });

  test("input function_call items use the same flattened name", async () => {
    const seen: { body?: any } = {};
    await callNonStream({
      input: [
        { type: "function_call", call_id: "c1", name: "automation_update", namespace: "mcp__codex_app", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
      ],
      tools: namespaceTools,
    }, undefined, seen);

    expect(seen.body.messages[0].tool_calls[0].function.name).toBe(UPSTREAM_AUTOMATION);
    expect(seen.body.messages[1]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });

  test("a namespaced tool_choice is rewritten instead of dangling", async () => {
    const seen: { body?: any } = {};
    await callNonStream({
      tools: namespaceTools,
      tool_choice: { type: "function", name: "automation_update", namespace: "mcp__codex_app" },
    }, undefined, seen);

    expect(seen.body.tool_choice).toEqual({ type: "function", function: { name: UPSTREAM_AUTOMATION } });
  });

  test("non-stream output restores name and namespace", async () => {
    const { json } = await callNonStream(
      { tools: namespaceTools },
      async () => Response.json(completion([toolCall(UPSTREAM_AUTOMATION, '{"x":1}')])),
    );

    const call = json.output.find((o: any) => o.type === "function_call");
    expect(call.name).toBe("automation_update");
    expect(call.namespace).toBe("mcp__codex_app");
    expect(call.arguments).toBe('{"x":1}');
  });

  test("stream output restores name and namespace on both added and done events", async () => {
    const text = await callStream({ tools: namespaceTools }, [
      sseChunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: UPSTREAM_AUTOMATION, arguments: '{"x":1}' } }] }, "tool_calls"),
    ]);

    for (const type of ["response.output_item.added", "response.output_item.done"]) {
      const payload = eventPayload(text, type);
      expect(payload.item.name).toBe("automation_update");
      expect(payload.item.namespace).toBe("mcp__codex_app");
    }
  });

  test("a late function name is restored before output_item.added", async () => {
    // 名称在第二个 delta 才到达：added 不能带空 name 发出去且永不更正
    const text = await callStream({ tools: namespaceTools }, [
      sseChunk({ tool_calls: [{ index: 0, id: "call_1", function: { arguments: '{"x"' } }] }),
      sseChunk({ tool_calls: [{ index: 0, function: { name: UPSTREAM_AUTOMATION, arguments: ":1}" } }] }, "tool_calls"),
    ]);

    const added = eventPayload(text, "response.output_item.added");
    expect(added.item.name).toBe("automation_update");
    expect(added.item.namespace).toBe("mcp__codex_app");

    const deltas = text.split("\n")
      .filter((l) => l.includes('"type":"response.function_call_arguments.delta"'))
      .map((l) => JSON.parse(l.slice("data: ".length)).delta);
    expect(deltas.join("")).toBe('{"x":1}');

    // added 必须早于任何参数 delta
    const addedAt = text.indexOf('"type":"response.output_item.added"');
    const deltaAt = text.indexOf('"type":"response.function_call_arguments.delta"');
    expect(addedAt).toBeLessThan(deltaAt);

    expect(eventPayload(text, "response.output_item.done").item.arguments).toBe('{"x":1}');
  });

  test("long names are truncated to 64 chars and still round-trip", async () => {
    const ns = "n".repeat(50);
    const member = "f".repeat(50);
    const tools = [{ type: "namespace", name: ns, tools: [{ type: "function", name: member, parameters: { type: "object" } }] }];
    const seen: { body?: any } = {};
    await callNonStream({ tools }, undefined, seen);

    const upstream = seen.body.tools[0].function.name;
    expect(upstream.length).toBeLessThanOrEqual(64);

    const { json } = await callNonStream({ tools }, async () => Response.json(completion([toolCall(upstream)])));
    const call = json.output.find((o: any) => o.type === "function_call");
    expect(call.name).toBe(member);
    expect(call.namespace).toBe(ns);
  });

  test("same member name in different namespaces stays distinct", async () => {
    const tools = [
      { type: "namespace", name: "ns_a", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
      { type: "namespace", name: "ns_b", tools: [{ type: "function", name: "run", parameters: { type: "object" } }] },
    ];
    const seen: { body?: any } = {};
    await callNonStream({ tools }, undefined, seen);

    const [nameA, nameB] = seen.body.tools.map((t: any) => t.function.name);
    expect(nameA).not.toBe(nameB);

    const { json } = await callNonStream({ tools }, async () => Response.json(completion([toolCall(nameA), toolCall(nameB)])));
    const calls = json.output.filter((o: any) => o.type === "function_call");
    expect(calls.map((c: any) => [c.name, c.namespace])).toEqual([["run", "ns_a"], ["run", "ns_b"]]);
  });

  test("an expanded name colliding with a top-level function is deduplicated deterministically", async () => {
    const tools = [
      { type: "function", name: UPSTREAM_AUTOMATION, description: "top-level", parameters: { type: "object" } },
      { type: "namespace", name: "mcp__codex_app", tools: [{ type: "function", name: "automation_update", parameters: { type: "object" } }] },
    ];
    const seen: { body?: any } = {};
    await callNonStream({ tools }, undefined, seen);

    const names = seen.body.tools.map((t: any) => t.function.name);
    expect(names).toHaveLength(2);
    expect(names[0]).toBe(UPSTREAM_AUTOMATION); // 顶层函数保留原名
    expect(names[1]).toBe(`${UPSTREAM_AUTOMATION}_2`); // namespace 成员让位

    const { json } = await callNonStream({ tools }, async () =>
      Response.json(completion([toolCall(names[0]), toolCall(names[1])])));
    const calls = json.output.filter((o: any) => o.type === "function_call");
    expect(calls[0].name).toBe(UPSTREAM_AUTOMATION);
    expect(calls[0].namespace).toBeUndefined();
    expect(calls[1]).toMatchObject({ name: "automation_update", namespace: "mcp__codex_app" });
  });
});