// An honest AI player: no free resources, no patched hull, no immortality.
// It plays the game through the same order queue a human uses, and tries to
// win — both spawners dead before turn 300.
//
//   node tests/play.mjs                    # 6 seeds, the reference policy
//   node tests/play.mjs --seeds 12         # more seeds
//   node tests/play.mjs --compare          # every strategy over the same seeds
//   node tests/play.mjs --strategy tiers   # one of them on its own
//   node tests/play.mjs --trace 20260816   # turn-by-turn journal for one seed
//   node tests/play.mjs --jobs 1           # serially, one seed at a time
//
// Seeds are played side by side in child processes — one per core less two —
// so six seeds is under a minute rather than five of them.

import C from '../src/sim/config.js';
import * as H from '../src/sim/hex.js';
import * as St from '../src/sim/state.js';
import * as O from '../src/sim/orders.js';
import * as B from '../src/sim/build.js';
import { evolutionPartners } from '../src/sim/build.js';
import * as A from '../src/sim/assault.js';

import { officerById } from '../src/sim/state.js';
import { networkReaches } from '../src/sim/enemy.js';
import { clearCapacity } from '../src/sim/labour.js';
import { roadRoute, roadFace, driveRoadGang, putCrewOnFrontier, putOfficerOnFrontier, workFeatures } from './route.mjs';
import { resolveTurn, concludeTurn } from '../src/sim/turn.js';
import { skip, finishCombat } from '../src/sim/combat.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

// ---- the turn ---------------------------------------------------------------

/**
 * Has the gang actually driven a road to this spawner? Not the same question as
 * `networkReaches`, which asks whether open ground of any kind joins the ship —
 * and open ground chains: beaches and meadows run right across the island, so
 * a spawner seventy tiles out reads as "reached" before a single tile is cut
 * toward it. That is the right answer for where a cohort walks in and the wrong
 * one for "do I still owe this spawner a road", which is what the gang is asked.
 */
