import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { createECDH, createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flushRequestTraces, runWithRequestTrace, startRequestTrace, type FetchLike } from "../../shared/trace";
import { createRetryBudget } from "./retry";
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

  test("non-encrypted CodeArts responses keep the upstream-readable L3 JSONL record unchanged", async () => {
    // force-plaintext 走 sendPlaintext，是 chat 唯一不协商密钥、不解密的上游路径。
    process.env.CODEARTS_FORCE_PLAINTEXT = "1";
    const plainBody = 'data: {"ok":1}\n\n';
    const { fetch: fake, calls } = recordingFetch(
      () => new Response(plainBody, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-plain-l3" }, chatBody());
    expect(await res.text()).toBe(plainBody);
    await trace.finish(Response.json({ ok: true }));

    const record = readRecords()[0];
    expect(record.schema).toBe(3);
    expect(record.upstream).toHaveLength(1);
    const chatAttempt = record.upstream[0];
    expect(calls.map((c) => c.url)).toEqual([CHAT_URL]);
    expect(chatAttempt.url).toBe(CHAT_URL);
    expect(chatAttempt.response.status).toBe(200);
    expect(chatAttempt.response.body).toBe(plainBody);
    expect(recordedHeader(chatAttempt.response.headers, "content-type")).toBe("text/event-stream");
    expect(recordedHeader(chatAttempt.response.headers, "x-encrypt-algo")).toBeNull();
    expect(chatAttempt.response.decode_error).toBeUndefined();
    expect(chatAttempt.response.complete).toBe(true);
    expect(JSON.stringify(record)).not.toContain("x-encrypt-algo");
  });

  test("records key-exchange and the graded 5xx retries", async () => {
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
    // 500 属短阶梯（总尝试 3 次）；注入假 sleep 避免真实等待。
    const snap = new SnapClient("https://snap.test", fake, { sleep: async () => {} });
    let resText = "";
    let resStatus = 0;
    try {
      const res = await snap.chat(CHAT_URL, headers, bodyObj);
      resStatus = res.status;
      resText = await res.text();
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    // 500 按短阶梯重试到第 3 次总尝试后返回上游错误；明文回退已移除
    expect(resStatus).toBe(500);
    expect(resText).toBe("ENCRYPTED_STAGE_FAILED");
    expect(calls.map((c) => c.url)).toEqual([KEY_EXCHANGE_URL, CHAT_URL, CHAT_URL, CHAT_URL]);

    const upstream = readRecords()[0].upstream;
    expect(upstream).toHaveLength(4);

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

    // 第二次仍是加密重试，而不是不可用的明文
    expect(upstream[2].url).toBe(CHAT_URL);
    expect(upstream[2].body).toEqual(bodyObj);
    expect(recordedHeader(upstream[2].headers, "x-encrypt-algo")).toBe("sm4-gcm");
    expect(recordedHeader(upstream[2].headers, "x-ot-trace-id")).toBe("trace-1");
    expect(upstream[2].response.status).toBe(500);

    // 第三次（短阶梯最后一跳）仍是加密尝试，而不是不可用的明文
    expect(upstream[3].url).toBe(CHAT_URL);
    expect(recordedHeader(upstream[3].headers, "x-encrypt-algo")).toBe("sm4-gcm");
    expect(upstream[3].response.status).toBe(500);

    // 尝试按发生顺序
    expect(upstream[0].t_ms).toBeLessThanOrEqual(upstream[1].t_ms);
    expect(upstream[1].t_ms).toBeLessThanOrEqual(upstream[2].t_ms);
    expect(upstream[2].t_ms).toBeLessThanOrEqual(upstream[3].t_ms);
    // 敏感值不落盘
    expect(JSON.stringify(upstream)).not.toContain("business-secret");
  });

  test("L3 records decrypted plaintext SSE with schema 3 while the caller receives the same plaintext", async () => {
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

    const record = readRecords()[0];
    expect(record.schema).toBe(3);
    const upstream = record.upstream;
    expect(upstream).toHaveLength(2);
    const chatAttempt = upstream[1];
    // L3 是 provider 解码后的可读响应：无加密头，content-type 为解码后的类型
    expect(recordedHeader(chatAttempt.response.headers, "x-encrypt-algo")).toBeNull();
    expect(recordedHeader(chatAttempt.response.headers, "x-encrypt-key-id")).toBeNull();
    expect(recordedHeader(chatAttempt.response.headers, "content-type")).toBe("text/event-stream");
    // L3 正文为明文 SSE，与调用方收到的内容一致，且不含密文帧形态
    const expectedPlaintext = plainFrames.map((frame) => frame + "\n\n").join("");
    expect(chatAttempt.response.body).toBe(expectedPlaintext);
    expect(chatAttempt.response.body).toBe(plaintext);
    expect(chatAttempt.response.body).toContain("data:");
    expect(chatAttempt.response.body).not.toContain(`${keyId}|`);
    for (const frame of rawFrames) expect(chatAttempt.response.body).not.toContain(frame);
    expect(chatAttempt.response.chunks.length).toBeGreaterThanOrEqual(1);
    expect(chatAttempt.response.chunks.reduce((n: number, c: any) => n + c.bytes, 0)).toBe(
      encoder.encode(expectedPlaintext).byteLength,
    );
    expect(chatAttempt.response.complete).toBe(true);
  });

  test("a corrupt encrypted frame keeps the decrypted prefix in L3 with a structured decode_error and no retry", async () => {
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const cipher = new SM4GCM();
    const keyId = "kid-10";
    let sessionKey: Uint8Array | null = null;
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    const firstPlain = 'data: {"a":1}\n\n';

    const { fetch: fake, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        const reqBody = JSON.parse(String(call.init.body));
        const shared = server.computeSecret(Buffer.from(reqBody.clientPublicKey, "base64"));
        sessionKey = new Uint8Array(createHash("sha256").update(shared).digest().subarray(0, 16));
        return Response.json({ serverPublicKey, keyId, expiresIn: 3600 });
      }
      const { ciphertext, iv, authTag } = cipher.encrypt(sessionKey!, encoder.encode(firstPlain), `${keyId}|0`);
      const badTag = authTag.slice();
      badTag[0] ^= 1;
      const corrupt = `${b64(iv)}:${b64(badTag)}:${b64(ciphertext)}`;
      return new Response(`${b64(iv)}:${b64(authTag)}:${b64(ciphertext)}\n\n${corrupt}\n\n`, {
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
    let callerError: unknown;
    try {
      const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-4" }, chatBody());
      try {
        await res.text();
      } catch (e) {
        callerError = e;
      }
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    // 调用方流拒绝，且没有因解密失败新增重试/预读
    expect(callerError).toBeDefined();
    expect(calls.filter((c) => c.url === CHAT_URL)).toHaveLength(1);

    const record = readRecords()[0];
    expect(record.upstream).toHaveLength(2);
    const chatAttempt = record.upstream[1];
    // L3 保留失败前已解密的明文前缀，并明确标记不完整
    expect(chatAttempt.response.body).toBe(firstPlain + "\n\n");
    expect(chatAttempt.response.complete).toBe(false);
    expect(chatAttempt.response.decode_error).toEqual({
      stage: "frame_decrypt",
      chunk_index: 1,
      message: "authentication tag mismatch",
    });
    // 请求级中断原因与未发生解密失败时一致（不引入新的中断原因）
    expect(record.response.abort_reason).toBeNull();
  });

  test("key-exchange failure rejects instead of sending a useless plaintext chat", async () => {
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return new Response("KX_DOWN", { status: 500 });
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let error: any;
    try {
      await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-3" }, chatBody());
    } catch (e) {
      error = e;
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(String(error?.message)).toContain("key exchange failed");
    const upstream = readRecords()[0].upstream;
    expect(upstream.map((u: any) => u.url)).toEqual([KEY_EXCHANGE_URL]);
    expect(upstream[0].response.status).toBe(500);
    expect(upstream[0].response.body).toBe("KX_DOWN");
  });

  test("a bare encrypted network error is surfaced without retrying or falling back to plaintext", async () => {
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      throw new Error("socket closed");
    });

    const trace = startRequestTrace(inbound(), { dir })!;
    const snap = new SnapClient("https://snap.test", fake);
    let error: any;
    try {
      await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-4" }, chatBody());
    } catch (e) {
      error = e;
    } finally {
      await trace.finish(Response.json({ ok: true }));
    }

    expect(String(error?.message)).toContain("upstream network error");
    const upstream = readRecords()[0].upstream;
    // key-exchange + 一次加密尝试；裸网络错误不重试，也没有明文尝试
    expect(upstream).toHaveLength(2);
    expect(upstream[1].response.status).toBe(0);
    expect(upstream[1].response.complete).toBe(false);
    expect(recordedHeader(upstream[1].headers, "x-encrypt-algo")).toBe("sm4-gcm");
  });

  test("a stalled upstream body fails with an idle timeout", async () => {
    process.env.CODEARTS_UPSTREAM_IDLE_TIMEOUT_MS = "50";
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const { fetch: fake } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) return Response.json({ serverPublicKey, keyId: "kid-1", expiresIn: 3600 });
      return new Response(new ReadableStream<Uint8Array>({ start() { /* 永不产出 */ } }), {
        status: 200,
        headers: { "X-Encrypt-Algo": "sm4-gcm", "X-Encrypt-Key-Id": "kid-1", "Content-Type": "text/event-stream" },
      });
    });

    // 不开请求上下文：trace 的上游旁路会一直等这条卡住的流，测试无法收尾
    const snap = new SnapClient("https://snap.test", fake);
    const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-idle" }, chatBody());
    let error: any;
    try {
      await res.text();
    } catch (e) {
      error = e;
    }
    expect(String(error?.message)).toContain("upstream idle timeout");
  });

  test("CODEARTS_FORCE_PLAINTEXT=1 sends the debug plaintext request without key exchange", async () => {
    process.env.CODEARTS_FORCE_PLAINTEXT = "1";
    const bodyObj = chatBody();
    const { fetch: fake, calls } = recordingFetch(
      () => new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    const snap = new SnapClient("https://snap.test", fake);
    const res = await snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-plain" }, bodyObj);

    expect(res.status).toBe(200);
    // 只发明文：没有 key-exchange，也没有加密重试
    expect(calls.map((c) => c.url)).toEqual([CHAT_URL]);
    expect(String(calls[0].init.body)).toBe(JSON.stringify(bodyObj));
    expect(headerValue(calls[0], "X-Encrypt-Algo")).toBeNull();
    expect(headerValue(calls[0], "Content-Type")).not.toBe("application/octet-stream");
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

describe("client cancellation", () => {
  function inboundWithSignal(signal: AbortSignal): Request {
    return new Request("http://localhost/codearts/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      signal,
    });
  }

  /** 加密 chat 的假 fetch：一直挂着，直到 init.signal 中止才 reject。 */
  function hangingChatFetch(onChatStarted: () => void) {
    return (call: RecordedCall): Response | Promise<Response> => {
      if (call.url === KEY_EXCHANGE_URL)
        return Response.json({ serverPublicKey: serverPublicKey(), keyId: "kid-1", expiresIn: 3600 });
      onChatStarted();
      return new Promise<Response>((_, reject) => {
        const signal = call.init.signal;
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (!signal) return; // 没有 signal 就永远挂着，超时会暴露回归
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail);
      });
    };
  }

  function serverPublicKey(): string {
    return createECDH("prime256v1").generateKeys().toString("base64");
  }

  test("abort rejects the in-flight encrypted chat fetch without retrying and records L3 incomplete", async () => {
    process.env.TRACE_CAPTURE_DIR = dir;
    const controller = new AbortController();
    let chatStarted!: () => void;
    const chatStartedP = new Promise<void>((r) => { chatStarted = r; });
    const { fetch: fake, calls } = recordingFetch(hangingChatFetch(() => chatStarted()));

    const snap = new SnapClient("https://snap.test", fake);
    const pending = runWithRequestTrace(inboundWithSignal(controller.signal), () =>
      snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel" }, chatBody(), { signal: controller.signal }));
    await chatStartedP;
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    await flushRequestTraces();

    // 上游 fetch 本身收到了 abort；取消后没有任何重试，也没有第二次 chat
    const chatCalls = calls.filter((c) => c.url === CHAT_URL);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].init.signal).toBeDefined();
    expect(chatCalls[0].init.signal!.aborted).toBe(true);
    // 密钥协商不跟随取消
    const keyExchange = calls.find((c) => c.url === KEY_EXCHANGE_URL)!;
    expect(keyExchange.init.signal).toBeUndefined();

    const record = readRecords()[0];
    // 观测：客户端断开是第一中断原因；上游可读响应未完成
    expect(record.response.abort_reason).toBe("client_disconnect");
    expect(record.response.complete).toBe(false);
    const chatAttempt = record.upstream.find((u: any) => u.url === CHAT_URL);
    expect(chatAttempt).toBeDefined();
    expect(chatAttempt.response.complete).toBe(false);
  });

  test("abort during key exchange lets the exchange finish but never sends chat", async () => {
    process.env.TRACE_CAPTURE_DIR = dir;
    const controller = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { fetch: fake, calls } = recordingFetch(async (call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        await gate; // 模拟协商仍在进行时客户端断开
        return Response.json({ serverPublicKey: serverPublicKey(), keyId: "kid-1", expiresIn: 3600 });
      }
      return new Response('data: {"ok":1}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    const snap = new SnapClient("https://snap.test", fake);
    const pending = runWithRequestTrace(inboundWithSignal(controller.signal), () =>
      snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel-kx" }, chatBody(), { signal: controller.signal }));
    await waitFor(() => calls.length === 1);
    controller.abort();
    release();
    await expect(pending).rejects.toBeDefined();
    await flushRequestTraces();

    // 协商不被取消、也不抛出；但协商完成后不再发 chat
    expect(calls.map((c) => c.url)).toEqual([KEY_EXCHANGE_URL]);
    expect(calls[0].init.signal).toBeUndefined();
    const record = readRecords()[0];
    expect(record.response.abort_reason).toBe("client_disconnect");
    expect(record.upstream.map((u: any) => u.url)).toEqual([KEY_EXCHANGE_URL]);
  });

  test("cancellation aborts the upstream fetch even when observability is off", async () => {
    // beforeEach 已删除 TRACE_CAPTURE_DIR：观测关闭
    const controller = new AbortController();
    let chatStarted!: () => void;
    const chatStartedP = new Promise<void>((r) => { chatStarted = r; });
    const { fetch: fake, calls } = recordingFetch(hangingChatFetch(() => chatStarted()));

    const snap = new SnapClient("https://snap.test", fake);
    const pending = snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel-off" }, chatBody(), { signal: controller.signal });
    await chatStartedP;
    controller.abort();
    await expect(pending).rejects.toBeDefined();

    const chatCalls = calls.filter((c) => c.url === CHAT_URL);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].init.signal!.aborted).toBe(true);
  });

  test("an already-aborted signal performs no key exchange and no chat", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch: fake, calls } = recordingFetch(() => Response.json({ ok: true }));
    const snap = new SnapClient("https://snap.test", fake);

    await expect(
      snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel-entry" }, chatBody(), { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(calls).toHaveLength(0);
  });

  test("a 5xx received after abort is not retried", async () => {
    const controller = new AbortController();
    const { fetch: fake, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL)
        return Response.json({ serverPublicKey: serverPublicKey(), keyId: "kid-1", expiresIn: 3600 });
      controller.abort(); // 上游 5xx 与客户端断开同时发生：取消优先
      return new Response("ENCRYPTED_STAGE_FAILED", { status: 500 });
    });

    const snap = new SnapClient("https://snap.test", fake);
    await expect(
      snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel-5xx" }, chatBody(), { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(calls.filter((c) => c.url === CHAT_URL)).toHaveLength(1);
  });

  test("abort after encrypted headers terminates the decryption stream without a new request", async () => {
    process.env.TRACE_CAPTURE_DIR = dir;
    const controller = new AbortController();
    const server = createECDH("prime256v1");
    const serverPublicKey = server.generateKeys().toString("base64");
    const cipher = new SM4GCM();
    const keyId = "kid-11";
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    let sessionKey: Uint8Array | null = null;
    const plain = 'data: {"ok":1}\n\n';

    const { fetch: fake, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        const reqBody = JSON.parse(String(call.init.body));
        const shared = server.computeSecret(Buffer.from(reqBody.clientPublicKey, "base64"));
        sessionKey = new Uint8Array(createHash("sha256").update(shared).digest().subarray(0, 16));
        return Response.json({ serverPublicKey, keyId, expiresIn: 3600 });
      }
      return new Response(new ReadableStream<Uint8Array>({
        start(ctrl) {
          // 先给一帧可解密内容，之后挂起直到客户端取消（模拟真实 fetch 的 body 中止）
          const { ciphertext, iv, authTag } = cipher.encrypt(sessionKey!, encoder.encode(plain), `${keyId}|0`);
          ctrl.enqueue(encoder.encode(`${b64(iv)}:${b64(authTag)}:${b64(ciphertext)}\n\n`));
          const fail = () => ctrl.error(new DOMException("aborted", "AbortError"));
          const signal = call.init.signal;
          if (!signal) return;
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail);
        },
      }), {
        status: 200,
        headers: { "X-Encrypt-Algo": "sm4-gcm", "X-Encrypt-Key-Id": keyId, "Content-Type": "text/event-stream" },
      });
    });

    const snap = new SnapClient("https://snap.test", fake);
    const resp = await runWithRequestTrace(inboundWithSignal(controller.signal), () =>
      snap.chat(CHAT_URL, { "x-ot-trace-id": "trace-cancel-mid" }, chatBody(), { signal: controller.signal }));

    const reader = resp.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value!).toString("utf8")).toContain('data: {"ok":1}');
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await flushRequestTraces();

    // 解密流已开始后取消：同样不重试、不再发第二次 chat
    expect(calls.filter((c) => c.url === CHAT_URL)).toHaveLength(1);
    const record = readRecords()[0];
    expect(record.response.abort_reason).toBe("client_disconnect");
    const chatAttempt = record.upstream.find((u: any) => u.url === CHAT_URL);
    expect(chatAttempt.response.complete).toBe(false);
  });
});

