// 凭证与模型池 — spec §1 凭证获取链 + benefit-service gateway/config（内核逐字语义）
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { signSl, signSh, type Credentials } from "./signer";
import { uuid32 } from "../../shared/ids";

export interface ModelInfo { modelId: string; modelName: string; endpoint: string }
export interface GatewayConfig { endpoint: string; models: ModelInfo[] }

const OPENGW_BASE = "https://opengw.developer.huaweicloud.com";
const SNAP_BASE = process.env.SNAP_ORIGIN ?? "https://snap-access.cn-north-4.myhuaweicloud.com";
const GATEWAY_CONFIG_PATH = "/api/v1/gateway/config";

export function loadCredentials(): Credentials {
  // 1) env（内核 resolveAkSk 同序：CODEARTS_CLI_* 先，HW_* 后）
  if (process.env.CODEARTS_CLI_AK && process.env.CODEARTS_CLI_SK)
    return { ak: process.env.CODEARTS_CLI_AK, sk: process.env.CODEARTS_CLI_SK, securityToken: "" };
  if (process.env.HW_ACCESS_KEY && process.env.HW_SECRET_KEY && process.env.HW_SECURITY_TOKEN)
    return { ak: process.env.HW_ACCESS_KEY, sk: process.env.HW_SECRET_KEY, securityToken: process.env.HW_SECURITY_TOKEN };
  // 2) state.vscdb snap 键（可能已过期——过期由 index.ts 的刷新链兜底，此处不抛）
  const fromDb = fromVscodeStateDb();
  if (fromDb) return fromDb;
  throw new Error(
    "未找到凭证：请设置 HW_ACCESS_KEY/HW_SECRET_KEY/HW_SECURITY_TOKEN（或 CODEARTS_CLI_AK/SK），" +
    "或确保码道 CodeArts Agent app 已登录（将自动提取 STS 凭证与 refresh_token）",
  );
}

// ---- 凭证持有器：刷新链可热替换当前凭证（openai/snap/telemetry 每次调用时动态读取）----
let CURRENT: Credentials | null = null;
export function setCredentials(c: Credentials): void { CURRENT = c; }
export function getCredentials(): Credentials {
  if (!CURRENT) CURRENT = loadCredentials();
  return CURRENT;
}

function fromRunningApp(): Credentials | null {
  return fromVscodeStateDb() ?? fromKernelHttp();
}

// 主路径：VSCode 扩展全局状态（huaweicloud.codearts-snap → userInfoKey.originData，内含 STS 全套）
// 过期不再抛错（返回带 expiresAt 的凭证，由刷新链决定续期）
function fromVscodeStateDb(): Credentials | null {
  try {
    const dbPath = `${homedir()}/Library/Application Support/CodeArts Agent/User/globalStorage/state.vscdb`;
    if (!existsSync(dbPath)) return null;
    const { Database } = require("bun:sqlite");
    const db = new Database(dbPath, { readonly: true });
    const row = db.query("SELECT value FROM ItemTable WHERE key='huaweicloud.codearts-snap'").get() as { value: string } | undefined;
    db.close();
    if (!row?.value) return null;
    const state = JSON.parse(row.value);
    const u = state?.userInfoKey?.originData;
    if (!u?.accessKey || !u?.secretKey) return null;
    const expiresAt = u.expiresAt ? new Date(u.expiresAt).toISOString() : undefined;
    const exp = expiresAt ? Date.parse(expiresAt) : Infinity;
    console.log(`[codearts] snap 键 STS 有效期至 ${expiresAt ?? "(未知)"}${exp < Date.now() ? "（已过期，等待刷新链续期）" : ""}`);
    return {
      ak: u.accessKey,
      sk: u.secretKey,
      securityToken: u.securityToken ?? "",
      domainId: u.domainId,
      expiresAt,
    };
  } catch {
    return null;
  }
}

// 兜底：内核 HTTP /global/config（部分版本返回 {}）
function fromKernelHttp(): Credentials | null {
  try {
    const base = `${homedir()}/.codeartsdoer/CodeArts_Agent`;
    if (!existsSync(base)) return null;
    let port: string | null = null;
    for (const entry of readdirSync(base)) {
      if (!entry.startsWith("Vscode_")) continue;
      const p = `${base}/${entry}/server_config.properties`;
      if (!existsSync(p)) continue;
      const m = readFileSync(p, "utf8").match(/^port=(\d+)/m);
      if (m) { port = m[1]; break; }
    }
    if (!port) return null;
    const pgrep = Bun.spawnSync(["/bin/sh", "-c", "pgrep -f AgentKernel | head -1"]);
    const pid = pgrep.stdout.toString().trim();
    if (!pid) return null;
    const ps = Bun.spawnSync(["/bin/sh", "-c", `ps eww ${pid} | tr ' ' '\\n' | grep '^OPENCODE_SERVER_PASSWORD=' | cut -d= -f2-`]);
    const password = ps.stdout.toString().trim();
    if (!password) return null;
    const cfg = Bun.spawnSync(["/bin/sh", "-c",
      `curl -sf -H "Authorization: Basic ${btoa(`codearts:${password}`)}" http://127.0.0.1:${port}/global/config`]);
    if (cfg.exitCode !== 0) return null;
    const data = JSON.parse(cfg.stdout.toString());
    const ui = data.userInfo ?? {};
    if (!ui.accessKeyId || !ui.secretAccessKey) return null;
    return {
      ak: ui.accessKeyId, sk: ui.secretAccessKey, securityToken: ui.accessToken ?? "",
      userToken: data.userToken, domainId: ui.domainId,
      origin: data.inferhubBaseUrl ? new URL(data.inferhubBaseUrl).origin : undefined,
    };
  } catch {
    return null;
  }
}