function roadedTo(s, spawner) {
  const seen = new Set();
  const queue = [];
  for (const f of (s.island?.footprint ?? [s.base])) {
    const k = H.key(f.q, f.r);
    seen.add(k);
    queue.push(f);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const n of H.neighbours(queue[head].q, queue[head].r)) {
      const k = H.key(n.q, n.r);
      if (seen.has(k)) continue;
      const t = St.tileAt(s, n.q, n.r);
      if (!St.isRoad(t) || t.occupant?.kind === 'spawner') continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return spawner.footprint.some((f) => H.neighbours(f.q, f.r)
    .some((n) => seen.has(H.key(n.q, n.r))));
}

function playTurn(s) {
  const events = resolveTurn(s);
  if (s.combat) { skip(s); const sum = finishCombat(s); if (sum) events.push(sum); }
  const turn = s.turn;
  concludeTurn(s, events);
  return { events, turn };
}

// ---- helpers ----------------------------------------------------------------

const officers = (s) => s.crew.officers;
const idleOfficer = (s, role) => St.idleOfficers(s).find((o) => o.role === role);
const built = (s, type) => s.buildings.filter((b) => b.type === type);
/** How this kind's fitting is got: crafted at a Workshop, or bought off a Merchant. */
const itemOrder = (kind) => (C.itemSource(kind) === 'iron'
  ? { type: 'craftItem', tower: kind } : { type: 'buyItem', tower: kind });
/** The houses the policy's two tower kinds need standing before a gun can go up. */
/**
 * The evolution partner of the policy's gun, if this build has one on the shelf.
 *
 * Six of the eight kinds are shelved here, and one of the casualties is every
 * legal recipe: the Aviary evolves with the Alligator Guards and with nothing
 * else, and the Guards are not buildable. So the policy has to be able to run a
 * one-kind line — which it now does, because asking for a mate that cannot be
 * bought spent the whole gun budget on orders that were refused.
 */
function mateFor(k) {
  return evolutionPartners(k.towerKind)
    .filter((i) => i < C.TOWERS.length && !C.towerShelved(i))[0];
}
function gunKinds(k) {
  return [k.towerKind, mateFor(k)].filter((i) => i !== undefined);
}
function gunHouses(k) {
  const houses = [...new Set(gunKinds(k).map((i) => C.itemHouse(i)))];
  // Crafting wants iron, and one Forge makes one a turn against a fitting's
  // six. The dock's counter is the way round it: gold the camps dig, over the
  // counter, out as iron. So the dock is part of the gun line's plant.
  if (gunKinds(k).some((i) => C.itemSource(i) === 'iron')) houses.push('dock');
  return houses;
}
const working = (s, type) => s.buildings.some((b) => b.type === type && St.isBuildingManned(s, b));

/** What the counter would charge to make good everything this cost is short of. */
function counterGold(s, cost) {
  let gold = 0;
  for (const res of ['wood', 'stone']) {
    const short = (cost[res] || 0) - s.res[res];
    if (short > 0) gold += C.tradeBuy(res, short);
  }
  return gold;
}

/**
 * Gold that is spoken for, and may not go into fittings.
 *
 * A run is won by killing two spawners and in no other way, and the only door
 * to that is a Sappers' Camp — 380 wood and 260 stone, the dearest yard on the
 * shelf. The policy used to spend every coin the moment it had eight of them,
 * which meant the camp was bought out from under itself by fittings, turn after
 * turn: seed 20260818 sat on a legal site from turn 20 and did not raise the
 * camp until 170, with 2100 gold earned and spent in between.
 *
 * So the camp's price at the counter is taken off the top from the turn it is
 * wanted. Fittings get what is left, which is still most of it — the whole camp
 * is about seventy gold in stone once the dock is open.
 */
function goldSpokenFor(s, k) {
  let held = k.goldReserve;
  if (working(s, 'dock') && !built(s, 'sappers').length && s.turn >= k.sappersFrom) {
    held += counterGold(s, C.buildingCost('sappers')) + k.counterFloor;
  }
  return held;
}

/**
 * The dock's counter, run as a supply line rather than as a market.
 *
 * Stone is the resource the island hands out most slowly and the one every yard
 * asks for: a Sappers' Camp is 260 of it, and the frontier pays 15 a boulder
 * against forest's 9 wood a tile. Left to itself the policy stalls with two
 * thousand wood and eleven stone — which is what it did, on six seeds out of
 * six, dying with the Sappers' Camp still unaffordable at turn 85.
 *
 * The counter settles it, and cheaply: 12 stone for 2 gold, and a single dug
 * chest is 220 gold. So the rule is to buy exactly what the next yard on the
 * wish list is short of and nothing on top — a stockpile bought speculatively
 * is gold not in a fitting, and the fittings are what hold the wave.
 */
function stockUp(s, k, wish) {
  if (!working(s, 'dock')) return;
  const want = { wood: 0, stone: 0 };
  // The next two things wanted — and the Sappers' Camp wherever it stands in
  // the list, because it is the one yard the run cannot be won without and it
  // is dear enough to never be "the next thing" on its own.
  const heads = wish.slice(0, 2);
  const camp = wish.find((w) => w.b === 'sappers');
  if (camp && !heads.includes(camp)) heads.push(camp);
  for (const w of heads) {
    const cost = w.tower ? C.TOWER_COST : (C.buildingCost(w.b) || {});
    want.wood = Math.max(want.wood, cost.wood || 0);
    want.stone = Math.max(want.stone, cost.stone || 0);
  }
  for (const res of ['stone', 'wood']) {
    const short = want[res] - s.res[res];
    if (short <= 0) continue;
    if (s.res.gold - C.tradeBuy(res, short) < k.counterFloor) continue;
    O.trade(s, { res, dir: 'buy', amount: short });
  }
  // A boat is the only way the crew ever grows, and its iron is the only reason
  // the Forge was ever on the list: 40 iron a flare against a Forge's one a
  // turn. Over the counter that is eighty gold — a third of one chest — so the
  // smelter is not a prerequisite for the crew any more, the counter is.
  const cost = B.flareCost(s);
  const left = B.flareAllowance(s) - (s.crew.flaresFired + s.crew.flaresInFlight.length);
  const ironShort = (cost.iron || 0) - s.res.iron;
  if (left > 0 && ironShort > 0 && s.res.wood >= (cost.wood || 0)
    && s.res.gold - C.tradeBuy('iron', ironShort) >= k.counterFloor) {
    O.trade(s, { res: 'iron', dir: 'buy', amount: ironShort });
  }
}

/**
 * Manning slots standing empty, worth filling, most valuable first.
 * A tier-1 tower is 1 dps — a hand is worth more cutting ground than behind
 * it — so emplacements only get crew once an item has made them a weapon.
 */
function shortfall(s, minTier) {
  const out = [];
  for (const b of s.buildings) {
    if (!b.complete || b.ruined) continue;
    const need = St.handsNeededFor(s, b) - St.assignmentsFor(s, b.id).length;
    for (let i = 0; i < need; i++) out.push(b.id);
  }
  for (const t of s.towers.slice().sort((a, b) => b.tier - a.tier)) {
    if (!t.complete || (t.tier < minTier && !t.evolved)) continue;
    const need = C.manningFor(t.tier, t.evolved) - St.assignmentsFor(s, t.id).length;
    for (let i = 0; i < need; i++) out.push(t.id);
  }
  return out;
}

/**
 * Fill those slots. Idle hands first; then take diggers off the face, because
 * an unmanned gun in a wave is worth nothing at all.
 */
function crewUp(s, minTier, diggerFloor, route) {
  const onRoute = new Set((route || []).map((p) => `${p.q},${p.r}`));
  let pulled = 0;
  for (const id of shortfall(s, minTier)) {
    if (O.enqueue(s, { type: 'assignMan', who: 'hand', targetId: id }).ok) continue;
    if (St.crewClearing(s) - pulled <= diggerFloor) break;
    const digger = s.crew.assignments.find((a) => a.kind === 'clear' && St.isHand(a.who) &&
      !onRoute.has(`${a.target.q},${a.target.r}`) &&
      !s.orders.some((o) => o.assignmentId === a.id));
    if (!digger) break;
    if (O.enqueue(s, { type: 'reassign', assignmentId: digger.id, kind: 'man', targetId: id }).ok) pulled++;
  }
}

/**
 * Network tiles the swarm could enter on but could not then walk to the hull
 * from — with `extra` treated as though a structure already stood on it.
 *
 * The two rules do not agree, and the gap is a trap. The ship's network is open
 * ground joined to the ship and does not care what is standing on it, so a road
 * with a gun on it is still network and still an entry. The resolve asks a
 * stricter question — `isPassable(.., 'assault')`, which a tower's or a yard's
 * tile fails — and when it cannot answer, `beginCombat` falls back to a path one
 * tile long. A cohort on a one-tile path is already at the end of its walk: it
 * arrives at the hull the instant the resolve opens, having passed nothing that
 * could shoot at it.
 *
 * That is what killed the reference policy on half its seeds. Four guns and
 * five yards ringing the landing sealed every open approach, and from then on
 * every wave took a hundred hull off in one resolve, unopposed. It is a bug in
 * the build (see README), but it is also a thing a player can walk into, so the
 * policy is taught to keep a lane open rather than to rely on it being fixed.
 */
function sealedEntries(s, extra = []) {
  const blocked = new Set(extra.map((t) => H.key(t.q, t.r)));
  const seen = new Set();
  const queue = [];
  for (const f of (s.island?.footprint ?? [s.base])) {
    const kk = H.key(f.q, f.r);
    seen.add(kk);
    queue.push(f);
  }
  for (let head = 0; head < queue.length; head++) {
    for (const n of H.neighbours(queue[head].q, queue[head].r)) {
      const kk = H.key(n.q, n.r);
      if (seen.has(kk) || blocked.has(kk)) continue;
      const tile = St.tileAt(s, n.q, n.r);
      if (!tile || !St.isCrewGround(s, tile) || !St.isPassable(s, tile, 'assault')) continue;
      seen.add(kk);
      queue.push(tile);
    }
  }
  let sealed = 0;
  for (const kk of St.shipNetwork(s)) {
    if (seen.has(kk) || blocked.has(kk)) continue;
    const [q, r] = kk.split(',').map(Number);
    const tile = St.tileAt(s, q, r);
    if (!tile || !St.isPassable(s, tile, 'assault')) continue; // already built on
    sealed++;
  }
  return sealed;
}

/** Would putting a structure on these tiles cut more of the map off from the hull? */
function keepsLaneOpen(s, tiles) {
  return sealedEntries(s, tiles) <= sealedEntries(s);
}

/** A spot for a building of this type, as close to the ship as it will go. */
function buildingSpot(s, type) {
  for (let d = 1; d < C.ISLAND_RADIUS; d++) {
    for (const h of H.ring(s.base, d)) {
      if (!B.canBuildBuilding(s, type, h.q, h.r).ok) continue;
      if (s.orders.some((o) => o.q === h.q && o.r === h.r)) continue;
      if (!keepsLaneOpen(s, C.buildingTiles(C.buildingDef(type).tiles, h.q, h.r))) continue;
      return h;
    }
  }
  return null;
}

/**
 * Clear a yard for a building that has nowhere to stand.
 *
 * A building is 4-6 tiles now, it needs road beside it, and it may not touch
 * the next one — so the ground for one no longer appears by accident along a
 * road the crew happened to cut. This picks the nearest site beside the road
 * that could become legal and puts hands on the tiles it is still short of.
 * Returns true if it put anyone to work.
 */
function clearPad(s, type, hands = 3) {
  const def = C.buildingDef(type);
  if (!def) return false;
  const net = St.shipNetwork(s);
  const allow = B.buildingAllow(s, type);
  const usable = (t) => !!t && !t.occupant && (t.cleared || St.isClearable(s, t)) && (!allow || allow(t));
  let best = null;
  for (let d = 1; d < C.ISLAND_RADIUS && !best; d++) {
    for (const h of H.ring(s.base, d)) {
      const anchor = St.tileAt(s, h.q, h.r);
      if (!usable(anchor)) continue;
      if (!H.neighbours(h.q, h.r).some((n) => net.has(H.key(n.q, n.r)))) continue;
      // A building has one shape and it is not negotiable, so the yard to cut is
      // that shape laid on this anchor — not whatever blob happens to grow.
      const foot = C.buildingTiles(def.tiles, h.q, h.r).map((p) => St.tileAt(s, p.q, p.r));
      if (!foot.every(usable)) continue;
      const short = foot.filter((t) => !t.cleared);
      if (!short.length) continue; // it is already legal; buildingSpot will find it
      best = short;
      break;
    }
  }
  if (!best) return false;
  let put = 0;
  for (const t of best) {
    if (put >= hands) break;
    if (O.workersOn(s, t).length) continue;
    if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: t.q, r: t.r } }).ok) put++;
  }
  return put > 0;
}

