// Spawners, cohorts, the advance, and the entry-point rule.

import C from './config.js';
import { key, distance, neighbours, spiral } from './hex.js';
import {
  tileAt, isPassable, isCrewGround, shipNetwork, addLog, nextId, draw, drawInt, drawPick,
} from './state.js';

// ---- pathing ---------------------------------------------------------------

/** A min-heap on `f`. Shared with the crew's own pathing in labour.js. */
export class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function advanceCost(state, tile) {
  if (tile.bridge || (tile.terrain === 'road' && tile.cleared)) return C.TERRAIN.road.advance;
  return C.TERRAIN[tile.terrain].advance;
}

/**
 * A* over passable tiles, cost = the advance multiplier. Includes `from`.
 * `phase` picks which passability rule applies — the turn-based march or the
 * real-time resolve.
 */
export function findPath(state, from, to, phase = 'advance') {
  const startK = key(from.q, from.r), goalK = key(to.q, to.r);
  if (startK === goalK) return [{ q: from.q, r: from.r }];
  const g = new Map([[startK, 0]]);
  const prev = new Map();
  const open = new Heap();
  const closed = new Set();
  open.push({ k: startK, q: from.q, r: from.r, f: distance(from, to) });
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    if (cur.k === goalK) break;
    const base = g.get(cur.k);
    for (const n of neighbours(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (closed.has(nk)) continue;
      const t = state.map.tiles.get(nk);
      if (!t || !isPassable(state, t, phase)) continue;
      const ng = base + advanceCost(state, t);
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, cur.k);
        open.push({ k: nk, q: n.q, r: n.r, f: ng + distance(n, to) });
      }
    }
  }
  if (!prev.has(goalK)) return null;
  const path = [];
  let k = goalK;
  while (k) {
    const [q, r] = k.split(',').map(Number);
    path.push({ q, r });
    if (k === startK) break;
    k = prev.get(k);
  }
  return path.reverse();
}

/**
 * Shortest path over the ship's open ground, BFS. Used to walk units in during
 * a resolve. Road and bridge are open ground and so are sand, salt and meadow:
 * a swarm coming up the beach is coming up the beach.
 */
export function openPath(state, from, to, phase = 'assault') {
  const startK = key(from.q, from.r), goalK = key(to.q, to.r);
  const prev = new Map([[startK, null]]);
  const queue = [{ q: from.q, r: from.r, k: startK }];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    if (cur.k === goalK) break;
    for (const n of neighbours(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (prev.has(nk)) continue;
      const t = state.map.tiles.get(nk);
      if (!t) continue;
      const goal = nk === goalK;
      if (!goal && (!isCrewGround(state, t) || !isPassable(state, t, phase))) continue;
      prev.set(nk, cur.k);
      queue.push({ q: n.q, r: n.r, k: nk });
    }
  }
  if (!prev.has(goalK)) return null;
  const path = [];
  let k = goalK;
  while (k) {
    const [q, r] = k.split(',').map(Number);
    path.push({ q, r });
    k = prev.get(k);
  }
  return path.reverse();
}

/**
 * A tile an advancing cohort enters at: any open ground joined to the ship —
 * road, bridge, sand, salt flat or meadow — or the ship's own standing. A patch
 * cut out in the field draws nothing until it is linked up, and open ground
 * that touches nothing of yours is just ground.
 */
export function isEntry(state, tile) {
  return !!tile && shipNetwork(state).has(key(tile.q, tile.r));
}

/**
 * What a cohort is making for.
 *
 * It heads for the nearest tile of the ship's open ground — whatever is joined
 * to the ship, cut or natural. If the ship itself is nearer than any of that,
 * it comes straight for the ship instead.
 */
export function cohortTarget(state, cohort) {
  const net = shipNetwork(state);
  let best = null, bestD = Infinity;
  for (const k of net) {
    const t = state.map.tiles.get(k);
    if (!t || t.occupant?.kind === 'base') continue; // the ship is judged on its own
    if (!isPassable(state, t)) continue; // a tower is standing on it; nothing can enter there
    const d = distance(cohort, t);
    if (d < bestD) { bestD = d; best = t; }
  }
  const shipD = distance(cohort, state.base);
  if (!best || shipD < bestD) return { q: state.base.q, r: state.base.r, ship: true };
  return { q: best.q, r: best.r, ship: false };
}

/** Is there a continuous walk over the ship's open ground to a tile beside this spawner? */
export function networkReaches(state, spawner) {
  const net = shipNetwork(state);
  const edge = new Set();
  for (const f of spawner.footprint) for (const n of neighbours(f.q, f.r)) edge.add(key(n.q, n.r));
  for (const f of spawner.footprint) edge.delete(key(f.q, f.r));
  for (const k of edge) if (net.has(k)) return true;
  return false;
}

// ---- cohorts ----------------------------------------------------------------

const cohortRadius = (n) => Math.max(0, Math.min(3, Math.floor(Math.sqrt(n / 6))));

export function cohortTiles(state, cohort) {
  return spiral({ q: cohort.q, r: cohort.r }, cohortRadius(cohort.units.length));
}

/** Is the cohort standing on cover? Then its count and composition are hidden. */
export function cohortHidden(state, cohort) {
  const t = tileAt(state, cohort.q, cohort.r);
  return !!t && !t.cleared && (t.terrain === 'forest' || t.terrain === 'canopy');
}

