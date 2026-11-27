// 凭证源语义：reload 纯读不写回、失败不清空 current、短 TTL 负缓存——注入 load/now 驱动，不触真实 Keychain。
import { test, expect, describe } from "bun:test";
import { defaultCredentialSource } from "./credentials";
import type { Credentials } from "./types";

const t1: Credentials = { accessToken: "tok", refreshToken: "ref", uid: "u1", source: "env" };
const t2: Credentials = { accessToken: "new", refreshToken: "ref2", uid: "u1", source: "env" };

describe("defaultCredentialSource", () => {
  test("reload is a pure read: a stale disk candidate does not clobber an adopted newer credential", async () => {
    let disk = t1;
    const src = defaultCredentialSource({ load: () => disk });
    expect(src.get()).toBe(t1);
    src.adopt(t2); // 模拟内置刷新成功回写（磁盘仍停留在 t1）
    const candidate = await src.reload();
    expect(candidate).toBe(t1);
    expect(src.get()).toBe(t2);
  });

  test("reload failure must not clear the current credential", async () => {
    const src = defaultCredentialSource({
      load: () => {
        throw new Error("keychain hiccup");
      },
    });
    src.adopt(t2);
    await expect(src.reload()).resolves.toBeNull();
    expect(src.get()).toBe(t2);
  });

  test("empty start: reload returns the disk candidate without adopting; explicit adopt makes it visible", async () => {
    let disk: Credentials | null = null;
    const src = defaultCredentialSource({
      load: () => {
        if (!disk) throw new Error("not found");
        return disk;
      },
    });
    expect(src.get()).toBeNull();
    disk = t1;
    expect(await src.reload()).toBe(t1);
    expect(src.get()).toBeNull();
    src.adopt(t1);
    expect(src.get()).toBe(t1);
  });

  test("failed reloads are negative-cached for a short TTL to bound blocking re-reads", async () => {
    let calls = 0;
    let t = 0;
    const src = defaultCredentialSource({
      load: () => {
        calls++;
        throw new Error("boom");
      },
      now: () => t,
      negativeTtlMs: 3000,
    });
    expect(await src.reload()).toBeNull();
    expect(calls).toBe(2); // 构造时已读一次
    t = 1000;
    expect(await src.reload()).toBeNull();
    expect(calls).toBe(2); // TTL 内命中负缓存，不再触 load
    t = 4000;
    expect(await src.reload()).toBeNull();
    expect(calls).toBe(3); // TTL 过期重新回源
  });
});
