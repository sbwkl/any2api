// OpenAI 错误 type 与 HTTP 状态对齐：
// 401 → authentication_error；429 → rate_limit_error；其他 4xx → invalid_request_error；5xx → upstream_error。
export function errorTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "upstream_error";
}

// 代理自身生成（非上游转发）的错误响应标记：协议层据此把错误信封转成请求方协议的形状，
// 即使 provider 配置了 normalizeErrors=false（该开关只表示「上游错误原样透传」）。
export const PROXY_ERROR_HEADER = "x-any2api-error-source";