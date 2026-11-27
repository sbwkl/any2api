// 共享协议层小工具 — 统一 backend 调用边界，避免 provider 异常变成裸 500。
import type { ChatBackend } from "./types";
import { PROXY_ERROR_HEADER } from "../shared/errors";

export async function safeRespond(
  backend: ChatBackend,
  body: any,
  opts: { stream: boolean; sessionKey: string; profile?: string; signal?: AbortSignal },
): Promise<Response> {
  try {
    return await backend.respond(body, opts);
  } catch (e: any) {
    return Response.json(
      { error: { message: e?.message ?? String(e), type: "server_error", code: null } },
      { status: 502, headers: { [PROXY_ERROR_HEADER]: "proxy" } },
    );
  }
}

// 翻译产物不变式：tools 与 tool_choice 必须一致。上游拒绝「无幸存工具 / 具名选择
// 引用被滤工具」的矛盾形状（InferHub.001001005 实测），Anthropic 与 Responses
// 两入口在能力位映射之后统一应用本检查。
export function pruneDanglingToolChoice(out: any): any {
  const survivingToolNames = new Set((out.tools ?? []).map((t: any) => t.function?.name));
  if (survivingToolNames.size === 0) delete out.tool_choice;
  else if (out.tool_choice?.type === "function" && !survivingToolNames.has(out.tool_choice.function?.name)) delete out.tool_choice;
  return out;
}