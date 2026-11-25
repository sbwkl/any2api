// snap 协议栈 — key-exchange（u$）、会话密钥管理（d$）、加密 chat（bz）、SSE 解密（g$）、心跳 — 内核逐字移植
import { createECDH, createHash, randomBytes } from "crypto";
import { SM4GCM } from "./sm4";
import { signSimple, signSh, type Credentials } from "./signer";
import { getCredentials } from "./config";
import { traceUpstream, type FetchLike } from "../../shared/trace";

const SM4_GCM_ALGO = "sm4-gcm";
const ENCRYPT_PATHS = ["/api/v2/chat/completions"];
const KEY_EXCHANGE_PATH = "/api/v1/security/key-exchange";
const REUSE_MARGIN_MS = 300000; // 提前 5 分钟换新

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf-8"));
const toUtf8 = (b: Uint8Array) => Buffer.from(b).toString("utf-8");

// ---- u$：ECDH P-256 密钥协商 ----
interface NegotiatedKey { keyId: string; sessionKey: Uint8Array; expiresIn: number }

class KeyExchangeClient {
  constructor(private baseUrl: string, private fetchImpl: FetchLike = fetch) {}

  async negotiate(): Promise<NegotiatedKey> {
    const creds = getCredentials(); // 每次协商取最新凭证（刷新链热替换）
    const ecdh = createECDH("prime256v1");
    const clientPublicKey = ecdh.generateKeys().toString("base64");
    const sessionId = randomBytes(16).toString("hex");
    const timestamp = Date.now();
    const url = `${this.baseUrl}${KEY_EXCHANGE_PATH}`;
    // Ew 语义：有 AKSK → signSimple（Content-Type: application/json）；否则 token 头
    const signed = signSimple(creds, "POST", url, "application/json");
    const headers = signed ? { ...signed } : { "Content-Type": "application/json" };
    if (creds.userToken) headers["x-auth-token"] = creds.userToken;
    const resp = await traceUpstream(
      { method: "POST", url, headers, body: JSON.stringify({ clientPublicKey, sessionId, timestamp }) },
      { fetch: this.fetchImpl },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`Key exchange failed: ${resp.status} ${text.slice(0, 200)}`);
    }
    const data = await resp.json() as { serverPublicKey: string; keyId: string; expiresIn: number };
    if (!data.serverPublicKey || !data.keyId) throw new Error("Key exchange response missing required fields");
    const shared = ecdh.computeSecret(Buffer.from(data.serverPublicKey, "base64"));
    const sessionKey = new Uint8Array(createHash("sha256").update(shared).digest().subarray(0, 16));
    return { keyId: data.keyId, sessionKey, expiresIn: data.expiresIn };
  }
}

// ---- d$：会话密钥管理器 ----
export class SessionKeyManager {
  private currentKey: (NegotiatedKey & { expiresAt: number }) | null = null;
  private client: KeyExchangeClient | null = null;
  private currentBaseUrl: string | null = null;
  constructor(
    private refreshIntervalSec = 3600,
    private fallbackOnFailure = true,
    private fetchImpl: FetchLike = fetch,
  ) {}

  async getOrNegotiateKey(baseUrl: string): Promise<NegotiatedKey> {
    if (this.currentKey && Date.now() < this.currentKey.expiresAt - REUSE_MARGIN_MS) return this.currentKey;
    if (!this.client || this.currentBaseUrl !== baseUrl) {
      this.client = new KeyExchangeClient(baseUrl, this.fetchImpl);
      this.currentBaseUrl = baseUrl;
    }
    try {
      const k = await this.client.negotiate();
      const ttl = k.expiresIn ? k.expiresIn * 1000 : this.refreshIntervalSec * 1000;
      this.currentKey = { ...k, expiresAt: Date.now() + ttl };
      return this.currentKey;
    } catch (e) {
      if (this.fallbackOnFailure && this.currentKey && Date.now() < this.currentKey.expiresAt)
        return this.currentKey;
      throw e;
    }
  }
  clearKey(): void { this.currentKey = null; }
}

// ---- g$：SSE 解密流（iv:tag:ct 三段 base64，AAD={keyId}|{chunkIndex}）----
function decryptChunk(cipher: SM4GCM, key: Uint8Array, keyId: string, frame: string, index: number): string {
  const segs = frame.split(":");
  if (segs.length !== 3) throw Error(`Invalid encrypted SSE chunk format: expected 3 fields, got ${segs.length}`);
  const iv = unb64(segs[0]);
  const tag = unb64(segs[1]);
  const ct = unb64(segs[2]);
  return toUtf8(cipher.decrypt(key, iv, tag, ct, `${keyId}|${index}`));
}

