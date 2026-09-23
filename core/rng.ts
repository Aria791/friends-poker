// core/rng.ts
// 可注入种子的 CSPRNG。生产环境不传 seed，由 crypto.getRandomValues 喂入 32 字节；
// 测试环境传入 number 种子以获得可复现序列。算法：xoshiro256**。
//
// 严禁在牌局中使用 Math.random —— 必须可复现、可审计。

const MASK = (1n << 64n) - 1n;

function rotl64(x: bigint, k: number): bigint {
  return ((x << BigInt(k)) | (x >> BigInt(64 - k))) & MASK;
}

function xoshiro256ss(state: bigint[]): () => number {
  let s = state.slice();
  return () => {
    const result = (rotl64((s[1] * 5n) & MASK, 7) * 9n) & MASK;
    const t = (s[1] << 17n) & MASK;
    s[2] ^= s[0];
    s[3] ^= s[1];
    s[1] ^= s[2];
    s[0] ^= s[3];
    s[2] ^= t;
    s[3] = rotl64(s[3], 45);
    return Number(result >> 11n) / 9007199254740992; // 53-bit 浮点，分布良好
  };
}

function bytesToU64(b: Uint8Array): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < 4; i++) {
    let v = 0n;
    for (let j = 0; j < 8; j++) v = (v << 8n) | BigInt(b[i * 8 + j]);
    out.push(v);
  }
  return out;
}

function splitmix64Seed(seed: number): bigint[] {
  let z = BigInt(seed >>> 0);
  const sm = (): bigint => {
    z = (z + 0x9e3779b97f4a7c15n) & MASK;
    let x = z;
    x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & MASK;
    x = x ^ (x >> 31n);
    return x;
  };
  return [sm(), sm(), sm(), sm()];
}

export type Rng = () => number; // 返回 [0,1) 浮点

export function createRng(seed?: number | Uint8Array): Rng {
  let state: bigint[];
  if (seed === undefined) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    state = bytesToU64(bytes);
  } else if (typeof seed === 'number') {
    state = splitmix64Seed(seed);
  } else {
    const padded = seed.length >= 32 ? seed : padBytes(seed, 32);
    state = bytesToU64(padded);
  }
  return xoshiro256ss(state);
}

function padBytes(b: Uint8Array, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = b[i % b.length];
  return out;
}
