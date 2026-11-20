// 签名器真机验证：用现有（可能过期的）STS 调 key-exchange，区分"签名错误"vs"token 过期"
import { loadCredentials } from "./config";
import { signSimple } from "./signer";
import { createECDH } from "crypto";

const creds = loadCredentials();
console.log(`[test] ak=${creds.ak.slice(0, 10)}... token_len=${creds.securityToken.length}`);

const ecdh = createECDH("prime256v1");
const clientPublicKey = ecdh.generateKeys().toString("base64");
const sessionId = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, "0")).join("");
const url = "https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/security/key-exchange";
const headers = signSimple(creds, "POST", url, "application/json");
console.log("[test] 签名头集:", Object.keys(headers).join(","));
console.log("[test] Authorization:", headers.Authorization.slice(0, 80) + "...");

const resp = await fetch(url, {
  method: "POST",
  headers,
  body: JSON.stringify({ clientPublicKey, sessionId, timestamp: Date.now() }),
});
const text = await resp.text();
console.log(`[test] HTTP ${resp.status}`);
console.log("[test] body:", text.slice(0, 500));
if (resp.ok) {
  const data = JSON.parse(text);
  const shared = ecdh.computeSecret(Buffer.from(data.serverPublicKey, "base64"));
  const { createHash } = await import("crypto");
  const key = createHash("sha256").update(shared).digest().subarray(0, 16);
  console.log("[test] keyId:", data.keyId, "expiresIn:", data.expiresIn, "sessionKey(前8字节):", Buffer.from(key.slice(0, 8)).toString("hex"));
}