function decryptStream(key: Uint8Array, keyId: string, resp: Response): Response {
  const reader = resp.body!.getReader();
  const cipher = new SM4GCM();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  let chunkIndex = 0;
  const FRAME_SEP = "\n\n";
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (buf.length > 0) {
              const frame = buf.trim();
              if (frame) {
                const plain = decryptChunk(cipher, key, keyId, frame, chunkIndex);
                controller.enqueue(encoder.encode(plain + FRAME_SEP));
                chunkIndex++;
              }
            }
            controller.close();
            return;
          }
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf(FRAME_SEP)) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + FRAME_SEP.length);
            const trimmed = frame.trim();
            if (!trimmed) continue;
            let plain: string;
            try {
              plain = decryptChunk(cipher, key, keyId, trimmed, chunkIndex);
            } catch (e: any) {
              console.error(`[snap] SSE 帧解密失败 chunk=${chunkIndex}: ${e?.message ?? e} frame=${trimmed.slice(0, 120)}`);
              throw e;
            }
            chunkIndex++;
            controller.enqueue(encoder.encode(plain + FRAME_SEP));
            if (chunkIndex % 50 === 0) await new Promise((r) => setImmediate(r));
          }
        }
      } catch (e) {
        console.error("[snap] 解密流终止:", (e as any)?.message ?? e);
        controller.error(e);
      }
    },
  });
  const headers = new Headers(resp.headers);
  headers.delete("X-Encrypt-Algo");
  headers.delete("X-Encrypt-Key-Id");
  headers.set("Content-Type", "text/event-stream");
  return new Response(stream, { status: resp.status, statusText: resp.statusText, headers });
}

// ---- bz：加密 chat 客户端（失败回退链逐字：协商失败→明文；网络错误→明文重发；KEY_EXPIRED→换 key 重试一次；其余非 2xx→明文重发）----
export class SnapClient {
  public keys: SessionKeyManager;
  private cipher = new SM4GCM();

  constructor(public chatOrigin: string, private fetchImpl: FetchLike = fetch) {
    this.keys = new SessionKeyManager(3600, true, this.fetchImpl);
  }

  // 明文发送：每次尝试独立记录（无请求上下文时入口自然透传）
  private sendPlaintext(url: string, headers: Record<string, string>, plaintext: string): Promise<Response> {
    return traceUpstream(
      { method: "POST", url, headers, body: plaintext },
      { fetch: this.fetchImpl },
    );
  }

  // headers：provider 层业务头（x-ot-* 等）；bodyJson：OpenAI 格式请求体对象
  async chat(url: string, headers: Record<string, string>, bodyObj: any, isRetry = false): Promise<Response> {
    // UXe 判定：仅 /api/v2/chat/completions 加密
    const pathname = new URL(url).pathname;
    if (process.env.CODEARTS_FORCE_PLAINTEXT === "1")
      return this.sendPlaintext(url, headers, JSON.stringify(bodyObj));
    if (!ENCRYPT_PATHS.some((p) => pathname.startsWith(p))) {
      return this.sendPlaintext(url, headers, JSON.stringify(bodyObj));
    }
    const baseUrl = new URL(url).origin;
    let key: NegotiatedKey;
    try {
      key = await this.keys.getOrNegotiateKey(baseUrl);
    } catch {
      return this.sendPlaintext(url, headers, JSON.stringify(bodyObj)); // 协商失败→明文
    }
    const plaintext = JSON.stringify(bodyObj);
    const ts = Date.now();
    const aad = `POST|${pathname}|${ts}`;
    const { ciphertext, iv, authTag } = this.cipher.encrypt(key.sessionKey, utf8(plaintext), aad);

    const h = new Headers(headers);
    h.set("X-Encrypt-Algo", SM4_GCM_ALGO);
    h.set("X-Encrypt-Key-Id", key.keyId);
    h.set("X-Encrypt-Iv", b64(iv));
    h.set("X-Encrypt-Tag", b64(authTag));
    h.set("X-Encrypt-Ts", String(ts));
    h.set("Content-Type", "application/octet-stream");
    // Ew signSimple re-sign（覆盖 Authorization/X-Sdk-Date；host 由 fetch 设置）
    const signed = signSimple(getCredentials(), "POST", url, "application/octet-stream");
    for (const [k, v] of Object.entries(signed)) {
      if (k.toLowerCase() === "host") continue;
      h.set(k, v);
    }

    let resp: Response;
    try {
      if (process.env.CODEARTS_DEBUG_HEADERS === "1") {
        const dump: Record<string, string> = {};
        h.forEach((v, k) => (dump[k] = k === "Authorization" ? `${v.slice(0, 60)}...` : v.length > 80 ? `${v.slice(0, 80)}...` : v));
        console.log("[snap] 最终上线头集:", JSON.stringify(dump, null, 1));
      }
      // L2 记录加密前明文（recordBody）；线上 body 为 base64 密文；线上头含 X-Encrypt-* 与重签名
      resp = await traceUpstream(
        { method: "POST", url, headers: h, body: b64(ciphertext), recordBody: bodyObj },
        { fetch: this.fetchImpl },
      );
    } catch {
      console.warn("[snap] 加密请求网络错误 → 明文重发");
      return this.sendPlaintext(url, headers, plaintext); // 网络错误→明文重发
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(`[snap] 加密请求非2xx: status=${resp.status} body=${text.slice(0, 300)}`);
      if (text.includes("ENCRYPT_KEY_EXPIRED") && !isRetry) {
        this.keys.clearKey();
        return this.chat(url, headers, bodyObj, true);
      }
      return this.sendPlaintext(url, headers, plaintext); // 非 2xx→明文重发
    }
    const algo = resp.headers.get("X-Encrypt-Algo");
    console.log(`[snap] chat 2xx: status=${resp.status} algo=${algo} ct=${resp.headers.get("Content-Type")} len=${resp.headers.get("Content-Length") ?? "?"}`);
    if (algo === SM4_GCM_ALGO) return decryptStream(key.sessionKey, key.keyId, resp);
    return resp;
  }
}

