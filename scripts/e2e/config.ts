import type { ProviderName } from "./types";

const PROVIDERS: ProviderName[] = ["codearts", "codebuddy"];
const DEFAULT_PREFERENCE = ["GLM-5.3-Flash", "DeepSeek-v4.1-Flash(1017)"];

export interface E2EConfig {
  maxCalls: number;
  providers: ProviderName[];
  modelPreference: string[];
  modelFallback?: string;
  record: boolean;
  baseline: boolean;
  timeoutMs: number;
  port: number;
  fixturesDir: string;
  reportsDir: string;
  imageUrl?: string;
  only?: string;
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

function parsePositiveInt(name: string, raw: string | undefined, def: number): number {
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} 必须是正整数（当前: ${JSON.stringify(raw)}）`);
  return n;
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`E2E_PORT 必须是 0..65535 的整数（当前: ${JSON.stringify(raw)}）`);
  return n;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  argv: string[] = process.argv.slice(2),
): E2EConfig {
  const rawProviders = parseList(env.E2E_PROVIDERS);
  const providers = (rawProviders.length ? rawProviders : [...PROVIDERS]) as ProviderName[];
  for (const p of providers) {
    if (!PROVIDERS.includes(p)) throw new Error(`E2E_PROVIDERS 含未知 provider: ${p}（可选: ${PROVIDERS.join(", ")}）`);
  }

  const preference = parseList(env.E2E_MODEL_PREFERENCE);

  return {
    maxCalls: parsePositiveInt("E2E_MAX_CALLS", env.E2E_MAX_CALLS, 40),
    providers,
    modelPreference: preference.length ? preference : [...DEFAULT_PREFERENCE],
    modelFallback: env.E2E_MODEL_FALLBACK?.trim() || undefined,
    record: env.E2E_RECORD === "1" || argv.includes("--record"),
    baseline: argv.includes("--baseline"),
    timeoutMs: parsePositiveInt("E2E_TIMEOUT_MS", env.E2E_TIMEOUT_MS, 120000),
    port: parsePort(env.E2E_PORT),
    fixturesDir: env.E2E_FIXTURES_DIR?.trim() || "e2e/fixtures",
    reportsDir: env.E2E_REPORTS_DIR?.trim() || "e2e/reports",
    imageUrl: env.E2E_IMAGE_URL?.trim() || undefined,
    only: env.E2E_ONLY?.trim() || undefined,
  };
}
