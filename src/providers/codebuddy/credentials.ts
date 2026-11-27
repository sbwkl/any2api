// 凭证源抽象 — facade 经此按请求获取凭证，不再在构造时捕获固定凭证对象。
import { loadCredentials } from "./config";
import type { Credentials } from "./types";

export interface CredentialSource {
  /** 当前内存凭证；未就绪时为 null */
  get(): Credentials | null;
  /** 按需回源：重新读取凭证源（CODEBUDDY_SESSION_JSON → CODEBUDDY_TOKEN/UID/REFRESH_TOKEN → Keychain + state.vscdb）；无凭证/失败返回 null，不抛错 */
  reload(): Promise<Credentials | null>;
  /** 采纳新凭证（内置 refreshToken 刷新成功后回写），使后续请求可见 */
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

/** 生产默认源：构造时立即加载一次真实凭证，加载失败（未登录）进入「凭证未就绪」空态而非抛出；
 *  reload() 按需回源重跑 loadCredentials()，取源优先级不变（SESSION_JSON → env → Keychain + state.vscdb），失败返回 null。 */
export function defaultCredentialSource(): CredentialSource {
  let current: Credentials | null = null;
  try {
    current = loadCredentials();
  } catch {
    current = null;
  }
  return {
    get: () => current,
    reload: async () => {
      try {
        current = loadCredentials();
      } catch {
        current = null;
      }
      return current;
    },
    adopt: (next) => {
      current = next;
    },
  };
}
