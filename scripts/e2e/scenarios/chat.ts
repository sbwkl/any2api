import { pngDataUrl } from "../images";
import { checkChatChunks, checkChatCompletion, checkErrorEnvelope } from "../verify";
import {
  assess,
  assessOptional,
  call,
  chatText,
  dumpHasImage,
  fail,
  jsonOf,
  mentionsRed,
  pass,
  rejectionVerdict,
  truncate,
  upstreamDump,
  type ScenarioContext,
  type ScenarioTemplate,
  type Verdict,
} from "./shared";

const OK_PROMPT = "Reply with exactly: OK";
const COLOR_PROMPT = "What is the dominant color of this image? Answer with one English word.";
export const RED_IMAGE_DATA_URL = pngDataUrl(32, 32, [255, 0, 0]);

function chatCompletionVerdict(ctx: ScenarioContext, res: Awaited<ReturnType<typeof call>>, imageDataUrl?: string): Promise<Verdict> | Verdict {
  const { json, error } = jsonOf(res);
  if (error) return fail(error);
  const v = assessOptional(res, checkChatCompletion(json), "openai");
  if (v.status !== "pass" || !imageDataUrl) return v;
  return (async () => {
    const dump = await upstreamDump(ctx);
    if (!dumpHasImage(dump, imageDataUrl)) return fail("上游请求未包含图片字段（静默丢弃）");
    if (!mentionsRed(chatText(json))) return fail(`上游收到图片但回答未提及 red：${truncate(chatText(json))}`);
    return pass("图片送达上游且颜色识别正确");
  })();
}

