// 华为云 AKSK 签名器 — 逐字移植自内核 sl.sign（provider/OTLP/心跳/网关配置）与
// encrypting-fetch TXe signSimple（key-exchange / chat 上线形态）。
import { createHash, createHmac } from "crypto";

export interface Credentials {
  ak: string; sk: string; securityToken: string; userToken?: string;
  origin?: string; domainId?: string; userId?: string;
  expiresAt?: string; // STS 过期时间（刷新链用）
}

const EMPTY_BODY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const SDK_SIGNING_ALGORITHM = "SDK-HMAC-SHA256";

export function formatDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function isDefaultPort(protocol: string, port: string): boolean {
  if (!port) return true;
  if (protocol === "https:" && port === "443") return true;
  if (protocol === "http:" && port === "80") return true;
  return false;
}

// ---- urlEncode（华为云 SDK 版；sl 与 bL/TXe 的 noEscape 表逐字拷贝，两者仅在尾部个别位不同）----
const SL_NO_ESCAPE =
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,1,0];
const TXE_NO_ESCAPE =
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,1,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,1,0];


function hexTable(table: string[]): string[] {
  if (table.length <= 0)
    for (let i = 0; i < 256; ++i) table[i] = "%" + ((i < 16 ? "0" : "") + i.toString(16)).toUpperCase();
  return table;
}
const SL_HEX: string[] = [];
const TXE_HEX: string[] = [];

function urlEncodeWith(e: string, noEscape: number[], hex: string[]): string {
  if (typeof e !== "string") e = String(e);
  let r = "", i = 0;
  for (let u = 0; u < e.length; ++u) {
    const c = e.charCodeAt(u);
    if (c < 128) {
      if (noEscape[c] === 1) continue;
      if (i < u) r += e.slice(i, u);
      i = u + 1;
      r += hexTable(hex)[c];
      continue;
    }
    if (i < u) r += e.slice(i, u);
    if (c < 2048) { i = u + 1; r += hexTable(hex)[192 | c >> 6] + hexTable(hex)[128 | c & 63]; continue; }
    if (c < 55296 || c >= 57344) { i = u + 1; r += hexTable(hex)[224 | c >> 12] + hexTable(hex)[128 | c >> 6 & 63] + hexTable(hex)[128 | c & 63]; continue; }
    if (++u, u >= e.length) throw Error("ERR_INVALID_URI");
    const p = e.charCodeAt(u) & 1023;
    i = u + 1;
    const s = 65536 + ((c & 1023) << 10 | p);
    r += hexTable(hex)[240 | s >> 18] + hexTable(hex)[128 | s >> 12 & 63] + hexTable(hex)[128 | s >> 6 & 63] + hexTable(hex)[128 | s & 63];
  }
  if (i === 0) return e;
  if (i < e.length) return r + e.slice(i);
  return r;
}

// sl 侧 urlEncode
export function urlEncodeSl(e: string): string { return urlEncodeWith(e, SL_NO_ESCAPE, SL_HEX); }
// encrypting-fetch (TXe/bL) 侧 urlEncode
export function urlEncodeTxe(e: string): string { return urlEncodeWith(e, TXE_NO_ESCAPE, TXE_HEX); }

function canonicalHeadersLowercase(X: Record<string, string>): string {
  const l = Object.keys(X).map((k) => ({ key: k, value: X[k] }));
  l.sort((a, b) => a.key.toLocaleLowerCase().localeCompare(b.key.toLocaleLowerCase()));
  let out = "";
  for (const { key, value } of l) {
    const lk = key.toLocaleLowerCase();
    const v = value.replace(/[\r\n]/g, " ").trim();
    out += `${lk}:${v}\n`;
  }
  return out;
}

function sha256Hex(s: string): string { return createHash("sha256").update(s).digest("hex"); }
function hmacSHA256Hex(key: string, s: string): string { return createHmac("sha256", key).update(s).digest("hex"); }

