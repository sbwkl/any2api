// STS 自动刷新 — 复刻 huaweicloud.authentication 扩展的 renewAndReuseSession 流程：
// 凭证源 = state.vscdb 中加密的 HuaweiCloudSession（SecretStorage 经 Electron safeStorage 落盘），
// 刷新 = POST https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens
//        （form: client_id/code_verifier/grant_type=refresh_token/refresh_token + DPoP ES256 JWT）
// 成功后把轮换后的 refresh_token 回写 SecretStorage（扩展多窗口语义：后续 renew 读到新 lineage）。
import { Database } from "bun:sqlite";
import { createDecipheriv, createCipheriv, pbkdf2Sync, randomBytes } from "crypto";
import { homedir } from "os";
import type { Credentials } from "./signer";
import { setCredentials } from "./config";
import { traceUpstream, type FetchLike } from "../../shared/trace";

// 内核常量（逐字对照 authentication 扩展）
const IAM_TOKEN_API = "/v1/oauth2/tokens";
const CLIENT_ID = "codearts-agent"; // env.uriScheme = Info.plist CFBundleURLSchemes
const GRANT_REFRESH_TOKEN = "refresh_token";
const MIN_SAFELY_RENEW = 18e5; // w = 30min
const MAX_SAFELY_RENEW = 72e5; // S = 2h
const EXPIRED_REFRESH_MARGIN_MS = 30 * 60 * 1000; // 余量低于 30min 才主动刷新（扩展最短续期间隔）

// IAM 错误语义（STS5.1806 分支按 error_msg 细分）
const ERR_CODE_INVALID_REFRESH_TOKEN = "STS5.1806";
const ERR_CODE_INVALID_DPOP = "STS5.1804";
const MSG_EXPIRED_REFRESH_TOKEN = "refresh code has expired";
const MSG_KID_NOT_FOUND = "kid not found";
const MSG_ALREADY_USED = "the refresh token has been used";

const STS_ENDPOINT = "https://sts.cn-north-4.myhuaweicloud.com";
const SECRET_KEY_EXPR =
  `secret://${JSON.stringify({ extensionId: "huaweicloud.authentication", key: "HuaweiCloudSession" })}`;
const STATE_DB_PATH = `${homedir()}/Library/Application Support/CodeArts Agent/User/globalStorage/state.vscdb`;

export interface SecretAuth {
  account: { id: string; label: string };
  scopes: string[];
  accessToken: string;
  accessKey: string;
  secretKey: string;
  securitytoken: string;
  expires_at: string;
  domainId: string;
  safelyRenewTokenInterval: number;
  loginContext: {
    pkcePair: { codeVerifier: string; codeChallenge: string; codeChallengeMethod: string };
    dpopKeyPair: { privateKeyJwk: any; publicKeyJwk: any };
  };
  refresh_token: string;
}

let safeStoragePassword: string | null = null;
let lastSeenRefreshToken: string | null = null;
let lastRenewError: string | null = null;

function getSafeStoragePassword(): string {
  if (safeStoragePassword) return safeStoragePassword;
  const r = Bun.spawnSync(["/usr/bin/security", "find-generic-password", "-s", "CodeArts Agent Safe Storage", "-w"]);
  if (r.exitCode !== 0) throw new Error(`无法读取钥匙串 Safe Storage（${r.stderr.toString().trim()}）`);
  safeStoragePassword = r.stdout.toString().trim();
  return safeStoragePassword;
}

