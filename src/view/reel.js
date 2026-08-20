// The resolve reel: what the turn just did, played back at watching speed.
//
// The sim is not involved. `resolveTurn` still runs to completion in one
// synchronous call and still returns the same event list it always did — the
// reel is built from that list afterwards and replays it, so nothing here can
// change an outcome. That is the whole design constraint: a cinematic that can
// desync from the rules it is illustrating is worse than no cinematic, and the
// only way to be sure it cannot is to give it no way to write.
//
// The cost of that choice is that the reel shows the finished map while the
// crew are still walking across it — ground they cut this turn is already open
// under their feet. The alternative is keeping a second, rewindable copy of the
// island, which is a great deal of machinery for a detail nobody looking at a
// walking dot is watching for.

import C from '../sim/config.js';
import { crewRoute, jobPlace } from '../sim/labour.js';
import { findPath } from '../sim/enemy.js';
import { tileAt } from '../sim/state.js';
import { axialToPixel, key } from '../sim/hex.js';
import * as art from './ascii.js';

// Seconds at 1x.
//
// The walk is paced by how far anybody actually went. The splashes are paced to
// be read: a picture and two numbers take longer to take in than they take to
// draw, and at the couple of seconds they first held, the panes registered as a
// flicker rather than as something you had been told. They are held about five
// times as long now. Nothing about that is load bearing — the reel's own 1x/3x
// and its skip are what a player in a hurry reaches for, and Space cuts a
// single pane without giving up the rest.
const WALK_MIN = 1.1;
const WALK_PER_STEP = 0.22;
const WALK_MAX = 4.0;
const POI_SECONDS = 11;
const BREED_SECONDS = 4.5;
const RELEASE_SECONDS = 12;

// How hard the camera is pulled to the beat's subject. Exponential smoothing,
// so it is framerate independent — a dropped frame moves it further, not less.
const CAMERA_PULL = 3.2;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- building the reel -----------------------------------------------------

/**
 * Where everything that moves stood before the resolve moved it.
 *
 * One snapshot for both sides, because both are walked in the same beat: the
 * turn moves the crew at step 1b and the cohorts at step 9, and a player who
 * watched those separately would be watching the same second of island twice.
 */
export function snapshotMovers(state) {
  const crew = new Map();
  for (const b of state.crew.members) crew.set(b.id, { q: b.q, r: b.r });
  const cohorts = new Map();
  for (const c of state.cohorts) cohorts.set(c.id, { q: c.q, r: c.r });
  return { crew, cohorts, ground: snapshotGround(state) };
}

/**
 * The ground as it stands, for every tile somebody is about to work.
 *
 * Only those tiles: labour is the one thing in the resolve that rewrites the
 * map, and it only ever touches ground an assignment or an order names. Copying
 * the whole island every turn to catch a handful of hexes would be four
 * thousand objects a turn for nothing.
 */
function snapshotGround(state) {
  const out = new Map();
  const add = (at) => {
    if (!at) return;
    const t = tileAt(state, at.q, at.r);
    if (!t || out.has(key(t.q, t.r))) return;
    out.set(key(t.q, t.r), {
      q: t.q, r: t.r, terrain: t.terrain, cleared: !!t.cleared,
      work: t.work || 0, bridge: !!t.bridge,
    });
  };
  for (const a of state.crew.assignments) add(jobPlace(state, a));
  for (const o of state.orders) add(o.target && o.target.q !== undefined ? o.target
    : (o.q !== undefined ? { q: o.q, r: o.r } : null));
  return out;
}

/**
 * The walking, as routes rather than as two endpoints.
 *
 * Asked of the map as it stands *after* the resolve, which is the map they will
 * be shown crossing — a gang that spent the turn cutting a road has opened it,
 * and a dot that walks the old way round would be walking past its own work.
 */
function walkers(state, before) {
  const out = [];
  for (const b of state.crew.members) {
    const from = before.crew.get(b.id);
    if (!from || (from.q === b.q && from.r === b.r)) continue;
    const route = crewRoute(state, from, { q: b.q, r: b.r });
    // An unreachable pair still walked — the ground closed behind them, or they
    // were landed rather than sent. Two points is a straight line, which is the
    // honest picture of a move nobody can draw a road for.
    const path = route.reachable && route.steps.length > 1
      ? route.steps
      : [from, { q: b.q, r: b.r }];
    out.push({ id: b.id, kind: b.kind, path });
  }
  return out;
}

/**
 * The advance, as routes rather than as two endpoints.
 *
 * Only the cohorts still standing at the end of the resolve. One that reached a
 * road is gone from the list — it has become a fight, with its own real-time
 * animation starting the moment the reel ends — and one that merged into
 * another has been absorbed into a blob that is itself walking.
 *
 * A cohort released this turn has no `before` at all: it was born at its
 * spawner and advanced in the same resolve, so the mound it came out of is
 * where its walk starts.
 */
