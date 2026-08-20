// The view, driven headlessly.  node tests/view.mjs
//
// src/view has no other coverage, and it is the half of the build that breaks
// silently: it imports nine symbols out of four sim modules, so a rename that
// nothing in sim/ uses still takes the game down at module-load time while the
// acceptance suite stays green. This is not a rendering test — nothing here
// looks at pixels. It loads the view against a stub canvas and draws real
// states through every branch that decides what gets drawn, and asserts only
// that the drawing happens and does not throw.

import C from '../src/sim/config.js';
import * as H from '../src/sim/hex.js';
import * as St from '../src/sim/state.js';
import * as O from '../src/sim/orders.js';
import * as B from '../src/sim/build.js';
import { resolveTurn, concludeTurn } from '../src/sim/turn.js';
import { skip, finishCombat } from '../src/sim/combat.js';
import { putCrewOnFrontier } from './route.mjs';

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

/** A 2d context that records what it was asked to do and draws nothing. */
function stubCanvas(w = 1200, h = 700) {
  let calls = 0;
  const ctx = new Proxy({}, {
    get(target, prop) {
      if (prop === 'canvas') return canvas;
      if (prop === 'measureText') return () => ({ width: 40 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      if (prop in target) return target[prop];
      return (...args) => { calls++; return undefined; };
    },
    set(target, prop, value) { target[prop] = value; return true; },
  });
  const canvas = { width: w, height: h, getContext: () => ctx, style: {} };
  return { canvas, calls: () => calls };
}

const play = (s) => {
  const e = resolveTurn(s);
  if (s.combat) { skip(s); finishCombat(s); }
  s.base.hull = C.HULL_MAX;
  concludeTurn(s, e);
};

// the baked-ground layer makes its own offscreen canvas
globalThis.document = globalThis.document || {
  createElement: (tag) => (tag === 'canvas' ? stubCanvas(64, 64).canvas : { style: {} }),
};

const { render } = await import('../src/view/render.js');
const { renderHud } = await import('../src/view/hud.js');
const { renderHover } = await import('../src/view/hover.js');
const camera = await import('../src/view/camera.js');

console.log('\nview · it loads and it draws');

// a fresh landing, and a state with towers, yards, cohorts and a live resolve
const fresh = St.createState(20260816);
const late = St.createState(20260816);
for (let i = 0; i < 40; i++) { putCrewOnFrontier(late); play(late); }
late.res.wood = 1e6; late.res.stone = 1e6; late.res.gold = 1e6;
{
  const spot = [...late.map.tiles.values()].find((x) => St.isBuildable(late, x, true) && !x.occupant);
  if (spot) { B.addItem(late, 0, 1); B.buildTower(late, spot.q, spot.r, 0); }
  const yard = [...late.map.tiles.values()].find((x) => B.canBuildBuilding(late, 'forge', x.q, x.r).ok);
  if (yard) B.buildBuilding(late, 'forge', yard.q, yard.r);
}

const frames = [];
for (const [label, s] of [['a fresh landing', fresh], ['forty turns in', late]]) {
  for (const zoom of [0, camera.ZOOMS.length - 1]) {           // the baked layer, and the live one
    for (const [what, ui] of [
      ['idle', { hover: null }],
      ['hovering', { hover: { q: s.base.q, r: s.base.r } }],
      ['placing a building', { hover: { q: s.base.q - 3, r: s.base.r - 3 }, placing: 'forge' }],
    ]) {
      frames.push({ label: `${label} · zoom ${zoom} · ${what}`, s, zoom, ui });
    }
  }
}

let drawn = 0, threw = null;
for (const f of frames) {
  const { canvas, calls } = stubCanvas();
  const cam = camera.createCamera();
  cam.zoom = f.zoom;
  camera.centreOn(cam, canvas, f.s.base.q, f.s.base.r);
  try {
    render(f.s, cam, canvas, f.ui);
    const before = calls();
    if (before < 50) threw = threw || `${f.label}: only ${before} draw calls`;
    drawn += before;
  } catch (e) {
    threw = threw || `${f.label}: ${e.message}`;
  }
}
t(`the map draws in every mode without throwing`, !threw,
  threw || `${frames.length} frames, ${drawn} context calls`);

// the panels, which read the same sim and are just as easy to break
{
  const el = { textContent: '', innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  let err = null;
  try {
    renderHud(late, el);
    renderHover(late, el, { q: late.base.q, r: late.base.r });
    renderHover(late, el, null);
    renderHover(late, el, { q: 9999, r: 9999 });
  } catch (e) { err = e.message; }
  t('the hud and the tile panel render', !err, err || `${el.textContent.length} chars of panel`);
}

// Two rules the canvas draws that the sim can be asked about directly, so they
// are pinned without a pixel: a worked point of interest must invalidate the
// baked ground layer, and the placement ghost's "whole shape red" case must
// actually occur.
{
  const s = St.createState(20260816);
  const chest = [...s.map.tiles.values()].find((x) => x.feature === 'cache' && !x.featureWorked);
  const before = s.map.version;
  const L = await import('../src/sim/labour.js');
  L.workFeature(s, chest, []);
  t('working a point of interest invalidates the baked map',
    s.map.version > before && chest.featureWorked,
    `map version ${before} -> ${s.map.version}`);
}
{
  const s = St.createState(20260816);
  s.res.wood = 1e6; s.res.stone = 1e6;
  for (const h of H.spiral(s.base, C.LANDING_CLIFF_RADIUS - 1)) {
    const tt = St.tileAt(s, h.q, h.r);
    if (tt && !tt.occupant && C.TERRAIN[tt.terrain].clearable) { tt.terrain = 'road'; tt.cleared = true; }
  }
  St.touchMap(s);
  const spot = [...s.map.tiles.values()].find((x) => B.canBuildBuilding(s, 'forge', x.q, x.r).ok);
  B.buildBuilding(s, 'forge', spot.q, spot.r);
  // somewhere every tile of the shape is fine and the placement is still refused
  let blanket = null;
  for (const tile of s.map.tiles.values()) {
    const plan = B.footprintPreview(s, tile.q, tile.r, C.buildingDef('forge').tiles, false, 'forge');
    const check = B.canBuildBuilding(s, 'forge', tile.q, tile.r);
    if (!check.ok && plan.length && plan.every((x) => x.ok)) { blanket = { at: `${tile.q},${tile.r}`, why: check.why }; break; }
  }
  t('the ghost\'s whole-shape-red case is reachable', !!blanket,
    blanket ? `${blanket.at}: ${blanket.why}` : 'never occurs — the rule in drawPlacement would be dead code');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
