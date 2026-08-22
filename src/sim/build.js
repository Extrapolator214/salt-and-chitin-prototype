// Towers, items, economic buildings, bridges, flares.
// Every function here answers "can this be done" as {ok, why} so the UI can
// grey a row out and say why, and "do it" as a mutation used by orders.js.

import C from './config.js';
import { key, distance, neighbours, spiral } from './hex.js';
import {
  tileAt, isBuildable, touchMap, addLog, nextId, holdFree, hasBuilding,
  buildingsOfType, towerManning, officerById, officerFor, shipNetwork,
  walkableForWork,
} from './state.js';

const ok = { ok: true };
const no = (why) => ({ ok: false, why });

// ---- costs -----------------------------------------------------------------

export function itemDiscount(state) {
  const wm = officerFor(state, 'item');
  return wm ? 1 - C.WEAPONS_MASTER_DISCOUNT * wm.quality : 1;
}
/** A tier-n item is worth 2^(n-1) tier-1 items. Only tier 1 is ever sold. */
export const itemWorth = (tier) => Math.pow(2, tier - 1);
export const itemBuyCost = (state) => Math.ceil(C.ITEM_BUY_GOLD * itemDiscount(state));
export const itemCraftCost = (state) => Math.ceil(C.ITEM_CRAFT_IRON * itemDiscount(state));

// ---- the hold --------------------------------------------------------------
// An item is a pair: which tower's fitting it is, and what tier. Items are not
// interchangeable — a Culverin's item does nothing on a Krakenling Well.

export const itemsOf = (state, tower, tier) =>
  state.base.hold.filter((it) => it.tower === tower && (tier === undefined || it.tier === tier));

export const countOf = (state, tower, tier) => itemsOf(state, tower, tier).length;

/**
 * The fitting a new emplacement would take: the lowest tier of its kind held,
 * or 0 for none at all.
 *
 * Lowest, deliberately. A tower is built at the tier of the fitting it takes,
 * so handing it the best one in the hold would spend a tier-4 gun on an
 * emplacement a tier-1 would have raised — and the tier-1 route reaches the
 * same place, because a standing tower rises by having a better fitting put in.
 * Taking the cheapest never costs the player a tier they could have had.
 */
export function buildTier(state, tower) {
  let low = 0;
  for (const it of state.base.hold) {
    if (it.tower !== tower) continue;
    if (!low || it.tier < low) low = it.tier;
  }
  return low;
}

export function takeItem(state, tower, tier) {
  const i = state.base.hold.findIndex((it) => it.tower === tower && it.tier === tier);
  return i >= 0 ? state.base.hold.splice(i, 1)[0] : null;
}

export function flareCost(state) {
  const m = hasBuilding(state, 'powder') ? 1 - C.FLARE_POWDER_DISCOUNT : 1;
  return { wood: Math.round(C.FLARE_COST_WOOD * m), iron: Math.round(C.FLARE_COST_IRON * m) };
}
export const flareDelay = (state) => (hasBuilding(state, 'powder') ? C.FLARE_DELAY_POWDER : C.FLARE_DELAY_TURNS);
export const flareAllowance = (state) => C.FLARE_GATE[C.actOf(state.turn) - 1];

export function canAfford(state, cost, pool = state.res) {
  return Object.entries(cost || {}).every(([k, v]) => pool[k] >= v);
}
export function spend(state, cost) {
  for (const [k, v] of Object.entries(cost || {})) state.res[k] -= v;
}

// ---- footprints ------------------------------------------------------------

/** Is this building one of the economy's, or the Palisade — which is not? */
const isEconomic = (def) => !!def && def.economic !== false;

/**
 * Plots the queue has already spoken for.
 *
 * A queued building is not on the map yet: nothing occupies its tiles and it
 * casts no halo. So the placement ghost drew a second yard green over the first
 * one's footprint, and both orders were legal — until the queue ran, when the
 * second was refused for ground the first had just taken. The queue is a
 * statement of intent about ground as much as about crew, and everything that
 * asks "may a structure stand here" has to read it.
 *
 * Safe to read during the resolve: `applyQueue` empties `state.orders` before
 * it applies any of them, so a building never blocks itself.
 */