describe("state-level retry and the shared budget", () => {
  type Step = { status: number; body?: string; headers?: Record<string, string> } | { networkError: string };

  function serverPublicKey(): string {
    return createECDH("prime256v1").generateKeys().toString("base64");
  }

  /** 脚本化上游：key-exchange 固定成功，chat 按顺序吐出 step；sleep 只记录不等待。 */
  function scriptedSnap(script: Step[], opts: { keyExchanges?: number } = {}) {
    const exchangeCount = opts.keyExchanges ?? 1;
    const servers = Array.from({ length: exchangeCount }, () => createECDH("prime256v1"));
    let exchange = 0;
    let chatIndex = 0;
    const delays: number[] = [];
    const { fetch, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        const server = servers[Math.min(exchange, servers.length - 1)];
        exchange++;
        return Response.json({
          serverPublicKey: server.generateKeys().toString("base64"),
          keyId: `kid-${exchange}`,
          expiresIn: 3600,
        });
      }
      const step = script[chatIndex++];
      if (!step) throw new Error("unscripted chat attempt");
      if ("networkError" in step) throw new Error(step.networkError);
      return new Response(step.body ?? "", { status: step.status, headers: step.headers });
    });
    const snap = new SnapClient("https://snap.test", fetch, {
      sleep: async (ms) => { delays.push(ms); },
      now: () => 0,
      random: () => 0,
    });
    return { snap, calls, delays, chatCalls: () => calls.filter((c) => c.url === CHAT_URL) };
  }

  test("503 uses the short ladder: three total attempts, then the upstream error is surfaced", async () => {
    const { snap, delays, chatCalls } = scriptedSnap([
      { status: 503, body: "APIG.0613" },
      { status: 503, body: "APIG.0613" },
      { status: 503, body: "APIG.0613" },
    ]);
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(503);
    expect(await resp.text()).toBe("APIG.0613");
    expect(chatCalls()).toHaveLength(3);
    expect(delays).toEqual([500, 1000]);
    expect(budget.attempts).toBe(3);
  });

  test("429 uses the long ladder: ten total attempts and nine backoff waits", async () => {
    const { snap, delays, chatCalls } = scriptedSnap(
      Array.from({ length: 10 }, () => ({ status: 429, body: "APIG.0308" })),
    );
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(429);
    expect(chatCalls()).toHaveLength(10);
    // 500, 1000, 2000, 4000，其后封顶 5s；jitter 由 random=()=>0 固定。
    expect(delays).toEqual([500, 1000, 2000, 4000, 5000, 5000, 5000, 5000, 5000]);
    expect(budget.attempts).toBe(10);
  });

  test.each([429, 406, 502])("%i is retried once and recovers on the second attempt", async (status) => {
    const { snap, delays, chatCalls } = scriptedSnap([{ status }, { status: 200, body: "ok" }]);
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("ok");
    expect(chatCalls()).toHaveLength(2);
    expect(delays).toEqual([500]);
    expect(budget.attempts).toBe(2);
  });

  test.each([500, 503, 504, 407])("%i is retried once and recovers on the second attempt", async (status) => {
    const { snap, delays, chatCalls } = scriptedSnap([{ status }, { status: 200, body: "ok" }]);
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(200);
    expect(chatCalls()).toHaveLength(2);
    expect(delays).toEqual([500]);
  });

  test.each([400, 401, 404, 405, 505])("other status %i is not retried", async (status) => {
    const { snap, delays, chatCalls } = scriptedSnap([{ status, body: "nope" }]);
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(status);
    expect(await resp.text()).toBe("nope");
    expect(chatCalls()).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(budget.attempts).toBe(1);
  });

  test("a bare network error is not retried", async () => {
    const { snap, delays, chatCalls } = scriptedSnap([{ networkError: "socket connection was closed" }]);
    const budget = createRetryBudget();

    await expect(snap.chat(CHAT_URL, {}, chatBody(), { budget })).rejects.toThrow("upstream network error");

    expect(chatCalls()).toHaveLength(1);
    expect(delays).toEqual([]);
    expect(budget.attempts).toBe(1);
  });

  test("an upstream retry-after hint overrides the computed backoff", async () => {
    const { snap, delays } = scriptedSnap([
      { status: 429, headers: { "retry-after": "2" } },
      { status: 200, body: "ok" },
    ]);

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget: createRetryBudget() });

    expect(resp.status).toBe(200);
    expect(delays).toEqual([2000]);
  });

  test("a key-expired resend keeps working but debits the shared budget", async () => {
    const { snap, chatCalls } = scriptedSnap(
      [
        { status: 400, body: "ENCRYPT_KEY_EXPIRED" },
        { status: 200, body: "ok" },
      ],
      { keyExchanges: 2 },
    );
    const budget = createRetryBudget();

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(200);
    expect(chatCalls()).toHaveLength(2);
    // 首次 chat + 换 key 重发，各扣一次预算
    expect(budget.attempts).toBe(2);
  });

  test("a shared budget continues across chat calls of the same inbound request", async () => {
    // 前序尝试已用掉 8 次预算：本次 429 只允许再试一次（第 9、10 次）后收手。
    const budget = createRetryBudget();
    budget.attempts = 8;
    const { snap, delays, chatCalls } = scriptedSnap([{ status: 429 }, { status: 491, body: "unexpected" }]);

    const resp = await snap.chat(CHAT_URL, {}, chatBody(), { budget });

    expect(resp.status).toBe(491);
    expect(chatCalls()).toHaveLength(2);
    // 第 9 次尝试后的退避已到达 5s 封顶
    expect(delays).toEqual([5000]);
    expect(budget.attempts).toBe(10);
  });

  test("cancel during a backoff wait ends the retry loop without spending more budget", async () => {
    const controller = new AbortController();
    const delays: number[] = [];
    let chatIndex = 0;
    const { fetch, calls } = recordingFetch((call) => {
      if (call.url === KEY_EXCHANGE_URL) {
        return Response.json({ serverPublicKey: serverPublicKey(), keyId: "kid-1", expiresIn: 3600 });
      }
      chatIndex++;
      return new Response("APIG.0308", { status: 429 });
    });
    const snap = new SnapClient("https://snap.test", fetch, {
      sleep: async (ms) => {
        delays.push(ms);
        controller.abort();
        const err = new Error("client disconnected");
        err.name = "AbortError";
        throw err;
      },
      now: () => 0,
      random: () => 0,
    });
    const budget = createRetryBudget();

    await expect(
      snap.chat(CHAT_URL, {}, chatBody(), { budget, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(calls.filter((c) => c.url === CHAT_URL)).toHaveLength(1);
    expect(delays).toEqual([500]);
    // 取消不消耗预算：只记已经发出的那一次尝试
    expect(budget.attempts).toBe(1);
    expect(chatIndex).toBe(1);
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
    expect(upstream[0].url).toBe("https://snap.test/snap-manager/v1/chat-session/heartbeat?status=busy");
    expect(upstream[0].method).toBe("PUT");
    expect(upstream[0].body).toEqual({});
    expect(recordedHeader(upstream[0].headers, "authorization")).toBe("<redacted>");

    // 首个 busy 的线上调用：status 在查询参数里、body 为 {}
    expect(calls[0].url).toBe("https://snap.test/snap-manager/v1/chat-session/heartbeat?status=busy");
    expect(calls[0].init.body).toBe("{}");

    // 后台 idle（stopBusy）：URL 含 ?status=idle、body 为 {}
    const idleCalls = calls.filter((c) => c.url.includes("?status=idle"));
    expect(idleCalls.length).toBeGreaterThanOrEqual(1);
    expect(idleCalls[0].init.body).toBe("{}");
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
    expect(upstream[0].body).toEqual({});

    // 24h 静默分支触发的两次 idle（后台）：URL 含 ?status=idle、body 为 {}
    const idleCalls = calls.filter((c) => c.url.includes("?status=idle"));
    expect(idleCalls.length).toBeGreaterThanOrEqual(2);
    expect(idleCalls[0].init.body).toBe("{}");
  });

  test("warns with status code and body fragment on non-2xx heartbeat responses without rejecting", async () => {
    const warnArgs: unknown[][] = [];
    const warnMock = spyOn(console, "warn").mockImplementation((...args) => { warnArgs.push(args); });
    try {
      const { fetch: fake } = recordingFetch(() => new Response('{"error_code":"TM.00001001"}', { status: 400 }));
      const hb = new HeartbeatManager("https://snap.test", { fetch: fake, intervalMs: 60000 });
      hb.startBusy("sess-400"); // 首个 busy（请求链内路径）
      await waitFor(() => warnArgs.length >= 1);
      hb.stopBusy("sess-400"); // idle（后台路径）
      await waitFor(() => warnArgs.length >= 2);
    } finally {
      warnMock.mockRestore();
    }

    // 两条路径都产生 warn：含 HTTP 状态码与响应体片段
    const joined = warnArgs.map((args) => args.join(" ")).join("\n");
    expect(joined).toContain("400");
    expect(joined).toContain("TM.00001001");
  });

  test("logs an error on heartbeat network failures without throwing", async () => {
    const errorArgs: unknown[][] = [];
    const errorMock = spyOn(console, "error").mockImplementation((...args) => { errorArgs.push(args); });
    try {
      const { fetch: fake } = recordingFetch(() => { throw new Error("network down"); });
      const hb = new HeartbeatManager("https://snap.test", { fetch: fake, intervalMs: 60000 });
      hb.startBusy("sess-net"); // 首个 busy（请求链内路径）
      await waitFor(() => errorArgs.length >= 1);
      hb.stopBusy("sess-net"); // idle（后台路径）
      await waitFor(() => errorArgs.length >= 2);
    } finally {
      errorMock.mockRestore();
    }

    expect(errorArgs.map((args) => args.join(" ")).join("\n")).toContain("network down");
  });
});
