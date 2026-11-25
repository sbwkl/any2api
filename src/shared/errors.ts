// 错误类型与上游错误分类。
// OpenAI 与 Anthropic 各有一套合法的 error.type 词汇，不能共用一个 catch-all：
// - OpenAI：invalid_request_error / authentication_error / permission_error /
//   not_found_error / rate_limit_error / server_error
// - Anthropic：invalid_request_error / authentication_error / permission_error /
//   not_found_error / request_too_large / rate_limit_error / api_error / overloaded_error
// 历史上双方都用非标准的 upstream_error，SDK 只能当作未知错误，且无法区分可重试性。
export function errorTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "server_error";
}

export function anthropicErrorTypeForStatus(status: number): string {
  if (status === 400) return "invalid_request_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 404) return "not_found_error";
  if (status === 413) return "request_too_large";
  if (status === 429) return "rate_limit_error";
  if (status === 529) return "overloaded_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

// 上游把 HTTP 状态藏进错误文本（codearts 实测：`InferHub.…400:`、`TM.…: 415`、
// `ModelArts.81101.429:`）。只认独立的 4xx/5xx 三段码，避免把 request-id/计数误判。
const EMBEDDED_STATUS = /(?:^|[^0-9])([45][0-9]{2})(?=$|[^0-9])/;

export function classifyUpstreamStatus(message: string): number {
  const m = EMBEDDED_STATUS.exec(message ?? "");
  if (m) return Number(m[1]);
  if (/rate limit|too many requests/i.test(message ?? "")) return 429;
  if (/timeout|timed out|ETIMEDOUT|APIG\.0203/i.test(message ?? "")) return 504;
  if (/ECONNRESET|socket connection was closed|ECONNREFUSED|EPIPE|network/i.test(message ?? "")) return 502;
  if (/unsupported media type/i.test(message ?? "")) return 415;
  if (/request param is invalid|参数校验失败|invalid request/i.test(message ?? "")) return 400;
  return 502;
}

// Responses 的 error.code 词汇与 HTTP 状态不同：429 用 rate_limit_exceeded，
// 其余 4xx 归 invalid_request_error，5xx/连接失败归 server_error。
export function responsesErrorCodeForStatus(status: number): string {
  if (status === 429) return "rate_limit_exceeded";
  if (status >= 500) return "server_error";
  return "invalid_request_error";
}

/** 分类为 5xx 的上游错误视为瞬时故障：调用方尚未向客户端发送字节时可安全重试一次。 */
export function isTransientUpstreamMessage(message: string): boolean {
  return classifyUpstreamStatus(message) >= 500;
}

/** 从上游错误响应体（JSON 或纯文本）中提取可读 message；空体返回 null。 */
export function extractUpstreamErrorMessage(text: string): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  try {
    const j: any = JSON.parse(raw);
    const message = j?.error?.message ?? j?.error?.msg ?? j?.error_msg ?? j?.message ?? j?.msg;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // 非 JSON：按纯文本透出前 500 字符
  }
  return raw.slice(0, 500);
}

export function anthropicErrorTypeForMessage(message: string): string {
  return anthropicErrorTypeForStatus(classifyUpstreamStatus(message));
}

// 代理自身生成（非上游转发）的错误响应标记：协议层据此把错误信封转成请求方协议的形状，
// 即使 provider 配置了 normalizeErrors=false（该开关只表示「上游错误原样透传」）。
export const PROXY_ERROR_HEADER = "x-any2api-error-source";