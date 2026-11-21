// 共享协议层小工具 — 统一 backend 调用边界，避免 provider 异常变成裸 500。
import type { ChatBackend } from "./types";

export async function safeRespond(
  backend: ChatBackend,
  body: any,
  opts: { stream: boolean; sessionKey: string; profile?: string },
): Promise<Response> {
  try {
    return await backend.respond(body, opts);
  } catch (e: any) {
    return Response.json(
      { error: { message: e?.message ?? String(e), type: "upstream_error", code: null } },
      { status: 502 },
    );
  }
}