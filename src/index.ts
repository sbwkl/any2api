// any2api — 各工具的 2Api 适配器注册入口
// 每个适配器是一个独立 provider（src/providers/<name>/），对外统一暴露 OpenAI 兼容 API。
// 路由：/v1/* → codearts（默认，向后兼容）；/codebuddy/v1/* → codebuddy。
import { createHandler as createCodeartsHandler } from "./providers/codearts";
import { createHandler as createCodebuddyHandler } from "./providers/codebuddy";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const codearts = await createCodeartsHandler();

  let codebuddy: (req: Request) => Promise<Response>;
  try {
    codebuddy = await createCodebuddyHandler();
  } catch (e: any) {
    const message = e?.message ?? String(e);
    console.error(`[any2api] codebuddy provider 不可用: ${message}`);
    codebuddy = async () =>
      Response.json(
        { error: { message: `codebuddy provider 不可用: ${message}`, type: "provider_unavailable" } },
        { status: 503 },
      );
  }

  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 255,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/codebuddy" || path.startsWith("/codebuddy/")) return codebuddy(req);
      return codearts(req);
    },
  });
  console.log(`[any2api] 路由: /v1/* → codearts; /codebuddy/v1/* → codebuddy; http://${HOST}:${server.port}`);
}

main().catch((e) => {
  console.error(`[any2api] 启动失败: ${e?.message ?? e}`);
  process.exit(1);
});