/**
 * Cut a yard for a gun that has nowhere to stand — `clearPad`, for towers.
 *
 * A gun's shape is settled the day it goes up and the whole of it has to be
 * open, so the wide kinds are the ones this is for: a Culverin Battery wants
 * two tiles and an Aviary three, and beside a one-tile road neither of them has
 * a second tile until somebody cuts one.
 */
function clearGunPad(s, radius, kinds, hands = 3) {
  for (const kind of kinds) {
    const spot = towerSpot(s, radius, kind, true);
    if (!spot) continue;
    const short = (gunShape(s, spot, kind, true) || []).filter((t) => !St.isBuildable(s, t, true));
    if (!short.length) continue;   // it is already legal; towerSpot will find it
    let put = 0;
    for (const t of short) {
      if (put >= hands) break;
      if (O.workersOn(s, t).length) continue;
      if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: t.q, r: t.r } }).ok) put++;
    }
    if (put > 0) return true;
  }
  return false;
}

/** An Excavation Camp has to cover an unworked cache; find one it can reach. */
function campSpot(s) {
  const caches = [...s.map.tiles.values()]
    .filter((t) => t.feature === 'cache' && !t.featureWorked)
    .sort((a, b) => H.distance(a, s.base) - H.distance(b, s.base));
  for (const cache of caches) {
    for (const h of H.spiral(cache, 1)) {
      if (!B.canBuildBuilding(s, 'excavation', h.q, h.r).ok) continue;
      if (s.orders.some((o) => o.q === h.q && o.r === h.r)) continue;
      return h;
    }
  }
  return null;
}

/**
 * Every tile of a gun's shape laid on `h`, or null if the ground cannot be it.
 *
 * `mayCut` is the difference between "a gun can go here now" and "a gun could
 * go here once the crew have been at it": a two- or three-tile battery no longer
 * finds its yard by accident along a road, so the policy has to be able to ask
 * the second question and then cut for the answer.
 */
function gunShape(s, h, towerIndex, mayCut) {
  const out = [];
  for (const p of C.towerTiles(towerIndex, h.q, h.r)) {
    const t = St.tileAt(s, p.q, p.r);
    if (!t || t.occupant) return null;
    if (St.isBuildable(s, t, true)) { out.push(t); continue; }
    if (!mayCut || !St.isClearable(s, t)) return null;
    out.push(t);
  }
  return out;
}

/**
 * Where a gun earns its keep. Ranges are short now, so a ring around the ship
 * is decoration — what matters is covering the road the units actually walk in
 * on. Score every site whose whole shape the ground will take by how much of
 * the entry road falls inside its range, and take the best.
 */
function towerSpot(s, radius, towerIndex, mayCut = false, avoid = []) {
  const net = [...St.shipNetwork(s)].map((k) => {
    const [q, r] = k.split(',').map(Number);
    return { q, r };
  });
  if (!net.length) return null;
  const range = C.TOWERS[towerIndex] ? C.TOWERS[towerIndex].range : C.TOWERS[1].range;
  let best = null, bestScore = -1;
  for (let d = 1; d <= radius + 6; d++) {
    for (const h of H.ring(s.base, d)) {
      if (mayCut) {
        if (!gunShape(s, h, towerIndex, true)) continue;
      } else if (!B.canBuildTower(s, h.q, h.r, towerIndex).ok) continue;
      if (s.orders.some((o) => o.q === h.q && o.r === h.r)) continue;
      if (avoid.includes(H.key(h.q, h.r))) continue;
      if (s.towers.some((t) => H.distance(t, h) < 2)) continue;
      // road tiles this gun would cover, weighted towards the ship: the last
      // stretch before the hull is the stretch that has to be held
      let score = 0;
      for (const p of net) {
        const dd = H.distance(p, h);
        if (dd > range) continue;
        score += 1 / (1 + H.distance(p, s.base) * 0.08);
      }
      if (score > bestScore) { bestScore = score; best = h; }
    }
  }
  // The best arc is worth nothing on the tile that seals the last lane in, so
  // that one candidate is checked against the walk the swarm has to have.
  if (best && !keepsLaneOpen(s, C.towerTiles(towerIndex, best.q, best.r))) {
    if (avoid.length >= 6) return null;   // the whole landing is walled; build nothing here
    return towerSpot(s, radius, towerIndex, mayCut, [...avoid, H.key(best.q, best.r)]);
  }
  return best;
}

// ---- the policy -------------------------------------------------------------

const DEFAULTS = {
  towerRing: 4,        // how far out the gun line sits
  // Every tower takes its own fitting, so a gun line of one kind concentrates
  // the money instead of splitting it eight ways. 4 is the Parrot Swarm Aviary:
  // range 3, four targets at once, and its fitting is a Parrot Cage — bought
  // off the Peculiar Merchant for 8 gold and made by nobody.
  //
  // That price is the whole reason it is the reference line. Gold arrives long
  // before anything else does — a chest is 220 for one hand's turn, and there
  // are twelve of them — so sixteen cages is 128 gold, which is one chest and a
  // half, which is a tier-5 gun. The Culverin's range-4 arc is the better gun
  // and the line was built on it for a year; its fitting is six iron, and iron
  // comes a tile at a time, so the arc arrives in act 2 and the waves do not
  // wait. Reach beats coverage only if you live to fit it.
  towerKind: 4,
  // Four guns, every one of them tier 5, and the fittings never split between
  // more emplacements than the gold will carry. Five was the old number, from
  // when a tower was the cheap half of a gun; it is the fitting that is dear.
  maxTowers: 6,
  mateShare: 1,        // how many of the four are the evolution partner
  tinkerFrom: Math.round(C.TURNS_PER_ACT * 0.6), // the Tinker's Shed is act-2 work
  camps: 0,            // Excavation Camps: dead content — a hand digs a cache in
                       // one turn for the same 220 the camp takes ten to pay
  forge: false,        // the seams are faster than the smelter; see `mineIron`
  // Both are fractions of an act, not turns: the clock was cut to a third when
  // the session target came down to an hour, and a policy with turn 15 and turn
  // 20 written into it was answering a question about a 300-turn run.
  sappersFrom: Math.round(C.TURNS_PER_ACT * 0.15), // start thinking about the offensive
  digRoadFrom: Math.round(C.TURNS_PER_ACT * 0.20), // start driving a road at the first spawner
  // Both of these used to be counts, from when the crew started at ten and
  // ended at forty. It starts at three now and grows a boat at a time, so a
  // "gang of six" was an order for twice the company: they are shares of
  // whoever is actually ashore, floored so that there is always somebody on the
  // road and somebody on the frontier.
  gangShare: 0.4,      // of the crew, held for the road face
  diggerShare: 0.25,   // of the crew, never taken off the frontier to man a gun
  manFromTier: 2,      // fittings are dear now, so a tier-2 gun is worth a hand
  goldReserve: 0,      // gold held back from the unmanning upgrade
  repairBelow: 70,
  repairReserve: 250,  // wood kept back when repairing
  // Gold kept out of the counter's hands: what is left after a stone order is
  // what buys fittings, and a gun with no fitting is a yard with no gun.
  counterFloor: 60,
  // The Trading Dock is off the reference line. Its counter sells 12 stone for
  // 2 gold, which makes every yard on the shelf free the moment one chest is
  // dug — a price the designer calls broken and does not play, so a policy that
  // leans on it is measuring the bug rather than the game. The code that trades
  // over it is kept (`stockUp` fires only when a dock is manned, and none is),
  // so the `dock` strategy below can still be pointed at it deliberately.
  dockEarly: false,
  warehouseEarly: true, // an unlimited hold is what makes a tier-5 fitting one turn's work
  tierFirst: true,     // merge every stack up rather than saving tier-1s for new guns
  powderEarly: true,   // the Powder Store in act 1: a boat a quarter off, and in one turn
  flareFirst: false,   // never spend wood the next flare is going to need
  mineIron: true,      // cut the iron seams first, wherever they are on the frontier
  quarry: true,        // and the stone, when the next yard on the list wants stone
  poiFirst: true,      // cut the ground over chests and wrecks first — that is the gold
  features: 8,         // bodies sent to work a point of interest in one turn
};

