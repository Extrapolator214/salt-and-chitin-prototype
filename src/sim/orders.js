// The order queue: validate, apply, revoke.
// Orders are appended in the player phase and applied only during resolve, so
// anything in the queue can be revoked at no cost.

import C from './config.js';
import { distance, key, parseKey, neighbours, NEIGHBOURS } from './hex.js';
import {
  tileAt, addLog, nextId, idleHands, idleOfficers, officerById, holdFree, holdCap,
  hasBuilding, isBuildingManned, buildingsOfType, walkableForWork, isClearable, memberById,
  handsNeededFor, towerManning, isHand, crewHeld, crewName, autoClearOn, setAutoClear,
} from './state.js';
import * as B from './build.js';
import {
  assign, unassign as dropAssignment, recomputeCapBonus, clearCapacity, levelBatch,
  travelTurnsFor, jobPlace, pickNearest, haulOf,
} from './labour.js';
import * as A from './assault.js';

const ok = { ok: true };
const no = (why) => ({ ok: false, why });
const NO_COST = {};

/**
 * Put a worker on a job, and say so out loud if there was nobody to put on it.
 *
 * `assign` returns null when the roster has no free body — the order was legal
 * when it was queued and is not by the time it is applied. Ignoring that made
 * the order vanish with no refusal and no line in the log: the player saw a
 * tile they had ordered worked, and nobody on it.
 */
function place(state, order, events, spec) {
  const a = assign(state, spec);
  if (!a) {
    const why = 'nobody free to take it';
    events.push({ kind: 'refused', order, why });
    addLog(state, `order refused — ${describe(state, order)}: ${why}`);
  }
  return a;
}

const FEATURE_NAME = {
  cache: 'treasure cache', spring: 'spring', officer: 'officer site', wreck: 'shipwreck',
};

/** How a tile reads in an order line: what is on it, then where it is. */
export function tileLabel(state, p) {
  const t = tileAt(state, p.q, p.r);
  if (!t) return `(${p.q},${p.r})`;
  const feature = t.feature && !t.featureWorked ? `${FEATURE_NAME[t.feature] || t.feature} - ` : '';
  const ground = t.bridge ? 'bridged fresh water' : (C.TERRAIN_NAME[t.terrain] ?? t.terrain);
  return `${feature}${ground} (${p.q},${p.r})`;
}

/**
 * Where the crew will be standing once this turn resolves.
 *
 * The resolve walks everybody first and only then sets them to work, so the
 * ground the orders should be checked against is not where the crew are now —
 * it is where they will be when the work starts. Three things are in it:
 *
 * - every tile the crew hold already (`crewHeld`): bodies standing still, and
 *   the faces workers have got to;
 * - the face of any queued job its worker can walk to inside this turn;
 * - a bridge queued this turn, which is ground by the time anyone crosses it.
 *
 * The second is a fixed point, and deliberately so. A hand who reaches his face
 * this turn is standing on it when the work starts, so the man behind him can
 * walk past him to the next face along, and the man behind *him* past that one.
 * A chain of jobs laid out in one phase therefore routes through itself, which
 * is the whole reason a gang can be pointed at a line of forest in one go. It
 * costs a route per queued job per pass; the queue is a handful of orders and
 * the crew are a few dozen bodies, so it is cheap enough to do honestly.
 *
 * What it will not do is run ahead of the bodies. A face nobody reaches this
 * turn holds nothing, so the reach stops where the crew stop.
 */
let groundCache = { key: null, value: null };

/**
 * The key is everything the answer depends on: the map, the turn, the queue,
 * the roster of jobs, and where every body is standing. The last one is why
 * this cannot ride on `state.map.version` like the other caches — `runMovement`
 * walks the crew without touching the map, and a stale reach would offer work
 * beside where somebody used to be.
 */
function groundKey(state) {
  return `${state.map.version}|${state.turn}|${state.ids}|${state.orders.length}`
    + `|${state.crew.assignments.map((a) => `${a.id}:${a.arrivesOnTurn}`).join(',')}`
    + `|${state.crew.members.map((m) => `${m.q},${m.r}`).join(';')}`;
}

/**
 * Turns of walking before a queued job's work starts.
 *
 * Everybody's own walk, save for a labour officer's extra faces: those are one
 * trip with his first, so they cost him nothing beyond the walk he is already
 * making and are cut in step with it — which is what `assign` charges them at
 * (`sameTripAs`) when the queue is applied.
 *
 * Pricing each face as a walk of its own is what made the far end of a batch
 * unqueueable. The Pioneer's three faces run in a line, so the third is a tile
 * further out than the first; measured on its own that tile is often over the
 * half-turn band and reads as a turn's march, so it held no ground, and the
 * tile beyond it — the one the player was plainly about to hand him — answered
 * "no way to walk there" even though the resolve would have had him cutting the
 * whole batch this turn.
 */
function tripTurns(state, o, who, held, byOrder) {
  if (o.type !== 'assignClear' || isHand(who) || clearCapacity(state, who) < 2) {
    return travelTurnsFor(state, who, o.target, held);
  }
  const first = firstFace(state, who, byOrder);
  if (!first || first === o) return travelTurnsFor(state, who, o.target, held);
  return first.arrivesOnTurn !== undefined
    ? Math.max(0, first.arrivesOnTurn - state.turn)
    : travelTurnsFor(state, who, first.target, held);
}

/**
 * The face a labour officer's batch is walked to: the one he is already on his
 * way to if he has one, otherwise the first his queue gives him.
 */
function firstFace(state, who, byOrder) {
  const standing = state.crew.assignments.find((a) => a.who === who && a.kind === 'clear');
  if (standing) return standing;
  return state.orders.find((o) => o.type === 'assignClear' && byOrder.get(o.id) === who) || null;
}

export function crewGroundAtResolve(state) {
  const k = groundKey(state);
  if (groundCache.key === k) return groundCache.value;
  const held = new Set(crewHeld(state));
  for (const o of state.orders) if (o.type === 'buildBridge') held.add(key(o.q, o.r));
  const jobs = state.orders.filter((o) => o.target && o.target.q !== undefined
    && (o.type === 'assignClear' || o.type === 'workFeature' || o.type === 'assignGarrison'));
  if (!jobs.length) { groundCache = { key: k, value: held }; return held; }
  // A pass at a time, because who takes each job depends on the ground opened
  // by the jobs already counted: `projectedCrew` routes to pick its bodies, so
  // it has to be asked again each time the set grows. It can grow at most once
  // per job, which bounds the loop.
  for (let pass = 0; pass <= jobs.length; pass++) {
    const { byOrder } = projectedCrew(state, held);
    let grew = false;
    for (const o of jobs) {
      const k = key(o.target.q, o.target.r);
      if (held.has(k)) continue;
      const who = byOrder.get(o.id);
      if (!who || tripTurns(state, o, who, held, byOrder) !== 0) continue;
      held.add(k);
      grew = true;
    }
    if (!grew) break;
  }
  groundCache = { key: k, value: held };
  return held;
}

/**
 * Ground a worker could be sent to: everywhere the crew can walk once this
 * turn's movement has happened, flooded on over open ground.
 *
 * This used to grow a ring at a time from where bodies actually stood, and
 * refused anything further out. It read as a bug at the table in both
 * directions. A worker plainly cutting a face was quoted "no way to walk there"
 * for the tile at his elbow, because the reach was reading his last waypoint
 * rather than the job he had arrived at. And a hand who would reach his face
 * this turn opened nothing beyond it, so a gang could not be pointed along a
 * line of forest in one phase even though the resolve would have walked them
 * there in order.
 *
 * Both come out of the same question, asked properly: a tile is out of reach
 * only if nobody can get to it, or beside it, by the time the work starts.
 */
function reachForWork(state) {
  return walkableForWork(state, crewGroundAtResolve(state));
}

