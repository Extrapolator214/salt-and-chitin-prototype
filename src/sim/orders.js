// The order queue: validate, apply, revoke.
// Orders are appended in the player phase and applied only during resolve, so
// anything in the queue can be revoked at no cost.

import C from './config.js';
import { distance, key, parseKey, neighbours, NEIGHBOURS } from './hex.js';
import {
  tileAt, addLog, nextId, idleHands, idleOfficers, officerById, holdFree, holdCap,
  hasBuilding, isBuildingManned, buildingsOfType, walkableForWork, isClearable, memberById,
  handsNeededFor, towerManning, isHand, crewHeld,
} from './state.js';
import * as B from './build.js';
import {
  assign, unassign as dropAssignment, recomputeCapBonus, clearCapacity, levelBatch,
  travelTurnsFor, jobPlace, pickNearest,
} from './labour.js';
import * as A from './assault.js';

const ok = { ok: true };
const no = (why) => ({ ok: false, why });
const NO_COST = {};

/**
 * The hand an order hands back, if any.
 *
 * Standing a worker down frees them, and `projectedHands` has to see it or the
 * next order in the same phase is refused for want of a body the player has
 * just released. Only a hand counts: an officer is not one of the ten, and
 * crediting one for him used to conjure a hand that did not exist.
 */
const handFreed = (state, assignmentId) => {
  const a = state.crew.assignments.find((x) => x.id === assignmentId);
  return a && isHand(a.who) ? -1 : 0;
};

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

