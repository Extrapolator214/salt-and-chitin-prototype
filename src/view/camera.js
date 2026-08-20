// Pan, zoom, screen <-> hex.

import { axialToPixel, pixelToAxial } from '../sim/hex.js';

export const ZOOMS = [3, 5, 8, 12, 16, 24];

export function createCamera() {
  return { x: 0, y: 0, zoom: 3 }; // x,y = the world point under the canvas centre
}

export const hexSize = (cam) => ZOOMS[cam.zoom];

export function worldToScreen(cam, canvas, wx, wy) {
  return { x: wx - cam.x + canvas.width / 2, y: wy - cam.y + canvas.height / 2 };
}
export function screenToWorld(cam, canvas, sx, sy) {
  return { x: sx + cam.x - canvas.width / 2, y: sy + cam.y - canvas.height / 2 };
}

export function screenToAxial(cam, canvas, sx, sy) {
  const w = screenToWorld(cam, canvas, sx, sy);
  return pixelToAxial(w.x, w.y, hexSize(cam));
}

export function axialToScreen(cam, canvas, q, r) {
  const p = axialToPixel(q, r, hexSize(cam));
  return worldToScreen(cam, canvas, p.x, p.y);
}

export function centreOn(cam, canvas, q, r) {
  const p = axialToPixel(q, r, hexSize(cam));
  cam.x = p.x;
  cam.y = p.y;
}

/** Zoom a step, keeping the hex under (sx,sy) put. */
export function zoomBy(cam, canvas, delta, sx, sy) {
  const before = screenToWorld(cam, canvas, sx, sy);
  const next = Math.max(0, Math.min(ZOOMS.length - 1, cam.zoom + delta));
  if (next === cam.zoom) return;
  const ratio = ZOOMS[next] / ZOOMS[cam.zoom];
  cam.zoom = next;
  cam.x = before.x * ratio - (sx - canvas.width / 2);
  cam.y = before.y * ratio - (sy - canvas.height / 2);
}

export function pan(cam, dx, dy) {
  cam.x -= dx;
  cam.y -= dy;
}

/**
 * Exact axial bounds of the visible rect: an r span, and a q span per row.
 * Never iterate the whole map.
 */
export function visibleRows(cam, canvas, radius) {
  const S = hexSize(cam);
  const tl = screenToWorld(cam, canvas, 0, 0);
  const br = screenToWorld(cam, canvas, canvas.width, canvas.height);
  const rMin = Math.max(-radius, Math.floor(tl.y / (1.5 * S)) - 1);
  const rMax = Math.min(radius, Math.ceil(br.y / (1.5 * S)) + 1);
  const rows = [];
  const SQRT3 = Math.sqrt(3);
  for (let r = rMin; r <= rMax; r++) {
    const qLo = Math.max(-radius - Math.min(0, r), Math.floor(tl.x / (SQRT3 * S) - r / 2) - 1);
    const qHi = Math.min(radius - Math.max(0, r), Math.ceil(br.x / (SQRT3 * S) - r / 2) + 1);
    if (qHi >= qLo) rows.push({ r, qLo, qHi });
  }
  return rows;
}
