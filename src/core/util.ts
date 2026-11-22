/** 简单的可复现随机数发生器(mulberry32),合成图与测试都用它 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uid(prefix = 'id'): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 角度归一化到 [0, π),脊线方向无极性 */
export function normAnglePi(a: number): number {
  let r = a % Math.PI;
  if (r < 0) r += Math.PI;
  return r;
}

/** 无极性方向差,结果 [0, π/2] */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(normAnglePi(a) - normAnglePi(b));
  return Math.min(d, Math.PI - d);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function nowTs(): number {
  return Date.now();
}
