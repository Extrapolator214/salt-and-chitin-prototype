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
import { skip, finishCombat, beginCombat, tick } from '../src/sim/combat.js';
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

const { render, jobLines } = await import('../src/view/render.js');
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

// A resolve held part-way through, which nothing else here reaches: the rounds
// in the air and the health bar over every unit are drawn off combat state, and
// `play` above skips straight past all of it.
const fighting = St.createState(20260816);
{
  // a lane cut from the ship out towards the near spawner, so the swarm walks
  // ground the guns can both see and shoot at
  const sp = fighting.spawners[0];
  const lane = H.line(fighting.base, sp).slice(0, 9);
  for (const p of lane) {
    const tt = St.tileAt(fighting, p.q, p.r);
    if (tt && !tt.occupant) { tt.terrain = 'road'; tt.cleared = true; }
  }
  // a gun beside it, so a tower's rounds are in the air as well as the ship's.
  // The fitting goes into the hold first: without one the site is refused for
  // the hold rather than for the ground.
  B.addItem(fighting, 0, 1);
  for (const h of H.spiral(lane[4], 2)) {
    const tt = St.tileAt(fighting, h.q, h.r);
    if (!tt || tt.occupant) continue;
    tt.terrain = 'road'; tt.cleared = true;
    St.touchMap(fighting);
    if (!B.canBuildTower(fighting, h.q, h.r, 0).ok) continue;
    B.buildTower(fighting, h.q, h.r, 0).complete = true;
    St.landHands(fighting, 1);
    fighting.crew.assignments.push({
      id: 'man-test', who: fighting.crew.members[0].id, kind: 'man',
      target: fighting.towers[0].id, arrivesOnTurn: 0,
    });
    break;
  }
  St.touchMap(fighting);
  const cohort = {
    spawnerId: sp.id,
    units: [
      { type: 'grub' }, { type: 'grub' }, { type: 'shell' },
      { type: 'shell', elite: true }, { type: 'grub', role: 'shield' }, { type: 'grub', role: 'healer' },
    ],
  };
  beginCombat(fighting, [{ cohort, entry: lane[lane.length - 1] }], []);
  for (let i = 0; i < 120; i++) tick(fighting, 1 / 30);
}
t('the fixture stands a manned gun beside the lane',
  fighting.towers.length === 1 && St.towerPower(fighting, fighting.towers[0]) > 0,
  `${fighting.towers.length} tower(s), ${fighting.towers.length ? St.towerPower(fighting, fighting.towers[0]) : 0} dps`);
t('a resolve puts rounds in the air',
  fighting.combat.projectiles.length + fighting.combat.impacts.length > 0,
  `${fighting.combat.projectiles.length} in flight, ${fighting.combat.impacts.length} landing, `
  + `${fighting.combat.killed} killed`);

/** Everything on the island, nudged half a hex off its own tile. */
const midStride = (s) => ({
  crew: new Map(s.crew.members.map((m) => [m.id, { q: m.q + 0.5, r: m.r - 0.5 }])),
  cohorts: new Map(s.cohorts.map((c) => [c.id, { q: c.q + 0.5, r: c.r - 0.5 }])),
});