/**
 * Can a worker be set to work this tile? Two things have to hold: nobody is on
 * it already — one face, one worker — and somebody can get to it, or beside it,
 * by the time this turn's work starts. A boulder is cleared from the ground
 * next to it, so touching the reach is enough.
 */
export function canWorkTile(state, p, ignoreAssignmentId) {
  const taken = workersOn(state, p).filter((a) => a.id !== ignoreAssignmentId);
  if (taken.length) {
    const officer = officerById(state, taken[0].who);
    return no(`${officer ? officer.name : taken[0].who} already has that tile`);
  }
  const reach = reachForWork(state);
  if (reach.has(key(p.q, p.r))) return ok;
  if (neighbours(p.q, p.r).some((n) => reach.has(key(n.q, n.r)))) return ok;
  return no('no way to walk there');
}

/**
 * The working frontier: every tile that could be cut open right now — clearable
 * ground standing on, or beside, what the crew can already reach. This is the
 * edge the cleared blob grows from.
 */
export function workableTiles(state) {
  const reach = reachForWork(state);
  const taken = new Set(
    projectedAssignments(state)
      .filter((a) => a.target && a.target.q !== undefined)
      .map((a) => key(a.target.q, a.target.r)),
  );
  const out = new Map();
  const offer = (nk) => {
    if (out.has(nk) || taken.has(nk)) return;
    const t = state.map.tiles.get(nk);
    if (t && isClearable(state, t)) out.set(nk, t);
  };
  // Walked without rebuilding the ring as objects: this is the frontier, it
  // grows with the cleared blob, and it used to allocate nine things per reach
  // tile to say the same thing.
  for (const k of reach) {
    const { q, r } = parseKey(k);
    offer(k);
    for (const d of NEIGHBOURS) offer(key(q + d[0], r + d[1]));
  }
  return [...out.values()];
}

/**
 * The water the crew could bridge right now: fresh water on, or beside, ground
 * they can already reach, and not already spoken for by a bridge in the queue.
 *
 * The order itself asks for less than this — any unbridged fresh water on the
 * map is legal, since a bridge is paid for in wood and not in walking. The
 * frontier rule is the map's, not the sim's: every river tile on the island lit
 * at once is not an offer, it is wallpaper, and the ones worth offering are the
 * ones somebody could actually walk to and start.
 */
export function bridgeableTiles(state) {
  const reach = reachForWork(state);
  const queued = new Set(
    state.orders.filter((o) => o.type === 'buildBridge').map((o) => key(o.q, o.r)),
  );
  const out = new Map();
  const offer = (nk) => {
    if (out.has(nk) || queued.has(nk)) return;
    const t = state.map.tiles.get(nk);
    if (t && t.terrain === 'freshwater' && !t.bridge) out.set(nk, t);
  };
  for (const k of reach) {
    const { q, r } = parseKey(k);
    for (const d of NEIGHBOURS) offer(key(q + d[0], r + d[1]));
  }
  return [...out.values()];
}

/** Every tile the queue has spoken for, so the map can mark them. */
export function queuedTiles(state) {
  const out = [];
  for (const o of state.orders) {
    if (o.target && o.target.q !== undefined) out.push({ q: o.target.q, r: o.target.r, kind: o.type });
    else if (o.q !== undefined) {
      if (o.type === 'buildBuilding') {
        const def = C.buildingDef(o.building);
        for (const p of B.footprintPreview(state, o.q, o.r, def.tiles, false, o.building)) out.push({ q: p.q, r: p.r, kind: o.type });
      } else if (o.type === 'buildTower') {
        // A gun stands on its own yard now, so the whole of it is marked, not
        // only the tile the order names.
        for (const p of C.towerTiles(o.towerIndex, o.q, o.r)) out.push({ q: p.q, r: p.r, kind: o.type });
      } else out.push({ q: o.q, r: o.r, kind: o.type });
    }
  }
  // A house queued to come down has no tile on the order — it names a building —
  // but its ground is as spoken for as any plot, and the player should be able
  // to see which one they marked from the map rather than only from the queue.
  for (const o of state.orders) {
    if (o.type !== 'demolishBuilding') continue;
    const b = state.buildings.find((x) => x.id === o.buildingId);
    if (b) for (const p of b.tiles) out.push({ q: p.q, r: p.r, kind: o.type });
  }
  return out;
}

/**
 * Queued structures standing on this tile — the orders themselves, not just the
 * fact that the ground is spoken for.
 *
 * `queuedTiles` above answers "is this hex claimed", which is all the map needs
 * to shade it. The tile panel needs the order, because the only thing anyone
 * wants to do with a plot they have changed their mind about is take it back —
 * and with the catalogue moved to the bar, a click on the tile was the one
 * gesture that still pointed at the thing they had placed.
 */
export function queuedStructuresAt(state, at) {
  const covers = (tiles) => tiles.some((p) => p.q === at.q && p.r === at.r);
  return state.orders.filter((o) => {
    if (o.type === 'buildBuilding') {
      const def = C.buildingDef(o.building);
      return !!def && covers(C.buildingTiles(def.tiles, o.q, o.r));
    }
    if (o.type === 'buildTower') return covers(C.towerTiles(o.towerIndex, o.q, o.r));
    if (o.type === 'buildBridge') return o.q === at.q && o.r === at.r;
    return false;
  });
}

/**
 * Each order type: what it costs, whether it is legal right now, how to apply
 * it, and how to say it in one line for the queue panel.
 */
