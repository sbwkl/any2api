// 凭证源抽象 — facade 经此按请求获取凭证，不再在构造时捕获固定凭证对象。
import { loadCredentials } from "./config";
import { serviceLogger } from "../../shared/log";
import type { Credentials } from "./types";

export interface CredentialSource {
  /** 当前内存凭证；未就绪时为 null */
  get(): Credentials | null;
  /** 按需回源：纯读磁盘候选凭证——不写回源状态、失败不清空 current（写回一律显式走 adopt()）；无凭证/失败返回 null，不抛错 */
  reload(): Promise<Credentials | null>;
  /** 采纳凭证为当前值（唯一写回机制）：请求前无凭证时采纳回源候选、401 回源读到新凭证、内置刷新成功回写 */
  adopt(next: Credentials): void;
}

/** 常量源：以固定凭证为初值的可采纳源（测试与「启动时已验证凭证」场景） */
export function staticSource(credentials: Credentials): CredentialSource {
  let current = credentials;
  return {
    get: () => current,
    reload: async () => current,
    adopt: (next) => {
      current = next;
    },
  };
}

export interface DefaultSourceOptions {
  /** 回源读取器；缺省真实 loadCredentials（取源优先级不变） */
  load?: () => Credentials;
  /** 时钟；缺省 Date.now */
  now?: () => number;
  /** 回源失败负缓存 TTL（毫秒）；缺省 3000 */
  negativeTtlMs?: number;
}

/** 生产默认源：构造时立即加载一次真实凭证，加载失败（未登录/配置错误）进入「凭证未就绪」空态而非抛出。
 *  reload() 纯读磁盘候选——磁盘可能比内存旧（内置刷新成功只 adopt 进内存、不落盘），写回由调用方按
 *  「是否新凭证」显式 adopt；失败短 TTL 负缓存，避免未就绪期密集重试反复阻塞进程（spawnSync security + sqlite）。 */
export function defaultCredentialSource(opts: DefaultSourceOptions = {}): CredentialSource {
  const load = opts.load ?? loadCredentials;
  const now = opts.now ?? Date.now;
  const negativeTtlMs = opts.negativeTtlMs ?? 3000;
  let current: Credentials | null = null;
  let failedAt: number | null = null;
  try {
    current = load();
  } catch (e: any) {
    // 区分「未登录」与配置/读取错误：原因入日志（错误文案不含凭证内容）
    serviceLogger.warn(`[codebuddy] 启动读取凭证失败: ${e?.message ?? e}`);
  }
  return {
    get: () => current,
    reload: async () => {
      if (failedAt !== null && now() - failedAt < negativeTtlMs) return null;
      try {
        const candidate = load();
        failedAt = null;
        return candidate;
      } catch (e: any) {
        // 纯读：失败不改写 current，避免瞬时读取故障摧毁内存中的有效凭证
        serviceLogger.warn(`[codebuddy] 回源读取凭证失败: ${e?.message ?? e}`);
        failedAt = now();
        return null;
      }
    },
    adopt: (next) => {
      current = next;
    },
  };
}