function queuedPlots(state) {
  const out = [];
  for (const o of state.orders || []) {
    if (o.type !== 'buildBuilding') continue;
    const def = C.buildingDef(o.building);
    if (!def) continue;
    out.push({ type: o.building, tiles: C.buildingTiles(def.tiles, o.q, o.r) });
  }
  return out;
}

/**
 * The same, for towers. A gun stands on one to three tiles now, so a queued
 * emplacement speaks for ground exactly as a queued yard does — two towers
 * ordered onto overlapping plots in one turn would otherwise both be legal, and
 * the second refused when the queue ran.
 */
function queuedTowerPlots(state) {
  const out = [];
  for (const o of state.orders || []) {
    if (o.type !== 'buildTower') continue;
    out.push({ towerIndex: o.towerIndex, tiles: C.towerTiles(o.towerIndex, o.q, o.r) });
  }
  return out;
}

/** Every tile a queued structure will stand on, tower or yard alike. */
export function claimedTiles(state) {
  const set = new Set();
  for (const p of queuedPlots(state)) for (const t of p.tiles) set.add(key(t.q, t.r));
  for (const p of queuedTowerPlots(state)) for (const t of p.tiles) set.add(key(t.q, t.r));
  return set;
}

/** Yards of this type the queue has already spoken for. */
export function queuedBuildingsOfType(state, type) {
  return queuedPlots(state).filter((p) => p.type === type);
}

/** The ground the ship herself stands on. */
const shipTiles = (state) => state.island?.footprint ?? [{ q: state.base.q, r: state.base.r }];

/** A plot's own tiles plus the ring of ground BUILDING_GAP wide around them. */
function haloOf(tiles, set = new Set()) {
  for (const p of tiles) {
    for (const h of spiral(p, C.BUILDING_GAP)) set.add(key(h.q, h.r));
  }
  return set;
}

/**
 * Every tile an economic building already stands on, plus the ring of ground
 * BUILDING_GAP wide around it. Nothing else economic may be put there, so two
 * yards never share a wall. Any tile does for the gap — road, forest, a stream;
 * what matters is that there is one.
 *
 * The ship is a yard like any other and keeps her gap too. She is the biggest
 * plot on the island and the one everything else crowds towards, so without it
 * the first Workshop goes up against her hull and the cove silts up with
 * buildings — and a wave that reaches the beach is then in among all of them.
 */
function buildingHalo(state) {
  const set = haloOf(shipTiles(state));
  for (const b of state.buildings) {
    if (!isEconomic(C.buildingDef(b.type))) continue;
    haloOf(b.tiles, set);
  }
  // and the ones the queue has spoken for, which will be standing there by the
  // time anything ordered in the same phase goes up
  for (const p of queuedPlots(state)) {
    if (!isEconomic(C.buildingDef(p.type))) continue;
    haloOf(p.tiles, set);
  }
  return set;
}

/**
 * The ground a building's effect would reach, laid on this plot.
 *
 * The union of a ring around every tile of the footprint, not a circle around
 * the anchor — which is what the rule actually says: `handsNeededFor` asks
 * whether *any* tile of a yard is within `BUNKHOUSE_RADIUS` of *any* tile of a
 * Bunkhouse. A three-tile Bunkhouse therefore covers a longer blob than a
 * circle drawn on its middle, and a player shown the circle would be told a
 * yard was out of reach that the rule takes in.
 *
 * Null for a building whose effect does not travel.
 */
export function coverageOf(state, type, tiles) {
  const radius = C.buildingRadius(type);
  if (!radius) return null;
  const set = new Set();
  for (const p of tiles) for (const h of spiral(p, radius)) set.add(key(h.q, h.r));
  return set;
}

/**
 * The yards that ground would take in — the reason to put it where you put it.
 *
 * Asked the same way `handsNeededFor` asks it, so what the outline promises is
 * what the manning rule will do. A ruin is left out: it wants nobody until it
 * is rebuilt, and counting it would flatter the plot.
 */
export function coveredBuildings(state, cover) {
  if (!cover) return [];
  return state.buildings.filter((b) => {
    const def = C.buildingDef(b.type);
    if (def && def.crew === 0) return false;      // a Palisade never wants anyone
    if (b.ruined) return false;
    return b.tiles.some((t) => cover.has(key(t.q, t.r)));
  });
}

/** What a building of this type may stand on, gap rule included. */
export function buildingAllow(state, type) {
  if (!isEconomic(C.buildingDef(type))) return null;
  const halo = buildingHalo(state);
  return (t) => !halo.has(key(t.q, t.r));
}