export const ORDERS = {
  assignClear: {
    label: (o, state) => `clear ${tileLabel(state, o.target)}`,
    cost: () => NO_COST,
    gain: (state, o) => {
      const t = tileAt(state, o.target.q, o.target.r);
      return t && isClearable(state, t) ? C.TERRAIN[t.terrain].yield : NO_COST;
    },
    hands: (o) => (isHand(o.who) ? 1 : 0),
    check: (state, o) => {
      const t = tileAt(state, o.target.q, o.target.r);
      if (!t) return no('off the map');
      if (!isClearable(state, t)) return no('nothing to clear there');
      return canWorkTile(state, o.target);
    },
    apply: (state, o, events, held) => {
      // a labour officer's faces are one trip: the second and third tiles cost
      // him nothing beyond the walk he is already making to the first, and they
      // are cut in step with it, so the batch comes free in one turn
      const batch = state.crew.assignments.filter((a) => a.who === o.who && a.kind === 'clear');
      const a = place(state, o, events, {
        kind: 'clear', who: o.who, target: o.target, at: o.target, held,
        // Carried onto the assignment so that standing the worker down later is
        // recognisable as calling off the standing order that made it.
        auto: o.auto,
        sameTripAs: batch.length ? Math.max(0, batch[0].arrivesOnTurn - state.turn) : undefined,
      });
      if (a && batch.length) levelBatch(state, [...batch, a]);
    },
  },

  assignMan: {
    label: (o, state) => {
      const t = state.towers.find((x) => x.id === o.targetId);
      const b = state.buildings.find((x) => x.id === o.targetId);
      return `man ${t ? C.TOWERS[t.towerIndex].name : b ? b.name : o.targetId}`;
    },
    cost: () => NO_COST,
    hands: (o) => (isHand(o.who) ? 1 : 0),
    check: (state, o) => {
      const target = state.towers.find((t) => t.id === o.targetId) || state.buildings.find((b) => b.id === o.targetId);
      if (!target) return no('gone');
      return ok;
    },
    apply: (state, o, events, held) => {
      const at = jobPlace(state, { kind: 'man', target: o.targetId });
      place(state, o, events, { kind: 'man', who: o.who, target: o.targetId, at, held });
    },
  },

  assignGarrison: {
    label: (o, state) => `station at ${tileLabel(state, o.target)}`,
    cost: () => NO_COST,
    hands: (o) => (isHand(o.who) ? 1 : 0),
    check: (state, o) => {
      const t = tileAt(state, o.target.q, o.target.r);
      if (!t || t.feature !== 'spring') return no('nothing to stand on');
      if (isClearable(state, t)) return no('clear the tile first');
      return canWorkTile(state, o.target);
    },
    apply: (state, o, events, held) => {
      place(state, o, events, { kind: 'garrison', who: o.who, target: o.target, at: o.target, held });
      recomputeCapBonus(state);
    },
  },

  // A point of interest is a job of its own: search the wreck, dig up the
  // chest, save the man. The ground has to be open first, so a chest under
  // forest is two turns — one to cut the tile, one to work what is under it.
  workFeature: {
    label: (o, state) => {
      const t = tileAt(state, o.target.q, o.target.r);
      const verb = t && t.feature ? C.featureAction(t.feature) : 'work';
      return `${verb} ${tileLabel(state, o.target)}`;
    },
    cost: () => NO_COST,
    gain: (state, o) => {
      const t = tileAt(state, o.target.q, o.target.r);
      if (!t || !t.feature || t.featureWorked) return NO_COST;
      if (t.feature === 'wreck') return haulOf(C.FEATURES.wreck);
      if (t.feature === 'cache') return { gold: C.FEATURES.cache.gold };
      return NO_COST;
    },
    hands: (o) => (isHand(o.who) ? 1 : 0),
    check: (state, o) => {
      const t = tileAt(state, o.target.q, o.target.r);
      if (!t) return no('off the map');
      if (!t.feature || t.featureWorked) return no('nothing left there');
      if (!C.featureAction(t.feature)) return no('nothing to be done there');
      if (isClearable(state, t)) return no('clear the tile first');
      return canWorkTile(state, o.target);
    },
    apply: (state, o, events, held) => {
      place(state, o, events, { kind: 'feature', who: o.who, target: o.target, at: o.target, held });
    },
  },

  // Moving a worker already in the field: the walk is counted from where they
  // stand, not from the ship.
  reassign: {
    label: (o) => 'redeploy a worker',
    cost: () => NO_COST,
    check: (state, o) => {
      const a = state.crew.assignments.find((x) => x.id === o.assignmentId);
      if (!a) return no('gone');
      if (a.kind === 'assault') return no('away on a sabotage mission');
      if (o.kind === 'man') {
        const target = state.towers.find((t) => t.id === o.targetId) || state.buildings.find((b) => b.id === o.targetId);
        if (!target) return no('gone');
      }
      if ((o.kind === 'clear' || o.kind === 'garrison') && o.target) {
        const free = canWorkTile(state, o.target, o.assignmentId);
        if (!free.ok) return free;
      }
      // this worker's own walk, not the crew's reach: a body cut off out on the
      // island can be standing beside ground the rest of the company can get to
      const to = o.kind === 'man'
        ? jobPlace(state, { kind: 'man', target: o.targetId }, memberById(state, a.who))
        : o.target;
      if (to && !Number.isFinite(travelTurnsFor(state, a.who, to, crewGroundAtResolve(state)))) {
        return no('no way to walk there from where they stand');
      }
      return ok;
    },
    apply: (state, o, events, held) => {
      const a = state.crew.assignments.find((x) => x.id === o.assignmentId);
      a.kind = o.kind;
      a.target = o.kind === 'man' ? o.targetId : o.target;
      // the new walk starts from wherever this one has got to
      const m = memberById(state, a.who);
      a.from = m ? { q: m.q, r: m.r } : a.from;
      a.leftOn = state.turn;
      const turns = travelTurnsFor(state, a.who, jobPlace(state, a, m), held);
      a.arrivesOnTurn = state.turn + (Number.isFinite(turns) ? turns : 0);
      recomputeCapBonus(state);
    },
  },

  buildTower: {
    label: (o, state) => `build ${C.TOWERS[o.towerIndex].name}`
      + (o.tier ? ` at tier ${o.tier}` : '') + ` on ${tileLabel(state, o)}`,
    cost: () => C.TOWER_COST,
    check: (state, o) => B.canBuildTower(state, o.q, o.r, o.towerIndex, o.tier),
    apply: (state, o, events) => {
      const t = B.buildTower(state, o.q, o.r, o.towerIndex, o.tier);
      events.push({ kind: 'built', what: C.TOWERS[o.towerIndex].name, id: t.id, q: o.q, r: o.r });
    },
  },

  fitItem: {
    label: (o) => `fit a tier-${o.tier} item`,
    cost: () => NO_COST,
    check: (state, o) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      if (!tower) return no('gone');
      return B.canFitItem(state, tower, o.tier);
    },
    apply: (state, o, events) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      const displaced = B.fitItem(state, tower, o.tier);
      events.push({ kind: 'fitted', tier: o.tier, displaced, id: tower.id });
      addLog(state, `${C.TOWERS[tower.towerIndex].name} rises to tier ${tower.tier}`);
    },
  },

  // The tier a tower was built at is otherwise the tier it dies at: a fitting
  // above tier 1 only exists by merging, and merging happens on the shelf. This
  // is that same merge with the gun's own fitting as one of the two — see
  // `build.canMergeIntoTower`.
  mergeIntoTower: {
    label: (o, state) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      return `merge a tier-${o.tier} fitting into ${tower ? C.TOWERS[tower.towerIndex].name : 'a tower'}`;
    },
    cost: () => NO_COST,
    check: (state, o) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      if (!tower) return no('gone');
      return B.canMergeIntoTower(state, tower, o.tier);
    },
    apply: (state, o, events) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      const work = B.startTowerMerge(state, tower, o.tier);
      events.push({ kind: 'towerMerging', id: tower.id, what: C.TOWERS[tower.towerIndex].name, tier: work.toTier, turns: work.turnsLeft });
      addLog(state, `${C.TOWERS[tower.towerIndex].name} at (${tower.q},${tower.r}) is being raised to tier ${work.toTier}`
        + ` — ${work.turnsLeft} turns, and it fires throughout`);
    },
  },

  // The house equivalent of taking a gun down. Queued rather than instant, like
  // every other thing done to a building: the crew have to walk out of it and
  // the ground has to come free, and both belong to the resolve.
  demolishBuilding: {
    label: (o, state) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      return `pull down ${b ? b.name : 'a building'}`;
    },
    cost: () => NO_COST,
    gain: (state, o) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      return b ? B.demolishRefund(b) : NO_COST;
    },
    check: (state, o) => B.canDemolish(state, state.buildings.find((x) => x.id === o.buildingId)),
    apply: (state, o, events) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      if (!b) return;
      const name = b.name;
      const refund = B.demolishBuilding(state, b);
      events.push({ kind: 'demolished', what: name, q: b.q, r: b.r, refund });
      addLog(state, `${name} at (${b.q},${b.r}) is pulled down — ${
        Object.entries(refund).map(([k, v]) => `${v} ${k}`).join(', ')} back`);
    },
  },

  disassembleTower: {
    label: () => 'disassemble a tower',
    cost: () => NO_COST,
    check: (state, o) => (state.towers.some((t) => t.id === o.towerId) ? ok : no('gone')),
    apply: (state, o, events) => {
      const tower = state.towers.find((t) => t.id === o.towerId);
      const refund = B.disassembleTower(state, tower);
      events.push({ kind: 'disassembled', refund });
    },
  },

  evolve: {
    label: () => 'evolve two towers',
    cost: () => NO_COST,
    check: (state, o) => {
      const a = state.towers.find((t) => t.id === o.towerId);
      const b = state.towers.find((t) => t.id === o.partnerId);
      if (!a || !b) return no('gone');
      return B.canEvolve(state, a, b);
    },
    apply: (state, o, events) => {
      const a = state.towers.find((t) => t.id === o.towerId);
      const b = state.towers.find((t) => t.id === o.partnerId);
      const name = `${C.TOWERS[a.towerIndex].name} + ${C.TOWERS[b.towerIndex].name}`;
      B.evolveTower(state, a, b);
      events.push({ kind: 'evolved', name, id: a.id });
      addLog(state, `${name} evolves`);
    },
  },

  // Neither route is open on the beach. A fitting has one house that supplies
  // it and no other — gold ones off the Peculiar Merchant, iron ones out of the
  // Workshop — so the hold is filled by first standing the house up.
  buyItem: {
    label: (o) => `buy a ${C.itemName(o.tower)}`,
    cost: (state) => ({ gold: B.itemBuyCost(state) }),
    check: (state, o) => {
      if (!C.TOWERS[o.tower]) return no('no such fitting');
      if (C.itemSource(o.tower) !== 'gold') return no(`a ${C.itemName(o.tower)} is crafted, not bought`);
      if (!hasBuilding(state, 'merchant')) return no('needs a manned Peculiar Merchant');
      return holdFree(state) > 0 ? ok : no('the hold is full');
    },
    apply: (state, o, events) => { B.addItem(state, o.tower, 1); events.push({ kind: 'item', how: 'bought', tower: o.tower }); },
  },

  craftItem: {
    label: (o) => `craft a ${C.itemName(o.tower)}`,
    cost: (state) => ({ iron: B.itemCraftCost(state) }),
    check: (state, o) => {
      if (!C.TOWERS[o.tower]) return no('no such fitting');
      if (C.itemSource(o.tower) !== 'iron') return no(`nobody makes a ${C.itemName(o.tower)} — it is bought`);
      if (!hasBuilding(state, 'workshop')) return no('needs a manned Workshop');
      return holdFree(state) > 0 ? ok : no('the hold is full');
    },
    apply: (state, o, events) => { B.addItem(state, o.tower, 1); events.push({ kind: 'item', how: 'crafted', tower: o.tower }); },
  },

  mergeItems: {
    label: (o) => `merge two tier-${o.tier} ${C.itemName(o.tower)}s`,
    cost: () => NO_COST,
    check: (state, o) => B.canMerge(state, o.tower, o.tier),
    apply: (state, o, events) => {
      B.mergeItems(state, o.tower, o.tier);
      events.push({ kind: 'merged-item', tower: o.tower, tier: o.tier + 1 });
    },
  },

  buildBuilding: {
    label: (o, state) => `build a ${C.buildingDef(o.building).name} on ${tileLabel(state, o)}`,
    cost: (state, o) => C.buildingCost(o.building),
    check: (state, o) => B.canBuildBuilding(state, o.building, o.q, o.r),
    apply: (state, o, events) => {
      const b = B.buildBuilding(state, o.building, o.q, o.r);
      events.push({ kind: 'built', what: b.name, id: b.id, q: o.q, r: o.r });
    },
  },

  repairBuilding: {
    label: (o, state) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      if (!b) return 'rebuild a ruin';
      return b.ruined ? `rebuild ${b.name}` : `repair ${b.name} — ${B.damagePoints(b)} points`;
    },
    cost: (state, o) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      return b ? B.buildingRepairCost(b) : {};
    },
    check: (state, o) => B.canRepairBuilding(state, o.buildingId),
    apply: (state, o, events) => {
      const ruin = state.buildings.find((x) => x.id === o.buildingId)?.ruined;
      const b = B.repairBuilding(state, o.buildingId);
      events.push({ kind: ruin ? 'rebuilt' : 'repaired', what: b.name });
    },
  },

  upgradeCrew: {
    label: (o, state) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      return `upgrade ${b ? b.name : 'a building'} — one hand fewer`;
    },
    cost: () => ({ gold: C.CREW_UPGRADE_GOLD }),
    check: (state, o) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      if (!b) return no('gone');
      if (b.ruined) return no('rebuild it first');
      if (b.upgraded) return no('already upgraded');
      if (handsNeededFor(state, b) <= 0) return no('it already runs on nobody');
      return ok;
    },
    apply: (state, o, events) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      b.upgraded = true;
      // whoever is now surplus to the smaller crew walks out
      const need = handsNeededFor(state, b);
      const mine = state.crew.assignments.filter((a) => a.kind === 'man' && a.target === b.id);
      for (const a of mine.slice(need)) {
        state.crew.assignments = state.crew.assignments.filter((x) => x.id !== a.id);
      }
      events.push({ kind: 'upgraded', what: b.name, need });
    },
  },

  buildBridge: {
    label: (o, state) => `bridge ${tileLabel(state, o)}`,
    cost: () => ({ wood: C.BRIDGE_COST_WOOD }),
    check: (state, o) => {
      const can = B.canBuildBridge(state, o.q, o.r);
      return can.ok ? canWorkTile(state, o) : can;
    },
    apply: (state, o, events) => {
      B.buildBridge(state, o.q, o.r);
      events.push({ kind: 'built', what: 'a bridge', q: o.q, r: o.r });
    },
  },

  fireFlare: {
    label: () => 'fire a flare',
    cost: (state) => B.flareCost(state),
    check: (state) => B.canFireFlare(state),
    apply: (state, o, events) => {
      B.fireFlare(state);
      events.push({ kind: 'flare', lands: state.turn + B.flareDelay(state) });
      addLog(state, `a flare goes up — ${C.FLARE_HANDS} hands land in ${B.flareDelay(state)} turns`);
    },
  },

  repairHull: {
    label: (o) => `repair ${o.points} hull`,
    cost: (state, o) => B.repairCost(o.points),
    check: (state, o) => (o.points > 0 && o.points <= B.repairable(state) ? ok : no('nothing to repair')),
    apply: (state, o, events) => {
      state.base.hull = Math.min(C.HULL_MAX, state.base.hull + o.points);
      events.push({ kind: 'repair', points: o.points, hull: state.base.hull });
    },
  },

  scheduleAssault: {
    label: (o) => 'send a Bug Sabotage mission',
    cost: () => NO_COST,
    hands: (o, state) => (state ? A.assaultHands(state, o.leader) : C.ASSAULT_HANDS) - (o.leader ? 1 : 0),
    check: (state, o) => A.canSchedule(state, o.spawnerId, o.leader),
    apply: (state, o, events) => {
      const a = A.schedule(state, o.spawnerId, o.leader);
      events.push({ kind: 'assaultScheduled', id: a.id });
    },
  },
};

