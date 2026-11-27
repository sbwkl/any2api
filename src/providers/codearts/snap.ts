// snap 协议栈 — key-exchange（u$）、会话密钥管理（d$）、加密 chat（bz）、SSE 解密（g$）、心跳 — 内核逐字移植
import { createECDH, createHash, randomBytes } from "crypto";
import { SM4GCM } from "./sm4";
import { signSimple, signSh } from "./signer";
import { getCredentials } from "./config";
import { traceUpstream, UpstreamDecodeError, type FetchLike } from "../../shared/trace";
import { serviceLogger } from "../../shared/log";
import {
  createRetryBudget,
  createRetryRuntime,
  planRetry,
  type RetryBudget,
  type RetryRuntime,
} from "./retry";

const SM4_GCM_ALGO = "sm4-gcm";
const ENCRYPT_PATHS = ["/api/v2/chat/completions"];
const KEY_EXCHANGE_PATH = "/api/v1/security/key-exchange";
const REUSE_MARGIN_MS = 300000; // 提前 5 分钟换新
const DEFAULT_IDLE_TIMEOUT_MS = 180000;

function idleTimeoutMs(): number {
  const n = Number(process.env.CODEARTS_UPSTREAM_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_IDLE_TIMEOUT_MS;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, "utf-8"));
const toUtf8 = (b: Uint8Array) => Buffer.from(b).toString("utf-8");

/** 客户端取消是终止信号而不是网络故障：加密客户端不得把它当成可重试错误。 */
function clientAbortError(): Error {
  const err = new Error("client disconnected");
  err.name = "AbortError";
  return err;
}

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
    const headers: Record<string, string> = signed ? { ...signed } : { "Content-Type": "application/json" };
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

/** 统一把帧解密失败包装为 trace 可识别的最小载体；index 由调用方在解密前确定。 */
function decryptTrackedChunk(
  cipher: SM4GCM,
  key: Uint8Array,
  keyId: string,
  frame: string,
  index: number,
  logPrefix?: string,
): string {
  try {
    return decryptChunk(cipher, key, keyId, frame, index);
  } catch (e: any) {
    if (logPrefix) serviceLogger.error(`${logPrefix} chunk=${index}: ${e?.message ?? e} frame=${frame.slice(0, 120)}`);
    throw new UpstreamDecodeError("frame_decrypt", index, e?.message ?? String(e));
  }
}