// ---- TXe signSimple（encrypting-fetch 上线形态；签名头集 content-type;host;x-sdk-content-sha256;x-sdk-date;x-security-token）----
export function signSimple(
  creds: Credentials, method: string, targetUrl: string, contentType: string,
): Record<string, string> {
  const D: Record<string, string> = {};
  const R = formatDate(new Date());
  D["X-Sdk-Date"] = R;
  const B = new URL(targetUrl);
  let W = B.hostname;
  if (B.port && !isDefaultPort(B.protocol, B.port)) W = `${W}:${B.port}`;
  D.Host = W;
  const X = { ...{ "Content-Type": contentType, "X-Sdk-Content-Sha256": "UNSIGNED-PAYLOAD", "X-Security-Token": creds.securityToken }, ...D };
  // canonicalURI：逐段 urlEncode（TXe 表）后强制尾 "/"
  const Z = (() => {
    const l = B.pathname.split("/").map((s) => urlEncodeTxe(s)).join("/");
    return l.endsWith("/") ? l : `${l}/`;
  })();
  const oe = Object.keys(X).sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())).join(";").toLocaleLowerCase();
  const ae = canonicalHeadersLowercase(X);
  const ge = [method, Z, "", ae, oe, "UNSIGNED-PAYLOAD"].join("\n");
  const Se = sha256Hex(ge);
  const Pe = [SDK_SIGNING_ALGORITHM, R, Se].join("\n");
  const Le = hmacSHA256Hex(creds.sk, Pe);
  const Ne = { ...X, Authorization: `${SDK_SIGNING_ALGORITHM} Access=${creds.ak}, SignedHeaders=${oe}, Signature=${Le}` };
  if (creds.securityToken) Ne["X-Security-Token"] = creds.securityToken;
  return Ne;
}

// ---- sl.sign（provider 层 / Sh() 链路：心跳、OTLP、gateway/config、statistics/plugin）----
export interface SlRequest {
  method: string; endpoint: string; data?: any;
  headers: Record<string, string>;
  queryParams?: Record<string, string | string[]>;
}

function slCanonicalURI(pathname: string): string {
  if (!pathname) return "";
  const segs = pathname.split("/").map((s) => urlEncodeSl(s));
  let u = segs.join("/");
  if (u[u.length - 1] !== "/") u += "/";
  return u;
}

function slCanonicalQueryString(req: SlRequest): string {
  if (!req.queryParams) return "";
  const keys = Object.keys(req.queryParams ?? "").sort();
  const out: string[] = [];
  for (const k of keys) {
    const ek = urlEncodeSl(k);
    const v = req.queryParams?.[k];
    if (Array.isArray(v)) {
      v.sort();
      for (const item of v) out.push(`${ek}=${urlEncodeSl(item)}`);
    } else out.push(`${ek}=${urlEncodeSl(v ?? "")}`);
  }
  return out.join("&");
}

function slBuildCanonicalHeaders(headers: Record<string, string>): string {
  const l = Object.keys(headers).map((k) => ({ key: k, value: headers[k] }));
  l.sort((a, b) => a.key.toLocaleLowerCase().localeCompare(b.key.toLocaleLowerCase()));
  let out = "";
  for (const { key, value } of l) {
    const lk = key.toLocaleLowerCase();
    out += `${lk}:${value}\n`;
  }
  return out;
}

export function signSl(req: SlRequest, creds: Credentials): Record<string, string> {
  const inject: Record<string, string> = {};
  let date = req.headers["X-Sdk-Date"];
  if (date) date = formatDate(new Date(date));
  else { date = formatDate(new Date()); inject["X-Sdk-Date"] = date; }
  const url = new URL(req.endpoint);
  let host = url.host;
  if (req.headers["host"]) host = req.headers["host"];
  inject.host = host;
  const merged: Record<string, string> = {};
  Object.assign(merged, req.headers);
  const ct = merged["content-type"];
  if (!ct || !ct.includes("multipart/form-data")) delete merged["content-type"];
  Object.assign(merged, inject);

  const canonicalURI = slCanonicalURI(url.pathname);
  const canonicalQuery = slCanonicalQueryString(req);
  const signedHeaders = Object.keys(merged).sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())).join(";").toLocaleLowerCase();
  const canonicalHeaders = slBuildCanonicalHeaders(merged);
  const payloadHash = merged["X-Sdk-Content-Sha256"]
    ?? (req.data !== undefined ? sha256Hex(JSON.stringify(req.data)) : EMPTY_BODY_SHA256);
  const canonicalRequest = [req.method, canonicalURI, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const hash = sha256Hex(canonicalRequest);
  const stringToSign = [SDK_SIGNING_ALGORITHM, date, hash].join("\n");
  const signature = hmacSHA256Hex(creds.sk, stringToSign);
  const out = { ...merged, Authorization: `${SDK_SIGNING_ALGORITHM} Access=${creds.ak}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  return out;
}

// ---- Sh()（auth-util）语义：AKSK 时 X-Security-token（小写 t）；signBody=false → UNSIGNED-PAYLOAD ----
export function signSh(
  req: { method: string; endpoint: string; data?: any; headers: Record<string, string>; queryParams?: Record<string, string | string[]> },
  creds: Credentials, opts?: { signBody?: boolean },
): Record<string, string> {
  const headers: Record<string, string> = { ...req.headers };
  if (creds.securityToken) headers["X-Security-token"] = creds.securityToken;
  if (opts?.signBody === false) headers["X-Sdk-Content-Sha256"] = "UNSIGNED-PAYLOAD";
  return signSl({ ...req, headers }, creds);
}
