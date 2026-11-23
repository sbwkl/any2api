// 共享协议层类型 — 路由层只依赖 ChatBackend，不感知 provider 名称。
import type { Route } from "../registry";

export interface ChatBackend {
  /** 模型池（OpenAI /v1/models 的 data 数组） */
  models(): any[];
  /** provider 健康信息 */
  health(): any;
  /** 可选：从请求解析 profile（如 x-codebuddy-agent） */
  profileFor?(req: Request): string | undefined;
  /** OpenAI Chat 门面 */
  handleChat(req: Request): Promise<Response>;
  /** 内部 OpenAI chat 管线；Anthropic/Responses 适配层复用 */
  respond(body: any, opts: { stream: boolean; sessionKey: string; profile?: string }): Promise<Response>;
}

export interface ProtocolCapabilities {
  /** full：支持 required/forced function；auto-only：上游只接受 auto */
  toolChoice?: "full" | "auto-only";
  /** 是否把上游错误归一为对应协议错误（默认 true）；false = 透传 provider 原样响应 */
  normalizeErrors?: boolean;
  /** 是否在响应中输出 thinking 块（默认 true） */
  thinking?: boolean;
  /** 是否把 Anthropic thinking 映射为 reasoning_effort（默认 true） */
  thinkingToEffort?: boolean;
  /** 是否把上游 prompt_tokens 视为包含缓存分量的总输入（默认 false；CodeBuddy 已实测为 true） */
  promptTokensIncludeCache?: boolean;
}

export type { Route };