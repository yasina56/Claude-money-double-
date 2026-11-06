export const TAU = Math.PI * 2;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Signed shortest difference b - a. */
export const angleDiff = (a: number, b: number) => wrapAngle(b - a);

/** Exponential soft cap: grows ~linearly for small x, approaches `cap` asymptotically. */
export const softCap = (x: number, cap: number) => (x <= 0 ? x : cap * (1 - Math.exp(-x / cap)));

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

/** Deterministic PRNG (mulberry32) so tests and procedural visuals are reproducible. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Lerp between angles along the shortest arc. */
export const lerpAngle = (a: number, b: number, t: number) => a + angleDiff(a, b) * t;
