// 共享协议路由 — 只依赖 ChatBackend，不含 provider 名称判断。
import type { Route } from "../registry";
import type { ChatBackend, ProtocolCapabilities } from "./types";
import { handleAnthropicMessages } from "./anthropic";
import { handleResponses } from "./responses";

export function createProtocolRoutes(backend: ChatBackend, caps: ProtocolCapabilities = {}): Route[] {
  return [
    {
      method: "GET",
      path: "/v1/models",
      handle: () => Response.json({ object: "list", data: backend.models() }),
    },
    {
      method: "POST",
      path: "/v1/chat/completions",
      handle: (req) => backend.handleChat(req),
    },
    {
      method: "POST",
      path: "/v1/messages",
      handle: (req) => handleAnthropicMessages(backend, req, caps),
    },
    {
      method: "POST",
      path: "/v1/responses",
      handle: (req) => handleResponses(backend, req, caps),
    },
    {
      method: "GET",
      path: "/healthz",
      handle: () => Response.json({ ok: true, ...backend.health() }),
    },
  ];
}

export type { ChatBackend, ProtocolCapabilities } from "./types";