function marchers(state, before) {
  const out = [];
  for (const c of state.cohorts) {
    const born = state.spawners.find((sp) => sp.id === c.spawnerId);
    const from = before.cohorts.get(c.id) || (born && { q: born.q, r: born.r });
    if (!from || (from.q === c.q && from.r === c.r)) continue;
    // The same A* the advance itself walked, so the blob retraces its own
    // route rather than sliding through whatever lies between the endpoints.
    const found = findPath(state, from, { q: c.q, r: c.r }, 'advance');
    const path = found && found.length > 1 ? found : [from, { q: c.q, r: c.r }];
    out.push({ id: c.id, path });
  }
  return out;
}

/**
 * Ground the labour changed this turn, as it stood before.
 *
 * The resolve cuts the tile at step 2, immediately after the walking at step 1b
 * — so by the time anyone sees the reel, the scrub a hand is still three tiles
 * short of is already road, and a forest tile shows a third of its work done by
 * a worker who has not reached it. Held for the length of the walk, which is
 * exactly the order the turn ran them in.
 */
function worked(state, before) {
  const out = new Map();
  for (const [k, was] of before.ground) {
    const t = tileAt(state, was.q, was.r);
    if (!t) continue;
    const changed = t.terrain !== was.terrain || !!t.cleared !== was.cleared
      || (t.work || 0) !== was.work || !!t.bridge !== was.bridge;
    if (changed) out.set(k, was);
  }
  return out;
}

/** The middle of a set of tiles, for pointing the camera at a group. */
function centroid(points) {
  if (!points.length) return null;
  let q = 0, r = 0;
  for (const p of points) { q += p.q; r += p.r; }
  return { q: q / points.length, r: r / points.length };
}

/**
 * The beats of one resolve, in the order the turn ran them.
 *
 * Returns null when the turn had nothing to show — an early turn with the crew
 * standing still and both spawners quietly breeding is most of them, and a reel
 * that interrupts to say nothing happened is worse than no reel.
 */
export function build(state, events, before) {
  const beats = [];

  const moved = walkers(state, before);
  const marched = marchers(state, before);
  if (moved.length || marched.length) {
    const all = [...moved, ...marched];
    const steps = Math.max(...all.map((w) => w.path.length - 1));
    beats.push({
      kind: 'walk',
      movers: moved,
      marchers: marched,
      ground: worked(state, before),
      // Framed on the crew when there are any, because that is where the player
      // is working and what they pressed the button to see. Only a turn with
      // nobody walking hands the camera to the enemy.
      focus: centroid((moved.length ? moved : marched)
        .flatMap((w) => [w.path[0], w.path[w.path.length - 1]])),
      seconds: Math.min(WALK_MAX, WALK_MIN + WALK_PER_STEP * steps),
    });
  }

  // One per site, in the order they were worked. The officer's own name arrives
  // on a separate event pushed right after the feature, so it is read forward
  // from here rather than searched for — two castaways in a turn is possible.
  events.forEach((e, i) => {
    if (e.kind !== 'feature') return;
    const joined = events.slice(i + 1).find((x) => x.kind === 'officer');
    beats.push({
      kind: 'poi',
      feature: e.feature,
      wood: e.wood, gold: e.gold,
      name: e.feature === 'officer' && joined ? joined.name : null,
      trade: e.feature === 'officer' && joined ? joined.trade : null,
      focus: { q: e.q, r: e.r },
      seconds: POI_SECONDS,
    });
  });

  // Read off the spawners rather than off an event, because breeding does not
  // raise one — it is a counter ticking, and the counter is already on the state
  // in exactly the form the splash wants to draw.
  const alive = state.spawners.filter((s) => s.alive);
  if (alive.length) {
    beats.push({
      kind: 'breed',
      spawners: alive.map((s) => ({
        kind: s.kind, name: s.name, stars: s.stars, cap: s.cap,
        turns: s.accumulatedTurns, of: C.ACCUMULATE_TURNS,
      })),
      focus: null,
      seconds: BREED_SECONDS,
    });
  }

  const released = events.filter((e) => e.kind === 'cohort');
  if (released.length) {
    beats.push({
      kind: 'release',
      cohorts: released.map((e) => {
        const sp = state.spawners.find((s) => s.id === e.id);
        return { kind: sp ? sp.kind : 'hive', name: e.spawner, units: e.units, q: e.q, r: e.r };
      }),
      focus: centroid(released.map((e) => ({ q: e.q, r: e.r }))),
      seconds: RELEASE_SECONDS,
    });
  }

  if (!beats.length) return null;
  return { beats, i: 0, t: 0, speed: 1, dirty: true, done: false };
}

