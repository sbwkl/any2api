// 遥测仿真器（最小 OTLP/JSON）— spec §5.3：与 chat 同 traceId 的 trace/log，5s 或 30 条批量
// UA=OTel-OTLP-Exporter-JavaScript；Sh 签名（signBody:false → UNSIGNED-PAYLOAD）
import { signSh } from "./signer";
import { getCredentials } from "./config";

const TRACE_URL = "https://collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/traces";
const LOG_URL = "https://collector-agents-access.cn-north-4.myhuaweicloud.com/collector/v1/logs";
const BATCH_DELAY_MS = 5000;
const BATCH_SIZE = 30;

interface SpanRecord { traceId: string; spanId: string; startNs: string; endNs: string; name: string; otFunction: string; modelId: string }
interface LogRecord { traceId: string; spanId: string; timeNs: string; severity: string; body: string; otFunction: string }

const attr = (k: string, v: string) => ({ key: k, value: { stringValue: v } });

export class TelemetrySimulator {
  private spans: SpanRecord[] = [];
  private logs: LogRecord[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private enabled: boolean, private serviceName: string) {
    if (enabled) this.timer = setInterval(() => this.flush().catch(() => {}), BATCH_DELAY_MS);
  }

  recordChat(opts: { traceId: string; spanId: string; startMs: number; endMs: number; otFunction: string; modelId: string }): void {
    if (!this.enabled) return;
    const ns = (ms: number) => `${ms}000000`;
    this.spans.push({
      traceId: opts.traceId, spanId: opts.spanId, name: "Kernel-chat",
      startNs: ns(opts.startMs), endNs: ns(opts.endMs), otFunction: opts.otFunction, modelId: opts.modelId,
    });
    this.logs.push({
      traceId: opts.traceId, spanId: opts.spanId, timeNs: ns(opts.endMs),
      severity: "INFO", body: `inference completed model=${opts.modelId}`, otFunction: opts.otFunction,
    });
    if (this.spans.length >= BATCH_SIZE) this.flush().catch(() => {});
  }

  private resourceAttributes(): any[] {
    return [
      attr("service.name", this.serviceName),
      attr("service.version", "1.0"),
      attr("service.component", "agent"),
      attr("agent_runtime_type", "ide-codeartsdoer"),
      attr("w3account", getCredentials().domainId ?? ""),
    ];
  }

  private execAttrs(r: { otFunction: string }): any[] {
    const creds = getCredentials();
    return [
      attr("service.function", r.otFunction),
      attr("domainId", creds.domainId ?? ""),
      attr("user.id", creds.userId ?? ""),
      attr("process.owner", creds.userId ?? ""),
    ];
  }

  private async flush(): Promise<void> {
    const spans = this.spans.splice(0, this.spans.length);
    const logs = this.logs.splice(0, this.logs.length);
    if (!spans.length && !logs.length) return;
    const jobs: Promise<unknown>[] = [];
    if (spans.length) {
      const payload = {
        resourceSpans: [{
          resource: { attributes: this.resourceAttributes() },
          scopeSpans: [{
            scope: { name: this.serviceName, version: "1.0" },
            spans: spans.map((s) => ({
              traceId: s.traceId, spanId: s.spanId, name: s.name, kind: 1,
              startTimeUnixNano: s.startNs, endTimeUnixNano: s.endNs,
              attributes: [...this.execAttrs(s), attr("model-id", s.modelId)],
              status: { code: 1 },
            })),
          }],
        }],
      };
      jobs.push(this.post(TRACE_URL, payload));
    }
    if (logs.length) {
      const payload = {
        resourceLogs: [{
          resource: { attributes: this.resourceAttributes() },
          scopeLogs: [{
            scope: { name: this.serviceName, version: "1.0" },
            logRecords: logs.map((l) => ({
              timeUnixNano: l.timeNs, observedTimeUnixNano: l.timeNs,
              severityText: l.severity, severityNumber: 9,
              body: { stringValue: l.body },
              traceId: l.traceId, spanId: l.spanId,
              attributes: this.execAttrs(l),
            })),
          }],
        }],
      };
      jobs.push(this.post(LOG_URL, payload));
    }
    await Promise.allSettled(jobs);
  }

  private async post(url: string, payload: any): Promise<void> {
    const headers = signSh({ method: "POST", endpoint: url, headers: { "Content-Type": "application/json" } }, getCredentials(), { signBody: false });
    headers["User-Agent"] = "OTel-OTLP-Exporter-JavaScript";
    try {
      const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!resp.ok) await resp.text().catch(() => {});
    } catch {}
  }
}
