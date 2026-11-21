// OpenAI 错误 type 与 HTTP 状态对齐：
// 401 → authentication_error；429 → rate_limit_error；其他 4xx → invalid_request_error；5xx → upstream_error。
export function errorTypeForStatus(status: number): string {
  if (status === 401) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "upstream_error";
}