// ---- playing it ------------------------------------------------------------

export const beat = (reel) => reel.beats[reel.i] || null;

/** Cut to the next beat, ending the reel if that was the last one. */
export function next(reel) {
  reel.i++;
  reel.t = 0;
  reel.dirty = true;
  if (reel.i >= reel.beats.length) reel.done = true;
}

/** Abandon the rest of it. The turn carries on from wherever it had got to. */
export function skip(reel) {
  reel.i = reel.beats.length;
  reel.done = true;
  reel.dirty = true;
}

/**
 * Advance by `dt` real seconds. Returns true when the last beat has played out.
 *
 * `held` stops the clock without ending anything: a pane under the pointer does
 * not time out, because the pane somebody has leaned in to read is precisely
 * the one about to close itself. The reel owns this rather than the caller
 * skipping the call, so "held" cannot drift into meaning "finished".
 *
 * The camera is a separate call — `cameraTarget` and `glide` — because only the
 * caller knows the hex size the target has to be measured in, and because the
 * camera keeps easing onto the beat already on screen even while it is held.
 */
export function tick(reel, dt, held = false) {
  if (reel.done) return true;
  const b = beat(reel);
  if (!b) { reel.done = true; return true; }
  if (held) return false;

  reel.t += dt * reel.speed;
  if (reel.t >= b.seconds) next(reel);
  return reel.done;
}

/** Where the camera wants to be for the current beat, in world pixels. */
export function cameraTarget(reel, size) {
  const b = beat(reel);
  if (!b || !b.focus) return null;
  return axialToPixel(b.focus.q, b.focus.r, size);
}

/** Ease the camera a step toward the beat's subject. */
export function glide(cam, target, dt) {
  if (!target) return;
  const k = 1 - Math.exp(-CAMERA_PULL * dt);
  cam.x += (target.x - cam.x) * k;
  cam.y += (target.y - cam.y) * k;
}

/** How far along its own route one mover is, in fractional axial coordinates. */
function along(path, done) {
  const last = path.length - 1;
  const at = done * last;
  const i = Math.min(last, Math.floor(at));
  const j = Math.min(last, i + 1);
  const f = at - i;
  return {
    q: path[i].q + (path[j].q - path[i].q) * f,
    r: path[i].r + (path[j].r - path[i].r) * f,
  };
}

/**
 * Sites the resolve has already worked but the reel has not yet shown.
 *
 * The sim marks a site worked the moment the resolve runs, and `touchMap` bakes
 * the ground again without its marker — so by the time the reel starts, every
 * chest found this turn has already vanished off the map. The player then
 * watches a body walk to a bare tile and only afterwards gets told what was on
 * it, which is the reveal backwards.
 *
 * So the marker is held on screen until its own pane has been and gone: a site
 * is listed here while its beat is still ahead of, or is, the current one, and
 * drops off the list the moment the reel moves past it.
 */
export function pending(reel) {
  if (!reel || reel.done) return null;
  const out = [];
  for (let i = reel.i; i < reel.beats.length; i++) {
    const b = reel.beats[i];
    if (b.kind === 'poi' && b.focus) out.push({ q: b.focus.q, r: b.focus.r, feature: b.feature });
  }
  return out.length ? out : null;
}

/**
 * The ground as it stood before the labour, while the walk is still playing.
 *
 * Null everywhere else: once the walking is over the labour has happened, and
 * the map is allowed to say so.
 */
export function groundBefore(reel) {
  const b = beat(reel);
  return b && b.kind === 'walk' && b.ground && b.ground.size ? b.ground : null;
}

/**
 * Everything mid-stride: the crew and the cohorts both, keyed by id, in
 * fractional axial coordinates.
 *
 * Null when the current beat is not the walk, which is what tells the renderer
 * to go back to drawing both where the state says they stand. Two maps rather
 * than one, because a crew id and a cohort id are drawn by different passes and
 * nothing should depend on the two id spaces never colliding.
 */
export function walkPositions(reel) {
  const b = beat(reel);
  if (!b || b.kind !== 'walk') return null;
  const done = Math.max(0, Math.min(1, reel.t / b.seconds));
  const crew = new Map();
  for (const w of b.movers) crew.set(w.id, along(w.path, done));
  const cohorts = new Map();
  for (const w of b.marchers) cohorts.set(w.id, along(w.path, done));
  return { crew, cohorts };
}

// ---- the splash ------------------------------------------------------------

// The foot of every pane: how long it has left before it closes itself, and the
// one control that acts on the pane rather than on the whole resolve.
//
// The bar is on the splash as well as in the panel because they answer different
// questions from different places — the panel says how far through the resolve
// you are, and this says how long *this* picture will stay up. It is the second
// one you want while you are reading, and looking away to the side of the screen
// to find it is exactly what you cannot afford to do.
const FOOT = '<div class="pane-foot">'
  + '<div class="pane-bar"><i></i></div>'
  + '<button data-r="next">next</button>'
  + '</div>';