const frames = [];
for (const [label, s] of [['a fresh landing', fresh], ['forty turns in', late], ['mid-resolve', fighting]]) {
  for (const zoom of [0, camera.ZOOMS.length - 1]) {           // the baked layer, and the live one
    for (const [what, ui] of [
      ['idle', { hover: null }],
      ['hovering', { hover: { q: s.base.q, r: s.base.r } }],
      ['placing a building', { hover: { q: s.base.q - 3, r: s.base.r - 3 }, placing: { kind: 'building', type: 'forge' } }],
      // the one building whose effect travels, so its coverage blob is drawn
      ['placing a Bunkhouse', { hover: { q: s.base.q - 3, r: s.base.r - 3 }, placing: { kind: 'building', type: 'bunkhouse' } }],
      // one tile and three, so both a single hex and a grown silhouette are laid
      ['placing a one-tile gun', { hover: { q: s.base.q - 3, r: s.base.r - 3 }, placing: { kind: 'tower', towerIndex: 0 } }],
      ['placing a three-tile gun', { hover: { q: s.base.q - 3, r: s.base.r - 3 }, placing: { kind: 'tower', towerIndex: 4 } }],
      // Mid-reel: every body and every blob is between hexes, so the two passes
      // that take fractional coordinates are drawn as well as the integer ones.
      ['mid-march', { hover: null, reel: {}, walk: midStride(s) }],
      ['a located tile, with the pointer elsewhere',
        { hover: { q: s.base.q + 2, r: s.base.r }, located: { q: s.base.q - 4, r: s.base.r + 1 } }],
      ['a site held on screen until its pane has played',
        { hover: null, reel: {}, revealing: [{ q: s.base.q - 2, r: s.base.r, feature: 'cache' },
          { q: s.base.q + 1, r: s.base.r - 2, feature: 'nonesuch' }] }],
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
  const before = reel.snapshotMovers(s);
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
        reel.panelHtml(r, 1);
        // sample the beat rather than run it out in real time
        for (let k = 0; k < 5; k++) {
          const at = reel.walkPositions(r);
          if (at) frames += at.crew.size + at.cohorts.size;
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
      const onOwnRoute = (list, side) => list.every((m) => {
        const first = m.path[0], last = m.path[m.path.length - 1];
        r2.t = 0;
        const start = reel.walkPositions(r2)[side].get(m.id);
        r2.t = r2.beats[0].seconds;
        const end = reel.walkPositions(r2)[side].get(m.id);
        return start.q === first.q && start.r === first.r && end.q === last.q && end.r === last.r;
      });
      t('a walk starts where the mover stood and ends where it stands now',
        onOwnRoute(w.movers, 'crew') && onOwnRoute(w.marchers, 'cohorts'),
        `${w.movers.length} walking, ${w.marchers.length} marching`);
    }
  }
}

// The camera ease "locate" rides on. It is the reel's own glide, so it is pinned
// here rather than trusted: a locate that stops short leaves the player looking
// at the wrong ground with a mark they cannot see.
{
  const cam = camera.createCamera();
  cam.x = 4000; cam.y = -2500;
  const target = H.axialToPixel(-16, 34, camera.hexSize(cam));
  const trail = [];
  for (let i = 0; i < 240; i++) {                       // four seconds at 60fps
    reel.glide(cam, target, 1 / 60);
    if (i % 60 === 59) trail.push(Math.round(Math.hypot(cam.x - target.x, cam.y - target.y)));
  }
  const start = Math.hypot(4000 - target.x, -2500 - target.y);
  t('the camera eases onto a located tile and settles on it',
    trail[trail.length - 1] < 1 && trail[0] < start / 2 && trail.every((d, i) => i === 0 || d <= trail[i - 1]),
    `${Math.round(start)}px away -> ${trail.join(' -> ')}`);

  // and it is a no-op with nothing to go to, which is what the frame loop
  // leans on every frame the player has not asked to be taken anywhere
  const still = camera.createCamera();
  still.x = 12; still.y = 34;
  reel.glide(still, null, 1 / 60);
  t('a camera with nowhere to go does not drift', still.x === 12 && still.y === 34, 'held still');
}

// The line from a body to the tile it is bound for. Pinned without a pixel,
// because the hard half is not the drawing — it is knowing which body walks an
// order that is still in the queue and so has no assignment behind it yet.
{
  const s = St.createState(20260816);
  const spot = O.workableTiles(s).slice().sort((a, b) => H.distance(b, s.base) - H.distance(a, s.base))[0];
  const before = jobLines(s).size;
  const res = O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: spot.q, r: spot.r } });
  const order = s.orders[s.orders.length - 1];
  const who = O.projectedCrew(s, O.crewGroundAtResolve(s)).byOrder.get(order.id);
  const lines = jobLines(s);
  const drawn = who && lines.get(who);

  t('a queued order draws a line from the body that will actually walk it',
    res.ok && !!who && !!drawn && drawn.q === spot.q && drawn.r === spot.r && lines.size === before + 1,
    `${who} -> (${spot.q},${spot.r}), ${before} lines before, ${lines.size} after`);

  // The queue panel names a body beside the row; the line must be to the same
  // one, or the map and the panel disagree about who is going where.
  t('the line and the queue row name the same body',
    who === O.projectedCrew(s, O.crewGroundAtResolve(s)).byOrder.get(order.id), String(who));

  // The case the arrival turn gets wrong. `arrivesOnTurn` reads as "this turn"
  // for the whole of the turn the walk ends on, so a body six tiles short of its
  // job is described as arriving — and a line drawn off that number is not drawn
  // at all. What settles it is where the body is standing.
  {
    const s3 = St.createState(20260816);
    const site = [...s3.map.tiles.values()]
      .find((x) => x.feature === 'wreck' && !x.featureWorked && !St.isClearable(s3, x));
    for (const p2 of H.line(s3.base, site)) {          // open a road out to it
      const tile = St.tileAt(s3, p2.q, p2.r);
      if (!tile || tile.occupant || tile === site) continue;
      if (tile.terrain === 'saltwater') tile.terrain = 'sand';
      if (!tile.cleared) { tile.cleared = true; tile.terrain = 'road'; }
    }
    St.touchMap(s3);
    O.enqueue(s3, { type: 'workFeature', who: 'hand', target: { q: site.q, r: site.r } });
    const ev = resolveTurn(s3);                         // the order becomes an assignment
    concludeTurn(s3, ev);

    const a = s3.crew.assignments.find((x) => x.kind === 'feature');
    const body = St.memberById(s3, a.who);
    const short = H.distance(body, site);
    const line = jobLines(s3).get(a.who);
    t('a body short of its job is joined to it even when it "arrives this turn"',
      short > 0 && a.arrivesOnTurn <= s3.turn && !!line && line.q === site.q && line.r === site.r,
      `${a.who} is ${short} tiles short, arrivesOnTurn ${a.arrivesOnTurn} against turn ${s3.turn}`);
  }

  // A body already standing on its own target has nowhere to be drawn to.
  const s2 = St.createState(20260816);
  const m2 = s2.crew.members[0];
  const face = O.workableTiles(s2).sort((a, b) => H.distance(a, m2) - H.distance(b, m2))[0];
  m2.q = face.q; m2.r = face.r;                       // stand him on the job
  O.enqueue(s2, { type: 'assignClear', who: m2.id, target: { q: face.q, r: face.r } });
  t('a body standing on its own target is joined to nothing',
    !jobLines(s2).has(m2.id),
    `${m2.id} stands on (${face.q},${face.r}) and is ordered to cut it`);
}