/**
 * Where a building of this type would stand if it stood here.
 *
 * Its fixed shape, laid on the anchor — never grown to fit. Every tile of the
 * shape is reported with whether the ground will take it, so the outline the
 * player sees is the same silhouette wherever the cursor is, red where the plot
 * will not do rather than quietly reshaped around the obstacle.
 */
export function buildingPlan(state, type, q, r) {
  const def = C.buildingDef(type);
  if (!def) return null;
  const allow = buildingAllow(state, type);
  const claimed = claimedTiles(state);
  return C.buildingTiles(def.tiles, q, r).map((p) => {
    const t = tileAt(state, p.q, p.r);
    const free = !claimed.has(key(p.q, p.r));
    return { q: p.q, r: p.r, ok: !!t && free && isBuildable(state, t, false) && (!allow || allow(t)) };
  });
}

/** The footprint a building of this type would take here, or null if it will not fit. */
export function buildingFootprint(state, type, q, r) {
  const plan = buildingPlan(state, type, q, r);
  if (!plan || plan.some((p) => !p.ok)) return null;
  return plan.map((p) => ({ q: p.q, r: p.r }));
}

function occupy(state, tiles, occupant) {
  for (const p of tiles) {
    const t = tileAt(state, p.q, p.r);
    t.occupant = occupant;
  }
  touchMap(state);
}
function release(state, tiles) {
  for (const p of tiles) {
    const t = tileAt(state, p.q, p.r);
    if (t) t.occupant = null;
  }
  touchMap(state);
}

// ---- towers ----------------------------------------------------------------

/**
 * Where a tower of this kind would stand if it stood here, tile by tile, each
 * one flagged with whether the ground will take it.
 *
 * Its fixed shape, laid on the anchor — the same silhouette wherever the cursor
 * goes, red where the plot will not do rather than quietly reshaped around the
 * obstacle. Exactly a yard's rule, minus the gap: guns may stand shoulder to
 * shoulder, and a battery of them along one lane is a thing worth building.
 */
export function towerPlan(state, q, r, towerIndex) {
  const claimed = claimedTiles(state);
  return C.towerTiles(towerIndex === undefined ? 0 : towerIndex, q, r).map((p) => {
    const t = tileAt(state, p.q, p.r);
    return {
      q: p.q,
      r: p.r,
      ok: !!t && !t.occupant && !claimed.has(key(p.q, p.r)) && isBuildable(state, t, true),
    };
  });
}

/** The ground a tower of this kind would take here, or null if it will not fit. */
export function towerFootprint(state, q, r, towerIndex) {
  const plan = towerPlan(state, q, r, towerIndex);
  return plan.some((p) => !p.ok) ? null : plan.map((p) => ({ q: p.q, r: p.r }));
}

export function canBuildTower(state, q, r, towerIndex, tier) {
  const t = tileAt(state, q, r);
  if (!t) return no('off the map');
  if (t.occupant) return no('occupied');
  if (claimedTiles(state).has(key(q, r))) return no('a structure is queued there');
  if (!isBuildable(state, t, true)) {
    if (t.terrain === 'sand' || t.terrain === 'salt') return no(`no footing on ${t.terrain}`);
    if (t.terrain === 'freshwater') return no('bridge it first');
    if (t.terrain === 'saltwater') return no('saltwater');
    return no('clear it first');
  }
  // The rest of its yard. A tower's shape is settled the day it is raised and
  // never grows again, so the whole of it has to be there before the order is
  // taken rather than found later on.
  const plan = towerPlan(state, q, r, towerIndex);
  const short = plan.filter((p) => !p.ok);
  if (short.length) {
    return no(`its ${plan.length} tiles will not fit here — ${short.length} short`);
  }
  for (const p of plan) {
    for (const sp of state.spawners) {
      if (sp.alive && distance(sp, p) <= C.EXCLUSION_RADIUS) return no(`within ${C.EXCLUSION_RADIUS} of a living spawner`);
    }
  }
  // A tower nobody can reach is a tower nobody can man, and a crag is by nature
  // ringed by ground the crew do not walk. The walk used to fall back to the
  // straight line where no route existed, so a gun could go up on a crag in the
  // middle of standing forest and a hand would step over the trees to work it.
  // Now the ground has to be opened first: some neighbour has to be somewhere
  // the crew can actually get to.
  const reach = walkableForWork(state);
  const own = new Set(plan.map((p) => key(p.q, p.r)));
  const reachable = plan.some((p) => neighbours(p.q, p.r)
    .some((n) => !own.has(key(n.q, n.r)) && reach.has(key(n.q, n.r))));
  if (!reachable) {
    return no('no way to walk to it — open the ground beside it first');
  }
  // The emplacement is wood and stone; the gun is a fitting out of the hold, of
  // this tower's own kind. Which tier goes in decides what the tower is built
  // at — but no longer how much ground it wants. `tier` names one; without it
  // the cheapest of its kind is spent.
  if (C.TOWER_NEEDS_ITEM && towerIndex !== undefined) {
    if (tier === undefined) {
      if (!buildTier(state, towerIndex)) return no(`needs a ${C.itemName(towerIndex)} in the hold`);
    } else if (!countOf(state, towerIndex, tier)) {
      return no(`no tier-${tier} ${C.itemName(towerIndex)} in the hold`);
    }
  }
  return ok;
}

