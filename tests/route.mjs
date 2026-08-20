// Shared by the two harnesses: the cheapest diggable route from the ship to a
// target, and the next piece of work on it.
//
// Road for free, clearable ground by the tile, rivers priced at what a bridge
// costs, ocean not at all. Sand and salt are walkable but can never be cleared,
// so no road will ever run over them — they are walls to a road even though a
// worker can cross them.

import C from '../src/sim/config.js';
import * as H from '../src/sim/hex.js';
import * as St from '../src/sim/state.js';
import * as O from '../src/sim/orders.js';
import { clearCapacity } from '../src/sim/labour.js';

export function roadRoute(s, target) {
  const startK = H.key(s.base.q, s.base.r), goalK = H.key(target.q, target.r);
  const g = new Map([[startK, 0]]);
  const prev = new Map();
  const open = [{ k: startK, q: s.base.q, r: s.base.r, f: 0 }];
  const done = new Set();
  while (open.length) {
    open.sort((a, b) => a.f - b.f);
    const cur = open.shift();
    if (done.has(cur.k)) continue;
    done.add(cur.k);
    if (cur.k === goalK) break;
    for (const n of H.neighbours(cur.q, cur.r)) {
      const nk = H.key(n.q, n.r);
      if (done.has(nk)) continue;
      const t = St.tileAt(s, n.q, n.r);
      if (!t || t.terrain === 'saltwater') continue;
      let step;
      if (nk === goalK) step = 0;
      else if (St.isRoad(t) || t.bridge) step = 0.2;
      else if (t.occupant?.kind === 'base') step = 0.2; // the ship's standing is already open
      // A spawner's mound can never be cleared, so a route only ever ends
      // beside one — priced high enough that it is never a short cut through.
      else if (t.occupant?.kind === 'spawner') step = 2;
      else if (t.terrain === 'freshwater') step = 4;
      else if (t.occupant) continue;
      else if (C.TERRAIN[t.terrain].clearable) step = 1;
      else continue; // sand, salt and cliff will never be road
      const ng = g.get(cur.k) + step;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, cur.k);
        open.push({ k: nk, q: n.q, r: n.r, f: ng + H.distance(n, target) * 0.2 });
      }
    }
  }
  if (!prev.has(goalK)) return null;
  const route = [];
  let k = goalK;
  while (k && k !== startK) {
    const [q, r] = k.split(',').map(Number);
    route.push({ q, r });
    k = prev.get(k);
  }
  return route.reverse();
}

/**
 * The next tiles on that route still wanting work, skipping what is already
 * spoken for. A road grows from its own end, so these come in order.
 */
export function roadFace(s, route, n) {
  const out = [];
  for (const p of route) {
    if (out.length >= n) break;
    const t = St.tileAt(s, p.q, p.r);
    if (!t) continue;
    if (t.terrain === 'freshwater' && !t.bridge) { out.push({ q: p.q, r: p.r, bridge: true }); continue; }
    if (!St.isClearable(s, t)) continue;
    if (O.workersOn(s, p).length) continue;
    out.push({ q: p.q, r: p.r });
  }
  return out;
}

/**
 * Put a gang on the road face. Idle hands first, then diggers pulled off ground
 * further from the target — a road does not build itself out of spare labour,
 * and hands parked on their first tile never advance it.
 */
export function driveRoadGang(s, target, size, diggerFloor = 0) {
  const route = roadRoute(s, target);
  if (!route) return null;
  let pulled = 0;
  for (const spot of roadFace(s, route, size)) {
    if (spot.bridge) { O.enqueue(s, { type: 'buildBridge', q: spot.q, r: spot.r }); continue; }
    if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: spot.q, r: spot.r } }).ok) continue;
    if (St.crewClearing(s) - pulled <= diggerFloor) break;
    const digger = s.crew.assignments.find((a) => a.kind === 'clear' && St.isHand(a.who) &&
      H.distance(a.target, target) > H.distance(spot, target) &&
      !s.orders.some((o) => o.assignmentId === a.id));
    if (!digger) break;
    if (O.enqueue(s, { type: 'reassign', assignmentId: digger.id, kind: 'clear', target: spot }).ok) pulled++;
  }
  return route;
}

/**
 * Maximum matching between workers and the faces they are already touching, so
 * the largest possible number of them work without spending a turn walking.
 * Returns [worker, tile] pairs.
 */