// The map must not run ahead of the walk. The resolve cuts at step 2, right
// after the walking at step 1b, so a one-turn scrub tile is road and a forest
// tile is a third worked before anyone has watched a body reach either.
{
  const s = St.createState(20260816);
  putCrewOnFrontier(s);                                 // queue a frontier of clears
  const before = reel.snapshotMovers(s);
  const wasScrub = [...s.map.tiles.values()]
    .filter((t) => t.terrain === 'scrub' && before.ground.has(H.key(t.q, t.r))).map((t) => H.key(t.q, t.r));
  const wasForest = [...s.map.tiles.values()]
    .filter((t) => t.terrain === 'forest' && before.ground.has(H.key(t.q, t.r))).map((t) => H.key(t.q, t.r));
  const events = resolveTurn(s);
  const r = reel.build(s, events, before);
  const held = reel.groundBefore(r);

  // a scrub tile cut this turn: road on the state, still scrub while they walk
  const cut = wasScrub.find((k) => {
    const t = St.tileAt(s, ...k.split(',').map(Number));
    return t && t.cleared;
  });
  t('a tile cut this turn is still its old ground while the walk plays',
    !!cut && !!held && held.get(cut).terrain === 'scrub' && held.get(cut).cleared === false
    && St.tileAt(s, ...cut.split(',').map(Number)).terrain === 'road',
    cut ? `${cut}: state says road, the reel says scrub` : 'no scrub was cut this turn');

  // a forest tile part-worked this turn: the wedge is held at what it was
  const part = wasForest.find((k) => {
    const t = St.tileAt(s, ...k.split(',').map(Number));
    return t && !t.cleared && (t.work || 0) > 0;
  });
  t('a part-worked tile holds the wedge it had before the walk',
    !!part && !!held && held.get(part).work === 0 && St.tileAt(s, ...part.split(',').map(Number)).work > 0,
    part ? `${part}: state says ${St.tileAt(s, ...part.split(',').map(Number)).work}/3, the reel says 0/3` : 'no forest was part-worked');

  // and once the walking is done the map is allowed to say what happened
  reel.next(r);
  t('the ground catches up the moment the walk is over',
    reel.groundBefore(r) === null, `now on ${(reel.beat(r) || {}).kind}`);
}

// A site the resolve has worked is off the map before the reel starts — the sim
// set featureWorked and touchMap re-baked the ground without it. The reel holds
// the marker until its own pane has been and gone, or the player watches a body
// walk to a bare tile and is told afterwards what was on it.
{
  const beats = [
    { kind: 'walk', movers: [], marchers: [], focus: null, seconds: 1 },
    { kind: 'poi', feature: 'cache', focus: { q: 3, r: 4 }, seconds: 1 },
    { kind: 'poi', feature: 'wreck', focus: { q: 9, r: -2 }, seconds: 1 },
    { kind: 'breed', spawners: [], focus: null, seconds: 1 },
  ];
  const r = { beats, i: 0, t: 0, speed: 1, done: false };
  const at = () => (reel.pending(r) || []).map((f) => `${f.feature}@${f.q},${f.r}`).join(' ');

  const onWalk = at();
  reel.next(r);                                   // onto the chest's own pane
  const onChest = at();
  reel.next(r);                                   // past it, onto the wreck's
  const onWreck = at();
  reel.next(r);                                   // past both
  const onBreed = at();

  t('a worked site stays on the map until its own pane has played',
    onWalk === 'cache@3,4 wreck@9,-2' && onChest === 'cache@3,4 wreck@9,-2'
    && onWreck === 'wreck@9,-2' && onBreed === '',
    `walk[${onWalk}] chest[${onChest}] wreck[${onWreck}] breed[${onBreed}]`);

  reel.skip(r);
  t('and nothing is held once the reel is over', reel.pending(r) === null && reel.pending(null) === null,
    'cleared');
}

