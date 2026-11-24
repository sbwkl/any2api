export interface HttpResult {
  status: number;
  contentType: string;
  headers: Headers;
  text: string;
  durationMs: number;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  rawBody?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export async function httpRequest(baseUrl: string, path: string, opts: RequestOptions = {}): Promise<HttpResult> {
  const started = Date.now();
  const method = opts.method ?? (opts.body !== undefined || opts.rawBody !== undefined ? "POST" : "GET");
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "any2api-e2e/1",
    ...opts.headers,
  };

  let body: string | undefined;
  if (opts.rawBody !== undefined) {
    body = opts.rawBody;
    headers["content-type"] ??= "application/json";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
  });
  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    headers: res.headers,
    text,
    durationMs: Date.now() - started,
  };
}
