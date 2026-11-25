// codebuddy 2Api provider — 注册表模块
// 路由：prefix=/codebuddy；相对路由由共享协议层 createProtocolRoutes 提供。
import { mountProviders, type ProviderModule, type ProviderInstance } from "../../registry";
import { createProtocolRoutes, type ChatBackend } from "../../protocols";
import { loadCredentials, loadProductConfig } from "./config";
import { CodeBuddyFacade } from "./openai";
import { MsgCenterPoller } from "./msgcenter";
import type { Profile } from "./types";

export const codebuddyProvider: ProviderModule = {
  name: "codebuddy",
  prefix: "/codebuddy",
  required: false,
  create: async (): Promise<ProviderInstance> => {
    const credentials = loadCredentials();
    const config = loadProductConfig(credentials.uid);
    const facade = new CodeBuddyFacade(config, credentials, {
      deviceToken: process.env.CODEBUDDY_DEVICE_TOKEN || undefined,
    });

    console.log(`[codebuddy] 凭证就绪 uid=${credentials.uid.slice(0, 8)}... 来源=${credentials.source}`);
    console.log(`[codebuddy] 模型池: ${config.models.map((m) => m.id).join(", ")}`);
    console.log(`[codebuddy] 提示词: ${config.prompts.length} 个，agent: ${config.agents.map((a) => a.name).join(", ") || "(无)"}`);

    if (process.env.CODEBUDDY_MSG_CENTER === "1") {
      const poller = new MsgCenterPoller({ config, getCredentials: () => facade.getCredentials() });
      poller.start();
      console.log("[codebuddy] msg-center 轮询已开启（30s）");
    }

    const backend: ChatBackend = {
      models: () => facade.modelsPayload().data,
      health: () => facade.healthPayload(),
      profileFor: (req) => facade.profileFor(req),
      handleChat: (req) => facade.handleChat(req),
      respond: (body, opts) => facade.respond(body, opts.stream, opts.sessionKey, (opts.profile as Profile) ?? "chat"),
    };

    return {
      routes: createProtocolRoutes(backend, {
        toolChoice: "auto-only",
        normalizeErrors: true,
        thinking: true,
        thinkingToEffort: true,
        promptTokensIncludeCache: true,
      }),
      health: () => facade.healthPayload(),
    };
  },
};

// 单 provider 启动（调试/独立运行）；src/index.ts 使用注册表。
export async function createHandler(): Promise<(req: Request) => Promise<Response>> {
  return mountProviders([codebuddyProvider]);
}