function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
){
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`upstream idle timeout after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([reader.read(), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function decryptStream(key: Uint8Array, keyId: string, resp: Response): Response {
  const reader = resp.body!.getReader();
  const cipher = new SM4GCM();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const idleMs = idleTimeoutMs();
  let buf = "";
  let chunkIndex = 0;
  const FRAME_SEP = "\n\n";
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for (;;) {
          const { done, value } = await readWithIdleTimeout(reader, idleMs);
          if (done) {
            if (buf.length > 0) {
              const frame = buf.trim();
              if (frame) {
                const plain = decryptTrackedChunk(cipher, key, keyId, frame, chunkIndex);
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
            const plain = decryptTrackedChunk(
              cipher,
              key,
              keyId,
              trimmed,
              chunkIndex,
              "[snap] SSE 帧解密失败",
            );
            chunkIndex++;
            controller.enqueue(encoder.encode(plain + FRAME_SEP));
            if (chunkIndex % 50 === 0) await new Promise((r) => setImmediate(r));
          }
        }
      } catch (e) {
        serviceLogger.error("[snap] 解密流终止:", (e as any)?.message ?? e);
        try { await reader.cancel(); } catch { /* reader 已释放 */ }
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

// ---- 请求记录专用：在 traceUpstream 读取响应之前完成 provider 解码 ----
// 仅 CodeArts chat 的成功加密响应走这里；trace 与调用方拿到同一个明文 Response。
function decryptingFetch(fetchImpl: FetchLike, key: NegotiatedKey): FetchLike {
  return async (input, init) => {
    const resp = await fetchImpl(input, init);
    const algo = resp.headers.get("X-Encrypt-Algo");
    if (!resp.ok || algo !== SM4_GCM_ALGO) return resp;
    serviceLogger.log(`[snap] chat 2xx: status=${resp.status} algo=${algo} ct=${resp.headers.get("Content-Type")} len=${resp.headers.get("Content-Length") ?? "?"}`);
    return decryptStream(key.sessionKey, key.keyId, resp);
  };
}

// ---- bz：加密 chat 客户端 ----
// 与内核逐字行为的有意偏差：内核在协商失败/网络错误/非 2xx 时改发明文，但明文 chat 实测
// 100% 被上游拒绝（内嵌 415），只会掩盖真实故障。这里按状态级重试表恢复（见 retry.ts）：
// 429/406/502 总尝试 ≤10，500/503/504/407 总尝试 ≤3，其它 4xx/5xx 与裸网络错误不重试；
// ENCRYPT_KEY_EXPIRED 换 key 重发保留但不计为独立上限，同样扣共享预算。
// CODEARTS_FORCE_PLAINTEXT=1 仅作调试开关。
export class SnapClient {
  public keys: SessionKeyManager;
  private cipher = new SM4GCM();
  private retry: RetryRuntime;

  constructor(
    public chatOrigin: string,
    private fetchImpl: FetchLike = fetch,
    retry: Partial<RetryRuntime> = {},
  ) {
    this.keys = new SessionKeyManager(3600, true, this.fetchImpl);
    this.retry = createRetryRuntime(retry);
  }

  // 明文发送：每次尝试独立记录（无请求上下文时入口自然透传）；明文路径不重试。
  private sendPlaintext(
    url: string,
    headers: Record<string, string>,
    plaintext: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    return traceUpstream(
      { method: "POST", url, headers, body: plaintext, signal },
      { fetch: this.fetchImpl },
    );
  }

  // headers：provider 层业务头（x-ot-* 等）；bodyJson：OpenAI 格式请求体对象
  // opts.signal：入站请求的取消信号；中止时上游 fetch 同一条链一起中止，且不重试。
  // opts.budget：整次入站请求共享的总尝试预算；缺省时本次调用自建一份。
  // opts.chargeBudget：false 表示本次调用的第一次发送是凭证修复动作（401 刷新后重发），
  // 不占用瞬时重试预算；其后的状态级重试照常扣预算。
  async chat(
    url: string,
    headers: Record<string, string>,
    bodyObj: any,
    opts: { signal?: AbortSignal; budget?: RetryBudget; chargeBudget?: boolean } = {},
  ): Promise<Response> {
    const { signal } = opts;
    const budget = opts.budget ?? createRetryBudget();
    if (signal?.aborted) throw clientAbortError();
    // UXe 判定：仅 /api/v2/chat/completions 加密
    const pathname = new URL(url).pathname;
    if (process.env.CODEARTS_FORCE_PLAINTEXT === "1")
      return this.sendPlaintext(url, headers, JSON.stringify(bodyObj), signal);
    if (!ENCRYPT_PATHS.some((p) => pathname.startsWith(p))) {
      return this.sendPlaintext(url, headers, JSON.stringify(bodyObj), signal);
    }
    const baseUrl = new URL(url).origin;
    let key: NegotiatedKey;
    try {
      // 取消不进入密钥协商：协商结果全局缓存，可能被其他请求等待，必须完成。
      key = await this.keys.getOrNegotiateKey(baseUrl);
    } catch (e: any) {
      // 明文回退对 chat 不可用（实测 8/8 得到内嵌 415）：直接报错，避免掩盖真实故障。
      // 调试场景仍可用 CODEARTS_FORCE_PLAINTEXT=1 显式走明文。
      throw new Error(`key exchange failed: ${e?.message ?? e}`);
    }
    // 检查点：协商期间客户端可能已断开；此时不得再发 chat。
    if (signal?.aborted) throw clientAbortError();
    let keyExpiredResent = false;
    // 豁免只覆盖本次调用的第一次发送；随后的状态级重试仍然扣共享预算。
    let charge = opts.chargeBudget !== false;

    for (;;) {
      // 检查点：每次上游尝试前；取消优先于一切重试判断，且不消耗预算。
      if (signal?.aborted) throw clientAbortError();
      if (charge) budget.attempts++;
      charge = true;

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
          serviceLogger.log("[snap] 最终上线头集:", JSON.stringify(dump, null, 1));
        }
        // L2 记录加密前明文（recordBody）；线上 body 为 base64 密文；线上头含 X-Encrypt-* 与重签名
        resp = await traceUpstream(
          { method: "POST", url, headers: h, body: b64(ciphertext), recordBody: bodyObj, signal },
          { fetch: decryptingFetch(this.fetchImpl, key) },
        );
      } catch (e: any) {
        // 裸网络错误按官方语义不可重试；取消导致的 fetch 中止同理。
        if (signal?.aborted) throw clientAbortError();
        throw new Error(`upstream network error: ${e?.message ?? e}`);
      }
      if (resp.ok) return resp;

      const text = await resp.text().catch(() => "");
      if (signal?.aborted) throw clientAbortError();
      serviceLogger.warn(`[snap] 加密请求非2xx: status=${resp.status} body=${text.slice(0, 300)}`);

      // 换密钥重发：保留原行为，但每次重发照常扣一次预算；单次 chat 最多一次。
      if (text.includes("ENCRYPT_KEY_EXPIRED") && !keyExpiredResent) {
        keyExpiredResent = true;
        serviceLogger.warn(
          `[snap] 重试 class=key_expired attempt=${budget.attempts} max=- delay=0ms（换密钥重发）`,
        );
        this.keys.clearKey();
        try {
          key = await this.keys.getOrNegotiateKey(baseUrl);
        } catch (e: any) {
          throw new Error(`key exchange failed: ${e?.message ?? e}`);
        }
        if (signal?.aborted) throw clientAbortError();
        continue;
      }

      const plan = planRetry({
        budget,
        status: resp.status,
        headers: resp.headers,
        now: this.retry.now,
        random: this.retry.random,
      });
      if (!plan) {
        // 明文回退是死路径（实测 415），不再重发；把上游状态/原文交回 provider 归一。
        const headersOut = new Headers();
        const contentType = resp.headers.get("content-type");
        if (contentType) headersOut.set("Content-Type", contentType);
        return new Response(text, { status: resp.status, statusText: resp.statusText, headers: headersOut });
      }
      serviceLogger.warn(
        `[snap] 重试 class=${plan.cls} status=${resp.status} attempt=${plan.attempt}/${plan.max} delay=${plan.delayMs}ms`,
      );
      try {
        await this.retry.sleep(plan.delayMs, signal);
      } catch (e) {
        if (signal?.aborted) throw clientAbortError();
        throw e;
      }
    }
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

  // Sh() 模式签名：X-Sdk-Content-Sha256=UNSIGNED-PAYLOAD；user-session-id 头；PUT。
  // status 放查询参数（与内核 uA.put(path, headers, {}, { status }) 逐字一致），body 固定 "{}"。
  // 签名 endpoint 传不含 query 的路径，query 经 queryParams 参与签名。
  private buildHeartbeat(sessionId: string, status: "busy" | "idle"): { url: string; headers: Record<string, string>; body: string } {
    const url = `${this.snapOrigin}${HEARTBEAT_PATH}?status=${status}`;
    const headers = signSh(
      {
        method: "PUT",
        endpoint: `${this.snapOrigin}${HEARTBEAT_PATH}`,
        queryParams: { status },
        headers: { "Content-Type": "application/json", "user-session-id": sessionId },
      },
      getCredentials(), { signBody: false },
    );
    return { url, headers, body: "{}" };
  }

  /** 响应检查（两条发送路径共享）：非 2xx warn（含状态码与响应片段）、网络异常 error；成功静默 */
  private async sendHeartbeat(sessionId: string, status: "busy" | "idle", send: () => Promise<Response>): Promise<void> {
    let resp: Response;
    try {
      resp = await send();
    } catch (e) {
      serviceLogger.error(`[snap] 心跳网络错误 session=${sessionId} status=${status}: ${(e as any)?.message ?? e}`);
      return;
    }
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      serviceLogger.warn(`[snap] 心跳非2xx session=${sessionId} status=${status} http=${resp.status} body=${text.slice(0, 300)}`);
    }
  }

  /** 请求链内发送：走请求记录入口（无请求上下文时自然 no-op） */
  private async sendRecorded(sessionId: string, status: "busy" | "idle"): Promise<void> {
    const { url, headers, body } = this.buildHeartbeat(sessionId, status);
    await this.sendHeartbeat(sessionId, status, () =>
      traceUpstream({ method: "PUT", url, headers, body }, { fetch: this.fetchImpl }),
    ).catch(() => {});
  }

  /** 定时器 / idle 等后台发送：显式用原始 fetch，不继承请求上下文 */
  private async sendBackground(sessionId: string, status: "busy" | "idle"): Promise<void> {
    const { url, headers, body } = this.buildHeartbeat(sessionId, status);
    await this.sendHeartbeat(sessionId, status, () =>
      this.fetchImpl(url, { method: "PUT", headers, body }),
    ).catch(() => {});
  }
}
