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
  /** 上游错误如何呈现：passthrough 保留 provider 原样；anthropic/responses 归一为对应协议 */
  errorShape?: "passthrough" | "anthropic" | "responses";
  /** 是否输出 thinking 块（默认 true） */
  thinking?: boolean;
}

export type { Route };