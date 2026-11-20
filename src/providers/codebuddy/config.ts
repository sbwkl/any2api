// 凭证、模型目录与提示词加载 — 对应 RFC-0001 §5.2/§5.3/§5.7
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";
import { Database } from "bun:sqlite";
import type { Credentials, ModelInfo, ProductConfig, Profile, PromptEntry, AgentEntry } from "./types";

export const DEFAULT_ENDPOINT = "https://copilot.tencent.com";
export const DEFAULT_GENIE_HOME = "/Applications/CodeBuddy CN.app/Contents/Resources/app/extensions/genie";

const KEYCHAIN_SERVICE = "CodeBuddy CN Safe Storage";
const STORAGE_KEY = `secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessTokencn"}`;

const FALLBACK_MODELS: ModelInfo[] = [
  { id: "hy4flash-free", name: "Hy4 flash", maxOutputTokens: 64000, maxInputTokens: 960000, supportsToolCall: true, supportsReasoning: true, contextLength: 960000, temperature: 0.9 },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
  { id: "hy3", name: "Hunyuan 3" },
  { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "gpt-5.4", name: "GPT-5.4" },
];

function readJson(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------- 凭证 ----------

function fromSessionJson(raw: string): Credentials | null {
  try {
    let text = raw.trim();
    if (!text.startsWith("{")) text = Buffer.from(text, "base64").toString("utf8");
    const o = JSON.parse(text);
    const auth = o.auth ?? {};
    const account = o.account ?? {};
    const accessToken = auth.accessToken ?? o.accessToken;
    const uid = account.uid ?? o.uid;
    if (!accessToken || !uid) return null;
    return {
      accessToken,
      refreshToken: auth.refreshToken ?? o.refreshToken,
      uid,
      domain: auth.domain ?? o.domain,
      expiresAt: auth.expiresAt ?? o.expiresAt,
      source: "session-json",
    };
  } catch {
    return null;
  }
}

function values(plaintext: string, jsonKey: string): string[] {
  const out: string[] = [];
  const pat = `"${jsonKey}":"`;
  let p = 0;
  while ((p = plaintext.indexOf(pat, p)) >= 0) {
    const start = p + pat.length;
    let end = start;
    while (end < plaintext.length && plaintext[end] !== '"') end++;
    out.push(plaintext.slice(start, end));
    p = end + 1;
  }
  return out;
}

function extractSessionFields(plaintext: string): Credentials | null {
  const uid = values(plaintext, "uid")[0];
  if (!uid) return null;
  const tokens = values(plaintext, "accessToken");
  const raw = tokens.find((t) => !t.includes("+")) ?? tokens[0];
  if (!raw) return null;
  const refreshToken = values(plaintext, "refreshToken")[0];
  const domain = values(plaintext, "domain").find((d) => d.includes("."));
  const exp = [...plaintext.matchAll(/"expiresAt":(\d+)/g)].map((m) => Number(m[1]));
  return {
    accessToken: raw,
    refreshToken,
    uid,
    domain,
    expiresAt: exp.length ? Math.max(...exp) : undefined,
    source: "keychain",
  };
}

// VSCode/Chromium safeStorage（macOS）：v10 + 16B IV + AES-128-CBC(PKCS7)，
// key = PBKDF2(Keychain 密码, "saltysalt", 1003, 16, SHA1)。
function decryptSafeStorage(blob: Buffer, password: string): string {
  if (blob.subarray(0, 3).toString("utf8") !== "v10") throw new Error("not a v10 safeStorage blob");
  const iv = blob.subarray(3, 19);
  const ct = blob.subarray(19);
  const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  const d = createDecipheriv("aes-128-cbc", key, iv);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function readSecretBlob(dbPath: string, key: string): Buffer | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT value FROM ItemTable WHERE key=?").get(key) as { value: string } | undefined;
    if (!row?.value) return null;
    try {
      const outer = JSON.parse(row.value);
      if (outer?.type === "Buffer" && Array.isArray(outer.data)) return Buffer.from(outer.data);
    } catch {
      // 不是 {"type":"Buffer","data":[...]} 包装
    }
    return Buffer.from(row.value, "base64");
  } finally {
    db.close();
  }
}

export function loadCredentials(): Credentials {
  if (process.env.CODEBUDDY_SESSION_JSON) {
    const c = fromSessionJson(process.env.CODEBUDDY_SESSION_JSON);
    if (c) return c;
  }
  if (process.env.CODEBUDDY_TOKEN) {
    const uid = process.env.CODEBUDDY_UID;
    if (!uid) throw new Error("CODEBUDDY_TOKEN 已设置但缺少 CODEBUDDY_UID");
    return {
      accessToken: process.env.CODEBUDDY_TOKEN,
      refreshToken: process.env.CODEBUDDY_REFRESH_TOKEN,
      uid,
      domain: process.env.CODEBUDDY_DOMAIN,
      source: "env",
    };
  }

  const dbPath = process.env.CODEBUDDY_STATE_DB
    ?? `${homedir()}/Library/Application Support/CodeBuddy CN/User/globalStorage/state.vscdb`;
  const pwRes = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"]);
  if (pwRes.exitCode === 0) {
    const password = pwRes.stdout.toString().trim();
    const blob = password ? readSecretBlob(dbPath, STORAGE_KEY) : null;
    if (blob) {
      const plaintext = decryptSafeStorage(blob, password);
      const creds = extractSessionFields(plaintext);
      if (creds?.accessToken && creds.uid) return creds;
    }
  }

  throw new Error(
    "未找到 CodeBuddy 凭证：请在 CodeBuddy CN 登录一次（代理会从 Keychain + state.vscdb 提取），" +
    "或设置 CODEBUDDY_TOKEN / CODEBUDDY_UID / CODEBUDDY_REFRESH_TOKEN 环境变量",
  );
}

