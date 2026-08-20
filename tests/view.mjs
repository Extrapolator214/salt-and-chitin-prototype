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
import { putCrewOnFrontier, driveRoadGang, workFeatures } from './route.mjs';

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
const reel = await import('../src/view/reel.js');
const labour = await import('../src/sim/labour.js');

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

// ---- the resolve reel ------------------------------------------------------
//
// The reel is a replay of an event list, so it can be checked without a canvas
// and without a clock: build one off a real resolve and look at what it decided
// to show. What is being pinned here is that it reads the same turn the sim ran
// — the beats are in the turn's own order, and every splash is renderable HTML.
{
  const s = St.createState(20260816);
  for (let i = 0; i < 6; i++) { putCrewOnFrontier(s); play(s); }

  // A turn that moves somebody: the snapshot has to be taken before the resolve.
  putCrewOnFrontier(s);
  const before = reel.snapshotCrew(s);
  const events = resolveTurn(s);
  const r = reel.build(s, events, before);

  t('a resolve with two live spawners always has a reel', !!r,
    r ? r.beats.map((b) => b.kind).join(' -> ') : 'built nothing');

  if (r) {
    const kinds = r.beats.map((b) => b.kind);
    const order = ['walk', 'poi', 'breed', 'release'];
    const ranks = kinds.map((k) => order.indexOf(k));
    t('the beats run in the order the turn ran its steps',
      ranks.every((v, i) => i === 0 || ranks[i - 1] <= v), kinds.join(' -> '));

    t('breeding reads both fronts off the state',
      r.beats.some((b) => b.kind === 'breed' && b.spawners.length === s.spawners.filter((x) => x.alive).length),
      `${s.spawners.filter((x) => x.alive).length} alive`);

    // Every beat's pane, and the walk's positions, without throwing.
    let err = null, panes = 0, frames = 0;
    try {
      while (!r.done) {
        const html = reel.paneHtml(r);
        if (html) panes++;
        reel.controlsHtml(r);
        // sample the beat rather than run it out in real time
        for (let k = 0; k < 5; k++) {
          if (reel.walkPositions(r)) frames++;
          reel.tick(r, reel.beat(r).seconds / 4);
          if (r.done) break;
        }
      }
    } catch (e) { err = e.message; }
    t('every beat renders and every walk frame places its bodies', !err,
      err || `${panes} panes, ${frames} walk frames`);

    // A walker's dots must stay on its own route: fractional coordinates that
    // wander off the path are the one failure the eye would not catch as a bug.
    const w = r.beats.find((b) => b.kind === 'walk');
    if (w) {
      const r2 = reel.build(s, events, before);
      const ends = w.movers.every((m) => {
        const first = m.path[0], last = m.path[m.path.length - 1];
        r2.t = 0;
        const start = reel.walkPositions(r2).get(m.id);
        r2.t = r2.beats[0].seconds;
        const end = reel.walkPositions(r2).get(m.id);
        return start.q === first.q && start.r === first.r && end.q === last.q && end.r === last.r;
      });
      t('a walk starts where the body stood and ends where it stands now', ends,
        `${w.movers.length} walking, longest ${Math.max(...w.movers.map((m) => m.path.length - 1))} steps`);
    }
  }
}

// All four beats over a run, rather than whichever two the sample turn happened
// to raise. The release only fires every ACCUMULATE_TURNS and a site is only
// worked once the ground over it is open, so a single turn cannot reach them.
{
  const s = St.createState(20260816);
  const seen = new Map();
  let err = null;
  // A site is only worked once a road has reached it, so the gang is aimed at the
  // nearest one rather than left to spread. The order of these three matters:
  // the frontier helper spends every idle hand, so the site has to be asked for
  // before it runs, not after.
  const nearestSite = () => [...s.map.tiles.values()]
    .filter((tile) => tile.feature && !tile.featureWorked && C.featureAction(tile.feature))
    .sort((a, b) => H.distance(a, s.base) - H.distance(b, s.base))[0] || null;
  try {
    for (let i = 0; i < 150 && !s.outcome; i++) {
      const site = seen.has('poi') ? null : nearestSite();
      if (site) driveRoadGang(s, site, 6);
      workFeatures(s, 2);
      putCrewOnFrontier(s);
      const before = reel.snapshotCrew(s);
      const events = resolveTurn(s);
      const r = reel.build(s, events, before);
      if (r) {
        for (const b of r.beats) seen.set(b.kind, (seen.get(b.kind) || 0) + 1);
        while (!r.done) { reel.paneHtml(r); reel.tick(r, reel.beat(r).seconds); }
      }
      if (s.combat) { skip(s); finishCombat(s); }
      s.base.hull = C.HULL_MAX;
      concludeTurn(s, events);
    }
  } catch (e) { err = e.message; }
  const kinds = [...seen.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
  t('a run raises every kind of beat', !err && ['walk', 'poi', 'breed', 'release'].every((k) => seen.has(k)),
    err || kinds);
}

// The three points of interest each have their own picture, and a kind nobody
// has written art for still renders rather than throwing.
{
  const s = St.createState(20260816);
  let err = null;
  const panes = [];
  try {
    for (const f of ['wreck', 'cache', 'officer', 'nonesuch']) {
      const fake = { beats: [{ kind: 'poi', feature: f, wood: 40, gold: 220, name: 'Bess', trade: 'quartermaster', focus: { q: 0, r: 0 }, seconds: 1 }], i: 0, t: 0, speed: 1, done: false };
      panes.push(reel.paneHtml(fake));
    }
  } catch (e) { err = e.message; }
  t('every point of interest has a splash, including an unknown one',
    !err && panes.length === 4 && panes.every((p) => p && p.includes('<pre')),
    err || `${panes.length} panes drawn`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