function buildUnits(state, spawner) {
  const n = spawner.stars * C.UNITS_PER_STAR;
  const grubs = Math.round(n * (spawner.grubShare ?? C.UNITS.grub.share));
  // A star is not only more of them; it is bigger ones. Without this a wave is
  // a longer queue at the same kill zone, and a gun line that holds the first
  // wave holds the last one too.
  const grown = 1 + C.UNIT_DANGER_SCALE * (spawner.stars - 1) ** C.UNIT_DANGER_EXP;
  const units = [];
  for (let i = 0; i < n; i++) {
    const type = i < grubs ? 'grub' : 'shell';
    units.push({ type, elite: false, role: null, grown });
  }
  if (spawner.eliteNext && units.length) {
    units[drawInt(state, units.length)].elite = true;
    spawner.eliteNext = false;
  }
  const specials = Math.max(0, spawner.stars - (C.SHIELD_STARS - 1));
  const free = units.filter((u) => !u.elite);
  for (let i = 0; i < specials && free.length; i++) {
    const a = free.splice(drawInt(state, free.length), 1)[0];
    if (a) a.role = 'shield';
    const b = free.splice(drawInt(state, free.length), 1)[0];
    if (b) b.role = 'healer';
  }
  return units;
}

export function releaseCohort(state, spawner, events) {
  const units = buildUnits(state, spawner);
  const cohort = {
    id: nextId(state, 'ms'),
    spawnerId: spawner.id,
    q: spawner.q, r: spawner.r,
    units,
    born: state.turn,
    tilesRemaining: distance(spawner, state.base),
  };
  state.cohorts.push(cohort);
  spawner.accumulatedTurns = 0;
  events.push({ kind: 'cohort', spawner: spawner.name, id: spawner.id, units: units.length, q: cohort.q, r: cohort.r });
  addLog(state, `the ${spawner.name} releases a cohort of ${units.length}`);
  return cohort;
}

export function killSpawner(state, spawner, events) {
  spawner.alive = false;
  spawner.mode = 'dead';
  for (const f of spawner.footprint) {
    const t = tileAt(state, f.q, f.r);
    if (t && t.occupant && t.occupant.id === spawner.id) t.occupant = null;
  }
  state.map.version++;
  // its accumulating cohort is released and advances on that same turn
  releaseCohort(state, spawner, events);
  // stars transfer to the survivors, respecting each cap
  const alive = state.spawners.filter((s) => s.alive);
  let left = spawner.stars;
  while (left > 0 && alive.some((s) => s.stars < s.cap)) {
    for (const s of alive) {
      if (left <= 0) break;
      if (s.stars < s.cap) { s.stars++; left--; }
    }
  }
  events.push({ kind: 'spawnerDied', spawner: spawner.name, id: spawner.id });
  addLog(state, `the ${spawner.name} is destroyed`);
}

// ---- the turn steps --------------------------------------------------------

export function escalate(state, events) {
  const alive = state.spawners.filter((s) => s.alive && s.stars < s.cap);
  if (!alive.length) return;
  const sp = drawPick(state, alive);
  sp.stars++;
  sp.eliteNext = true;
  events.push({ kind: 'escalation', spawner: sp.name, id: sp.id, stars: sp.stars });
  addLog(state, `the ${sp.name} gains a star (${sp.stars})`);
}

export function runSpawners(state, events) {
  for (const sp of state.spawners) {
    if (!sp.alive) continue;
    sp.accumulatedTurns++;
    if (sp.accumulatedTurns >= C.ACCUMULATE_TURNS) releaseCohort(state, sp, events);
  }
}

/**
 * Advance every cohort one turn and report contacts.
 * A cohort walks toward whatever cohortTarget picks, spending advance multipliers
 * up to ADVANCE_TILES_PER_TURN, and makes contact the moment it steps onto the
 * player's road.
 */
export function advanceCohorts(state, events) {
  const contacts = [];
  for (const cohort of state.cohorts.slice()) {
    const target = cohortTarget(state, cohort);
    cohort.target = { q: target.q, r: target.r };
    cohort.headingForShip = target.ship;
    let path = findPath(state, { q: cohort.q, r: cohort.r }, target);
    if (!path || path.length < 2) path = findPath(state, { q: cohort.q, r: cohort.r }, state.base);
    if (!path || path.length < 2) {
      cohort.blocked = true;
      continue;
    }
    cohort.blocked = false;
    let budget = C.ADVANCE_TILES_PER_TURN;
    let contactAt = null;
    let i = 1;
    for (; i < path.length; i++) {
      const t = tileAt(state, path[i].q, path[i].r);
      const cost = advanceCost(state, t);
      if (i > 1 && budget - cost < -C.EPSILON) break; // always take at least one tile
      budget -= cost;
      cohort.q = path[i].q;
      cohort.r = path[i].r;
      if (isEntry(state, t)) { contactAt = { q: t.q, r: t.r }; break; }
      if (budget <= C.EPSILON) break;
    }
    cohort.tilesRemaining = distance(cohort, state.base);
    if (contactAt) {
      contacts.push({ cohort, entry: contactAt, spawnerId: cohort.spawnerId });
      state.cohorts.splice(state.cohorts.indexOf(cohort), 1);
    }
  }
  mergeCohorts(state, events);
  return contacts;
}

/** Two cohorts on overlapping tiles merge into one and arrive together. */
export function mergeCohorts(state, events) {
  for (let i = 0; i < state.cohorts.length; i++) {
    for (let j = i + 1; j < state.cohorts.length; j++) {
      const a = state.cohorts[i], b = state.cohorts[j];
      const ra = cohortRadius(a.units.length), rb = cohortRadius(b.units.length);
      if (distance(a, b) > ra + rb) continue;
      a.units.push(...b.units);
      state.cohorts.splice(j, 1);
      events.push({ kind: 'merged', units: a.units.length, q: a.q, r: a.r });
      addLog(state, `two cohorts merge — ${a.units.length} units`);
      j--;
    }
  }
}
