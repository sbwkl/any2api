// SM4-GCM — 逐字移植自内核 minified 实现（切片偏移 29121382 起，类 tE / a$ / gXe）。
// GCM 组成为标准 NIST SP 800-38D（H=E_K(0^16)，12B IV 时 J0=IV||00000001，GHASH 标准 GF(2^128) 乘法）。

const SBOX = Uint8Array.from([
  214,144,233,254,204,225,61,183,22,182,20,194,40,251,44,5,43,103,154,118,42,190,4,195,170,68,19,38,73,134,6,153,
  156,66,80,244,145,239,152,122,51,84,11,67,237,207,172,98,228,179,28,169,201,8,232,149,128,223,148,250,117,143,63,166,
  71,7,167,252,243,115,23,186,131,89,60,25,230,133,79,168,104,107,129,178,113,100,218,139,248,235,15,75,112,86,157,53,30,
  36,14,94,99,88,209,162,37,34,124,59,1,33,120,135,212,0,70,87,159,211,39,82,76,54,2,231,160,196,200,158,234,191,
  138,210,64,199,56,181,163,247,242,206,249,97,21,161,224,174,93,164,155,52,26,85,173,147,50,48,245,140,177,227,29,246,226,
  46,130,102,202,96,192,41,35,171,13,83,78,111,213,219,55,69,222,253,142,47,3,255,106,114,109,108,91,81,141,27,175,
  146,187,221,188,127,17,217,92,65,31,16,90,216,10,193,49,136,165,205,123,189,45,116,208,18,184,229,180,176,137,105,151,74,
  12,150,119,126,101,185,241,9,197,110,198,132,24,240,125,236,58,220,77,32,121,238,95,62,215,203,57,72,
]);

// CK 常量（kO）
const CK = new Uint32Array([
  462357,472066609,943670861,1415275113,1886879365,2358483617,2830087869,3301692121,
  3773296373,4228057617,404694573,876298825,1347903077,1819507329,2291111581,2762715833,
  3234320085,3705924337,4177462797,337322537,808926789,1280531041,1752135293,2223739545,
  2695343797,3166948049,3638552301,4110090761,269950501,741554753,1213159005,1684763257,
]);

// FK 常量（Pue 中的立即数）
const FK = [2746333894, 1453994832, 1736282519, 2993693404];

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

// ev: 逐字节 S-box 变换（原 ev()）
function sboxWord(w: number): number {
  return (
    ((SBOX[(w >>> 24) & 255] & 255) << 24 |
     (SBOX[(w >>> 16) & 255] & 255) << 16 |
     (SBOX[(w >>> 8) & 255] & 255) << 8 |
     (SBOX[w & 255] & 255)) >>> 0
  );
}

// 密钥扩展（原 Pue；mode 1=加密序, 0=解密序逆排）
export function keySchedule(key: Uint8Array, rk: Uint32Array, mode: number): void {
  let k = ((key[0] & 255) << 24) | ((key[1] & 255) << 16) | ((key[2] & 255) << 8) | (key[3] & 255);
  let D = ((key[4] & 255) << 24) | ((key[5] & 255) << 16) | ((key[6] & 255) << 8) | (key[7] & 255);
  let R = ((key[8] & 255) << 24) | ((key[9] & 255) << 16) | ((key[10] & 255) << 8) | (key[11] & 255);
  let B = ((key[12] & 255) << 24) | ((key[13] & 255) << 16) | ((key[14] & 255) << 8) | (key[15] & 255);
  k = (k ^ FK[0]) >>> 0; D = (D ^ FK[1]) >>> 0; R = (R ^ FK[2]) >>> 0; B = (B ^ FK[3]) >>> 0;
  for (let J = 0; J < 32; J += 4) {
    let W = (D ^ R ^ B ^ CK[J]) >>> 0; W = sboxWord(W);
    k = (k ^ (W ^ rotl(W, 13) ^ rotl(W, 23))) >>> 0; rk[J] = k;
    W = (R ^ B ^ k ^ CK[J + 1]) >>> 0; W = sboxWord(W);
    D = (D ^ (W ^ rotl(W, 13) ^ rotl(W, 23))) >>> 0; rk[J + 1] = D;
    W = (B ^ k ^ D ^ CK[J + 2]) >>> 0; W = sboxWord(W);
    R = (R ^ (W ^ rotl(W, 13) ^ rotl(W, 23))) >>> 0; rk[J + 2] = R;
    W = (k ^ D ^ R ^ CK[J + 3]) >>> 0; W = sboxWord(W);
    B = (B ^ (W ^ rotl(W, 13) ^ rotl(W, 23))) >>> 0; rk[J + 3] = B;
  }
  if (mode === 0) {
    for (let J = 0; J < 16; J++) {
      const t = rk[J]; rk[J] = rk[31 - J]; rk[31 - J] = t;
    }
  }
}