/**
 * Raise a tower here, spending one fitting of its kind out of the hold.
 *
 * `want` names the tier to spend. Left out, the cheapest held is taken — which
 * is the right default and was for a long time the only behaviour: a standing
 * tower rises by having a better fitting put in, so spending the good one on
 * the emplacement never bought a tier the cheap one could not reach. It is a
 * default and not a rule, though. Holding a tier-4 and nothing else pressing to
 * spend it on, a player may want the gun firing at tier 4 today rather than
 * raising it at 1 and fitting it again next turn.
 */
export function buildTower(state, q, r, towerIndex, want) {
  const def = C.TOWERS[towerIndex];
  const held = want !== undefined && countOf(state, towerIndex, want) ? want : buildTier(state, towerIndex);
  const tier = C.TOWER_NEEDS_ITEM ? held || 1 : 1;
  if (C.TOWER_NEEDS_ITEM) takeItem(state, towerIndex, tier);
  const footprint = towerFootprint(state, q, r, towerIndex) || [{ q, r }];
  const tower = {
    id: nextId(state, 'tw'),
    q, r, towerIndex, tier, evolved: false,
    essence: [def.essence], itemTier: C.TOWER_NEEDS_ITEM ? tier : 0,
    footprint,
    complete: false,
  };
  state.towers.push(tower);
  occupy(state, tower.footprint, { kind: 'tower', id: tower.id });
  return tower;
}

/** Fit an item of `tier` in place; the displaced item returns to inventory. */
export function canFitItem(state, tower, tier) {
  if (tower.evolved) return no('evolved towers take no items');
  if (tier <= tower.tier && tower.itemTier > 0) return no('not a higher tier');
  if (tier < 1 || tier > C.MAX_TIER) return no('no such tier');
  if (!countOf(state, tower.towerIndex, tier)) return no(`no tier-${tier} ${C.itemName(tower.towerIndex)} in the hold`);
  return ok;
}

export function fitItem(state, tower, tier) {
  takeItem(state, tower.towerIndex, tier);
  const displaced = tower.itemTier;
  // The emplacement does not change: a better gun goes into the yard that is
  // already there. Only the manning it wants moves with the tier.
  tower.tier = tier;
  tower.itemTier = tier;
  if (displaced > 0) state.base.hold.push({ tower: tower.towerIndex, tier: displaced });
  return displaced;
}

export function disassembleTower(state, tower) {
  release(state, tower.footprint);
  state.towers.splice(state.towers.indexOf(tower), 1);
  state.crew.assignments = state.crew.assignments.filter((a) => !(a.kind === 'man' && a.target === tower.id));
  const refund = {
    wood: Math.floor(C.TOWER_COST.wood * C.DISASSEMBLE_REFUND),
    stone: Math.floor(C.TOWER_COST.stone * C.DISASSEMBLE_REFUND),
  };
  state.res.wood += refund.wood;
  state.res.stone += refund.stone;
  if (tower.itemTier > 0) state.base.hold.push({ tower: tower.towerIndex, tier: tower.itemTier });
  return refund;
}

/** Tower i evolves with i+1 or i+7 (mod 20), never mutually. */
export function evolutionPartners(towerIndex) {
  return C.EVOLUTION_OFFSETS
    .map((o) => (towerIndex + o) % C.EVOLUTION_MOD)
    .filter((i) => i < C.TOWERS.length);
}