// ---- queue -----------------------------------------------------------------

export const costOf = (state, order) => ORDERS[order.type].cost(state, order) || NO_COST;
export const gainOf = (state, order) =>
  (ORDERS[order.type].gain ? ORDERS[order.type].gain(state, order) : NO_COST) || NO_COST;

/**
 * What is left to spend once everything already queued is paid for.
 *
 * Costs only. What the queued work *earns* is deliberately not counted here:
 * `applyQueue` runs before `runLabour`, so a tower queued behind a clear order
 * cannot be paid for out of that tile's timber, and letting it look affordable
 * would only earn a refusal at the resolve.
 */
export function projectedRes(state) {
  const p = { ...state.res };
  for (const o of state.orders) {
    for (const [k, v] of Object.entries(costOf(state, o))) p[k] -= v;
  }
  return p;
}

/**
 * What the run holds once the queued work has actually been done — costs paid
 * and every queued tile, wreck and chest brought in. Some of it lands turns
 * from now, because the worker has to walk there first.
 */
export function projectedAfterWork(state) {
  const p = projectedRes(state);
  for (const o of state.orders) {
    for (const [k, v] of Object.entries(gainOf(state, o))) p[k] += v;
  }
  return p;
}

/**
 * What the coming resolve will actually pay out.
 *
 * Not the same number as `projectedAfterWork`, and the difference is the whole
 * point of putting it in the bar: a forest face queued this turn is three turns
 * of cutting away, so its wood is not income the player can spend on the next
 * screen. This counts only what lands when End Turn is pressed — the faces
 * whose last turn of work falls on this pass, and the wrecks and chests
 * somebody is already standing on.
 *
 * It reads the same rules the resolve does: the walk has to be over, the batch
 * is levelled to its furthest face, and a tile nobody reaches this turn pays
 * nothing.
 */