// Chromium os_crypt：PBKDF2-SHA1(pw,"saltysalt",1003,16) + AES-128-CBC(iv=0x20×16)，前缀 "v10"
function decryptSecretBlob(buf: Uint8Array): string {
  const prefix = new TextDecoder().decode(buf.slice(0, 3));
  if (prefix !== "v10") throw new Error(`未知的 safeStorage 前缀 ${prefix}`);
  const key = pbkdf2Sync(getSafeStoragePassword(), "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const dec = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([dec.update(buf.slice(3)), dec.final()]).toString("utf8");
}

function encryptSecretBlob(plaintext: string): Uint8Array {
  const key = pbkdf2Sync(getSafeStoragePassword(), "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const enc = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([enc.update(Buffer.from(plaintext, "utf8")), enc.final()]);
  const out = Buffer.concat([Buffer.from("v10", "utf8"), ct]);
  return new Uint8Array(out);
}

export function readSecretSession(): SecretAuth | null {
  try {
    const db = new Database(STATE_DB_PATH, { readonly: true });
    const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(SECRET_KEY_EXPR) as { value: string } | undefined;
    db.close();
    if (!row?.value) return null;
    const envelope = JSON.parse(row.value) as { type: string; data: number[] };
    if (envelope?.type !== "Buffer" || !Array.isArray(envelope.data)) return null;
    const auth = JSON.parse(decryptSecretBlob(new Uint8Array(envelope.data))) as SecretAuth;
    if (!auth?.refresh_token || !auth?.loginContext?.dpopKeyPair) return null;
    return auth;
  } catch (e: any) {
    console.warn(`[refresher] 读取 HuaweiCloudSession 失败: ${e?.message ?? e}`);
    return null;
  }
}

function writeSecretSession(auth: SecretAuth): void {
  const plaintext = JSON.stringify(auth);
  const blob = encryptSecretBlob(plaintext);
  const envelope = JSON.stringify({ type: "Buffer", data: Array.from(blob) });
  for (let attempt = 0; ; attempt++) {
    try {
      const db = new Database(STATE_DB_PATH);
      db.run("PRAGMA busy_timeout = 5000");
      db.run("UPDATE ItemTable SET value = ? WHERE key = ?", [envelope, SECRET_KEY_EXPR]);
      db.close();
      return;
    } catch (e) {
      if (attempt >= 2) throw e; // 回写失败非致命：内存凭证仍可用，下轮重试
      Bun.sleepSync(300);
    }
  }
}

export function toCredentials(auth: SecretAuth): Credentials {
  return {
    ak: auth.accessKey,
    sk: auth.secretKey,
    securityToken: auth.securitytoken,
    origin: undefined,
    domainId: auth.domainId,
    expiresAt: auth.expires_at,
    refreshToken: auth.refresh_token,
  };
}

/** 从 SecretStorage 读凭证（不触发刷新）；供 index.ts 启动时择优 */
export function credentialsFromSecretSession(): Credentials | null {
  const auth = readSecretSession();
  if (!auth) return null;
  lastSeenRefreshToken = auth.refresh_token;
  const creds = toCredentials(auth);
  setCredentials(creds);
  return creds;
}

function b64url(input: Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf.toString("base64url");
}

// DPoP 证明：ES256 JWT（protected {alg,typ,jwk}，payload {htm,htu,iat,jti}），签名为 raw r||s
async function generateDpop(loginContext: SecretAuth["loginContext"], htm: string, htu: string): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "jwk", loginContext.dpopKeyPair.privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const header = { alg: "ES256", typ: "dpop+jwt", jwk: loginContext.dpopKeyPair.publicKeyJwk };
  const payload = {
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(32).toString("hex"),
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}

function computeSafelyRenewTokenInterval(expiration: string): number {
  try {
    const half = Math.floor((Date.parse(expiration) - Date.now()) / 2);
    if (!Number.isFinite(half)) return MIN_SAFELY_RENEW;
    return Math.min(MAX_SAFELY_RENEW, Math.max(MIN_SAFELY_RENEW, half));
  } catch { return MIN_SAFELY_RENEW; }
}

function classifyRefreshError(body: any): "AlreadyUsed" | "Expired" | "InvalidSystemTime" | "Other" {
  const code = body?.error_code, msg = String(body?.error_msg ?? "");
  if (code === ERR_CODE_INVALID_DPOP && (msg.includes("DPoP proof has expired") || msg.includes("DPoP proof issued in the future")))
    return "InvalidSystemTime";
  if (code === ERR_CODE_INVALID_REFRESH_TOKEN) {
    if (msg.includes(MSG_EXPIRED_REFRESH_TOKEN) || msg.includes(MSG_KID_NOT_FOUND)) return "Expired";
    if (msg.includes(MSG_ALREADY_USED)) return "AlreadyUsed";
  }
  return "Other";
}

async function callRefresh(
  auth: SecretAuth,
  fetchImpl: FetchLike = fetch,
): Promise<{ credentials: { access_key_id: string; secret_access_key: string; security_token: string; expiration: string }; refresh_token: string }> {
  const url = `${STS_ENDPOINT}${IAM_TOKEN_API}`;
  const dpop = await generateDpop(auth.loginContext, "POST", url);
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code_verifier: auth.loginContext.pkcePair.codeVerifier,
    grant_type: GRANT_REFRESH_TOKEN,
    refresh_token: auth.refresh_token,
  }).toString();
  // 请求链内（401 重试）记录；保活定时器与启动刷新无请求上下文，入口自然 no-op
  const resp = await traceUpstream(
    {
      method: "POST",
      url,
      headers: { DPoP: dpop, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    },
    { fetch: fetchImpl },
  );
  const json = await resp.json().catch(() => null) as any;
  if (!resp.ok || !json?.credentials)
    throw Object.assign(new Error(`STS 刷新失败 HTTP ${resp.status}`), { iamBody: json });
  if (!json.credentials.access_key_id || !json.refresh_token)
    throw new Error("STS 刷新响应缺少 credentials/refresh_token 字段");
  return json;
}

function buildRenewedAuth(old: SecretAuth, renewed: Awaited<ReturnType<typeof callRefresh>>): SecretAuth {
  return {
    ...old,
    accessKey: renewed.credentials.access_key_id,
    secretKey: renewed.credentials.secret_access_key,
    securitytoken: renewed.credentials.security_token,
    expires_at: renewed.credentials.expiration,
    safelyRenewTokenInterval: computeSafelyRenewTokenInterval(renewed.credentials.expiration),
    refresh_token: renewed.refresh_token,
  };
}

/** 单次刷新：读 SecretStorage → 刷新 → 回写轮换后的 refresh_token → 采纳新 STS */
export async function refreshNow(fetchImpl: FetchLike = fetch): Promise<Credentials> {
  const auth = readSecretSession();
  if (!auth) throw new Error("SecretStorage 中无 HuaweiCloudSession（请先在 app 内登录）");
  try {
    const renewed = await callRefresh(auth, fetchImpl);
    const newAuth = buildRenewedAuth(auth, renewed);
    writeSecretSession(newAuth);
    lastSeenRefreshToken = newAuth.refresh_token;
    lastRenewError = null;
    const creds = toCredentials(newAuth);
    setCredentials(creds);
    console.log(`[refresher] STS 已刷新，有效期至 ${newAuth.expires_at}（refresh_token 已轮换并回写）`);
    return creds;
  } catch (e: any) {
    const kind = classifyRefreshError(e.iamBody);
    lastRenewError = kind;
    if (kind === "AlreadyUsed") {
      // 扩展多窗口语义：另一窗口（app）已轮换 → 重读共享存储采纳新凭证
      const fresh = readSecretSession();
      if (fresh && fresh.refresh_token !== auth.refresh_token) {
        lastSeenRefreshToken = fresh.refresh_token;
        lastRenewError = null;
        const creds = toCredentials(fresh);
        setCredentials(creds);
        console.log("[refresher] refresh_token 已被 app 窗口轮换，采纳共享存储新凭证");
        return creds;
      }
      throw new Error("refresh_token 已被消费但共享存储未更新：可能是另一次失败的刷新（调用成功但回写前崩溃）或多窗口竞争，请在 app 内重新登录");
    }
    if (kind === "Expired")
      throw new Error("refresh_token 已过期（" + (e.iamBody?.error_msg ?? "") + "），请在 app 内重新登录");
    if (kind === "InvalidSystemTime")
      throw new Error("DPoP 校验失败：系统时间偏差过大（" + (e.iamBody?.error_msg ?? "") + "）");
    throw new Error(`STS 刷新失败: ${e.iamBody?.error_code ?? ""} ${e.iamBody?.error_msg ?? e.message}`);
  }
}

/**
 * 维护循环一步：采纳 app 续期的新凭证（lineage 变化）或按需刷新。
 * app 健康时（其按 (expiration-now)/2 ∈ [30min,2h] 续期）仅需采纳，不产生竞争。
 */
export async function maintainCredentials(fetchImpl: FetchLike = fetch): Promise<void> {
  const auth = readSecretSession();
  if (!auth) return;
  if (lastSeenRefreshToken && auth.refresh_token !== lastSeenRefreshToken) {
    lastSeenRefreshToken = auth.refresh_token;
    const creds = toCredentials(auth);
    setCredentials(creds);
    console.log(`[refresher] 采纳 app 续期的 STS（有效期至 ${auth.expires_at}）`);
    return;
  }
  if (!lastSeenRefreshToken) lastSeenRefreshToken = auth.refresh_token;
  const remaining = Date.parse(auth.expires_at) - Date.now();
  if (remaining > EXPIRED_REFRESH_MARGIN_MS) return;
  try {
    await refreshNow(fetchImpl);
  } catch (e: any) {
    console.warn(`[refresher] 主动续期失败: ${e?.message ?? e}`);
  }
}

export function startCredentialMaintainer(): void {
  maintainCredentials().catch(() => {});
  setInterval(() => maintainCredentials().catch(() => {}), 60_000).unref?.();
}

export { lastRenewError };
