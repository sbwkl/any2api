import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createECDH, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRequestTrace, type FetchLike } from "../../shared/trace";
import { HeartbeatManager, SnapClient } from "./snap";
import { SM4GCM } from "./sm4";

const encoder = new TextEncoder();
const old = { ...process.env };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "any2api-codearts-"));
  process.env.CODEARTS_CLI_AK = "test-ak";
  process.env.CODEARTS_CLI_SK = "test-sk";
  delete process.env.TRACE_CAPTURE_DIR;
  delete process.env.UPSTREAM_DUMP_DIR;
  delete process.env.CODEARTS_FORCE_PLAINTEXT;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...old };
});

function inbound(): Request {
  return new Request("http://localhost/codearts/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
}

function readRecords(): any[] {
  const file = join(dir, `capture-${new Date().toISOString().slice(0, 10)}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function recordingFetch(handler: (call: RecordedCall) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fake = async (input: any, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fake as FetchLike, calls };
}

function headerValue(call: RecordedCall, name: string): string | null {
  return new Headers(call.init.headers as HeadersInit | undefined).get(name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(cond: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(2);
  }
}

/** 头记录保留原始大小写，按名大小写不敏感取值 */
function recordedHeader(headers: Record<string, string>, name: string): string | null {
  const hit = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : null;
}

const CHAT_URL = "https://snap.test/api/v2/chat/completions";
const KEY_EXCHANGE_URL = "https://snap.test/api/v1/security/key-exchange";

function chatBody() {
  return { model: "m", messages: [{ role: "user", content: "hi" }], stream: true };
}

describe("snap.chat request-scoped attempts", () => {
  test("without a request context outbound calls are not recorded", async () => {
    process.env.TRACE_CAPTURE_DIR = dir; // 仅开环境变量、不建立请求上下文
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const { fetch: fake, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const snap = new SnapClient("https://snap.test", fake);
    const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-0" }, chatBody());

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(readRecords()).toHaveLength(0);
  });

  test("records key-exchange, encrypted send and plaintext fallback as separate attempts", async () => {
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const bodyObj = chatBody();
    const headers = { "x-ot-trace-id": "trace-1", authorization: "Bearer business-secret" };

    const { fetch: fake, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      }
      if (headerValue(call, "X-Encrypt-Algo") === "sm4-gcm") {
        return new Response("ENCRYPTED_STAGE_FAILED", { status: 500 });
      }
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let resText = "";
    let resStatus = 0;
    try {
      const res = await snap.chat(CHAT_URL, headers, bodyObj);
      resStatus = res.status;
      resText = await res.text();
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(resStatus).toBe(200);
    expect(resText).toBe('data: {"ok":1}\n\n');
    expect(calls.map((c) => c.url)).toEqual([KEY_EXCHANGE_URL, CHAT_URL, CHAT_URL]);

    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(3);

    // L2 + L3：key-exchange
    expect(upstream[0].method).toBe("POST");
    expect(typeof upstream[0].body.clientPublicKey).toBe("string");
    expect(typeof upstream[0].body.sessionId).toBe("string");
    expect(recordedHeader(upstream[0].headers, "authorization")).toBe("<redacted>");
    expect(JSON.parse(upstream[0].response.body).keyId).toBe("kid-1");

    // L2：加密尝试记录加密前明文；线上 body 是 base64 密文
    expect(upstream[1].url).toBe(CHAT_URL);
    expect(upstream[1].body).toEqual(bodyObj);
    expect(recordedHeader(upstream[1].headers, "x-encrypt-algo")).toBe("sm4-gcm");
    expect(recordedHeader(upstream[1].headers, "x-encrypt-key-id")).toBe("kid-1");
    expect(recordedHeader(upstream[1].headers, "content-type")).toBe("application/octet-stream");
    expect(recordedHeader(upstream[1].headers, "authorization")).toBe("<redacted>");
    const wireBody = String(calls[1].init.body);
    expect(wireBody).not.toBe(JSON.stringify(bodyObj));
    expect(() => JSON.parse(wireBody)).toThrow();
    // SM4-GCM 无填充：密文字节数 = 明文字节数
    expect(Buffer.from(wireBody, "base64").length).toBe(Buffer.from(JSON.stringify(bodyObj), "utf8").length);
    expect(upstream[1].response.status).toBe(500);
    expect(upstream[1].response.body).toBe("ENCRYPTED_STAGE_FAILED");

    // L2 + L3：非 2xx 后的明文重发
    expect(upstream[2].url).toBe(CHAT_URL);
    expect(upstream[2].body).toEqual(bodyObj);
    expect(recordedHeader(upstream[2].headers, "x-encrypt-algo")).toBeNull();
    expect(recordedHeader(upstream[2].headers, "x-ot-trace-id")).toBe("trace-1");
    expect(recordedHeader(upstream[2].headers, "authorization")).toBe("<redacted>");
    expect(upstream[2].response.status).toBe(200);
    expect(upstream[2].response.body).toBe('data: {"ok":1}\n\n');
    expect(upstream[2].response.complete).toBe(true);

    // 尝试按发生顺序
    expect(upstream[0].t_ms).toBeLessThanOrEqual(upstream[1].t_ms);
    expect(upstream[1].t_ms).toBeLessThanOrEqual(upstream[2].t_ms);
    // 敏感值不落盘
    expect(JSON.stringify(upstream)).not.toContain("business-secret");
  });

  test("L3 keeps the raw ciphertext frames while the caller receives decrypted SSE", async () => {
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const cipher = new SM4GCM();
    const keyId = "kid-9";
    let sessionKey: Uint8Array | null = null;

    // 上游明文 SSE 帧（两帧），用协商出的会话密钥加密成 iv:tag:ct（AAD=keyId|index）
    const plainFrames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n'];
    const rawFrames: string[] = [];
    const encryptFrames = () => {
      for (const [i, plain] of plainFrames.entries()) {
        const { ciphertext, iv, authTag } = cipher.encrypt(sessionKey!, encoder.encode(plain), `${keyId}|${i}`);
        const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
        rawFrames.push(`${b64(iv)}:${b64(authTag)}:${b64(ciphertext)}`);
      }
    };
    const rawBody = () => rawFrames.join("\n\n") + "\n\n";

    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        const reqBody = JSON.parse(String(call.init.body));
        const shared = server.computeSecret(Buffer.from(reqBody.clientPublicKey, "base64"));
        sessionKey = new Uint8Array(createHash("sha256").update(shared).digest().subarray(0, 16));
        return Response.json({ serverPublicKey, keyId, expiresIn: 3600 });
      }
      encryptFrames();
      return new Response(rawBody(), {
        status: 200,
        headers: {
          "X-Encrypt-Algo": "sm4-gcm",
          "X-Encrypt-Key-Id": keyId,
          "Content-Type": "application/x-encrypted-sse",
        },
      });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let plaintext = "";
    try {
      const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-2" }, chatBody());
      plaintext = await res.text();
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    // 调用方拿到的是解密后的明文 SSE（decryptStream 每帧补 FRAME_SEP）
    expect(plaintext).toBe(plainFrames.map((frame) => frame + "\n\n").join(""));
    expect(Buffer.from(plaintext).includes(encoder.encode("data:"))).toBe(true);

    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(2);
    const encryptedAttempt = upstream[1];
    // 响应头在 decryptStream 删除加密头之前快照
    expect(recordedHeader(encryptedAttempt.response.headers, "x-encrypt-algo")).toBe("sm4-gcm");
    expect(recordedHeader(encryptedAttempt.response.headers, "x-encrypt-key-id")).toBe(keyId);
    // L3 记录上游原始密文文本（g4 帧），不是解密后的明文
    expect(encryptedAttempt.response.body).toBe(rawBody());
    expect(encryptedAttempt.response.body).not.toContain("data:");
    expect(encryptedAttempt.response.chunks.length).toBeGreaterThanOrEqual(1);
    expect(encryptedAttempt.response.chunks.reduce((n: number, c: any) => n + c.bytes, 0)).toBe(
      encoder.encode(rawBody()).byteLength,
    );
    expect(encryptedAttempt.response.complete).toBe(true);
  });

  test("records the plaintext fallback when key-exchange itself fails", async () => {
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return new Response("KX_DOWN", { status: 500 });
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let status = 0;
    try {
      status = (await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-3" }, chatBody())).status;
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(status).toBe(200);
    const upstream = readRecords()[0].upstream;
    expect(upstream.map((u: any) => u.url)).toEqual([KEY_EXCHANGE_URL, CHAT_URL]);
    expect(upstream[0].response.status).toBe(500);
    expect(upstream[0].response.body).toBe("KX_DOWN");
    expect(upstream[1].body).toEqual(chatBody());
    expect(recordedHeader(upstream[1].headers, "x-encrypt-algo")).toBeNull();
    expect(upstream[1].response.status).toBe(200);
  });

  test("records the plaintext resend after an encrypted network error", async () => {
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      if (headerValue(call, "X-Encrypt-Algo")) throw new Error("socket closed");
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let status = 0;
    try {
      status = (await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-4" }, chatBody())).status;
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(status).toBe(200);
    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(3);
    expect(upstream[1].response.status).toBe(0);
    expect(upstream[1].response.complete).toBe(false);
    expect(recordedHeader(upstream[1].headers, "x-encrypt-algo")).toBe("sm4-gcm");
    expect(upstream[2].body).toEqual(chatBody());
    expect(recordedHeader(upstream[2].headers, "x-encrypt-algo")).toBeNull();
    expect(upstream[2].response.status).toBe(200);
  });

  test("KEY_EXPIRED re-negotiates the key and records the retry attempts", async () => {
    const servers = [createECDH("prime256v1"), createECDH("prime256v1")];
    let exchange = 0;
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        const server = servers[exchange];
        exchange++;
        return Response.json({ serverPublicKey: server.generateKeys().toString("base64"), keyId: `kid-${exchange}`, expiresIn: 3600 });
      }
      const keyId = headerValue(call, "X-Encrypt-Key-Id");
      if (keyId === "kid-1") return new Response("ENCRYPT_KEY_EXPIRED", { status: 400 });
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let status = 0;
    try {
      status = (await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-5" }, chatBody())).status;
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(status).toBe(200);
    const upstream = readRecords()[0].upstream;
    expect(upstream.map((u: any) => u.url)).toEqual([KEY_EXCHANGE_URL, CHAT_URL, KEY_EXCHANGE_URL, CHAT_URL]);
    expect(recordedHeader(upstream[1].headers, "x-encrypt-key-id")).toBe("kid-1");
    expect(upstream[1].response.body).toBe("ENCRYPT_KEY_EXPIRED");
    expect(recordedHeader(upstream[3].headers, "x-encrypt-key-id")).toBe("kid-2");
    expect(upstream[3].body).toEqual(chatBody());
    expect(upstream[3].response.status).toBe(200);
  });
});

describe("heartbeat recording boundary", () => {
  test("records the first busy in the request chain but not timer ticks or idle", async () => {
    const { fetch: fake, calls } = recordingFetch(() => Response.json({ ok: true }));
    const trace = startRequestTrace(inbound(), { dir })!;
    const hb = new HeartbeatManager("https://snap.test", { fetch: fake, intervalMs: 5 });
    try {
      hb.startBusy("sess-1");
      await waitFor(() => calls.length >= 3); // 首次 busy + 至少 2 次 tick（后台，不记录）
      hb.stopBusy("sess-1"); // idle（后台，不记录）
      await waitFor(() => calls.length >= 4);
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    // tick 与 idle 确实发生了，但没有进入记录
    expect(calls.length).toBeGreaterThan(2);
    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toBe("https://snap.test/snap-manager/v1/chat-session/heartbeat");
    expect(upstream[0].method).toBe("PUT");
    expect(upstream[0].body).toEqual({ status: "busy" });
    expect(recordedHeader(upstream[0].headers, "authorization")).toBe("<redacted>");
  });

  test("does not record the 24h silent-idle branch triggered from the timer", async () => {
    const { fetch: fake, calls } = recordingFetch(() => Response.json({ ok: true }));
    const trace = startRequestTrace(inbound(), { dir })!;
    const hb = new HeartbeatManager("https://snap.test", { fetch: fake, intervalMs: 5, maxLifetimeMs: 0 });
    try {
      hb.startBusy("sess-2");
      await waitFor(() => calls.length >= 3); // 首个 tick 命中 24h 静默分支：stopBusy idle + idle（后台）
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(calls.length).toBeGreaterThanOrEqual(3);
    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(1);
    expect(upstream[0].body).toEqual({ status: "busy" });
  });
});