export function incomeNextTurn(state) {
  const out = { wood: 0, stone: 0, iron: 0, gold: 0 };
  const bump = (res, n) => { if (n) out[res] = (out[res] || 0) + n; };

  // The projection, not the raw assignments: a face somebody is two turns into
  // pays nothing if the queue has already pulled them off it, and reading the
  // assignments directly quoted those tiles as income they never brought in.
  const tasks = projectedAssignments(state);
  // Over the ground the crew will be standing on once this turn resolves, not
  // where they are standing now — the same ground the resolve routes over. Ask
  // it of the present and every job past the frontier has no route: no body to
  // do it, an infinite walk to reach it, and so no income. A gang pointed along
  // a line of forest was quoted one face's wood for six faces' work.
  const held = crewGroundAtResolve(state);
  const { byOrder } = projectedCrew(state, held);
  const typeOf = new Map(state.orders.map((o) => [o.id, o.type]));

  // whose hands are on each job, and the walk still in front of them
  const body = (a) => (a.queued ? byOrder.get(a.id) || (isHand(a.who) ? null : a.who) : a.who);
  const walkOf = new Map();
  for (const a of tasks) {
    if (a.kind === 'clear' && !a.queued && !walkOf.has(a.who)) {
      walkOf.set(a.who, Math.max(0, a.arrivesOnTurn - state.turn));
    }
  }
  const arrivesOn = (a, who) => {
    if (!a.queued) return a.arrivesOnTurn;
    // a labour officer's extra faces ride the walk his first one is on; a
    // reassigned worker sets out again from wherever they have got to
    const batched = typeOf.get(a.id) === 'assignClear' && walkOf.has(a.who);
    if (batched) return state.turn + walkOf.get(a.who);
    const turns = travelTurnsFor(state, who, a.target, held);
    if (typeOf.get(a.id) === 'assignClear' && !isHand(a.who)) walkOf.set(a.who, turns);
    return state.turn + turns;
  };

  const faces = new Map();      // tile key -> the work it carries into the pass
  const prizes = new Set();     // tiles a worker will stand on and empty
  for (const a of tasks) {
    if (a.kind !== 'clear' && a.kind !== 'feature') continue;
    const who = body(a);
    if (!who || arrivesOn(a, who) > state.turn) continue;
    const t = tileAt(state, a.target.q, a.target.r);
    if (!t) continue;
    if (a.kind === 'clear') {
      if (!isClearable(state, t)) continue;
      faces.set(key(t.q, t.r), { tile: t, work: t.work || 0, gang: who });
    } else if (t.feature && !t.featureWorked && !isClearable(state, t)) {
      prizes.add(t);
    }
  }

  // one batch is one job, so its faces come in together — the levelling the
  // resolve does has to be read here too, or a joining face is quoted a turn late
  const level = new Map();
  for (const f of faces.values()) level.set(f.gang, Math.max(level.get(f.gang) ?? 0, f.work));
  for (const f of faces.values()) {
    if (Math.max(f.work, level.get(f.gang)) + 1 < C.turnsToClear(f.tile.terrain)) continue;
    for (const [res, n] of Object.entries(C.TERRAIN[f.tile.terrain].yield)) bump(res, n);
  }

  // a wreck or a chest pays the turn the worker reaches it — nothing is banked
  // on it, one turn of standing there is the whole job
  for (const t of prizes) {
    if (t.feature === 'wreck') {
      const haul = haulOf(C.FEATURES.wreck);
      for (const res of Object.keys(haul)) bump(res, haul[res]);
    }
    if (t.feature === 'cache') bump('gold', C.FEATURES.cache.gold);
  }
  return out;
}

/**
 * Every worker's task once the queue has run — standing assignments with the
 * pending orders folded in. One projection serves the crew list, the map
 * overlay and every "is this tile already spoken for" question.
 */
export function projectedAssignments(state) {
  const out = state.crew.assignments.map((a) => ({ ...a, queued: false }));
  const drop = (id) => {
    const i = out.findIndex((a) => a.id === id);
    return i >= 0 ? out.splice(i, 1)[0] : null;
  };
  for (const o of state.orders) {
    switch (o.type) {
      case 'assignClear':
        out.push({ id: o.id, kind: 'clear', who: o.who, target: o.target, queued: true });
        break;
      case 'assignGarrison':
        out.push({ id: o.id, kind: 'garrison', who: o.who, target: o.target, queued: true });
        break;
      case 'workFeature':
        out.push({ id: o.id, kind: 'feature', who: o.who, target: o.target, queued: true });
        break;
      case 'assignMan':
        out.push({ id: o.id, kind: 'man', who: o.who, target: o.targetId, queued: true });
        break;
      case 'reassign': {
        const gone = drop(o.assignmentId);
        if (gone) {
          out.push({
            id: o.id, kind: o.kind, who: gone.who, queued: true,
            target: o.kind === 'man' ? o.targetId : o.target,
          });
        }
        break;
      }
      case 'scheduleAssault':
        if (o.leader) out.push({ id: o.id, kind: 'assault', who: o.leader, target: o.spawnerId, queued: true });
        break;
      default: break;
    }
  }
  return out;
}

/**
 * Which body each queued order will actually take, and who is left over.
 *
 * The queue is applied in order and `assign` takes the nearest free body at the
 * moment each order runs — so the second "a hand" order in a queue does not get
 * the same hand as the first. The panel did not know that: it offered the
 * nearest idle hand for every tile you opened, quoting his walk each time, and
 * the resolve then sent someone else entirely from further away. Two orders,
 * one hand, two promises that could not both be kept.
 *
 * This is the register the panel and the resolve now share. It walks the queue
 * in the same order, with the same choice rule, marking each body as spoken for
 * as it goes — so what the panel quotes is what the turn does.
 */
export function projectedCrew(state, held) {
  const taken = new Set(state.crew.assignments.map((a) => a.who));
  const byOrder = new Map();
  // `'hand'` is the only token that means "whichever hand is nearest". An order
  // that names a body — which auto-clear's do — is that body's, and the panel
  // has to say so: `assign` resolves it the same way, and the two disagreeing
  // put one man's name in the queue and sent another.
  const poolFor = (who) => state.crew.members.filter((m) => !taken.has(m.id)
    && (who === 'hand' ? m.kind === 'hand' : m.id === who));

  // A labour officer's extra faces are the same body, not a second one. He is
  // spoken for the moment his first face is queued, so the register had nobody
  // left to hand the other two to and left them unassigned — which read as a
  // nameless row in the queue panel, and mattered far more than that once
  // `crewGroundAtResolve` started asking who was going where: a face with no
  // worker holds no ground, so the third tile of a line the Pioneer was plainly
  // going to cut answered "no way to walk there".
  const faces = new Map();
  const elsewhere = new Set();
  for (const a of state.crew.assignments) {
    if (a.kind === 'clear') faces.set(a.who, (faces.get(a.who) || 0) + 1);
    else elsewhere.add(a.who);
  }
  const batchTakes = (o) => {
    if (o.type !== 'assignClear' || isHand(o.who) || elsewhere.has(o.who)) return false;
    const n = faces.get(o.who) || 0;
    return n > 0 && n < clearCapacity(state, o.who) && !!memberById(state, o.who);
  };

  for (const o of state.orders) {
    if (o.type === 'reassign') continue;            // the same body, a new job
    let at = null;
    if (o.type === 'assignClear' || o.type === 'assignGarrison' || o.type === 'workFeature') {
      at = o.target;
    } else if (o.type === 'assignMan') {
      at = jobPlace(state, { kind: 'man', target: o.targetId });
    } else continue;
    if (batchTakes(o)) {
      faces.set(o.who, faces.get(o.who) + 1);
      byOrder.set(o.id, o.who);
      continue;
    }
    const m = pickNearest(state, poolFor(o.who), at, held);
    if (!m) continue;
    taken.add(m.id);
    byOrder.set(o.id, m.id);
    if (o.type === 'assignClear') faces.set(m.id, (faces.get(m.id) || 0) + 1);
  }
  return { byOrder, taken };
}

