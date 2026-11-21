// Provider 注册表与路由分发 — 对应 RFC-0001 的 provider 边界重构
// 路由层只回答：哪个前缀、交给谁、失败怎么退化；provider 不再知道自己的公开前缀。

export interface Route {
  method: string;
  /** 相对 provider 挂载点的路径，如 "/v1/chat/completions" */
  path: string;
  handle: (req: Request) => Response | Promise<Response>;
}

export interface HealthStatus {
  ok: boolean;
  [key: string]: unknown;
}

export interface ProviderInstance {
  routes: Route[];
  health?: () => HealthStatus | Promise<HealthStatus>;
}

export interface ProviderModule {
  name: string;
  /** "" = 默认 provider；"/codebuddy" = 挂载到该前缀 */
  prefix: string;
  /** 启动失败时：true → 抛出（进程退出）；false/缺省 → 该前缀返回 503 */
  required?: boolean;
  create: () => Promise<ProviderInstance>;
}

interface MountedProvider {
  module: ProviderModule;
  instance?: ProviderInstance;
  error?: string;
}

function matchesPrefix(path: string, prefix: string): boolean {
  if (!prefix) return true;
  return path === prefix || path.startsWith(prefix + "/");
}

function stripPrefix(path: string, prefix: string): string {
  if (!prefix) return path;
  if (path === prefix) return "/";
  return path.slice(prefix.length);
}

function providerUnavailable(name: string, error?: string): Response {
  return Response.json(
    { error: { message: `provider ${name} unavailable${error ? `: ${error}` : ""}`, type: "provider_unavailable" } },
    { status: 503 },
  );
}

async function healthResponse(mounted: MountedProvider[]): Promise<Response> {
  const providers = await Promise.all(mounted.map(async (m) => {
    if (!m.instance) return { provider: m.module.name, ok: false, error: m.error };
    try {
      const h = await m.instance.health?.();
      return { provider: m.module.name, ...(h ?? { ok: true }) };
    } catch (e: any) {
      return { provider: m.module.name, ok: false, error: e?.message ?? String(e) };
    }
  }));
  return Response.json({ ok: providers.every((p) => p.ok), providers });
}

export async function mountProviders(modules: ProviderModule[]): Promise<(req: Request) => Promise<Response>> {
  const mounted: MountedProvider[] = [];
  for (const module of modules) {
    try {
      const instance = await module.create();
      mounted.push({ module, instance });
      console.log(`[any2api] provider ${module.name} ready (prefix='${module.prefix || "/"}', routes=${instance.routes.length})`);
    } catch (e: any) {
      const message = e?.message ?? String(e);
      if (module.required) throw e;
      console.error(`[any2api] provider ${module.name} unavailable: ${message}`);
      mounted.push({ module, error: message });
    }
  }

  return async (req) => {
    const path = new URL(req.url).pathname;

    // 聚合健康检查（/healthz 由路由层统一处理，provider 不再各自暴露根路径）
    if (req.method === "GET" && path === "/healthz") {
      return healthResponse(mounted);
    }

    // 最长前缀 + 路径边界匹配；剥离前缀后在 provider 内匹配相对路由。
    const candidates = mounted
      .map((m) => ({ m, prefix: m.module.prefix }))
      .filter((x) => matchesPrefix(path, x.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length);

    for (const { m, prefix } of candidates) {
      const rel = stripPrefix(path, prefix);
      if (!m.instance) return providerUnavailable(m.module.name, m.error);
      const route = m.instance.routes.find((r) => r.path === rel && r.method === req.method);
      if (route) return route.handle(req);
      const pathExists = m.instance.routes.some((r) => r.path === rel);
      if (pathExists) return new Response("method not allowed", { status: 405 });
      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  };
}