export function canEvolve(state, tower, partner) {
  if (!hasBuilding(state, 'tinker')) return no("needs a manned Tinker's Shed");
  if (tower.evolved || partner.evolved) return no('already evolved');
  if (tower.tier < C.MAX_TIER || partner.tier < C.MAX_TIER) return no('both must be tier 5');
  if (!evolutionPartners(tower.towerIndex).includes(partner.towerIndex)) return no('not a legal recipe');
  return ok;
}

export function evolveTower(state, tower, partner) {
  // The partner's ground goes back to the island; the survivor keeps its own
  // shape, which is the shape it was raised on. An evolution is two guns made
  // into one, not a yard extension.
  release(state, partner.footprint);
  state.towers.splice(state.towers.indexOf(partner), 1);
  state.crew.assignments = state.crew.assignments.filter((a) => !(a.kind === 'man' && a.target === partner.id));
  tower.evolved = true;
  tower.essence = [...tower.essence, C.TOWERS[partner.towerIndex].essence];
  return tower;
}

// ---- economic buildings ----------------------------------------------------

export function canBuildBuilding(state, type, q, r) {
  const def = C.buildingDef(type);
  if (!def) return no('no such building');
  if (!def.repeatable) {
    if (buildingsOfType(state, type).length > 0) return no('already built');
    if (queuedPlots(state).some((p) => p.type === type)) return no('already in the queue');
  }
  const plan = buildingPlan(state, type, q, r);
  const short = plan.filter((p) => !p.ok);
  if (short.length) {
    // Say which of the two it is, because they want different answers: one is
    // more clearing, the other is somewhere else entirely.
    const halo = isEconomic(def) ? buildingHalo(state) : null;
    if (halo && short.every((p) => halo.has(key(p.q, p.r)))) {
      const ship = haloOf(shipTiles(state));
      const whose = short.every((p) => ship.has(key(p.q, p.r))) ? 'ship' : 'next building';
      return no(`leave ${C.BUILDING_GAP} tile clear of the ${whose}`);
    }
    return no(`its ${def.tiles} tiles will not fit here — ${short.length} short`);
  }
  const foot = plan.map((p) => ({ q: p.q, r: p.r }));
  if (isEconomic(def)) {
    // What a working building needs beside it is a way for the goods to leave,
    // and that is any open ground joined to the ship — the road you cut, the
    // bridges, or the sand and meadow that were already open. A natural run of
    // open ground is a supply line the island handed you rather than one you
    // paid for; it is also a lane the cohorts march straight up.
    const net = shipNetwork(state);
    const joined = foot.some((p) => neighbours(p.q, p.r).some((n) => net.has(key(n.q, n.r))));
    if (!joined) return no('needs open ground beside it, joined to the ship');
  }
  if (type === 'excavation') {
    const onCache = foot.some((p) => {
      const t = tileAt(state, p.q, p.r);
      return t.feature === 'cache' && !t.featureWorked;
    });
    if (!onCache) return no('must cover an unworked treasure cache');
  }
  return ok;
}

export function buildBuilding(state, type, q, r) {
  const def = C.buildingDef(type);
  const foot = buildingFootprint(state, type, q, r);
  const b = {
    id: nextId(state, 'bd'),
    type, name: def.name,
    q, r,
    tiles: foot,
    upgraded: false,   // the crew upgrade: one hand fewer, bought once
    complete: false,
    progress: 0,
  };
  b.maxHp = C.BUILDING_HP_PER_TILE * def.tiles;
  b.hp = b.maxHp;
  b.ruined = false;
  if (type === 'excavation') {
    const cacheTile = foot.map((p) => tileAt(state, p.q, p.r)).find((t) => t.feature === 'cache' && !t.featureWorked);
    b.cache = { q: cacheTile.q, r: cacheTile.r };
    cacheTile.featureWorked = true; // claimed; the gold pays out over 10 turns
  }
  state.buildings.push(b);
  occupy(state, b.tiles, { kind: 'building', id: b.id });
  return b;
}

/** What putting a ruin back on its feet costs — a fraction of building it new. */
export function rebuildCost(type) {
  const out = {};
  for (const [k, v] of Object.entries(C.buildingCost(type))) out[k] = Math.ceil(v * C.RUIN_REBUILD_FRACTION);
  return out;
}