function matchFreeSteps(workers, frontier) {
  const near = workers.map((w) => frontier
    .map((f, i) => [i, H.distance(f, w)])
    .filter(([, d]) => d <= 1)
    .map(([i]) => i));
  const takenBy = new Map(); // tile index -> worker index
  const augment = (wi, seen) => {
    for (const ti of near[wi]) {
      if (seen.has(ti)) continue;
      seen.add(ti);
      const holder = takenBy.get(ti);
      if (holder === undefined || augment(holder, seen)) { takenBy.set(ti, wi); return true; }
    }
    return false;
  };
  for (let wi = 0; wi < workers.length; wi++) augment(wi, new Set());
  return [...takenBy.entries()].map(([ti, wi]) => [workers[wi], frontier[ti]]);
}

/**
 * Put the crew on the working frontier, each worker taking the tile nearest to
 * where they are actually standing. A clear order is one tile, so this runs
 * every turn — and pairing worker-to-tile rather than tile-to-worker is what
 * keeps them cutting instead of walking.
 */
export function putCrewOnFrontier(s, max = Infinity) {
  const frontier = O.workableTiles(s);
  if (!frontier.length) return 0;
  let placed = 0;
  const spare = St.idleMembers(s).filter((m) => m.kind === 'hand');
  const done = new Set();
  // First pass: only pairings that cost no walk at all. Greedy is not good
  // enough — a hand with one face beside it loses that face to a neighbour who
  // had five, and then walks. So match hands to touching faces properly, by
  // augmenting paths, and every hand that could work without moving does.
  for (const [w, spot] of matchFreeSteps(spare, frontier)) {
    if (placed >= max || O.projectedHands(s) <= 0) break;
    if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: spot.q, r: spot.r } }).ok) {
      placed++;
      done.add(w.id);
    }
  }
  // then anyone still spare walks to the nearest face
  for (const w of spare) {
    if (done.has(w.id)) continue;
    if (placed >= max || O.projectedHands(s) <= 0) break;
    const near = frontier.slice().sort((a, b) => H.distance(a, w) - H.distance(b, w));
    for (const spot of near) {
      if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: spot.q, r: spot.r } }).ok) {
        placed++;
        done.add(w.id);
        break;
      }
    }
  }
  // anyone left over takes whatever is still open, nearest the ship first
  const rest = frontier.slice().sort((a, b) => H.distance(a, s.base) - H.distance(b, s.base));
  let guard = 0;
  while (placed < max && O.projectedHands(s) > 0 && guard < rest.length) {
    const spot = rest[guard++];
    if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: spot.q, r: spot.r } }).ok) placed++;
  }
  return placed;
}

/**
 * The same, for a labour officer who works several faces at once. His batch has
 * to touch and be one kind of ground, so the first face is not simply the
 * nearest: it is the nearest one with enough of its own ground beside it to
 * fill the batch. Starting on a lone tile of forest in the scrub wastes two
 * thirds of him.
 */
export function putOfficerOnFrontier(s, officer) {
  const cap = clearCapacity(s, officer.id);
  const frontier = O.workableTiles(s);
  if (!frontier.length) return;
  const from = St.memberById(s, officer.id) || s.base;
  const near = frontier.slice().sort((a, b) => H.distance(a, from) - H.distance(b, from));
  const company = (f) => Math.min(cap - 1,
    near.filter((n) => n.terrain === f.terrain && H.distance(n, f) === 1).length);
  const first = near.slice().sort((a, b) => company(b) - company(a) ||
    H.distance(a, from) - H.distance(b, from))[0];
  let placed = 0;
  if (O.enqueue(s, { type: 'assignClear', who: officer.id, target: { q: first.q, r: first.r } }).ok) placed++;
  for (const spot of near) {
    if (placed >= cap) break;
    if (spot.terrain !== first.terrain) continue;
    if (O.enqueue(s, { type: 'assignClear', who: officer.id, target: { q: spot.q, r: spot.r } }).ok) placed++;
  }
}

/** Work any point of interest that is uncovered and within reach. */
export function workFeatures(s, max = Infinity) {
  let placed = 0;
  for (const t of s.map.tiles.values()) {
    if (placed >= max || O.projectedHands(s) <= 0) break;
    if (!t.feature || t.featureWorked || !C.featureAction(t.feature)) continue;
    if (O.enqueue(s, { type: 'workFeature', who: 'hand', target: { q: t.q, r: t.r } }).ok) placed++;
  }
  return placed;
}