/**
 * Every job once the queue has run, with each one named to the body that will
 * actually do it — and everyone the queue has not spoken for.
 *
 * `projectedAssignments` carries an order's `who` verbatim, and for the common
 * "put a hand on it" order that is the literal string `hand`: nobody. So a
 * panel that asked it who was busy learned nothing about the hands the queue
 * was about to take, and listed all of them as standing about — five free in
 * the crew panel against the bar's one spare, with four of the five named
 * against orders in the queue beside it. `projectedCrew` already works out
 * which body each order takes, in the same order and by the same rule as the
 * resolve; this is that answer folded back into the roster, so the table and
 * the count come off one list and cannot disagree.
 *
 * An order with nobody left to take it keeps its `hand`, which is the honest
 * answer and matches no member.
 */
export function projectedRoster(state) {
  const { byOrder } = projectedCrew(state, crewGroundAtResolve(state));
  const tasks = projectedAssignments(state).map((a) => {
    const body = a.queued ? byOrder.get(a.id) : a.who;
    return body && body !== a.who ? { ...a, who: body } : a;
  });
  return { tasks, busy: new Set(tasks.map((a) => a.who)) };
}

/** Officers with nothing to do once the queue has run. */
export function projectedIdleOfficers(state) {
  const busy = new Set(projectedAssignments(state).map((a) => a.who));
  return state.crew.officers.filter((o) => !busy.has(o.id));
}

/** Who is working, or about to work, this tile. */
export function workersOn(state, p) {
  return projectedAssignments(state).filter(
    (a) => a.target && a.target.q === p.q && a.target.r === p.r,
  );
}

/** Idle hands left once everything already queued has taken its crew. */
export function projectedHands(state) {
  let free = idleHands(state);
  for (const o of state.orders) {
    const h = ORDERS[o.type].hands;
    if (h) free -= h(o, state);
  }
  return free;
}

/**
 * The hold and each tower's fitted tier as they will stand once the queue has
 * run. Without this a queued merge stays legal for ever, because the items it
 * consumes are still sitting in the hold.
 */
export function projectedItems(state) {
  const hold = state.base.hold.map((it) => ({ ...it }));
  const towerTier = new Map(state.towers.map((t) => [t.id, t.itemTier]));
  const towerKind = new Map(state.towers.map((t) => [t.id, t.towerIndex]));
  const take = (tower, tier) => {
    const i = hold.findIndex((it) => it.tower === tower && it.tier === tier);
    if (i >= 0) { hold.splice(i, 1); return true; }
    return false;
  };
  const has = (tower, tier) => hold.some((it) => it.tower === tower && it.tier === tier);
  const count = (tower, tier) => hold.filter((it) => it.tower === tower && it.tier === tier).length;
  // The tier a new emplacement would take, over the projected hold rather than
  // the real one: queue two towers of a kind and the second is quoted the
  // fitting the first one leaves behind, not the one it is about to spend.
  const lowest = (tower) => hold.reduce((low, it) =>
    (it.tower === tower && (!low || it.tier < low) ? it.tier : low), 0);
  for (const o of state.orders) {
    switch (o.type) {
      case 'buyItem': case 'craftItem': hold.push({ tower: o.tower, tier: 1 }); break;
      case 'buildTower':
        // the tier the order names, or the cheapest of its kind if it names none
        if (C.TOWER_NEEDS_ITEM) take(o.towerIndex, o.tier ?? lowest(o.towerIndex));
        break;
      case 'mergeItems':
        take(o.tower, o.tier); take(o.tower, o.tier);
        hold.push({ tower: o.tower, tier: o.tier + 1 });
        break;
      case 'fitItem': {
        const kind = towerKind.get(o.towerId);
        take(kind, o.tier);
        const prev = towerTier.get(o.towerId) || 0;
        if (prev > 0) hold.push({ tower: kind, tier: prev });
        towerTier.set(o.towerId, o.tier);
        break;
      }
      // The fitting leaves the hold when the work starts; the tower's own tier
      // does not move for another two turns, so `towerTier` is left alone.
      case 'mergeIntoTower':
        take(towerKind.get(o.towerId), o.tier);
        break;
      case 'disassembleTower': {
        const kind = towerKind.get(o.towerId);
        const prev = towerTier.get(o.towerId) || 0;
        if (prev > 0) hold.push({ tower: kind, tier: prev });
        towerTier.delete(o.towerId);
        break;
      }
      default: break;
    }
  }
  return { hold, towerTier, towerKind, has, count, lowest };
}

function checkAgainstQueue(state, order) {
  const { hold, towerTier, towerKind, has, count, lowest } = projectedItems(state);
  const cap = holdCap(state);
  switch (order.type) {
    case 'buyItem': case 'craftItem':
      return hold.length < cap ? ok : no('the hold is full');
    case 'mergeItems':
      return count(order.tower, order.tier) >= 2 ? ok : no('needs two of that fitting and tier');
    case 'fitItem': {
      const kind = towerKind.get(order.towerId);
      if (kind === undefined) return no('gone');
      if (!has(kind, order.tier)) return no(`no tier-${order.tier} ${C.itemName(kind)} in the hold`);
      const cur = towerTier.get(order.towerId);
      if (cur > 0 && order.tier <= cur) return no('not a higher tier');
      return ok;
    }
    case 'buildTower': {
      if (!C.TOWER_NEEDS_ITEM) return ok;
      if (order.tier === undefined) {
        return lowest(order.towerIndex) ? ok : no(`needs a ${C.itemName(order.towerIndex)} in the hold`);
      }
      // A named tier is a named item: two towers queued at tier 4 want two
      // tier-4 fittings, and the second is refused if only one was ever held.
      return has(order.towerIndex, order.tier)
        ? ok : no(`no tier-${order.tier} ${C.itemName(order.towerIndex)} in the hold`);
    }
    case 'mergeIntoTower': {
      const kind = towerKind.get(order.towerId);
      if (kind === undefined) return no('already queued for removal');
      if (state.orders.some((o) => o.type === 'mergeIntoTower' && o.towerId === order.towerId)) {
        return no('already queued to be raised');
      }
      // Against the tier the gun will be holding once the queue has run: a
      // fitting queued into it this turn changes which tier there is a twin of.
      const cur = towerTier.get(order.towerId);
      if (cur !== order.tier) return no(`its fitting will be tier ${cur}`);
      // A fitting queued to be fitted or spent elsewhere is not in the hold to
      // be merged, which is the whole point of asking the projection.
      return has(kind, order.tier) ? ok : no(`no tier-${order.tier} ${C.itemName(kind)} in the hold`);
    }
    case 'disassembleTower': case 'evolve':
      return towerTier.has(order.towerId) ? ok : no('already queued for removal');
    case 'assignMan': {
      // A job has as many places as it has places. Everyone already on it
      // counts, queued or standing, or the same building takes a crew twice.
      const tower = state.towers.find((t) => t.id === order.targetId);
      const b = state.buildings.find((x) => x.id === order.targetId);
      const need = tower ? towerManning(state, tower).need : b ? handsNeededFor(state, b) : 0;
      if (b && state.orders.some((o) => o.type === 'demolishBuilding' && o.buildingId === b.id)) {
        return no('it is queued to be pulled down');
      }
      if (b && b.ruined) return no('a ruin has nothing to man');
      if (need <= 0) return no(b ? 'it runs on nobody' : 'it needs nobody');
      const on = projectedAssignments(state).filter((a) => a.kind === 'man' && a.target === order.targetId).length;
      return on < need ? ok : no(`${on}/${need} already on it`);
    }
    case 'upgradeCrew':
      if (state.orders.some((o) => o.type === 'demolishBuilding' && o.buildingId === order.buildingId)) {
        return no('it is queued to be pulled down');
      }
      return state.orders.some((o) => o.type === 'upgradeCrew' && o.buildingId === order.buildingId)
        ? no('already queued') : ok;
    // Nothing else is worth doing to a house that is coming down this turn, and
    // pulling one down twice would pay for it twice.
    case 'demolishBuilding':
      return state.orders.some((o) => o.type === 'demolishBuilding' && o.buildingId === order.buildingId)
        ? no('already queued') : ok;
    // One repair puts the whole building back, so a second is a second price for
    // nothing. The queue is where that is caught: the damage is still on the
    // building until the turn ends, so the check alone would let it through.
    case 'repairBuilding':
      if (state.orders.some((o) => o.type === 'demolishBuilding' && o.buildingId === order.buildingId)) {
        return no('it is queued to be pulled down');
      }
      return state.orders.some((o) => o.type === 'repairBuilding' && o.buildingId === order.buildingId)
        ? no('already queued') : ok;
    default:
      return ok;
  }
}

