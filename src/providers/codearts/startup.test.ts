import { test, expect, describe } from "bun:test";
import { planStartupCredentials } from "./index";
import type { Credentials } from "./signer";

const base: Credentials = { ak: "a", sk: "s", securityToken: "t" };
const past = new Date(Date.now() - 3_600_000).toISOString();
const future = new Date(Date.now() + 3_600_000).toISOString();

describe("codearts startup credential plan", () => {
  test("env static credentials (no expiry) are used as-is", () => {
    expect(planStartupCredentials(base, null)).toEqual({ creds: base, refresh: false });
  });

  test("a token with unknown or unparseable expiry is not treated as expired", () => {
    for (const expiresAt of [undefined, "not-a-date"]) {
      const creds = { ...base, expiresAt };
      expect(planStartupCredentials(creds, null)).toEqual({ creds, refresh: false });
    }
  });

  test("an expired token with SecretStorage lineage is refreshed", () => {
    const secret = { ...base, expiresAt: past, refreshToken: "refresh-1" };
    expect(planStartupCredentials(null, secret)).toEqual({ creds: secret, refresh: true });
  });

  test("a token that has not expired yet is used without refreshing", () => {
    const creds = { ...base, expiresAt: future };
    expect(planStartupCredentials(creds, null)).toEqual({ creds, refresh: false });
  });

  test("an expired token without lineage fails with a clear message", () => {
    expect(() => planStartupCredentials({ ...base, expiresAt: past }, null)).toThrow("无刷新凭据");
  });

  test("a refreshable lineage rescues an expired snap-key bootstrap", () => {
    // snap 键更新但已过期，SecretStorage 中的 lineage 仍可续期
    const bootstrap = { ...base, expiresAt: new Date(Date.now() - 1_800_000).toISOString() };
    const secret = { ...base, expiresAt: past, refreshToken: "refresh-1" };
    const plan = planStartupCredentials(bootstrap, secret);
    expect(plan.creds).toEqual(bootstrap); // 更新时间更近的 snap 键被选中
    expect(plan.refresh).toBe(true);
  });

  test("a secret session without a refresh token cannot rescue an expired bootstrap", () => {
    const bootstrap = { ...base, expiresAt: past };
    const secret = { ...base, expiresAt: past };
    expect(() => planStartupCredentials(bootstrap, secret)).toThrow("无刷新凭据");
  });

  test("missing credentials on both sides fail", () => {
    expect(() => planStartupCredentials(null, null)).toThrow("未找到凭证");
  });
});