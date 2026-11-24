import type { ProviderName } from "../types";
import { checkAnthropicMessage, checkAnthropicStream, checkErrorEnvelope } from "../verify";
import { RED_IMAGE_DATA_URL } from "./chat";
import {
  anthropicText,
  assess,
  assessOptional,
  call,
  dumpHasImage,
  fail,
  jsonOf,
  mentionsRed,
  pass,
  rejectionVerdict,
  truncate,
  upstreamDump,
  type Scenario,
  type Verdict,
} from "./shared";

const OK_PROMPT = "Reply with exactly: OK";
const COLOR_PROMPT = "What is the dominant color of this image? Answer with one English word.";
const RED_BASE64 = RED_IMAGE_DATA_URL.slice(RED_IMAGE_DATA_URL.indexOf(",") + 1);

const redImageBlock = () => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: RED_BASE64 },
});

export function anthropicScenarios(provider: ProviderName): Scenario[] {
  return [
    {
      id: "messages.basic.nonstream",
      provider,
      endpoint: "/v1/messages",
      feature: "基础非流式（含 usage）",
      clause: "ANT-MSG-01",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 128,
            messages: [{ role: "user", content: OK_PROMPT }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        return assess(res, checkAnthropicMessage(json));
      },
    },
    {
      id: "messages.basic.stream",
      provider,
      endpoint: "/v1/messages",
      feature: "SSE 事件序列",
      clause: "ANT-MSG-02",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 128,
            stream: true,
            messages: [{ role: "user", content: OK_PROMPT }],
          },
          headers: { accept: "text/event-stream" },
        });
        if (res.status !== 200) return fail(`HTTP ${res.status}：${truncate(res.text)}`);
        return assess(res, checkAnthropicStream(res.text), { sse: true });
      },
    },
    {
      id: "messages.multi_turn.system",
      provider,
      endpoint: "/v1/messages",
      feature: "multi-turn + system string",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 128,
            system: "You are terse.",
            messages: [
              { role: "user", content: "Name the capital of France." },
              { role: "assistant", content: "Paris." },
              { role: "user", content: "Now name the country." },
            ],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        return assess(res, checkAnthropicMessage(json));
      },
    },
    {
      id: "messages.image.base64",
      provider,
      endpoint: "/v1/messages",
      feature: "base64 图片",
      clause: "ANT-MSG-03",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 256,
            messages: [{
              role: "user",
              content: [{ type: "text", text: COLOR_PROMPT }, redImageBlock()],
            }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkAnthropicMessage(json), "anthropic");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dumpHasImage(dump, RED_IMAGE_DATA_URL)) return fail("上游请求未包含图片字段（静默丢弃）");
        if (!mentionsRed(anthropicText(json))) return fail(`上游收到图片但回答未提及 red：${truncate(anthropicText(json))}`);
        return pass("图片送达上游且颜色识别正确");
      },
    },
    {
      id: "messages.image.url",
      provider,
      endpoint: "/v1/messages",
      feature: "URL 图片",
      clause: "ANT-MSG-03",
      needsImageUrl: true,
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 32,
            messages: [{
              role: "user",
              content: [
                { type: "text", text: "Describe this image in one short sentence." },
                { type: "image", source: { type: "url", url: ctx.imageUrl } },
              ],
            }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkAnthropicMessage(json), "anthropic");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dump.includes(ctx.imageUrl!)) return fail("上游请求未包含图片 URL（静默丢弃）");
        return pass("URL 图片送达上游");
      },
    },
    {
      id: "messages.image.tool_result",
      provider,
      endpoint: "/v1/messages",
      feature: "tool_result 内嵌图片",
      clause: "ANT-MSG-04",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 256,
            messages: [
              { role: "user", content: "Take a screenshot." },
              { role: "assistant", content: [{ type: "tool_use", id: "toolu_e2e", name: "screenshot", input: {} }] },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "toolu_e2e",
                    content: [{ type: "text", text: "screenshot attached" }, redImageBlock()],
                  },
                  { type: "text", text: COLOR_PROMPT },
                ],
              },
            ],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkAnthropicMessage(json), "anthropic");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dumpHasImage(dump, RED_IMAGE_DATA_URL)) return fail("tool_result 图片未送达上游（静默丢弃）");
        if (!mentionsRed(anthropicText(json))) return fail(`上游收到图片但回答未提及 red：${truncate(anthropicText(json))}`);
        return pass("tool_result 图片送达上游且颜色识别正确");
      },
    },
    {
      id: "messages.image.system",
      provider,
      endpoint: "/v1/messages",
      feature: "system 数组中的图片",
      clause: "ANT-MSG-05",
      knownDefect: true,
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 256,
            system: [
              { type: "text", text: "You are terse." },
              redImageBlock(),
            ],
            messages: [{ role: "user", content: COLOR_PROMPT }],
          },
        });
        const { json, error } = jsonOf(res);
        if (error) return fail(`HTTP ${res.status}；${error}`);
        const v = assessOptional(res, checkAnthropicMessage(json), "anthropic");
        if (v.status !== "pass") return v;
        const dump = await upstreamDump(ctx);
        if (!dumpHasImage(dump, RED_IMAGE_DATA_URL)) return fail("system 图片未送达上游（静默丢弃）");
        if (!mentionsRed(anthropicText(json))) return fail(`上游收到图片但回答未提及 red：${truncate(anthropicText(json))}`);
        return pass("system 图片送达上游");
      },
    },
    {
      id: "messages.tools.forced",
      provider,
      endpoint: "/v1/messages",
      feature: "tools + 强制 tool_choice",
      clause: "ANT-MSG-06",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: {
            model: ctx.model,
            max_tokens: 64,
            messages: [{ role: "user", content: "Use the get_color tool with color red. Do not answer in text." }],
            tools: [{
              name: "get_color",
              description: "Return the color the user asks about",
              input_schema: { type: "object", properties: { color: { type: "string" } }, required: ["color"] },
            }],
            tool_choice: { type: "tool", name: "get_color" },
          },
        });
        const rejection = rejectionVerdict(res, "anthropic");
        if (rejection) return rejection;
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        const base = assess(res, checkAnthropicMessage(json));
        if (base.status !== "pass") return base;
        const toolUse = (json?.content ?? []).find((b: any) => b?.type === "tool_use");
        if (!toolUse) return fail("响应缺少 tool_use（强制 tool_choice 被忽略）");
        if (toolUse.name !== "get_color") return fail(`tool_use.name 为 ${String(toolUse.name)}`);
        if (json?.stop_reason !== "tool_use") return fail(`stop_reason 为 ${String(json?.stop_reason)}（期望 tool_use）`);
        return pass("强制 tool_choice 生效");
      },
    },
    {
      id: "messages.negative.unknown_model",
      provider,
      endpoint: "/v1/messages",
      feature: "未知模型 + 错误信封归一",
      clause: "ANT-MSG-07",
      run: async (ctx) => {
        const res = await call(ctx, "/v1/messages", {
          body: { model: "e2e-model-does-not-exist", max_tokens: 4, messages: [{ role: "user", content: "hi" }] },
        });
        if (res.status >= 400 && res.status < 500) {
          const { json, error } = jsonOf(res);
          if (error) return fail(error);
          const env = checkErrorEnvelope(json, "anthropic");
          return env.ok ? pass(`显式拒绝（HTTP ${res.status}）`) : fail(`错误信封不是 Anthropic 形状：${env.issues.join("；")}`);
        }
        if (res.status === 200) {
          const { json } = jsonOf(res);
          return fail(`未知模型被静默接受/回退（响应 model=${String(json?.model)}）`);
        }
        return fail(`HTTP ${res.status}：${truncate(res.text)}`);
      },
    },
    {
      id: "messages.negative.invalid_json",
      provider,
      endpoint: "/v1/messages",
      feature: "非法 JSON 请求体",
      clause: "ANT-MSG-07",
      run: async (ctx): Promise<Verdict> => {
        const res = await call(ctx, "/v1/messages", { rawBody: "{" });
        if (!(res.status >= 400 && res.status < 500)) return fail(`HTTP ${res.status}（期望 4xx）：${truncate(res.text)}`);
        const { json, error } = jsonOf(res);
        if (error) return fail(error);
        const env = checkErrorEnvelope(json, "anthropic");
        return env.ok ? pass(`HTTP ${res.status}；错误信封合规`) : fail(env.issues.join("；"));
      },
    },
  ];
}
