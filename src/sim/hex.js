// Axial coordinates (q, r), pointy-top hexes, third coordinate s = -q - r.

export const NEIGHBOURS = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [-1, +1], [0, +1]];

export const key = (q, r) => `${q},${r}`;
export const parseKey = (k) => {
  const i = k.indexOf(',');
  return { q: +k.slice(0, i), r: +k.slice(i + 1) };
};

export const neighbours = (q, r) => NEIGHBOURS.map(([dq, dr]) => ({ q: q + dq, r: r + dr }));

export function distance(a, b) {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

export const tilesInRadius = (n) => 3 * n * n + 3 * n + 1;

export function ring(centre, radius) {
  if (radius === 0) return [{ q: centre.q, r: centre.r }];
  const out = [];
  // start at the corner in direction 4, then walk each of the 6 sides
  let q = centre.q + NEIGHBOURS[4][0] * radius;
  let r = centre.r + NEIGHBOURS[4][1] * radius;
  for (let d = 0; d < 6; d++) {
    for (let i = 0; i < radius; i++) {
      out.push({ q, r });
      q += NEIGHBOURS[d][0];
      r += NEIGHBOURS[d][1];
    }
  }
  return out;
}

export function spiral(centre, radius) {
  const out = [{ q: centre.q, r: centre.r }];
  for (let n = 1; n <= radius; n++) out.push(...ring(centre, n));
  return out;
}

export function cubeRound(x, y, z) {
  let rx = Math.round(x), ry = Math.round(y), rz = Math.round(z);
  const dx = Math.abs(rx - x), dy = Math.abs(ry - y), dz = Math.abs(rz - z);
  if (dx > dy && dx > dz) rx = -ry - rz;
  else if (dy > dz) ry = -rx - rz;
  else rz = -rx - ry;
  return { q: rx, r: rz };
}

export const axialRound = (q, r) => cubeRound(q, -q - r, r);

// line(a, b) returns distance(a,b)+1 tiles, starting at a, ending at b.
export function line(a, b) {
  const n = distance(a, b);
  if (n === 0) return [{ q: a.q, r: a.r }];
  // cube-lerp with a small nudge so ties break the same way every time
  const ax = a.q + 1e-6, az = a.r + 1e-6, ay = -ax - az;
  const bx = b.q + 2e-6, bz = b.r + 2e-6, by = -bx - bz;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push(cubeRound(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t));
  }
  out[0] = { q: a.q, r: a.r };
  out[out.length - 1] = { q: b.q, r: b.r };
  return out;
}

// Pixel conversion, size S. Pointy-top: x = S*sqrt(3)*(q + r/2), y = S*3/2*r
const SQRT3 = Math.sqrt(3);

export function axialToPixel(q, r, S) {
  return { x: S * SQRT3 * (q + r / 2), y: S * 1.5 * r };
}

export function pixelToAxial(x, y, S) {
  const r = (2 / 3) * (y / S);
  const q = x / (S * SQRT3) - r / 2;
  return axialRound(q, r);
}

// Degrees, screen convention: 0 = east, growing clockwise on screen (y down).
export function bearing(a, b) {
  const pa = axialToPixel(a.q, a.r, 1), pb = axialToPixel(b.q, b.r, 1);
  const deg = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

// The tile exactly `dist` away from `centre` on the given bearing.
export function atBearing(centre, deg, dist) {
  if (dist <= 0) return { q: centre.q, r: centre.r };
  const rad = (deg * Math.PI) / 180;
  const p = axialToPixel(centre.q, centre.r, 1);
  // pixel radius for hex distance d lies in [1.5d, sqrt(3)d]; overshoot, then walk
  const reach = SQRT3 * dist * 1.35;
  const far = pixelToAxial(p.x + Math.cos(rad) * reach, p.y + Math.sin(rad) * reach, 1);
  const l = line(centre, far);
  return l[Math.min(dist, l.length - 1)];
}

// Smallest absolute difference between two bearings, in degrees.
export function angleDiff(a, b) {
  let d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

export function within(centre, radius) {
  return spiral(centre, radius);
}
