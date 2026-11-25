// CodeArts 协议能力声明 — 路由装配与本模块共用同一常量，审计时一眼可见。
// 共享协议路由的默认能力位为 false；只有语义不同的上游在此显式开启。
import type { ProtocolCapabilities } from "../../protocols";

export const CODEARTS_PROTOCOL_CAPABILITIES: ProtocolCapabilities = {
  // full：支持 required/forced function。
  toolChoice: "full",
  // 裸上游错误原样透传；provider 生成的代理信封（x-any2api-error-source: proxy，
  // 即 chat 失败路径）仍会按请求方协议归一。
  normalizeErrors: false,
  // 不把 Anthropic thinking 映射为 reasoning_effort。
  thinkingToEffort: false,
  // 上游 prompt_tokens 含缓存分量：input_tokens 需扣除缓存读取与缓存写入（spec #14 / ticket #15）。
  promptTokensIncludeCache: true,
};