const pane = (title, body, note = '') =>
  `<h2>${esc(title)}</h2><pre class="art">${esc(body)}</pre>`
  + (note ? `<p class="note">${note}</p>` : '');

function poiPane(b) {
  if (b.feature === 'wreck') {
    return pane('a shipwreck is searched', art.WRECK,
      `<b>+${b.wood}</b> wood out of her ribs`);
  }
  if (b.feature === 'cache') {
    return pane('a chest is dug up', art.CACHE,
      `<b>+${b.gold}</b> gold, and gold is the only thing that buys a gun`);
  }
  return pane('a castaway is saved', art.CASTAWAY,
    b.name ? `${esc(b.name)} joins the company — ${esc(b.trade || 'a pirate')}` : 'he joins the company');
}

/** Both fronts side by side, each in its own equal share of the width. */
function breedPane(b) {
  const cols = b.spawners.map((s) => {
    const bar = '#'.repeat(s.turns) + '.'.repeat(Math.max(0, s.of - s.turns));
    const stars = '*'.repeat(s.stars) + '-'.repeat(Math.max(0, s.cap - s.stars));
    return '<div class="reel-col">'
      + `<pre class="art">${esc(art.forSpawner(s.kind))}</pre>`
      + `<div class="reel-name">${esc(s.name)}</div>`
      + `<div class="note">brood <span class="bar">${esc(bar)}</span> ${s.turns}/${s.of}</div>`
      + `<div class="note">stars <span class="bar">${esc(stars)}</span> ${s.stars}/${s.cap}</div>`
      + '</div>';
  });
  return '<h2>the island breeds</h2>'
    + `<div class="reel-cols" style="grid-template-columns: repeat(${b.spawners.length}, 1fr)">`
    + cols.join('') + '</div>';
}

/** Everything let go this turn, one column each. */
function releasePane(b) {
  const cols = b.cohorts.map((c) => '<div class="reel-col">'
    + `<pre class="art">${esc(art.forSpawner(c.kind))}</pre>`
    + '<div class="reel-arrow">|</div>'
    + `<pre class="art bad">${esc(art.column(c.units))}</pre>`
    + `<div class="reel-name">${esc(c.name)}</div>`
    + `<div class="note">a cohort of <b>${c.units}</b> is on the road</div>`
    + '</div>');
  return '<h2>cohorts released</h2>'
    + `<div class="reel-cols" style="grid-template-columns: repeat(${b.cohorts.length}, 1fr)">`
    + cols.join('') + '</div>';
}

/**
 * The splash for the current beat. Called only when the beat changes, never per
 * frame — the progress bar under it is a CSS animation for exactly that reason.
 */
export function paneHtml(reel) {
  const b = beat(reel);
  if (!b || b.kind === 'walk') return null;
  if (b.kind === 'poi') return poiPane(b) + FOOT;
  if (b.kind === 'breed') return breedPane(b) + FOOT;
  if (b.kind === 'release') return releasePane(b) + FOOT;
  return null;
}

/** What the beat on screen is, in the panel's own words. */
const BEAT_LABEL = {
  walk: 'the island moves',
  poi: 'a site is worked',
  breed: 'the island breeds',
  release: 'cohorts released',
};

/**
 * The panel in the side column: the settings, and the one control that acts on
 * a whole resolve rather than on the pane in front of you.
 *
 * Rendered whether or not a reel is running, because the speed is a standing
 * preference and not only a control — a player who has settled on 3x has
 * settled on it for the run, and a control that only exists while it is being
 * used cannot be set in advance. Stepping a single beat is the opposite kind of
 * thing and lives on the splash instead.
 */
export function panelHtml(reel, speed) {
  const on = (s) => (s === speed ? ' class="on"' : '');
  const b = reel && beat(reel);
  const controls = '<div class="row">'
    + '<span class="k">speed</span>'
    + `<button data-r="1"${on(1)}>1x</button>`
    + `<button data-r="3"${on(3)}>3x</button>`
    + '<span class="gap"></span>'
    + `<button data-r="skip"${b ? '' : ' disabled'}>skip</button>`
    + '</div>';

  const line = b
    ? `<div class="beat"><b>${esc(BEAT_LABEL[b.kind] || b.kind)}</b> · ${reel.i + 1} of ${reel.beats.length}</div>`
    : '<div class="beat">plays when the turn ends</div>';

  return '<h3>Resolve turn animation</h3>' + line + controls
    + (b ? '<div id="reel-bar"><i></i></div>' : '');
}