/**
 * Five ways to play the same game.
 *
 * `optimal` is the reference policy — the one the gate runs, tuned over the
 * sweep. The other four each take one of its levers and lean on it to the
 * exclusion of the others, which is the point: what they measure is not whether
 * a lever is good but whether the game rewards specialising in it. A strategy
 * that wins as often as the reference on a fifth of the moving parts is telling
 * you the rest of the parts are decoration.
 */
const STRATEGIES = {
  optimal: {},

  // The line the harness ran for a year: the Culverin Battery's range-4 arc,
  // its fitting crafted at a Workshop out of iron, five guns rather than four.
  // Kept as a strategy because it is a fair question — the arc really is the
  // better gun — and it answers it: the fitting arrives too late.
  culverin: {
    towerKind: 1, maxTowers: 5, mateShare: 2, forge: true,
  },

  // The counter, played for what it is worth: 12 stone for 2 gold, iron at 2
  // gold a bar, every yard on the shelf paid for out of one chest. It wins, and
  // that is the finding — the dock's prices are the loosest numbers in the
  // build, and this is how much win rate they are worth.
  dock: {
    dockEarly: true,
  },

  // Fewer guns, every one of them as high as it will go, and the Tinker's Shed
  // early because an evolution is 97.7 power against a tier-5's 39.1.
  tiers: {
    maxTowers: 2, mateShare: 1, tinkerFrom: Math.round(C.TURNS_PER_ACT * 0.3), manFromTier: 3,
  },

  // The frontier rather than the buried gold: no chest-first rule, three bodies
  // on a point of interest instead of eight, and the crew cutting whatever face
  // is nearest. What it measures is how much of the run the twelve caches are.
  frontier: {
    poiFirst: false, features: 3,
  },

  // Hands are the one resource the island cannot make. A flare is 300 wood and
  // 40 iron, a quarter off with a Powder Store, and it is the only way past a
  // crew of ten — so no wood is ever spent below the price of the next boat.
  flare: {
    flareFirst: true, forge: true, maxTowers: 3,
  },
};