/**
 * Everything an order is asked except the ground it names: the queue, the
 * stores, the hold, the bodies.
 *
 * Split out because a catalogue has no tile to offer. The gunnery shelf lists
 * eight towers before the player has picked anywhere to put one, and the only
 * honest thing a row can grey itself out for at that point is a price it cannot
 * meet or a fitting it does not hold. Whether *this* hex will take it is
 * answered by the outline that follows the cursor afterwards.
 */
export function canOrderAnywhere(state, order) {
  const def = ORDERS[order.type];
  if (!def) return no('no such order');
  return checkResources(state, order);
}

export function canEnqueue(state, order) {
  const def = ORDERS[order.type];
  if (!def) return no('no such order');
  const check = def.check(state, order);
  if (!check.ok) return check;
  return checkResources(state, order);
}

function checkResources(state, order) {
  const def = ORDERS[order.type];
  const queued = checkAgainstQueue(state, order);
  if (!queued.ok) return queued;
  const cost = def.cost(state, order) || NO_COST;
  const have = projectedRes(state);
  for (const [k, v] of Object.entries(cost)) {
    if (have[k] < v) return no(`needs ${v} ${k}`);
  }
  if (def.hands) {
    const need = def.hands(order, state);
    if (need > 0 && projectedHands(state) < need) return no('no idle hands');
  }
  if (order.who && order.who !== 'hand') {
    const officer = officerById(state, order.who);
    const mine = projectedAssignments(state).filter((a) => a.who === order.who);
    const clears = mine.filter((a) => a.kind === 'clear');
    const cap = clearCapacity(state, order.who);
    if (order.type === 'assignClear' && clears.length === mine.length && cap > 1) {
      // a labour officer works several faces at once, and they must touch
      if (clears.length >= cap) return no(`${officer.name} works ${cap} faces at once, and has ${cap}`);
      if (clears.length && !clears.some((a) => distance(a.target, order.target) === 1)) {
        return no(`must touch a tile ${officer.name} is already clearing`);
      }
      // and be the same ground. The batch is one job at one rate: a face of
      // scrub is a turn and a face of forest is three, so mixing them would
      // hand him the shrub for nothing on the back of the trees.
      const held = tileAt(state, clears[0]?.target.q, clears[0]?.target.r);
      const want = tileAt(state, order.target.q, order.target.r);
      if (held && want && held.terrain !== want.terrain) {
        return no(`${officer.name} works one kind of ground at a time — ${C.TERRAIN_NAME[held.terrain] ?? held.terrain}`);
      }
    } else if (mine.length) {
      return no('that officer is already ordered');
    }
  }
  return ok;
}

export function enqueue(state, order) {
  const check = canEnqueue(state, order);
  if (!check.ok) return check;
  state.orders.push({ ...order, id: nextId(state, 'or') });
  return ok;
}

export function revoke(state, id) {
  const i = state.orders.findIndex((o) => o.id === id);
  if (i < 0) return;
  const [gone] = state.orders.splice(i, 1);
  // Taking back a job nobody asked for is how a player says they did not want it
  // asked for. The standing order goes with it — otherwise the same tile is
  // queued again at the top of the next turn and the only way out is to keep
  // revoking it.
  if (gone.auto && gone.who) stopAutoClear(state, gone.who, 'the order was taken back');
}

/**
 * Turn one body's auto-clear off, and say so.
 *
 * The log line matters: a setting the player never touched has just changed
 * itself, and a switch that moves without saying so is a bug as far as anyone
 * watching is concerned.
 */
function stopAutoClear(state, who, why) {
  if (!autoClearOn(state, who)) return;
  setAutoClear(state, who, false);
  addLog(state, `${crewName(state, who)} is off auto-clear — ${why}`);
}

/**
 * Standing orders, run at the top of the player's turn.
 *
 * Anyone with auto-clear on and nothing to do takes the nearest tile that can be
 * cut. Nearest by walk, not by crow's flight: the order is enqueued the way any
 * other is, so it is refused for the same reasons — no way to walk there, the
 * tile already spoken for — and the next candidate is tried instead.
 *
 * Orders, not assignments. What comes out of this is a queue the player can read
 * and take back before the turn ends, which is the whole contract of the queue:
 * nothing happens to the island that was not visible first.
 *
 * `only` narrows it to one body: the tick going on mid-turn is a standing order
 * starting now rather than next turn, and a man standing about with the box
 * ticked in front of the player is the plainest case there is. Narrow, because
 * ticking one body should put that body to work and nobody else.
 */
export function autoClearOrders(state, only = null) {
  const put = [];
  // Labour officers pick first. The Pioneer wants a run of three touching faces
  // of one ground; a hand who has taken the middle of the only such run leaves
  // him nothing that shape, and he ends up on a single face while fourteen
  // hands each hold one. Capacity descending, roster order within it.
  const queue = [...state.crew.members]
    .sort((a, b) => clearCapacity(state, b.id) - clearCapacity(state, a.id));
  for (const m of queue) {
    if (!m.autoClear || (only && m.id !== only)) continue;
    if (projectedRoster(state).busy.has(m.id)) continue;
    const mine = autoClearBatch(state, m);
    for (const t of mine) put.push({ who: m.id, q: t.q, r: t.r });
  }
  if (put.length) {
    const bodies = new Set(put.map((p) => p.who)).size;
    addLog(state, only
      ? `${crewName(state, only)} is on auto-clear, and clears the nearest `
        + `${put.length === 1 ? 'tile' : `${put.length} tiles`}`
      : `auto-clear puts ${bodies} of the crew back to work`);
  }
  return put;
}

/**
 * One body's share of the frontier: the nearest face they can take, and — for a
 * labour officer, who cuts several at once — the rest of a batch grown out from
 * it.
 *
 * The batch is grown the way the queue would take it by hand — same ground,
 * touching — because those are the rules `checkAgainstQueue` already holds an
 * officer's faces to: one job at one rate, cut in step, paid for with one walk.
 * Asking for anything else would only be refused. It is also what the map offers
 * under the pointer, so auto-clear takes what could have been clicked and
 * nothing more. If the blob runs out before his capacity does, he takes what
 * there was: a thin frontier is a real answer.
 */
function autoClearBatch(state, m) {
  const took = [];
  const cap = clearCapacity(state, m.id);
  const offer = (t) => {
    const order = { type: 'assignClear', who: m.id, target: { q: t.q, r: t.r }, auto: true };
    if (!canEnqueue(state, order).ok) return false;
    return enqueue(state, order).ok;
  };
  // `workableTiles` drops what the queue has already taken, so neither this body
  // nor the next is offered the same tile twice.
  const pool = workableTiles(state).sort((a, b) => distance(m, a) - distance(m, b));
  for (const t of bestBatch(pool, cap)) {
    if (offer(t)) took.push(t);
  }
  // The plan was drawn before any of it was queued, so a tile can still be
  // refused under him — a body walking to it, a face taken in the same pass. A
  // worker with nothing is worse than a worker with the wrong tile: try the
  // rest of the frontier for anything at all.
  if (!took.length) {
    for (const t of pool.slice(0, AUTO_CLEAR_TRIES)) {
      if (offer(t)) { took.push(t); break; }
    }
  }
  return took;
}