// Policy Center policy/bundle（商用版真实模型列表下发端点，逐字对照扩展 getPolicyCenterConfig）：
// POST {policyDomain}/v1/policy/bundle，Agent-Type: PromptCenter；商业版 x-auth-token 为空串
// （"Hc version, token is transferred by the toolkit"），认证靠 provider 层 AKSK 签名。
// 响应 plugin_config[].config(JSON 字符串数组) 各 agent 段含 user_model_list，取首段主模型池。
export async function fetchPolicyModels(creds: Credentials): Promise<ModelInfo[]> {
  const url = `${SNAP_BASE}/v1/policy/bundle`;
  const body = {
    ide: "CodeArts Agent",
    application: "CodeArts Agent",
    plugin_name: "snap_vscode",
    plugin_version: "5.0.0",
  };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Language": "zh-cn",
    "x-snap-traceid": uuid32(),
    "Agent-Type": "PromptCenter",
    "x-auth-token": "",
  };
  const signed = signSh({ method: "POST", endpoint: url, data: body, headers }, creds);
  const resp = await fetch(url, { method: "POST", headers: signed, body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`policy/bundle HTTP ${resp.status}`);
  const json = await resp.json() as any;
  for (const item of json?.plugin_config ?? []) {
    let cfg: any = item?.config;
    if (typeof cfg === "string") { try { cfg = JSON.parse(cfg); } catch { continue; } }
    if (!Array.isArray(cfg)) continue;
    for (const seg of cfg) {
      if (!Array.isArray(seg?.user_model_list)) continue;
      const models: ModelInfo[] = [];
      for (const m of seg.user_model_list) {
        if (!m?.model_id) continue;
        models.push({ modelId: m.model_id, modelName: m.model_name || m.model_id, endpoint: "" });
      }
      if (models.length) return models;
    }
  }
  throw new Error("policy/bundle 响应中无 user_model_list");
}

// 模型发现：policy/bundle（真实客户端机制）优先，失败回退观测池
export async function discoverModels(creds: Credentials): Promise<GatewayConfig> {
  try {
    const models = await fetchPolicyModels(creds);
    return { endpoint: "", models };
  } catch (e: any) {
    console.warn(`[codearts] policy/bundle 不可用（${e?.message ?? e}），使用观测模型池`);
    return {
      endpoint: "",
      models: [
        { modelId: "glm-5.3-flash", modelName: "GLM-5.3-Flash", endpoint: "" },
        { modelId: "deepseek-v4.1-flash", modelName: "DeepSeek-V4.1-Flash", endpoint: "" },
      ],
    };
  }
}

// benefit-service getGatewayConfig（内核逐字语义）：GET opengw /api/v1/gateway/config
// 头：Content-Type: application/json + x-snap-traceid(uuid32) + X-Security-token；sl.sign（EMPTY body hash）
// 注：需渠道订阅（普通账号报 invalid channel），真实客户端拉模型列表不用此端点，保留供参考。
export async function fetchGatewayConfig(creds: Credentials): Promise<GatewayConfig> {
  const url = `${OPENGW_BASE}${GATEWAY_CONFIG_PATH}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-snap-traceid": uuid32(),
  };
  if (creds.securityToken) headers["X-Security-token"] = creds.securityToken;
  const signed = signSl({ method: "GET", endpoint: url, headers }, creds);
  const resp = await fetch(url, { method: "GET", headers: signed });
  const body = await resp.json().catch(() => null) as any;
  if (body?.error_code !== "0000" || !body?.result) {
    // 福利模型端点需要渠道上下文（无福利订阅时报 invalid channel, group not found）。
    // 真实客户端此时也拿不到该池，回退到内核观测到的默认模型。
    console.warn(`[codearts] gateway/config 不可用（${body?.error_msg ?? resp.status}），使用观测模型池`);
    return {
      endpoint: "",
      models: [
        { modelId: "glm-5.3-flash", modelName: "GLM-5.3-Flash", endpoint: "" },
        { modelId: "deepseek-v4.1-flash", modelName: "DeepSeek-V4.1-Flash", endpoint: "" },
      ],
    };
  }
  const endpoint = body.result.endpoint || body.result.base_url;
  const models: ModelInfo[] = [];
  if (Array.isArray(body.result.models)) {
    for (const m of body.result.models) {
      if (!m.model_id) continue;
      models.push({ modelId: m.model_id, modelName: m.model_name || m.model_alias || m.model_id, endpoint });
    }
  }
  if (!models.length) {
    console.warn("[codearts] gateway/config 未返回模型池，使用观测模型池");
    return {
      endpoint,
      models: [
        { modelId: "glm-5.3-flash", modelName: "GLM-5.3-Flash", endpoint },
        { modelId: "deepseek-v4.1-flash", modelName: "DeepSeek-V4.1-Flash", endpoint },
      ],
    };
  }
  return { endpoint, models };
}
