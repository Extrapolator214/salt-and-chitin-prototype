// mulberry32, seeded. Every random draw in sim/ goes through here.
// An Rng is a plain object {s} so it can live in state and be copied.

export const createRng = (seed) => ({ s: (seed >>> 0) || 1 });

export function next(rng) {
  rng.s = (rng.s + 0x6d2b79f5) >>> 0;
  let t = rng.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const nextInt = (rng, n) => Math.floor(next(rng) * n);
export const range = (rng, lo, hi) => lo + next(rng) * (hi - lo);
export const intRange = (rng, lo, hi) => lo + nextInt(rng, hi - lo + 1); // inclusive
export const pick = (rng, arr) => arr[nextInt(rng, arr.length)];
export const chance = (rng, p) => next(rng) < p;

export function shuffle(rng, arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = nextInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Deterministic integer hash, for lattice noise. Not a stream.
export function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise2(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(x - x0), fy = smooth(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

// Layered value noise, `octaves` octaves, output in [0,1).
export function fbm(x, y, seed, octaves = 3, scale = 1 / 9) {
  let amp = 1, freq = scale, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(x * freq, y * freq, seed + o * 7919) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
