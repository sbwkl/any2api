// codebuddy 2Api provider 装配 — 路由：/codebuddy/v1/*、/codebuddy/healthz
import { loadCredentials, loadProductConfig } from "./config";
import { CodeBuddyFacade } from "./openai";

export async function createHandler(): Promise<(req: Request) => Promise<Response>> {
  const credentials = loadCredentials();
  const config = loadProductConfig();
  const facade = new CodeBuddyFacade(config, credentials, {
    deviceToken: process.env.CODEBUDDY_DEVICE_TOKEN || undefined,
  });

  console.log(`[codebuddy] 凭证就绪 uid=${credentials.uid.slice(0, 8)}... 来源=${credentials.source}`);
  console.log(`[codebuddy] 模型池: ${config.models.map((m) => m.id).join(", ")}`);
  console.log(`[codebuddy] 提示词: ${config.prompts.length} 个，agent: ${config.agents.map((a) => a.name).join(", ") || "(无)"}`);

  return async (req: Request) => {
    const path = new URL(req.url).pathname;
    if (path === "/codebuddy/v1/models" && req.method === "GET") return facade.handleModels();
    if (path === "/codebuddy/v1/models" && req.method !== "GET") return new Response("method not allowed", { status: 405 });
    if (path === "/codebuddy/v1/chat/completions" && req.method === "POST") return facade.handleChat(req);
    if (path === "/codebuddy/v1/chat/completions") return new Response("method not allowed", { status: 405 });
    if (path === "/codebuddy/healthz") return Response.json(facade.healthPayload());
    return new Response("not found", { status: 404 });
  };
}