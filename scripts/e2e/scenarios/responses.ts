import type { ProviderName } from "../types";
import { checkErrorEnvelope, checkResponseObject, checkResponsesStream } from "../verify";
import { RED_IMAGE_DATA_URL } from "./chat";
import {
  assess,
  assessOptional,
  call,
  dumpHasImage,
  fail,
  jsonOf,
  notSupported,
  pass,
  rejectionVerdict,
  truncate,
  upstreamDump,
  type Scenario,
} from "./shared";

const OK_PROMPT = "Reply with exactly: OK";
const COLOR_PROMPT = "What is the dominant color of this image? Answer with one English word.";

export function responsesScenarios(provider: ProviderName): Scenario[] {
  return [
    {
      id: "responses.basic.nonstream",
      provider,
      endpoint: "/v1/responses",
      feature: "基础非流式（含 usage）",
      clause: "OAI-RESP-01",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/responses", {
          body: { model: ctx.model, input: OK_PROMPT, max_output_tokens: 128 },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        return assess(res, checkResponseObject(json));
      },
    },
    {
      id: "responses.basic.stream",
      provider,
      endpoint: "/v1/responses",
      feature: "SSE 事件序列",
      clause: "OAI-RESP-02",
      knownDefect: true,
      run: async (ctx) => {
        const res = await call(ctx, "/v1/responses", {
          body: { model: ctx.model, input: OK_PROMPT, max_output_tokens: 128, stream: true },
          headers: { accept: "text/event-stream" },
        });
        if (res.status !== 200) return fail(`HTTP ${res.status}：${truncate(res.text)}`);
        return assess(res, checkResponsesStream(res.text), { sse: true });
      },
    },
    {
      id: "responses.image.data_url",
      provider,
      endpoint: "/v1/responses",
      feature: "input_image data URL",
      clause: "OAI-RESP-03",
      knownDefect: true,
      run: async (ctx) => {
        const res = await call(ctx, "/v1/responses", {
          body: {
            model: ctx.model,
            max_output_tokens: 256,
            input: [{
              role: "user",
              content: [
                { type: "input_text", text: COLOR_PROMPT },
                { type: "input_image", image_url: RED_IMAGE_DATA_URL, detail: "auto" },
              ],
            }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkResponseObject(json), "openai");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dumpHasImage(dump, RED_IMAGE_DATA_URL)) return fail("上游请求未包含图片字段（input_image 被丢弃）");
        const text = (json?.output ?? [])
          .find((o: any) => o?.type === "message")?.content
          ?.find((c: any) => c?.type === "output_text")?.text ?? "";
        if (!/\bred\b/i.test(text)) return fail(`上游收到图片但回答未提及 red：${truncate(text)}`);
        return pass("input_image 送达上游且颜色识别正确");
      },
    },
    {
      id: "responses.tools.forced",
      provider,
      endpoint: "/v1/responses",
      feature: "function tools + 强制 tool_choice",
      clause: "OAI-RESP-04",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/responses", {
          body: {
            model: ctx.model,
            max_output_tokens: 64,
            input: "Use the get_color tool with color red. Do not answer in text.",
            tools: [{
              type: "function",
              name: "get_color",
              description: "Return the color the user asks about",
              parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
            }],
            tool_choice: { type: "function", name: "get_color" },
          },
        });
        const rejection = rejectionVerdict(res, "openai");
        if (rejection) return rejection;
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        if (json?.object !== "response" || json?.status !== "completed") return fail(`响应不是 completed 的 response 对象（status=${String(json?.status)}）`);
        const callItem = (json?.output ?? []).find((o: any) => o?.type === "function_call");
        if (!callItem) {
          return provider === "codebuddy"
            ? notSupported("provider 声明 toolChoice=auto-only，强制 tool_choice 被降级")
            : fail("output 缺少 function_call（强制 tool_choice 被忽略）");
        }
        if (callItem.name !== "get_color") return fail(`function_call.name 为 ${String(callItem.name)}`);
        try {
          JSON.parse(callItem.arguments);
        } catch {
          return fail(`function_call.arguments 不是合法 JSON：${truncate(String(callItem.arguments), 120)}`);
        }
        return pass("强制 tool_choice 生效");
      },
    },
    {
      id: "responses.negative.unknown_model",
      provider,
      endpoint: "/v1/responses",
      feature: "未知模型显式拒绝",
      clause: "OAI-RESP-05",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/responses", {
          body: { model: "e2e-model-does-not-exist", input: "hi", max_output_tokens: 4 },
        });
        if (res.status >= 400 && res.status < 500) {
          const { json, error } = jsonOf(res);
          if (error) return fail(error);
          const env = checkErrorEnvelope(json, "openai");
          return env.ok ? pass(`显式拒绝（HTTP ${res.status}）`) : fail(`错误信封不合规：${env.issues.join("；")}`);
        }
        if (res.status === 200) {
          const { json } = jsonOf(res);
          return fail(`未知模型被静默接受/回退（响应 model=${String(json?.model)}）`);
        }
        return fail(`HTTP ${res.status}：${truncate(res.text)}`);
      },
    },
  ];
}