/**
 * The nearest run of faces one body could take in a single batch.
 *
 * The seed is not simply the nearest tile. A nearest tile with nothing of its
 * own kind beside it is a batch of one, and the Master Pioneer standing on one
 * face is two thirds of him wasted — so each of the nearest few is tried as a
 * seed, the blob it could grow is measured, and the first that fills his
 * capacity wins. Nothing fills it: the largest blob going is taken instead,
 * which is the honest answer on a frontier that has no run of three in it.
 *
 * Measured before anything is queued, so this is a plan rather than a sequence
 * of orders — cheap to throw away, and cheap to try a dozen of.
 */
function bestBatch(pool, cap) {
  if (cap <= 1) return pool.slice(0, 1);
  let best = [];
  for (const seed of pool.slice(0, AUTO_CLEAR_TRIES)) {
    const blob = [seed];
    while (blob.length < cap) {
      // `pool` is sorted nearest-first, so this takes the nearest legal face
      const next = pool.find((t) => !blob.includes(t) && t.terrain === seed.terrain
        && blob.some((b) => distance(b, t) === 1));
      if (!next) break;
      blob.push(next);
    }
    if (blob.length > best.length) best = blob;
    if (best.length >= cap) break;
  }
  return best;
}

// How many of the nearest faces are tried before a body is left standing. The
// frontier is sorted by distance, so the first is nearly always the one; the
// rest are for the case where the closest few are unreachable or taken.
const AUTO_CLEAR_TRIES = 12;

// ---- standing down ---------------------------------------------------------
// The other thing that is not an order. The queue exists to hold back what
// changes the world, so that any of it can be taken back before the turn ends;
// taking a worker off a job changes nothing out there at all. It moves nobody —
// they go on standing exactly where the job left them — it costs nothing, and
// there is no state of the world in which it can fail.
//
// Queued, it was three separate pieces of make-believe: `handFreed` crediting a
// hand back to `projectedHands`, a case in `projectedAssignments` that dropped
// the row again, and a branch in `projectedCrew` that un-took the body. Each
// one existed to describe a release that had not happened yet, and each was a
// place the panels could disagree with the resolve about who was free. Doing it
// now instead deletes all three, and the answer they were approximating — the
// body is loose, put them somewhere else this phase — is simply the truth.
//
// And because nobody walks, the release is its own undo: a worker stood down
// off a house is still standing on the house, so manning it again is a job with
// no walk in it (see `jobPlace`).

/** Take a worker off their job, now. */
export function standDown(state, assignmentId) {
  const a = state.crew.assignments.find((x) => x.id === assignmentId);
  if (!a) return no('gone');
  // The one job that cannot be called off: the team is away over the island
  // with the powder, and there is nobody here to stand down.
  if (a.kind === 'assault') return no('away on a sabotage mission');
  // Same as revoking the order it came from: taking a body off work nobody
  // asked for is the player saying to stop putting them on it.
  if (a.auto) stopAutoClear(state, a.who, 'the work was called off');
  dropAssignment(state, a.id);
  recomputeCapBonus(state);
  addLog(state, `${crewName(state, a.who)} stands down`);
  return ok;
}

// ---- the counter -----------------------------------------------------------
// The other one, and for the same reason. Goods over a counter are handed
// across and paid for on the spot: there is nothing in a trade for a resolve to
// carry out, so making it wait for one would only be a rule about waiting. It
// costs no turn and no body.
//
// It lives in this file and not in build.js because the hard half is the queue.
// The stores in the bar are already spent down by everything queued against
// them, and selling wood a queued Workshop is counting on would leave the
// resolve unable to pay for its own order — so what is on the counter is
// `projectedRes`, not `state.res`.

/** What a trade of `amount` comes to, in whole gold. `null` for goods the dock does not deal in. */
export function tradeQuote(state, res, dir, amount) {
  if (!C.TRADE[res]) return null;
  const n = Math.floor(Number(amount));
  if (!Number.isFinite(n)) return null;
  return { res, dir, amount: n, gold: dir === 'sell' ? C.tradeSell(res, n) : C.tradeBuy(res, n) };
}

/** The most of a good there is to sell: what the queue has not already spent. */
export function tradeMost(state, res) {
  return Math.max(0, Math.floor(projectedRes(state)[res] || 0));
}

export function canTrade(state, { res, dir, amount }) {
  if (!C.TRADE[res]) return no('the dock does not deal in that');
  if (dir !== 'sell' && dir !== 'buy') return no('sold or bought, nothing else');
  if (!hasBuilding(state, 'dock')) return no('needs a manned Trading Dock');
  const n = Number(amount);
  if (!Number.isInteger(n) || n <= 0) return no('a whole amount, one or more');
  const have = projectedRes(state);
  const q = tradeQuote(state, res, dir, n);
  if (dir === 'sell') {
    if ((have[res] || 0) < n) return no(`only ${Math.max(0, have[res] || 0)} ${res} free of the queue`);
    // Whole gold, and the dock does not round up for you: a handful of wood is
    // not worth a coin, and saying so is better than taking it for nothing.
    if (q.gold < 1) return no(`${n} ${res} is not worth a whole gold`);
  } else if (have.gold < q.gold) {
    return no(`needs ${q.gold} gold`);
  }
  return ok;
}

/** Strike the trade. Instant: the stores move now, and nothing is queued. */
export function trade(state, order) {
  const check = canTrade(state, order);
  if (!check.ok) return check;
  const { res, dir } = order;
  const q = tradeQuote(state, res, dir, Number(order.amount));
  if (dir === 'sell') {
    state.res[res] -= q.amount;
    state.res.gold += q.gold;
    state.stats.goldEarned += q.gold;
    addLog(state, `${q.amount} ${res} goes over the dock's counter for ${q.gold} gold`);
  } else {
    state.res.gold -= q.gold;
    state.res[res] += q.amount;
    addLog(state, `${q.gold} gold over the dock's counter buys ${q.amount} ${res}`);
  }
  return { ...ok, gold: q.gold, amount: q.amount };
}

export const describe = (state, order) => ORDERS[order.type].label(order, state);

/** Step 1 of the resolve. Anything no longer legal is dropped, not charged. */
export function applyQueue(state, events) {
  const queue = state.orders;
  // The ground the crew will be standing on, worked out while the queue is
  // still here to be read — and then handed to every order in it.
  //
  // Without this the check and the resolve disagreed about the same queue. The
  // check asks the question of the whole queue at once and is therefore
  // order-blind: three faces in a line are all legal however they were clicked,
  // because between them the crew will have opened the way. `applyQueue` empties
  // `state.orders` before it applies any of them, so an order looking at the
  // queue from inside the resolve sees only what has already been applied — and
  // a face whose way in was opened by an order later in the list was refused
  // with "nobody free to take it". Eighty-six of them in a hundred and twenty
  // turns of the reference policy, every one a body standing idle for a turn.
  const held = crewGroundAtResolve(state);
  state.orders = [];
  for (const order of queue) {
    const def = ORDERS[order.type];
    const check = def.check(state, order);
    const cost = def.cost(state, order) || NO_COST;
    const affordable = Object.entries(cost).every(([k, v]) => state.res[k] >= v);
    if (!check.ok || !affordable) {
      const why = check.ok ? 'not enough left to pay for it' : check.why;
      events.push({ kind: 'refused', order, why });
      addLog(state, `order refused — ${describe(state, order)}: ${why}`);
      continue;
    }
    B.spend(state, cost);
    def.apply(state, order, events, held);
  }
}