// ---------- 产品配置 / 模型 / 提示词 ----------

function mapModels(rawModels: any[], agents: AgentEntry[]): ModelInfo[] {
  const out = new Map<string, ModelInfo>();
  for (const m of rawModels ?? []) {
    if (!m?.id) continue;
    out.set(m.id, {
      id: m.id,
      name: m.name || m.id,
      vendor: m.vendor,
      maxOutputTokens: m.maxOutputTokens,
      maxInputTokens: m.maxInputTokens,
      supportsToolCall: m.supportsToolCall,
      supportsReasoning: m.supportsReasoning ?? m.onlyReasoning,
      contextLength: m.maxInputTokens,
      temperature: m.temperature,
      tags: m.tags,
    });
  }
  for (const a of agents ?? []) {
    for (const id of a.models ?? []) {
      if (!out.has(id)) out.set(id, { id, name: id });
    }
  }
  if (!out.has("hy4flash-free")) {
    const observed = FALLBACK_MODELS.find((m) => m.id === "hy4flash-free")!;
    out.set(observed.id, observed);
  }
  return [...out.values()];
}

export function loadProductConfig(): ProductConfig {
  const home = process.env.CODEBUDDY_GENIE_HOME ?? DEFAULT_GENIE_HOME;
  const raw = readJson(`${home}/product.json`);
  const pkg = readJson(`${home}/package.json`);
  if (!raw) {
    return {
      endpoint: DEFAULT_ENDPOINT,
      productName: "CodeBuddy",
      platform: "CodeBuddyIDE",
      deploymentType: "SaaS",
      version: pkg?.version ?? "0.0.0",
      models: FALLBACK_MODELS.slice(),
      agents: [],
      prompts: [],
    };
  }
  const agents: AgentEntry[] = Array.isArray(raw.agents)
    ? raw.agents.map((a: any) => ({
        name: a.name,
        description: a.description,
        instructions: a.instructions,
        models: Array.isArray(a.models) ? a.models : undefined,
        tools: Array.isArray(a.tools) ? a.tools : undefined,
      }))
    : [];
  const prompts: PromptEntry[] = Array.isArray(raw.prompts)
    ? raw.prompts.filter((p: any) => typeof p?.template === "string").map((p: any) => ({
        name: p.name,
        template: p.template,
        tags: Array.isArray(p.tags) ? p.tags : undefined,
      }))
    : [];
  return {
    endpoint: raw.endpoint ?? DEFAULT_ENDPOINT,
    productName: raw.productName ?? "CodeBuddy",
    platform: raw.platform ?? "CodeBuddyIDE",
    deploymentType: raw.deploymentType ?? "SaaS",
    version: pkg?.version ?? "0.0.0",
    models: mapModels(raw.models, agents),
    agents,
    prompts,
    authentication: raw.authentication,
  };
}

export function selectPrompt(prompts: PromptEntry[], name: string, modelId: string): PromptEntry | undefined {
  const candidates = prompts.filter((p) => p.name === name);
  if (!candidates.length) return undefined;
  const tagged = candidates.find((p) => p.tags?.some((t) => modelId === t || modelId.startsWith(t)));
  if (tagged) return tagged;
  return candidates.find((p) => !p.tags || p.tags.length === 0) ?? candidates[0];
}

export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{#[\s\S]*?#\}/g, "")
    .replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

// 生成 IDE 的系统提示词信封。chat profile 对应 IDE 的 chat agent（无 instructions）。
export function buildAgentPrompt(config: ProductConfig, profile: Profile, model: ModelInfo): string | undefined {
  if (profile === "chat") return undefined;
  let name = profile === "ask" ? "ask-agent-prompt" : "craft-agent-prompt";
  if (profile === "craft" && process.env.CODEBUDDY_TODO === "1") name = "craft-agent-prompt-with-todo";
  const prompt = selectPrompt(config.prompts, name, model.id);
  if (!prompt) return undefined;
  const vars: Record<string, string> = {
    ModelNamePrompt: ` powered by ${model.name} model`,
    SafetyPrompt: "",
    ModelSpecialPrompt: "",
    subAgentPrompt: "",
    CodebaseSearchContext: "",
    AgentsArtifactsPrompt: "",
    ResultPresentationPrompt: "",
    ToolResultPresentationPrompt: "",
    ClawMemory_1: "",
    ClawMemory_2: "",
    ClawMemory_3: "",
    WorkingMemoryContent: "",
    UserMemoryContent: "",
  };
  const body = renderPrompt(prompt.template, vars).trim();
  let out = `<system_prompt>\n${body}\n</system_prompt>`;
  if (vars.SafetyPrompt) out += `\n<special_instructions>\n${vars.SafetyPrompt}\n</special_instructions>`;
  return out;
}

export function resolveModel(models: ModelInfo[], name?: string): ModelInfo {
  if (!name) return models[0] ?? FALLBACK_MODELS[0];
  const lower = name.toLowerCase();
  return (
    models.find((m) => m.id.toLowerCase() === lower)
    ?? models.find((m) => m.name.toLowerCase() === lower)
    ?? models.find((m) => m.id.toLowerCase().includes(lower) || lower.includes(m.id.toLowerCase()))
    ?? { id: name, name }
  );
}