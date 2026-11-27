// codebuddy 2Api provider — 注册表模块
// 路由：prefix=/codebuddy；相对路由由共享协议层 createProtocolRoutes 提供。
import { mountProviders, type ProviderModule, type ProviderInstance } from "../../registry";
import { createProtocolRoutes, type ChatBackend } from "../../protocols";
import { loadProductConfig } from "./config";
import { defaultCredentialSource, type CredentialSource } from "./credentials";
import { CodeBuddyFacade } from "./openai";
import { MsgCenterPoller } from "./msgcenter";
import type { Profile } from "./types";
import { serviceLogger } from "../../shared/log";

export interface CodebuddyProviderDeps {
  /** 注入凭证源（测试用）；缺省时生产默认走真实 loadCredentials（取源优先级不变） */
  credentialSource?: CredentialSource;
  /** 注入上游 fetch（测试用）；缺省时用全局 fetch */
  fetchImpl?: typeof fetch;
}

// 可注入构造入口：测试注入假凭证源 + 假 fetchImpl；生产以无参默认路径运行。
export function createCodebuddyProvider(deps: CodebuddyProviderDeps = {}): ProviderModule {
  return {
    name: "codebuddy",
    prefix: "/codebuddy",
    required: false,
    create: async (): Promise<ProviderInstance> => {
      // 生产默认：构造默认源时即加载真实凭证；注入凭证源时完全绕开真实加载。
      // T2：无凭证也挂载成功（「凭证未就绪」态），不再因缺凭证抛错被 registry 固化为 503。
      const source = deps.credentialSource ?? defaultCredentialSource();
      const credentials = source.get();
      // loadProductConfig 不依赖凭证：无 uid 时走本地/回退模型目录。
      const config = loadProductConfig(credentials?.uid);
      const facade = new CodeBuddyFacade(config, source, {
        deviceToken: process.env.CODEBUDDY_DEVICE_TOKEN || undefined,
        fetchImpl: deps.fetchImpl,
      });

    if (credentials) {
      serviceLogger.log(`[codebuddy] 凭证就绪 uid=${credentials.uid.slice(0, 8)}... 来源=${credentials.source}`);
    } else {
      serviceLogger.log("[codebuddy] 凭证未就绪：已挂载，等待登录后按需回源");
    }
    serviceLogger.log(`[codebuddy] 模型池: ${config.models.map((m) => m.id).join(", ")}`);
    serviceLogger.log(`[codebuddy] 提示词: ${config.prompts.length} 个，agent: ${config.agents.map((a) => a.name).join(", ") || "(无)"}`);

    if (process.env.CODEBUDDY_MSG_CENTER === "1") {
      const poller = new MsgCenterPoller({ config, getCredentials: () => facade.getCredentials() });
      poller.start();
      serviceLogger.log("[codebuddy] msg-center 轮询已开启（30s）");
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
}

// 生产默认 provider（无注入依赖）；src/index.ts 使用注册表。
export const codebuddyProvider: ProviderModule = createCodebuddyProvider();

// 单 provider 启动（调试/独立运行）；src/index.ts 使用注册表。
export async function createHandler(): Promise<(req: Request) => Promise<Response>> {
  return mountProviders([codebuddyProvider]);
}