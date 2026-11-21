// 消息中心轮询（可选旁路信号）— RFC-0001 §5.8
// 真实 IDE 每 30s GET /v2/msg-center/message/summary；默认关闭，CODEBUDDY_MSG_CENTER=1 开启。
import type { Credentials, ProductConfig } from "./types";

export interface MsgCenterOptions {
  config: ProductConfig;
  getCredentials: () => Credentials;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}

export class MsgCenterPoller {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private opts: MsgCenterOptions) {}

  start(): void {
    if (this.timer) return;
    const interval = this.opts.intervalMs ?? 30000;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    const creds = this.opts.getCredentials();
    const version = this.opts.config.version || "3.10.0";
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${creds.accessToken}`,
      "X-User-Id": creds.uid,
      "X-Product": this.opts.config.deploymentType || "SaaS",
      "X-Product-Version": version,
      "User-Agent": `CodeBuddy/${version}`,
      "Accept": "application/json",
    };
    if (creds.domain) headers["X-Domain"] = creds.domain;
    const url = `${this.opts.config.endpoint}/v2/msg-center/message/summary`;
    const resp = await (this.opts.fetchImpl ?? fetch)(url, { headers });
    if (!resp.ok) {
      await resp.text().catch(() => {});
      return;
    }
    const json: any = await resp.json().catch(() => null);
    // 静默：只维护“在线”信号，不输出轮询日志；需要观测时用 CODEBUDDY_DEBUG=1。
    if (process.env.CODEBUDDY_DEBUG === "1") {
      console.log(`[codebuddy] msg-center summary total=${json?.data?.total ?? "?"}`);
    }
  }
}