export function chatScenarios(): ScenarioTemplate[] {
  return [
    {
      id: "chat.basic.nonstream",
      endpoint: "/v1/chat/completions",
      feature: "基础非流式（含 usage）",
      clause: "OAI-CHAT-01",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: { model: ctx.model, messages: [{ role: "user", content: OK_PROMPT }], max_tokens: 128 },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        return assess(res, checkChatCompletion(json));
      },
    },
    {
      id: "chat.basic.stream",
      endpoint: "/v1/chat/completions",
      feature: "SSE 流式 + usage 块",
      clause: "OAI-CHAT-02",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            messages: [{ role: "user", content: OK_PROMPT }],
            max_tokens: 128,
            stream: true,
            stream_options: { include_usage: true },
          },
          headers: { accept: "text/event-stream" },
        });
        if (res.status !== 200) return fail(`HTTP ${res.status}：${truncate(res.text)}`);
        return assess(res, checkChatChunks(res.text, { expectUsage: true }), { sse: true });
      },
    },
    {
      id: "chat.image.data_url",
      endpoint: "/v1/chat/completions",
      feature: "image_url data URL",
      clause: "OAI-CHAT-04",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 256,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: COLOR_PROMPT },
                { type: "image_url", image_url: { url: RED_IMAGE_DATA_URL } },
              ],
            }],
          },
        });
        return chatCompletionVerdict(ctx, res, RED_IMAGE_DATA_URL);
      },
    },
    {
      id: "chat.image.url",
      endpoint: "/v1/chat/completions",
      feature: "image_url 公网 URL",
      clause: "OAI-CHAT-04",
      needsImageUrl: true,
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 32,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Describe this image in one short sentence." },
                { type: "image_url", image_url: { url: ctx.imageUrl } },
              ],
            }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkChatCompletion(json), "openai");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dump.includes(ctx.imageUrl!)) return fail("上游请求未包含图片 URL（静默丢弃）");
        return pass("URL 图片送达上游");
      },
    },
    {
      id: "chat.multi_turn.system",
      endpoint: "/v1/chat/completions",
      feature: "multi-turn + system",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 128,
            messages: [
              { role: "system", content: "You are terse." },
              { role: "user", content: "Name the capital of France." },
              { role: "assistant", content: "Paris." },
              { role: "user", content: "Now name the country." },
            ],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        return assess(res, checkChatCompletion(json));
      },
    },
    {
      id: "chat.response_format.json_schema",
      endpoint: "/v1/chat/completions",
      feature: "response_format json_schema",
      clause: "OAI-CHAT-06",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 512,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "answer",
                strict: true,
                schema: {
                  type: "object",
                  properties: { ok: { type: "boolean" } },
                  required: ["ok"],
                  additionalProperties: false,
                },
              },
            },
            messages: [{ role: "user", content: "Return JSON with ok=true." }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkChatCompletion(json), "openai");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        const forwarded = dump.includes("json_schema");
        if (!forwarded) return fail("上游请求未包含 response_format.json_schema（静默丢弃）");
        let parsed: any;
        try {
          parsed = JSON.parse(chatText(json));
        } catch {
          return fail(`json_schema 已送达上游，但 content 不是 JSON（上游未强制结构）：${truncate(chatText(json))}`);
        }
        if (parsed?.ok !== true) return fail(`JSON 内容不符合要求：${truncate(chatText(json))}`);
        return pass("json_schema 送达上游且输出符合结构");
      },
    },
    {
      id: "chat.tools.forced",
      endpoint: "/v1/chat/completions",
      feature: "tools + 强制 tool_choice",
      clause: "OAI-CHAT-05",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 256,
            messages: [{ role: "user", content: "Use the get_color tool with color red. Do not answer in text." }],
            tools: [{
              type: "function",
              function: {
                name: "get_color",
                description: "Return the color the user asks about",
                parameters: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
              },
            }],
            tool_choice: { type: "function", function: { name: "get_color" } },
          },
        });
        const rejection = rejectionVerdict(res, "openai");
        if (rejection) return rejection;
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        const base = assess(res, checkChatCompletion(json));
        if (base.status !== "pass") return base;
        const toolCall = json?.choices?.[0]?.message?.tool_calls?.[0];
        if (!toolCall) return fail("响应缺少 tool_calls（强制 tool_choice 被忽略）");
        if (toolCall?.function?.name !== "get_color") return fail(`tool_calls[0].name 为 ${String(toolCall?.function?.name)}`);
        try {
          JSON.parse(toolCall.function.arguments);
        } catch {
          return fail(`tool_calls[0].arguments 不是合法 JSON：${truncate(String(toolCall.function.arguments), 120)}`);
        }
        return pass("强制 tool_choice 生效且 arguments 可解析");
      },
    },
    {
      id: "chat.response_format.json",
      endpoint: "/v1/chat/completions",
      feature: "response_format json_object",
      clause: "OAI-CHAT-06",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 512,
            response_format: { type: "json_object" },
            messages: [{ role: "user", content: 'Return exactly this JSON and nothing else: {"ok":true}' }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkChatCompletion(json), "openai");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dump.includes("response_format")) return fail("上游请求未包含 response_format（静默丢弃）");
        let parsed: any;
        try {
          parsed = JSON.parse(chatText(json));
        } catch {
          return fail(`response_format 已送达上游，但 content 不是 JSON：${truncate(chatText(json))}`);
        }
        if (parsed?.ok !== true) return fail(`JSON 内容不符合要求：${truncate(chatText(json))}`);
        return pass("response_format 送达上游且输出为 JSON");
      },
    },
    {
      id: "chat.logprobs",
      endpoint: "/v1/chat/completions",
      feature: "logprobs / top_logprobs",
      clause: "OAI-CHAT-07",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: {
            model: ctx.model,
            max_tokens: 8,
            logprobs: true,
            top_logprobs: 1,
            messages: [{ role: "user", content: "Say OK" }],
          },
        });
        if (res.status !== 200) {
          const rejection = rejectionVerdict(res, "openai");
          return rejection ?? fail(`HTTP ${res.status}：${truncate(res.text)}`);
        }
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        const lp = json?.choices?.[0]?.logprobs;
        if (!lp || !Array.isArray(lp.content)) return fail("响应缺少 choices[0].logprobs.content（参数被静默丢弃）");
        return pass("logprobs 已返回");
      },
    },
    {
      id: "chat.n",
      endpoint: "/v1/chat/completions",
      feature: "n > 1",
      clause: "OAI-CHAT-08",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: { model: ctx.model, max_tokens: 16, n: 2, messages: [{ role: "user", content: "Say one word." }] },
        });
        if (res.status !== 200) {
          const rejection = rejectionVerdict(res, "openai");
          return rejection ?? fail(`HTTP ${res.status}：${truncate(res.text)}`);
        }
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        if (!Array.isArray(json?.choices) || json.choices.length !== 2) {
          return fail(`choices 数量为 ${json?.choices?.length ?? 0}（n=2 被静默丢弃）`);
        }
        return pass("n=2 返回两条 choices");
      },
    },
    {
      id: "chat.negative.unknown_model",
      endpoint: "/v1/chat/completions",
      feature: "未知模型显式拒绝",
      clause: "OAI-CHAT-03",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", {
          body: { model: "e2e-model-does-not-exist", messages: [{ role: "user", content: "hi" }], max_tokens: 4 },
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
    {
      id: "chat.negative.invalid_json",
      endpoint: "/v1/chat/completions",
      feature: "非法 JSON 请求体",
      clause: "OAI-CHAT-03",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/chat/completions", { rawBody: "{" });
        if (!(res.status >= 400 && res.status < 500)) return fail(`HTTP ${res.status}（期望 4xx）：${truncate(res.text)}`);
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        const env = checkErrorEnvelope(json, "openai");
        return env.ok ? pass(`HTTP ${res.status}；错误信封合规`) : fail(env.issues.join("；"));
      },
    },
  ];
}