// 单块加密（原 VT；展开轮次等价为通用 32 轮）
export function encryptBlock(input: Uint8Array, output: Uint8Array, rk: Uint32Array): void {
  let k = ((input[0] & 255) << 24) | ((input[1] & 255) << 16) | ((input[2] & 255) << 8) | (input[3] & 255);
  let D = ((input[4] & 255) << 24) | ((input[5] & 255) << 16) | ((input[6] & 255) << 8) | (input[7] & 255);
  let R = ((input[8] & 255) << 24) | ((input[9] & 255) << 16) | ((input[10] & 255) << 8) | (input[11] & 255);
  let B = ((input[12] & 255) << 24) | ((input[13] & 255) << 16) | ((input[14] & 255) << 8) | (input[15] & 255);
  for (let i = 0; i < 32; i++) {
    let W = (D ^ R ^ B ^ rk[i]) >>> 0; W = sboxWord(W);
    const t = (W ^ rotl(W, 2) ^ rotl(W, 10) ^ rotl(W, 18) ^ rotl(W, 24)) >>> 0;
    const nw = (k ^ t) >>> 0;
    k = D; D = R; R = B; B = nw;
  }
  output[0] = (B >>> 24) & 255; output[1] = (B >>> 16) & 255; output[2] = (B >>> 8) & 255; output[3] = B & 255;
  output[4] = (R >>> 24) & 255; output[5] = (R >>> 16) & 255; output[6] = (R >>> 8) & 255; output[7] = R & 255;
  output[8] = (D >>> 24) & 255; output[9] = (D >>> 16) & 255; output[10] = (D >>> 8) & 255; output[11] = D & 255;
  output[12] = (k >>> 24) & 255; output[13] = (k >>> 16) & 255; output[14] = (k >>> 8) & 255; output[15] = k & 255;
}

// inc32（原 yue）
function inc32(b: Uint8Array): void {
  for (let i = b.length - 1; i >= b.length - 4; i--) {
    b[i]++;
    if (b[i] !== 0) break;
  }
}

// 标准 GHASH：Y ^= X; Y = Y·H（GF(2^128)，R=0xE1000000_00000000_00000000_00000000）
function ghashMulBlock(Y: Uint8Array, H: Uint8Array): void {
  // Z=0 累加在 Y 内；逐位处理 Y 的 128 位，乘 H 的标准算法：
  // Z0=0, V=H; for i in 0..127: if bit_i(Y): Z^=V; V=xtime(V); 最终 Z = Y·H
  let Z = new Uint8Array(16);
  let V = new Uint8Array(H);
  for (let i = 0; i < 128; i++) {
    const bit = (Y[i >> 3] >> (7 - (i & 7))) & 1;
    if (bit) for (let j = 0; j < 16; j++) Z[j] ^= V[j];
    const lsb = V[15] & 1;
    // V >>= 1
    for (let j = 15; j > 0; j--) V[j] = ((V[j] >>> 1) | (V[j - 1] << 7)) & 255;
    V[0] = V[0] >>> 1;
    if (lsb) V[0] ^= 0xe1;
  }
  Y.set(Z);
}