/** Every tile the queue has spoken for, so the map can mark them. */
export function queuedTiles(state) {
  const out = [];
  for (const o of state.orders) {
    if (o.target && o.target.q !== undefined) out.push({ q: o.target.q, r: o.target.r, kind: o.type });
    else if (o.q !== undefined) {
      if (o.type === 'buildBuilding') {
        const def = C.buildingDef(o.building);
        for (const p of B.footprintPreview(state, o.q, o.r, def.tiles, false, o.building)) out.push({ q: p.q, r: p.r, kind: o.type });
      } else out.push({ q: o.q, r: o.r, kind: o.type });
    }
  }
  return out;
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
    hands: (o) => (o.who === 'hand' ? 1 : 0),
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
    hands: (o) => (o.who === 'hand' ? 1 : 0),
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
    hands: (o) => (o.who === 'hand' ? 1 : 0),
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
      if (t.feature === 'wreck') return { wood: C.FEATURES.wreck.wood };
      if (t.feature === 'cache') return { gold: C.FEATURES.cache.gold };
      return NO_COST;
    },
    hands: (o) => (o.who === 'hand' ? 1 : 0),
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
    // standing one down is the only redeployment that frees a body
    hands: (o, state) => (o.kind === 'idle' ? handFreed(state, o.assignmentId) : 0),
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
      const to = o.kind === 'man' ? jobPlace(state, { kind: 'man', target: o.targetId }) : o.target;
      if (to && !Number.isFinite(travelTurnsFor(state, a.who, to, crewGroundAtResolve(state)))) {
        return no('no way to walk there from where they stand');
      }
      return ok;
    },
    apply: (state, o, events, held) => {
      const a = state.crew.assignments.find((x) => x.id === o.assignmentId);
      if (o.kind === 'idle') { dropAssignment(state, a.id); recomputeCapBonus(state); return; }
      a.kind = o.kind;
      a.target = o.kind === 'man' ? o.targetId : o.target;
      // the new walk starts from wherever this one has got to
      const m = memberById(state, a.who);
      a.from = m ? { q: m.q, r: m.r } : a.from;
      a.leftOn = state.turn;
      const turns = travelTurnsFor(state, a.who, jobPlace(state, a), held);
      a.arrivesOnTurn = state.turn + (Number.isFinite(turns) ? turns : 0);
      recomputeCapBonus(state);
    },
  },

  unassign: {
    label: () => 'unassign',
    cost: () => NO_COST,
    hands: (o, state) => handFreed(state, o.assignmentId),
    check: (state, o) => (state.crew.assignments.some((a) => a.id === o.assignmentId) ? ok : no('gone')),
    apply: (state, o) => { dropAssignment(state, o.assignmentId); recomputeCapBonus(state); },
  },

  buildTower: {
    label: (o, state) => `build ${C.TOWERS[o.towerIndex].name} on ${tileLabel(state, o)}`,
    cost: () => C.TOWER_COST,
    check: (state, o) => B.canBuildTower(state, o.q, o.r, o.towerIndex),
    apply: (state, o, events) => {
      const t = B.buildTower(state, o.q, o.r, o.towerIndex);
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

  buyItem: {
    label: (o) => `buy a ${C.itemName(o.tower)}`,
    cost: (state) => ({ gold: B.itemBuyCost(state) }),
    check: (state, o) => {
      if (!C.TOWERS[o.tower]) return no('no such fitting');
      return holdFree(state) > 0 ? ok : no('the hold is full');
    },
    apply: (state, o, events) => { B.addItem(state, o.tower, 1); events.push({ kind: 'item', how: 'bought', tower: o.tower }); },
  },

  craftItem: {
    label: (o) => `craft a ${C.itemName(o.tower)}`,
    cost: (state) => ({ iron: B.itemCraftCost(state) }),
    check: (state, o) => {
      if (!C.TOWERS[o.tower]) return no('no such fitting');
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
      return `rebuild ${b ? b.name : 'a ruin'}`;
    },
    cost: (state, o) => {
      const b = state.buildings.find((x) => x.id === o.buildingId);
      return b ? B.rebuildCost(b.type) : {};
    },
    check: (state, o) => B.canRepairBuilding(state, o.buildingId),
    apply: (state, o, events) => {
      const b = B.repairBuilding(state, o.buildingId);
      events.push({ kind: 'rebuilt', what: b.name });
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
    hands: (o, state) => (state ? A.assaultHands(state) : C.ASSAULT_HANDS) - (o.leader ? 1 : 0),
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
    if (t.feature === 'wreck') bump('wood', C.FEATURES.wreck.wood);
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
        if (gone && o.kind !== 'idle') {
          out.push({
            id: o.id, kind: o.kind, who: gone.who, queued: true,
            target: o.kind === 'man' ? o.targetId : o.target,
          });
        }
        break;
      }
      case 'unassign':
        drop(o.assignmentId);
        break;
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
  const poolFor = (who) => state.crew.members.filter((m) => !taken.has(m.id)
    && (isHand(who) ? m.kind === 'hand' : m.id === who));

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
    if (o.type === 'unassign' || (o.type === 'reassign' && o.kind === 'idle')) {
      const a = state.crew.assignments.find((x) => x.id === o.assignmentId);
      if (a) taken.delete(a.who);
      continue;
    }
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
  for (const o of state.orders) {
    switch (o.type) {
      case 'buyItem': case 'craftItem': hold.push({ tower: o.tower, tier: 1 }); break;
      case 'buildTower':
        if (C.TOWER_NEEDS_ITEM) take(o.towerIndex, 1);
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
  return { hold, towerTier, towerKind, has, count };
}

function checkAgainstQueue(state, order) {
  const { hold, towerTier, towerKind, has, count } = projectedItems(state);
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
    case 'buildTower':
      if (!C.TOWER_NEEDS_ITEM) return ok;
      return has(order.towerIndex, 1) ? ok : no(`needs a tier-1 ${C.itemName(order.towerIndex)}`);
    case 'disassembleTower': case 'evolve':
      return towerTier.has(order.towerId) ? ok : no('already queued for removal');
    case 'assignMan': {
      // A job has as many places as it has places. Everyone already on it
      // counts, queued or standing, or the same building takes a crew twice.
      const tower = state.towers.find((t) => t.id === order.targetId);
      const b = state.buildings.find((x) => x.id === order.targetId);
      const need = tower ? towerManning(state, tower).need : b ? handsNeededFor(state, b) : 0;
      if (b && b.ruined) return no('a ruin has nothing to man');
      if (need <= 0) return no(b ? 'it runs on nobody' : 'it needs nobody');
      const on = projectedAssignments(state).filter((a) => a.kind === 'man' && a.target === order.targetId).length;
      return on < need ? ok : no(`${on}/${need} already on it`);
    }
    case 'upgradeCrew':
      return state.orders.some((o) => o.type === 'upgradeCrew' && o.buildingId === order.buildingId)
        ? no('already queued') : ok;
    default:
      return ok;
  }
}

export function canEnqueue(state, order) {
  const def = ORDERS[order.type];
  if (!def) return no('no such order');
  const check = def.check(state, order);
  if (!check.ok) return check;
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
  if (i >= 0) state.orders.splice(i, 1);
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