// A cohort released this turn was never in the snapshot — it was born at its
// spawner and advanced in the same resolve — so its march has to start at the
// mound rather than at wherever it ended up.
{
  const s = St.createState(20260816);
  let checked = 0, wrong = 0;
  for (let i = 0; i < 12 && !s.outcome; i++) {
    const known = new Set(s.cohorts.map((c) => c.id));
    const before = reel.snapshotMovers(s);
    const events = resolveTurn(s);
    const r = reel.build(s, events, before);
    const walk = r && r.beats.find((b) => b.kind === 'walk');
    for (const m of (walk ? walk.marchers : [])) {
      if (known.has(m.id)) continue;                       // it was already marching
      const c = s.cohorts.find((x) => x.id === m.id);
      const sp = s.spawners.find((x) => x.id === c.spawnerId);
      checked++;
      if (m.path[0].q !== sp.q || m.path[0].r !== sp.r) wrong++;
    }
    if (s.combat) { skip(s); finishCombat(s); }
    s.base.hull = C.HULL_MAX;
    concludeTurn(s, events);
  }
  t('a cohort released this turn marches out of its own spawner', checked > 0 && wrong === 0,
    `${checked} newly released, ${wrong} starting somewhere else`);
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
      const before = reel.snapshotMovers(s);
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
  // The split the panel and the splash are meant to have: the panel is settings
  // plus the one control that acts on a whole resolve, and stepping a single
  // beat lives on the pane it steps past. Pinned because it is the kind of thing
  // that drifts back the moment either one is edited.
  {
    const idle = reel.panelHtml(null, 3);
    t('idle, the panel is the three settings and nothing that cannot be pressed',
      idle.includes('Resolve turn animation') && idle.includes('data-r="3" class="on"')
      && !idle.includes('data-r="next"') && !idle.includes('disabled')
      && !idle.includes('reel-bar'),
      'idle panel');

    // Skip is a setting beside the speeds, not a control that only exists while
    // there is something to abandon: it is pressable and shows as chosen with no
    // reel anywhere, and it says what it does to the turns that follow.
    const off = reel.panelHtml(null, 'skip');
    t('skip is one of the settings, pressed and standing',
      off.includes('data-r="skip" class="on"') && !off.includes('disabled')
      && off.includes('off — turns resolve without it'),
      'skip panel');

    const live = { beats: [{ kind: 'breed', spawners: [], focus: null, seconds: 1 }], i: 0, t: 0, speed: 1, done: false };
    const panel = reel.panelHtml(live, 1);
    t('playing, skip is live and next is nowhere on the panel',
      !panel.includes('disabled') && !panel.includes('data-r="next"') && panel.includes('reel-bar'),
      'playing panel');

    const poi = reel.paneHtml({ beats: [{ kind: 'poi', feature: 'cache', gold: 220, focus: { q: 0, r: 0 }, seconds: 1 }], i: 0, t: 0, speed: 1, done: false });
    t('the splash carries next, and only next',
      poi.includes('data-r="next"') && !poi.includes('data-r="skip"') && !poi.includes('data-r="1"'),
      'splash pane');
    t('the splash carries its own countdown, so a reader need not look away',
      poi.includes('pane-bar') && panel.includes('reel-bar'), 'both bars');

    // A pane under the pointer does not time out. Held has to mean "stopped",
    // never "finished" — a hold that reported done would close the very pane
    // somebody had leaned in to read.
    const held = { beats: [{ kind: 'breed', spawners: [], focus: null, seconds: 2 }], i: 0, t: 0, speed: 1, done: false };
    const doneWhileHeld = reel.tick(held, 60, true);
    const tHeld = held.t;
    reel.tick(held, 1, false);
    t('a pane under the pointer holds its clock, and holding is not finishing',
      !doneWhileHeld && tHeld === 0 && !held.done && held.t === 1,
      `t after a 60s hold ${tHeld}, then ${held.t} after a second of running`);

    // and letting go still closes it on time
    reel.tick(held, 1.1, false);
    t('letting go lets the pane close itself', held.done, `beat ${held.i + 1} of ${held.beats.length}`);
  }

  t('every point of interest has a splash, including an unknown one',
    !err && panes.length === 4 && panes.every((p) => p && p.includes('<pre')),
    err || `${panes.length} panes drawn`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