function policy(s, k, m) {
  const gold = s.res.gold;

  // --- 0 · a flare is the only way the crew ever grows. Fire on sight.
  O.enqueue(s, { type: 'fireFlare' });

  // --- 1 · keep the hull up. Losing it loses the run outright.
  if (s.base.hull < k.repairBelow && s.res.wood > k.repairReserve) {
    const afford = Math.floor((s.res.wood - k.repairReserve) / C.REPAIR_WOOD_PER_HULL);
    const pts = Math.min(B.repairable(s), afford);
    if (pts > 0) O.enqueue(s, { type: 'repairHull', points: pts });
  }

  // --- 2 · the build order. One wish list, take the first thing affordable.
  //     Gold is the whole early defence: a chest pays 220 gold, a tier-5 tower
  //     is 39 dps against a tier-1's 1, and gold buys guns as fast as the
  //     chests come in — once the Merchant that sells them is standing.
  // Ten hands is the entire budget until a flare lands, so the list is short
  // and every entry has to earn its crew. A Bunkhouse first: it halves the
  // manning on everything near it, which is worth more than any single gun.
  const camps = built(s, 'excavation').length;
  const wish = [];
  // Everything below is pushed through this: a yard this build has shelved is
  // an order that will be refused, and a wish list full of refusals is a policy
  // that never builds anything. It used to open every run by asking for a
  // Bunkhouse, which is shelved, and then stop.
  const push = (w) => { if (w.tower || !C.buildingShelved(w.b)) wish.push(w); };
  if (!built(s, 'bunkhouse').length) push({ b: 'bunkhouse' });
  // The Trading Dock, before anything it is not the prerequisite for. It is not
  // the surplus that makes it worth the second slot on the list — it is the
  // counter: stone at 12 for 2 gold turns the run's one scarce resource into
  // the one the island is covered in, and every yard after it goes up on
  // schedule instead of when a boulder happens to fall on the frontier.
  // The house that supplies the gun line's fitting, before the gun line: a
  // fitting is crafted at a Workshop or bought off a Peculiar Merchant and got
  // nowhere else, so without it every tower below is an order that is refused.
  //
  // Ahead of the dock, and that is the whole of the early game: gold arrives
  // long before there is anything to spend it on — 670 of it by turn 20 on the
  // chests alone — and until this house is standing it simply piles up while
  // the waves walk in past three empty emplacements.
  for (const house of gunHouses(k)) if (!built(s, house).length) push({ b: house });
  // The Warehouse, before the guns rather than after them. Five hold slots is
  // not a stockpile limit, it is a *merge* limit: two fittings of a tier make
  // one of the next, so sixteen tier-1s make one tier-5 — and sixteen will not
  // fit in five slots, which is how the hold used to jam at four odd tiers with
  // no legal merge and no room to buy the pair that would unjam it. With the
  // hold unlimited the whole ladder is one turn's work: buy sixteen at eight
  // gold, merge four times, fit a tier-5 gun the turn the emplacement is up.
  if (k.warehouseEarly && !built(s, 'warehouse').length) push({ b: 'warehouse' });
  if (k.dockEarly && !built(s, 'dock').length) push({ b: 'dock' });

  // A boat a quarter off and in one turn instead of three, bought before the
  // first gun rather than after the fifth. Hands are the one thing the island
  // does not sell, and everything below is done by hand.
  if (k.powderEarly && !built(s, 'powder').length) push({ b: 'powder' });
  for (let i = 0; i < 2; i++) push({ tower: true });
  if (!built(s, 'sappers').length && s.turn >= k.sappersFrom) push({ b: 'sappers' });
  // no evolution without it, and no holding act 3 without an evolution
  if (!built(s, 'tinker').length && s.turn >= k.tinkerFrom) push({ b: 'tinker' });
  // The Forge is the only iron, iron is the only flare, and a flare is the
  // only way the crew ever grows past ten. It goes up early or not at all.
  if (!built(s, 'forge').length && k.forge) push({ b: 'forge' });
  // where the Warehouse used to sit, for a strategy that does not take it early
  if (!k.warehouseEarly && !built(s, 'warehouse').length) push({ b: 'warehouse' });
  if (camps < Math.min(2, k.camps)) push({ b: 'excavation' });
  for (let i = 2; i < k.maxTowers; i++) push({ tower: true });
  // A camp on every cache, for a strategy that wants to measure the building
  // rather than the hand. `camps: 0` is the reference line and means never: a
  // hand digs a cache in one turn for the 220 gold a camp takes ten turns and
  // a crew to pay, so the two compete for the same twelve holes and the hand
  // wins every one of them.
  for (let i = camps; i < k.camps; i++) push({ b: 'excavation' });


  // A ruin is the cheapest building on the island and the most valuable: it is
  // one the crew already paid for. Rebuilding comes before anything new — but
  // not for ever. Ground that has been fought over three times is ground the
  // wave walks across every wave, and paying to raise a yard there again is
  // paying to have it pulled down again. The Sappers' Camp is the exception:
  // without it there is no offence and the run cannot be won at all.
  for (const b of s.buildings) {
    if (!b.ruined) continue;
    if (b.type !== 'sappers' && (b.ruinedCount || 0) >= 3) continue;
    if (O.enqueue(s, { type: 'repairBuilding', buildingId: b.id }).ok) break;
  }

  // Wood the next boat is going to need is not wood to spend on a yard. Held
  // against the act's own allowance rather than against what is affordable
  // today: the whole point of a reserve is the turns when the boat cannot be
  // paid for yet, and asking `canEnqueue` would have answered "no flare, spend
  // freely" on exactly those turns.
  const flaresLeft = B.flareAllowance(s) - (s.crew.flaresFired + s.crew.flaresInFlight.length);
  const holdWood = k.flareFirst && flaresLeft > 0 ? B.flareCost(s).wood : 0;
  const affordable = (w) => {
    if (!holdWood || w.tower) return true;
    const cost = C.buildingCost(w.b) || {};
    return s.res.wood - (cost.wood || 0) >= holdWood;
  };

  // What the next yard is short of, bought over the counter before the list is
  // walked — so "the first thing affordable" means the first thing wanted.
  stockUp(s, k, wish);

  for (const w of wish) {
    if (!affordable(w)) continue;
    if (w.tower) {
      if (s.towers.length >= k.maxTowers) continue;
      // the minor kind exists only to be evolved with the major one
      const mate = mateFor(k);
      const haveMate = s.towers.filter((t) => t.towerIndex === mate).length;
      // the major kind first — the minor one exists only for the evolution, so
      // it must never come at the cost of having any gun at all
      const order = s.towers.length < 2 || mate === undefined || haveMate >= k.mateShare
        ? [k.towerKind, mate] : [mate, k.towerKind];
      // The site is looked for per kind, because the kinds want different
      // ground: a gun's yard is one to three tiles and settled for life, so a
      // spot that takes a Swivel Gun Post need not take a Culverin Battery.
      let put = false;
      for (const kind of order) {
        if (kind === undefined) continue;
        const spot = towerSpot(s, k.towerRing, kind);
        if (!spot) continue;
        if (O.enqueue(s, { type: 'buildTower', q: spot.q, r: spot.r, towerIndex: kind }).ok) { put = true; break; }
      }
      if (put) break;
      // nowhere open enough for any of them — cut the yard rather than wait
      if (clearGunPad(s, k.towerRing, order.filter((x) => x !== undefined))) break;
      continue;
    }
    const spot = w.b === 'excavation' ? campSpot(s) : buildingSpot(s, w.b);
    if (!spot) {
      // nowhere legal yet — cut a yard for it rather than waiting for one
      if (w.b !== 'excavation' && clearPad(s, w.b)) break;
      continue;
    }
    if (O.enqueue(s, { type: 'buildBuilding', building: w.b, q: spot.q, r: spot.r }).ok) break;
  }

  // What the offensive has first call on. Everything below spends what is left.
  const reserve = goldSpokenFor(s, k);

  // --- 3b · buy the crews back. 50 gold to run a building unmanned returns
  //      two hands for ever, and with a crew of ten that beats eight items.
  if (s.res.gold >= C.CREW_UPGRADE_GOLD + reserve) {
    // The upgrade is one hand off the crew, so the gold goes furthest on a
    // building that is already down to its last one — inside a Bunkhouse's
    // radius. That one comes back crewed by nobody, for ever.
    const manned = s.buildings
      .filter((b) => b.complete && !b.ruined && !b.upgraded && St.handsNeededFor(s, b) > 0)
      .sort((a, b) => St.handsNeededFor(s, a) - St.handsNeededFor(s, b))[0];
    if (manned) O.enqueue(s, { type: 'upgradeCrew', buildingId: manned.id });
  }

  // --- 4 · fittings. Each tower takes its own, so buy for the guns that are
  //     standing, merge those stacks up, and fit the best of each.
  // the minor kind has to be bought for too, or the evolution partner can never
  // be founded — a tower is raised on a fitting of its own kind and no other
  const mateKind = mateFor(k);
  const kinds = [...new Set([k.towerKind, mateKind, ...s.towers.map((t) => t.towerIndex)])]
    .filter((i) => i !== undefined);
  // top the iron up over the counter, if the line is Workshop work and a dock
  // is open: gold is what the camps make, and iron is what the Workshop eats
  if (kinds.some((i) => C.itemSource(i) === 'iron')) {
    const price = B.itemCraftCost(s);
    while (s.res.iron < price * 2
      && s.res.gold > reserve + C.TRADE.iron.buy * price
      && O.trade(s, { res: 'iron', dir: 'buy', amount: price }).ok) { /* again */ }
  }
  // Fittings, up to what is not spoken for. Bought for one kind at a time
  // rather than round-robin: two of a tier make one of the next, so five slots
  // filled a fitting each from two kinds merge into nothing at all — which is
  // how the hold used to jam at [Culverin 3, Culverin 2, Culverin 1, Chain 2,
  // Chain 1] with no legal merge and no room to buy the pair that would fix it.
  const stacks = O.projectedItems(s);
  const ranked = kinds.slice().sort((a, b) => {
    const lowest = (i) => { for (let t = 1; t <= C.MAX_TIER; t++) if (stacks.count(i, t) === 1) return t; return 99; };
    return lowest(a) - lowest(b);
  });
  let bought = 0;
  while (ranked.length && bought < 40) {
    if (O.projectedRes(s).gold - B.itemBuyCost(s) < reserve
      && C.itemSource(ranked[bought % ranked.length]) === 'gold') break;
    // in pairs, because a pair is what a merge takes
    const kind = ranked[Math.floor(bought / 2) % ranked.length];
    if (!O.enqueue(s, itemOrder(kind)).ok) break;
    bought++;
  }
  // Merging greedily starves the yard. An emplacement takes whatever tier it is
  // handed, so this is no longer a rule it would break — but it is still the
  // right play: the founding spends the lowest tier held, and a stack merged
  // away is a gun that has to be bought again before the next tower goes up.
  // Holding tier-1s back founds the next gun; spending them raises the ones
  // standing. The tier strategy is the second of those and nothing else.
  const wantMore = !k.tierFirst && s.towers.length < k.maxTowers;
  let merged = true;
  while (merged) {
    merged = false;
    for (const kind of kinds) {
      for (let tier = 1; tier < C.MAX_TIER; tier++) {
        if (tier === 1 && wantMore && O.projectedItems(s).count(kind, 1) < 3) continue;
        if (O.enqueue(s, { type: 'mergeItems', tower: kind, tier }).ok) merged = true;
      }
    }
  }
  const proj = O.projectedItems(s);
  for (const tower of s.towers.slice().sort((a, b) => a.tier - b.tier)) {
    if (tower.evolved) continue;
    for (let tier = C.MAX_TIER; tier > tower.tier; tier--) {
      if (!proj.count(tower.towerIndex, tier)) continue;
      if (O.enqueue(s, { type: 'fitItem', towerId: tower.id, tier }).ok) break;
    }
  }
  // --- 4b · the evolution. Two tier-5s of partner kinds become one gun worth
  //      two and a half of them, which is what act 3 asks for.
  if (!s.towers.some((t) => t.evolved)) {
    outer: for (const a of s.towers) {
      for (const b of s.towers) {
        if (a.id === b.id) continue;
        if (O.enqueue(s, { type: 'evolve', towerId: a.id, partnerId: b.id }).ok) break outer;
      }
    }
  }

  // --- 5 · the assault, the only way a spawner dies.
  //     Nothing else in the run ends it, so when a road is open the team gets
  //     made room for: an officer is held back to lead, and hands come off the
  //     face if that is what it takes.
  const camp = built(s, 'sappers')[0];
  if (camp && St.isBuildingManned(s, camp)) {
    // A mission is a walk now, so what makes a spawner a target is that the crew
    // can get to the staging ground two tiles off it — and the hive is not a
    // target at all until the flank has fallen.
    const reachable = s.spawners.filter((sp) => A.targetable(s, sp) &&
      !s.assaults.some((a) => a.targetSpawnerId === sp.id));
    for (const sp of reachable) {
      // The Sapper Captain first, and it is not close. He is 90% where another
      // lieutenant is 65% and nobody at all is 40%, and the team he leads is two
      // hands rather than four — so on a 32-turn march he is worth about forty
      // turns of the run against the next man, which is more than the Weapons
      // Master's discount is worth over the whole of it. The list used to put
      // the passive trades first, on the reasoning that their verb goes on
      // working while they are away; the arithmetic does not support it.
      const leader = ['assault', 'item', 'man', 'clear']
        .map((role) => idleOfficer(s, role))
        .find((o) => o && o.quality >= 1) || null;
      const order = { type: 'scheduleAssault', spawnerId: sp.id, leader: leader ? leader.id : null };
      if (O.enqueue(s, order).ok) { m.assaults++; continue; }

      // Could not go: free what it needs and ask again in the same breath.
      // Standing a worker down is instant, so the bodies are loose inside this
      // phase and the team marches this turn rather than next — which it has
      // to, because the labour below is about to put any idle hand it finds
      // straight back on the frontier.
      if (!leader) {
        const held = s.crew.assignments.find((a) => a.kind === 'clear' &&
          (officerById(s, a.who)?.quality ?? 0) >= 1);
        if (held) O.standDown(s, held.id);
      }
      const lead = leader || ['assault', 'item', 'man', 'clear']
        .map((role) => idleOfficer(s, role))
        .find((o) => o && o.quality >= 1) || null;
      const need = A.assaultHands(s, lead ? lead.id : null) - (lead ? 1 : 0) - St.idleHands(s);
      for (let i = 0; i < need; i++) {
        const digger = s.crew.assignments.find((a) => a.kind === 'clear' && St.isHand(a.who));
        if (!digger) break;
        O.standDown(s, digger.id);
      }
      const retry = { type: 'scheduleAssault', spawnerId: sp.id, leader: lead ? lead.id : null };
      if (O.enqueue(s, retry).ok) { m.assaults++; continue; }
      break;
    }
  }


  // --- 7 · labour. Early: open ground round the ship for wood, stone and
  //     building room. From digRoadFrom: a gang on the road to the nearest
  //     living spawner, because nothing else can end the run.
  // the nearest spawner that has no road to it yet — so the gang carries on
  // toward the second one while the first team is still marching
  const target = s.spawners.filter((x) => x.alive && !roadedTo(s, x))
    .sort((a, b) => H.distance(a, s.base) - H.distance(b, s.base))[0];
  const driving = s.turn >= k.digRoadFrom && !!target;

  // The crew splits, it does not queue: manning takes what it needs but is
  // never allowed to strip the road gang, and the gang works what is left.
  const crew = St.handCount(s);
  const gang = Math.max(2, Math.round(crew * k.gangShare));
  const diggerFloor = Math.max(1, Math.round(crew * k.diggerShare));
  crewUp(s, k.manFromTier, driving ? gang : diggerFloor, driving ? m.route : null);
  if (driving) m.route = driveRoadGang(s, target, gang, 0);

  // anything the digging has uncovered is worth a body for one turn
  workFeatures(s, k.features);
  // Stone is the scarce half of every yard — a Sappers' Camp is 260 of it — and
  // it comes out of boulders and nothing else, at 15 a tile against forest's 9
  // wood. Left to the nearest-face rule the crew cut wood they already have
  // two thousand of and the offensive never gets paid for, so when the next
  // yard on the list is short of stone the seams come first.
  if (k.quarry && wish.length) {
    const next = wish[0].tower ? C.TOWER_COST : (C.buildingCost(wish[0].b) || {});
    if ((next.stone || 0) > s.res.stone) cutWhere(s, (t) => t.terrain === 'stone');
  }
  // The two strategies that pick their ground rather than taking the nearest of
  // it. Queued before the frontier pass below, which fills in with whatever is
  // left — so this is a preference, not a restriction.
  if (k.mineIron) cutWhere(s, (t) => t.terrain === 'iron');
  if (k.poiFirst) cutWhere(s, (t) => !!t.feature && !t.featureWorked);
  // A clear order is one tile, so the crew goes back on the frontier every
  // turn — each worker taking the nearest face to where they already stand.
  putCrewOnFrontier(s);
  // officers work too. The Master Gunner is worth most behind the best gun;
  // the Master Pioneer is worth three hands cutting ground.
  const holdBack = camp ? (idleOfficer(s, 'assault') || idleOfficer(s, 'item')) : null;
  for (const o of St.idleOfficers(s)) {
    if (holdBack && o.id === holdBack.id) continue; // he leads the next assault
    if (o.role === 'man' && s.towers.length) {
      const best = s.towers.slice().sort((a, b) => b.tier - a.tier)[0];
      if (best && best.tier >= k.manFromTier &&
          O.enqueue(s, { type: 'assignMan', who: o.id, targetId: best.id }).ok) continue;
    }
    // A labour officer works several touching faces. On the road that means
    // consecutive tiles of the route — they are adjacent by construction, and
    // it is the road that decides the run.
    const cap = clearCapacity(s, o.id);
    const faces = driving && m.route
      ? roadFace(s, m.route, cap).filter((f) => !f.bridge)
      : [];
    if (faces.length) {
      // his batch is one kind of ground, and the road wants the tile in front of
      // it first — so take the run of the route that matches that tile, and let
      // topUpFaces find him the rest
      const ground = St.tileAt(s, faces[0].q, faces[0].r).terrain;
      for (const f of faces) {
        if (St.tileAt(s, f.q, f.r).terrain !== ground) continue;
        O.enqueue(s, { type: 'assignClear', who: o.id, target: f });
      }
      continue;
    }
    putOfficerOnFrontier(s, o);
  }
}

