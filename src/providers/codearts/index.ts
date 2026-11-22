// codearts 2Api 适配器 — 码道 CodeArts Agent → OpenAI 兼容 API
// 协议规格见 protocol-spec.md（真实头全息样本 §0、双签名器 §2、SM4-GCM §3…）
import { loadCredentials, discoverModels, setCredentials, type Credentials } from "./config";
import { SnapClient } from "./snap";
import { OpenAIFacade } from "./openai";
import { TelemetrySimulator } from "./telemetry";
import { signSh } from "./signer";
import {
  credentialsFromSecretSession,
  refreshNow,
  startCredentialMaintainer,
} from "./refresher";
import { createProtocolRoutes, type ChatBackend } from "../../protocols";
import { mountProviders, type ProviderModule, type ProviderInstance } from "../../registry";

const PORT = Number(process.env.PORT ?? 8787);

async function resolveInitialCredentials() {
  // snap 键过期/缺失不阻断启动：SecretStorage lineage（refresh_token）仍可续期恢复
  let bootstrap: Credentials | null = null;
  try {
    bootstrap = loadCredentials();
  } catch (e: any) {
    console.warn(`[codearts] snap 键凭证不可用：${e?.message ?? e}`);
  }
  const secretCreds = credentialsFromSecretSession();
  if (!bootstrap && !secretCreds)
    throw new Error("未找到凭证：请先打开码道 CodeArts Agent 登录一次（代理会自动提取 STS 与刷新凭据）");
  let creds = (bootstrap ?? secretCreds)!;
  // 择优：取更新鲜者
  if (bootstrap && secretCreds) {
    const s = secretCreds.expiresAt ? Date.parse(secretCreds.expiresAt) : Infinity;
    const b = bootstrap.expiresAt ? Date.parse(bootstrap.expiresAt) : -1;
    if (s >= b) creds = secretCreds;
  }
  setCredentials(creds);
  // 启动时过期 → 立即刷新（需 SecretStorage lineage 可用）
  if (!creds.expiresAt || Date.parse(creds.expiresAt) <= Date.now()) {
    if (!secretCreds?.refreshToken)
      throw new Error("STS 已过期且无刷新凭据：请打开码道 CodeArts Agent 重新登录");
    console.log("[codearts] STS 已过期，尝试自动刷新…");
    creds = await refreshNow();
  }
  return creds;
}

// 装配 codearts provider；路由路径相对挂载点，由注册表负责前缀分发。
export async function createProvider(): Promise<ProviderInstance> {
  const creds = await resolveInitialCredentials();
  console.log(`[codearts] 凭证就绪 ak=${creds.ak.slice(0, 8)}... 有效期至 ${creds.expiresAt ?? "(env 静态凭证)"}`);

  startCredentialMaintainer(); // 每 60s：采纳 app 续期 / 余量 <30min 时自动续期

  // 模型发现（§7.4 步骤 2）：policy/bundle 动态下发，失败回退观测池
  const gw = await discoverModels(creds);
  console.log(`[codearts] 模型池: ${gw.models.map((m) => m.modelId).join(", ")} endpoint=${gw.endpoint}`);

  const snapOrigin = creds.origin ?? process.env.SNAP_ORIGIN ?? "https://snap-access.cn-north-4.myhuaweicloud.com";
  const snap = new SnapClient(snapOrigin);
  const telemetry = new TelemetrySimulator(process.env.OTLP_ENABLED !== "false", process.env.OTLP_SERVICE_NAME ?? "codeagent-kernel");

  // 启动旁路信号：statistics/plugin（真实客户端启动/git-ai 判定时调用）
  fetch(`${snapOrigin}/snap-manager/v1/statistics/plugin`, {
    method: "GET",
    headers: signSh(
      { method: "GET", endpoint: `${snapOrigin}/snap-manager/v1/statistics/plugin`, headers: { "Content-Type": "application/json" } },
      creds,
    ),
  }).then((r) => console.log(`[codearts] statistics/plugin -> ${r.status}`)).catch(() => {});

  const facade = new OpenAIFacade(snap, gw, telemetry);

  const backend: ChatBackend = {
    models: () => facade.modelsPayload().data,
    health: () => ({ ok: true }),
    handleChat: (req) => facade.handleChat(req),
    respond: (body, opts) => facade.respond(body, opts.stream, opts.sessionKey),
  };
  // codearts：full tool_choice（支持 required/forced function），错误透传上游响应。
  const routes = createProtocolRoutes(backend, {
    toolChoice: "full",
    normalizeErrors: false,
    thinkingToEffort: false,
  });
  return { routes, health: () => ({ ok: true }) };
}

export const codeartsProvider: ProviderModule = {
  name: "codearts",
  prefix: "/codearts",
  required: true,
  create: createProvider,
};

export async function start(): Promise<void> {
  const handler = await mountProviders([codeartsProvider]);
  const server = Bun.serve({
    port: PORT,
    // 生产默认只监听本机回环；需要局域网访问时设 HOST=0.0.0.0（注意：服务无鉴权，勿暴露公网）
    hostname: process.env.HOST ?? "127.0.0.1",
    idleTimeout: 255,
    fetch: handler,
  });
  console.log(`[codearts] OpenAI 兼容端点: http://127.0.0.1:${server.port}/codearts/v1 (POST /codearts/v1/chat/completions, GET /codearts/v1/models)`);
  console.log(`[codearts] 提示: OpenAI SDK baseUrl=http://127.0.0.1:${server.port}/codearts/v1  api-key=任意非空串`);
}