// GHASH — 内核 Q5 语义（与标准 GCM 的关键差异）：
// 每次 update() 独立冲刷尾部 —— 残余字节立即零填充成块并处理，不跨 update 缓冲拼接。
// 真实请求中 aad("POST|path|ts") 非 16 倍数 → aad 尾单独成块，密文另起块。服务端按此语义校验。
class GHASH {
  private Y = new Uint8Array(16);
  constructor(private H: Uint8Array) {}
  update(data: Uint8Array): void {
    const nBlocks = Math.floor(data.length / 16);
    for (let b = 0; b < nBlocks; b++) {
      for (let j = 0; j < 16; j++) this.Y[j] ^= data[b * 16 + j];
      ghashMulBlock(this.Y, this.H);
    }
    const rem = data.length % 16;
    if (rem > 0) {
      const padded = new Uint8Array(16);
      padded.set(data.subarray(nBlocks * 16));
      for (let j = 0; j < 16; j++) this.Y[j] ^= padded[j];
      ghashMulBlock(this.Y, this.H);
    }
  }
  digest(): Uint8Array {
    return new Uint8Array(this.Y);
  }
}

function writeUint64BE(buf: Uint8Array, offset: number, value: bigint): void {
  for (let i = 0; i < 8; i++) {
    buf[offset + i] = Number((value >> BigInt((7 - i) * 8)) & 0xffn);
  }
}

// GCM 核心（原 gXe；encrypt=1 / decrypt=0）
function gcm(
  data: Uint8Array, key: Uint8Array, iv: Uint8Array, aad: Uint8Array, mode: number, tag?: Uint8Array,
): { output: Uint8Array; tag?: Uint8Array } {
  if (mode === 0 && (!tag || tag.length !== 16)) throw Error("GCM decryption requires a 16-byte authentication tag");
  const rk = new Uint32Array(32);
  keySchedule(key, rk, 1);
  const zeros = new Uint8Array(16);
  const H = new Uint8Array(16);
  encryptBlock(zeros, H, rk); // H = E_K(0^128)
  let J0: Uint8Array;
  if (iv.length === 12) {
    J0 = new Uint8Array(16);
    J0.set(iv, 0);
    J0[15] = 1;
  } else {
    // 标准 GCM：J0 = GHASH_H(IV || pad || [len(IV)]64)（内核同序：update(iv)→update(lenblock)）
    const g = new GHASH(H);
    g.update(iv);
    const lenBlock = new Uint8Array(16);
    writeUint64BE(lenBlock, 8, BigInt(iv.length * 8));
    g.update(lenBlock);
    J0 = g.digest();
  }
  const counter = new Uint8Array(J0);
  inc32(counter);
  const tagMask = new Uint8Array(16);
  encryptBlock(J0, tagMask, rk);

  const out = new Uint8Array(data.length);
  let off = 0, remaining = data.length;
  while (remaining >= 16) {
    const s = new Uint8Array(16);
    encryptBlock(counter, s, rk);
    for (let i = 0; i < 16; i++) out[off + i] = data[off + i] ^ s[i];
    inc32(counter);
    off += 16; remaining -= 16;
  }
  if (remaining > 0) {
    const s = new Uint8Array(16);
    encryptBlock(counter, s, rk);
    for (let i = 0; i < remaining; i++) out[off + i] = data[off + i] ^ s[i];
  }

  if (mode === 0) {
    // 先验 tag：GHASH(AAD||C||len)，与内核 gXe 一致
    const g = new GHASH(H);
    if (aad.length > 0) g.update(aad);
    g.update(data);
    const lenBlock = new Uint8Array(16);
    writeUint64BE(lenBlock, 0, BigInt(aad.length * 8));
    writeUint64BE(lenBlock, 8, BigInt(data.length * 8));
    g.update(lenBlock);
    const S = g.digest();
    for (let i = 0; i < 16; i++) S[i] ^= tagMask[i];
    let diff = 0;
    for (let i = 0; i < 16; i++) diff |= S[i] ^ tag![i];
    if (diff !== 0) throw Error("authentication tag mismatch");
    return { output: out };
  }
  // 加密：GHASH(AAD||C||len)
  const g = new GHASH(H);
  if (aad.length > 0) g.update(aad);
  g.update(out);
  const lenBlock = new Uint8Array(16);
  writeUint64BE(lenBlock, 0, BigInt(aad.length * 8));
  writeUint64BE(lenBlock, 8, BigInt(out.length * 8));
  g.update(lenBlock);
  const S = g.digest();
  const outTag = new Uint8Array(16);
  for (let i = 0; i < 16; i++) outTag[i] = S[i] ^ tagMask[i];
  return { output: out, tag: outTag };
}