/**
 * Put whatever hands are spare on the faces that answer `want`, nearest first.
 *
 * The frontier pass that follows takes the nearest tile to each body, which is
 * the right default and the wrong one for a strategy about *which* ground: an
 * iron seam four tiles out is worth more than the forest under somebody's feet,
 * and a chest is worth more than either. Queued first, so those tiles are taken
 * before the general pass sees them, and everyone it does not use is still put
 * to work by it.
 */
function cutWhere(s, want) {
  const faces = O.workableTiles(s).filter(want);
  if (!faces.length) return 0;
  let placed = 0;
  for (const f of faces.sort((a, b) => H.distance(a, s.base) - H.distance(b, s.base))) {
    if (O.projectedHands(s) <= 0) break;
    if (O.enqueue(s, { type: 'assignClear', who: 'hand', target: { q: f.q, r: f.r } }).ok) placed++;
  }
  return placed;
}

/** Keep every labour officer working all the faces he can hold. */
function topUpFaces(s) {
  for (const o of s.crew.officers) {
    const mine = O.projectedAssignments(s).filter((a) => a.who === o.id);
    const clears = mine.filter((a) => a.kind === 'clear');
    if (!clears.length || clears.length !== mine.length) continue;
    for (const c of clears) {
      for (const n of H.neighbours(c.target.q, c.target.r)) {
        if (O.enqueue(s, { type: 'assignClear', who: o.id, target: n }).ok) break;
      }
    }
    void 0;
  }
}