export function canRepairBuilding(state, id) {
  const b = state.buildings.find((x) => x.id === id);
  if (!b) return no('no such building');
  if (!b.ruined) return no('not a ruin');
  const cost = rebuildCost(b.type);
  if (!canAfford(state, cost)) return no(`needs ${Object.entries(cost).map(([k, v]) => `${v} ${k}`).join(' + ')}`);
  return ok;
}

/** The queue has already paid `rebuildCost` by the time this runs. */
export function repairBuilding(state, id) {
  const b = state.buildings.find((x) => x.id === id);
  b.ruined = false;
  b.hp = b.maxHp;
  b.complete = false; // it stands again at the end of the turn, like any build
  touchMap(state);
  addLog(state, `${b.name} is rebuilt out of its own ruin`);
  return b;
}

/**
 * Take damage off a building. It is never destroyed — at zero it is ruined:
 * still standing, still holding its ground, but doing nothing until it is
 * rebuilt. Returns true on the tick that ruins it.
 */
export function damageBuilding(state, b, amount) {
  if (b.ruined) return false;
  b.hp -= amount;
  if (b.hp > 0) return false;
  b.hp = 0;
  b.ruined = true;
  b.ruinedCount = (b.ruinedCount || 0) + 1; // how many times this ground has been fought over
  // the crew walk out of a ruin; there is nothing there to man
  state.crew.assignments = state.crew.assignments.filter((a) => !(a.kind === 'man' && a.target === b.id));
  touchMap(state);
  return true;
}

// ---- bridges ---------------------------------------------------------------

export function canBuildBridge(state, q, r) {
  const t = tileAt(state, q, r);
  if (!t) return no('off the map');
  if (t.terrain !== 'freshwater') return no('only fresh water can be bridged');
  if (t.bridge) return no('already bridged');
  return ok;
}

export function buildBridge(state, q, r) {
  const t = tileAt(state, q, r);
  t.bridge = true;
  state.bridges.push({ q, r });
  touchMap(state);
  return t;
}

// ---- items -----------------------------------------------------------------

/**
 * What a footprint would take, and whether each tile of it will do. Used to
 * paint the placement outline before the order is given: green where the
 * ground will take a building, red where it will not.
 */
export function footprintPreview(state, q, r, n, forTower = false, type = null) {
  // Both draw their own fixed shape, whether or not the plot will take it — a
  // tower reads `n` as its tower index, a building as its tile count.
  if (forTower) return towerPlan(state, q, r, n);
  return buildingPlan(state, type, q, r) || [];
}

export function addItem(state, tower, tier = 1) {
  if (holdFree(state) <= 0) return false;
  state.base.hold.push({ tower, tier });
  return true;
}

/** Two of the same fitting and the same tier make one of the next tier up. */
export function canMerge(state, tower, tier) {
  if (tier >= C.MAX_TIER) return no(`tier ${C.MAX_TIER} is the ceiling`);
  if (countOf(state, tower, tier) < 2) return no('needs two of that fitting and tier');
  return ok;
}

export function mergeItems(state, tower, tier) {
  takeItem(state, tower, tier);
  takeItem(state, tower, tier);
  state.base.hold.push({ tower, tier: tier + 1 });
}

// ---- flares ----------------------------------------------------------------

export function canFireFlare(state) {
  if (state.crew.flaresFired + state.crew.flaresInFlight.length >= flareAllowance(state)) {
    return no(`act ${'I'.repeat(C.actOf(state.turn))} allows ${flareAllowance(state)}`);
  }
  const since = state.turn - (state.crew.lastFlareTurn ?? -Infinity);
  if (since < C.FLARE_COOLDOWN) {
    return no(`the last boat left ${since} turn${since === 1 ? '' : 's'} ago; ${C.FLARE_COOLDOWN} between them`);
  }
  return ok;
}

export function fireFlare(state) {
  state.crew.flaresInFlight.push({ landsOnTurn: state.turn + flareDelay(state) });
  state.crew.lastFlareTurn = state.turn;
}

// ---- ship ------------------------------------------------------------------

export const repairCost = (points) => ({ wood: points * C.REPAIR_WOOD_PER_HULL });
export const repairable = (state) => C.HULL_MAX - state.base.hull;