export class SM4GCM {
  encrypt(key: Uint8Array, plaintext: Uint8Array, aad: string): { ciphertext: Uint8Array; iv: Uint8Array; authTag: Uint8Array } {
    if (key.length !== 16) throw Error(`SM4 key must be 16 bytes, got ${key.length}`);
    const iv = new Uint8Array(crypto.getRandomValues(new Uint8Array(12)));
    const { output, tag } = gcm(plaintext, key, iv, new TextEncoder().encode(aad), 1);
    return { ciphertext: new Uint8Array(output), iv, authTag: new Uint8Array(tag!) };
  }
  decrypt(key: Uint8Array, iv: Uint8Array, tag: Uint8Array, ciphertext: Uint8Array, aad: string): Uint8Array {
    if (key.length !== 16) throw Error(`SM4 key must be 16 bytes, got ${key.length}`);
    if (iv.length !== 12) throw Error(`GCM IV must be 12 bytes, got ${iv.length}`);
    const { output } = gcm(ciphertext, key, iv, new TextEncoder().encode(aad), 0, tag);
    return new Uint8Array(output);
  }
}

// 开发自检入口：bun run src/sm4.ts
if (import.meta.main) {
  const sm4 = new SM4GCM();
  // SM4 标准 ECB 测试向量：key=pt=0123456789abcdeffedcba9876543210 → 681EDF34D206965E86B3E94F536E4246
  const key = Uint8Array.from([0x01,0x23,0x45,0x67,0x89,0xab,0xcd,0xef,0xfe,0xdc,0xba,0x98,0x76,0x54,0x32,0x10]);
  const rk = new Uint32Array(32);
  keySchedule(key, rk, 1);
  const out = new Uint8Array(16);
  encryptBlock(key, out, rk);
  const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
  console.log("ECB vector:", hex(out), out[0] === 0x68 && out[15] === 0x46 ? "PASS" : "FAIL");
  // GCM roundtrip + tamper
  const k = crypto.getRandomValues(new Uint8Array(16));
  const pt = new TextEncoder().encode("hello 中文 测试 {\"a\":1}");
  const e = sm4.encrypt(k, pt, "POST|/api/v2/chat/completions|1795159217259");
  const d = sm4.decrypt(k, e.iv, e.authTag, e.ciphertext, "POST|/api/v2/chat/completions|1795159217259");
  console.log("roundtrip:", Buffer.from(d).toString() === Buffer.from(pt).toString() ? "PASS" : "FAIL");
  try {
    const bad = e.authTag.slice(); bad[0] ^= 1;
    sm4.decrypt(k, e.iv, bad, e.ciphertext, "POST|/api/v2/chat/completions|1795159217259");
    console.log("tamper:", "FAIL");
  } catch { console.log("tamper:", "PASS"); }
  try {
    sm4.decrypt(k, e.iv, e.authTag, e.ciphertext, "wrong|aad|1");
    console.log("aad-sensitivity:", "FAIL");
  } catch { console.log("aad-sensitivity:", "PASS"); }
}