// ---- a run ------------------------------------------------------------------

export { DEFAULTS, STRATEGIES, policy };

export function playRun(seed, opts = {}) {
  const k = { ...DEFAULTS, ...opts };
  const s = St.createState(seed);
  const m = { assaults: 0, roadTurns: 0, route: null, routeFor: null, routeAge: 0 };
  const journal = [];
  let firstKill = null, campTurn = null, roadTurn = null;

  while (!s.outcome && s.turn <= C.TURNS_PER_RUN) {
    policy(s, k, m);
    const { events, turn } = playTurn(s);

    if (!campTurn && working(s, 'sappers')) campTurn = turn;
    if (!roadTurn && s.spawners.some((x) => x.alive && networkReaches(s, x))) roadTurn = turn;
    for (const e of events) {
      if (e.kind === 'spawnerDied' && !firstKill) firstKill = turn;
      if (e.kind === 'combatEnd') for (const rn of e.ruined || []) m.ruined = (m.ruined || 0) + 1;
      if (e.kind === 'assault') journal.push(`t${turn} assault on the ${e.target}: ${e.result}`);
      if (e.kind === 'spawnerDied') journal.push(`t${turn} the ${e.spawner} is destroyed`);
    }
    if (opts.trace && turn % 20 === 0) {
      journal.push(`t${turn} hull ${s.base.hull} wood ${s.res.wood} gold ${s.res.gold} ` +
        `crew ${St.handCount(s)} clearing ${St.crewClearing(s)} power ${St.totalPower(s).toFixed(0)} ` +
        `towers ${s.towers.length} tiers[${s.towers.map((t) => t.tier).join('')}] ` +
        `camps ${built(s, 'excavation').length} cleared ${s.stats.tilesCleared}`);
    }
  }

  return {
    seed,
    outcome: s.outcome,
    turn: s.turn,
    hull: s.base.hull,
    spawnersLeft: s.spawners.filter((x) => x.alive).length,
    peakPower: s.stats.peakPower,
    cleared: s.stats.tilesCleared,
    gold: s.stats.goldEarned,
    towers: s.towers.map((t) => t.tier).sort((a, b) => b - a),
    camps: built(s, 'excavation').length,
    hands: St.handCount(s),
    assaults: m.assaults,
    campTurn, roadTurn, firstKill,
    ruined: m.ruined || 0,
    journal,
  };
}

// ---- cli --------------------------------------------------------------------
// Guarded so the file can also be imported by a browser — the same policy then
// drives a real run through the interface's own order queue.

// Only when this file IS the command being run. It used to fire on import too,
// so anything that pulled `policy` in for its own harness paid for six full
// runs first and had its own output buried under the summary table.
const isEntry = typeof process !== 'undefined'
  && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isEntry) runCli(process.argv.slice(2));

async function runCli(args) {
// One seed, as JSON on stdout. This is the worker `--jobs` forks; it is not
// meant to be read by a person.
const oneIdx = args.indexOf('--one');
if (oneIdx >= 0) {
  const row = playRun(Number(args[oneIdx + 1]), JSON.parse(args[oneIdx + 2] || '{}'));
  delete row.journal;
  process.stdout.write(JSON.stringify(row));
  return;
}
const traceIdx = args.indexOf('--trace');
const seedsIdx = args.indexOf('--seeds');
const nSeeds = seedsIdx >= 0 ? Number(args[seedsIdx + 1]) : 6;
const sweepIdx = args.indexOf('--sweep');
const stratIdx = args.indexOf('--strategy');
const compareIdx = args.indexOf('--compare');
const named = stratIdx >= 0 ? args[stratIdx + 1] : null;
if (named && !STRATEGIES[named]) {
  console.log(`no such strategy: ${named}. One of ${Object.keys(STRATEGIES).join(', ')}`);
  process.exit(1);
}
const knobs = named ? STRATEGIES[named] : {};
const jobsIdx = args.indexOf('--jobs');
// A run is a minute of arithmetic and there are twelve of them, so the seeds
// are played side by side in child processes rather than one after another: the
// six-seed gate went from five minutes to forty seconds, which is the
// difference between a harness you run before a commit and one you do not.
// `--jobs 1` is the old behaviour, and is what `--trace` and `--sweep` use.
const jobs = jobsIdx >= 0 ? Math.max(1, Number(args[jobsIdx + 1]))
  : Math.max(1, Math.min(nSeeds, (os.availableParallelism?.() ?? 4) - 2));

/** `nSeeds` runs of one set of knobs, in parallel unless told otherwise. */
async function runSeeds(k) {
  const seeds = Array.from({ length: nSeeds }, (_, i) => C.DEFAULT_SEED + i);
  if (jobs <= 1) return seeds.map((seed) => playRun(seed, k));
  const rows = new Array(seeds.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < seeds.length; i = next++) {
      rows[i] = await new Promise((resolve) => {
        const child = spawn(process.execPath,
          [fileURLToPath(import.meta.url), '--one', String(seeds[i]), JSON.stringify(k)]);
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('close', () => {
          try { resolve(JSON.parse(out)); } catch { resolve({ seed: seeds[i], outcome: 'crashed', turn: 0, towers: [], journal: [] }); }
        });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, seeds.length) }, worker));
  return rows;
}