// ---- ChatSessionHeartbeat（内核逐字语义）：busy 每 30s；idle 立即；24h 静默自动 idle ----
const HEARTBEAT_PATH = "/snap-manager/v1/chat-session/heartbeat";
const BUSY_INTERVAL_MS = 30000;
const MAX_LIFETIME_MS = 86400000;

export interface HeartbeatOptions {
  /** 可注入 fetch 以便单测；默认全局 fetch */
  fetch?: FetchLike;
  /** busy 间隔；默认 30s，测试可注入更短值 */
  intervalMs?: number;
  /** 会话最大静默寿命；默认 24h，测试可注入更短值 */
  maxLifetimeMs?: number;
}

export class HeartbeatManager {
  private timers = new Map<string, { timer: ReturnType<typeof setInterval>; lastAliveAt: number }>();
  private fetchImpl: FetchLike;
  private intervalMs: number;
  private maxLifetimeMs: number;

  constructor(private snapOrigin: string, opts: HeartbeatOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.intervalMs = opts.intervalMs ?? BUSY_INTERVAL_MS;
    this.maxLifetimeMs = opts.maxLifetimeMs ?? MAX_LIFETIME_MS;
  }

  touch(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (t) t.lastAliveAt = Date.now();
  }

  startBusy(sessionId: string): void {
    if (this.timers.has(sessionId)) { this.touch(sessionId); return; }
    // 请求链内首次 busy：走共享记录入口（无请求上下文时自然 no-op）
    this.sendRecorded(sessionId, "busy").catch(() => {});
    // 注意：interval 在请求上下文内创建时会继承首个请求的 ALS store（实测），
    // 定时器路径的发送必须显式用原始 fetch，不依赖上下文判定。
    const timer = setInterval(() => {
      const t = this.timers.get(sessionId);
      if (!t) return;
      if (Date.now() - t.lastAliveAt > this.maxLifetimeMs) {
        this.stopBusy(sessionId);
        this.sendBackground(sessionId, "idle").catch(() => {});
        return;
      }
      this.sendBackground(sessionId, "busy").catch(() => {});
    }, this.intervalMs);
    this.timers.set(sessionId, { timer, lastAliveAt: Date.now() });
  }

  stopBusy(sessionId: string): void {
    const t = this.timers.get(sessionId);
    if (!t) return;
    clearInterval(t.timer);
    this.timers.delete(sessionId);
    this.sendBackground(sessionId, "idle").catch(() => {});
  }

  // Sh() 模式签名：X-Sdk-Content-Sha256=UNSIGNED-PAYLOAD；user-session-id 头；PUT
  private buildHeartbeat(sessionId: string, status: "busy" | "idle"): { url: string; headers: Record<string, string>; body: string } {
    const url = `${this.snapOrigin}${HEARTBEAT_PATH}`;
    const headers = signSh(
      { method: "PUT", endpoint: url, headers: { "Content-Type": "application/json", "user-session-id": sessionId } },
      getCredentials(), { signBody: false },
    );
    return { url, headers, body: JSON.stringify({ status }) };
  }

  /** 请求链内发送：走请求记录入口（无请求上下文时自然 no-op） */
  private async sendRecorded(sessionId: string, status: "busy" | "idle"): Promise<void> {
    const { url, headers, body } = this.buildHeartbeat(sessionId, status);
    await traceUpstream({ method: "PUT", url, headers, body }, { fetch: this.fetchImpl }).catch(() => {});
  }

  /** 定时器 / idle 等后台发送：显式用原始 fetch，不继承请求上下文 */
  private async sendBackground(sessionId: string, status: "busy" | "idle"): Promise<void> {
    const { url, headers, body } = this.buildHeartbeat(sessionId, status);
    await this.fetchImpl(url, { method: "PUT", headers, body }).catch(() => {});
  }
}
