import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ServerHandle {
  baseUrl: string;
  dumpDir: string;
  captureDir: string;
  logs: () => string;
  stop: () => Promise<void>;
}

export interface StartServerOptions {
  port?: number;
  env?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
}

interface Spawned {
  exited: Promise<number>;
  exitCode: number | null;
  kill: (signal?: number | NodeJS.Signals) => void;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
}

async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return true;
    } catch {
      // retry until deadline
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export async function startServer(opts: StartServerOptions = {}): Promise<ServerHandle> {
  const dumpDir = mkdtempSync(join(tmpdir(), "any2api-e2e-upstream-"));
  const captureDir = mkdtempSync(join(tmpdir(), "any2api-e2e-capture-"));
  const chunks: string[] = [];
  const logs = () => chunks.join("");

  const proc = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...opts.env,
      PORT: String(opts.port ?? 0),
      HOST: "127.0.0.1",
      UPSTREAM_DUMP_DIR: dumpDir,
      TRACE_CAPTURE_DIR: captureDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  }) as unknown as Spawned;

  const collector = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        chunks.push(decoder.decode(chunk, { stream: true }));
        if (chunks.length > 500) chunks.splice(0, chunks.length - 500);
      }
    } catch {
      // stream closed on kill
    }
  };
  void collector(proc.stdout as ReadableStream<Uint8Array>);
  void collector(proc.stderr as ReadableStream<Uint8Array>);

  const startupTimeoutMs = opts.startupTimeoutMs ?? 90000;
  const portOk = await waitFor(() => {
    if (proc.exitCode !== null) throw new Error(`服务进程提前退出（code=${proc.exitCode}）：\n${logs()}`);
    return /http:\/\/127\.0\.0\.1:(\d+)/.test(logs());
  }, startupTimeoutMs);
  if (!portOk) {
    proc.kill();
    throw new Error(`等待服务监听端口超时：\n${logs()}`);
  }
  const port = Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(logs())![1]);
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthy = await waitFor(async () => {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  }, 30000);
  if (!healthy) {
    proc.kill();
    throw new Error(`服务健康检查超时：\n${logs()}`);
  }

  const stop = async () => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    const exited = await Promise.race([
      proc.exited.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (!exited) proc.kill("SIGKILL");
  };

  return { baseUrl, dumpDir, captureDir, logs, stop };
}