/** One strategy over `nSeeds` seeds, as a row and its runs. */
async function runStrategy(name) {
  const rows = await runSeeds(STRATEGIES[name]);
  const wins = rows.filter((r) => r.outcome === 'won');
  return {
    name,
    rows,
    wins: wins.length,
    kills: rows.reduce((n, r) => n + (2 - r.spawnersLeft), 0),
    meanTurn: wins.length ? Math.round(wins.reduce((n, r) => n + r.turn, 0) / wins.length) : 0,
    meanPower: Math.round(rows.reduce((n, r) => n + r.peakPower, 0) / rows.length),
    meanHands: Math.round(rows.reduce((n, r) => n + r.hands, 0) / rows.length),
    meanGold: Math.round(rows.reduce((n, r) => n + r.gold, 0) / rows.length),
    meanCleared: Math.round(rows.reduce((n, r) => n + r.cleared, 0) / rows.length),
    assaults: rows.reduce((n, r) => n + r.assaults, 0),
    meanLoss: Math.round(rows.filter((r) => r.outcome !== 'won')
      .reduce((n, r, _, a) => n + r.turn / a.length, 0)),
  };
}

if (sweepIdx >= 0) {
  const grid = [];
  for (const digRoadFrom of [20, 35, 50])
    for (const gang of [3, 4, 6])
      for (const maxTowers of [2, 3, 4])
        grid.push({ digRoadFrom, gang, maxTowers });
  const rows = [];
  for (const k of grid) {
    let wins = 0, kills = 0, turns = 0;
    for (let i = 0; i < nSeeds; i++) {
      const r = playRun(C.DEFAULT_SEED + i, k);
      if (r.outcome === 'won') { wins++; turns += r.turn; }
      kills += 2 - r.spawnersLeft;
    }
    rows.push({ ...k, wins, kills, meanWin: wins ? Math.round(turns / wins) : 0 });
  }
  rows.sort((a, b) => b.wins - a.wins || b.kills - a.kills);
  console.log('road gang towers | wins kills meanWinTurn');
  for (const r of rows.slice(0, 12)) {
    console.log(`${String(r.digRoadFrom).padStart(4)} ${String(r.gang).padStart(4)} ${String(r.maxTowers).padStart(6)} |` +
      ` ${String(r.wins).padStart(4)}/${nSeeds} ${String(r.kills).padStart(5)} ${String(r.meanWin || '-').padStart(11)}`);
  }
} else if (compareIdx >= 0) {
  // Every strategy over the same seeds, so the column that differs is the plan
  // and nothing else.
  const names = Object.keys(STRATEGIES);
  console.log(`${nSeeds} seeds each, ${names.length * nSeeds} runs\n`);
  // Printed as each finishes rather than at the end: thirty runs is twenty
  // minutes, and a table that appears all at once is twenty minutes of nothing.
  const out = [];
  for (const name of names) {
    const r = await runStrategy(name);
    out.push(r);
    console.log(`  ${r.name.padEnd(9)} ${r.wins}/${nSeeds} won, ${r.kills} spawners`);
  }
  console.log('\nstrategy  wins kills  meanWin  meanLoss  power hands  gold cleared assaults');
  for (const r of out.sort((a, b) => b.wins - a.wins || b.kills - a.kills)) {
    console.log(
      `${r.name.padEnd(9)} ${String(r.wins).padStart(2)}/${nSeeds} ${String(r.kills).padStart(5)}` +
      ` ${String(r.meanTurn || '-').padStart(8)} ${String(r.meanLoss || '-').padStart(9)}` +
      ` ${String(r.meanPower).padStart(6)} ${String(r.meanHands).padStart(5)}` +
      ` ${String(r.meanGold).padStart(5)} ${String(r.meanCleared).padStart(7)} ${String(r.assaults).padStart(8)}`);
  }
  console.log('\nkills is spawners destroyed out of ' + (2 * nSeeds) + '; meanLoss is how far a losing run got.');
} else if (traceIdx >= 0) {
  const seed = Number(args[traceIdx + 1]) || C.DEFAULT_SEED;
  const r = playRun(seed, { ...knobs, trace: true });
  console.log(r.journal.join('\n'));
  console.log(`\n${seed}: ${r.outcome} on turn ${r.turn}, hull ${r.hull}, ${r.spawnersLeft} spawners left`);
} else {
  const rows = await runSeeds(knobs);
  if (named) console.log(`strategy: ${named}`);
  console.log('seed      outcome       turn hull left power cleared gold camps towers        assaults camp road kill');
  for (const r of rows) {
    console.log(
      `${r.seed}  ${(r.outcome || '-').padEnd(12)} ${String(r.turn).padStart(4)} ${String(r.hull).padStart(4)}` +
      ` ${String(r.spawnersLeft).padStart(4)} ${r.peakPower.toFixed(0).padStart(5)} ${String(r.cleared).padStart(7)}` +
      ` ${String(r.gold).padStart(4)} ${String(r.camps).padStart(5)} ${`[${r.towers.join('')}]`.padEnd(13)}` +
      ` ${String(r.assaults).padStart(8)} ${String(r.campTurn ?? '-').padStart(4)} ${String(r.roadTurn ?? '-').padStart(4)} ${String(r.firstKill ?? '-').padStart(4)}`);
  }
  const wins = rows.filter((r) => r.outcome === 'won').length;
  console.log(`\n${wins}/${rows.length} won`);
  // A gate, not a scoreboard. It used to exit 0 whatever happened, so a change
  // that took the reference policy from winning to never winning was invisible
  // to anything but a reader. The floor is deliberately low — this asserts that
  // the game is still winnable by an honest policy, not that it wins often.
  // Raise it with --min N when you want a stricter bar.
  //
  // It applies to the reference policy only. A specialised strategy scoring
  // nothing is a finding about that strategy, not a broken build — `flare` at
  // 0/6 is the harness working, not the harness failing.
  const minIdx = args.indexOf('--min');
  const floor = minIdx >= 0 ? Number(args[minIdx + 1]) : (named ? 0 : 1);
  if (wins < floor) {
    console.log(`FAIL — wanted at least ${floor} win${floor === 1 ? '' : 's'} in ${rows.length}`);
    process.exit(1);
  }
}
}
