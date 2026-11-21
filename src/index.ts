// any2api — 各工具的 2Api 适配器注册入口
// 路由层只负责 provider 前缀分发；新增 provider 只需在注册表加一行。
import { mountProviders } from "./registry";
import { codeartsProvider } from "./providers/codearts";
import { codebuddyProvider } from "./providers/codebuddy";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

async function main(): Promise<void> {
  const handler = await mountProviders([codeartsProvider, codebuddyProvider]);
  const server = Bun.serve({
    port: PORT,
    hostname: HOST,
    idleTimeout: 255,
    fetch: handler,
  });
  console.log(`[any2api] 路由: /codearts/v1/* → codearts; /codebuddy/v1/* → codebuddy; http://${HOST}:${server.port}`);
}

main().catch((e) => {
  console.error(`[any2api] 启动失败: ${e?.message ?? e}`);
  process.exit(1);
});