// An honest AI player: no free resources, no patched hull, no immortality.
// It plays the game through the same order queue a human uses, and tries to
// win — both spawners dead before turn 300.
//
//   node tests/play.mjs                 # 6 seeds, summary
//   node tests/play.mjs --seeds 12      # more seeds
//   node tests/play.mjs --trace 20260816  # turn-by-turn journal for one seed

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
function gunKinds(k) {
  const mate = evolutionPartners(k.towerKind).filter((i) => i < C.TOWERS.length)[0];
  return [k.towerKind, mate].filter((i) => i !== undefined);
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

/** A spot for a building of this type, as close to the ship as it will go. */
function buildingSpot(s, type) {
  for (let d = 1; d < C.ISLAND_RADIUS; d++) {
    for (const h of H.ring(s.base, d)) {
      if (!B.canBuildBuilding(s, type, h.q, h.r).ok) continue;
      if (s.orders.some((o) => o.q === h.q && o.r === h.r)) continue;
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
function towerSpot(s, radius, towerIndex, mayCut = false) {
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
  return best;
}

// ---- the policy -------------------------------------------------------------

const DEFAULTS = {
  towerRing: 4,        // how far out the gun line sits
  // Every tower takes its own fitting, so a gun line of one kind concentrates
  // the money instead of splitting it eight ways. 1 is the Culverin Battery,
  // range 4 — the widest arc on the shelf, and Workshop work.
  //
  // Its fitting is iron, and one Forge makes one iron a turn against a
  // fitting's six, so the line looks unaffordable on paper. The dock's counter
  // is what makes it: gold out of the chests, over the counter, back as iron.
  // The gold shelf — Dynamite and the beasts, bought whole off the Merchant —
  // needs one building fewer and was tried first; over six seeds it holds the
  // waves worse than a range-4 arc does, because what kills this run is a lane
  // the guns cannot reach across.
  towerKind: 1,
  // A real gun line: act 3's waves cannot be held by two guns. Five towers of
  // two kinds, every one pushed to tier 5, and the two of the minor kind fed to
  // an evolution — an evolved tower is 97.7 dps against a tier-5's 39.1.
  maxTowers: 5,
  mateShare: 2,        // how many of the five are the evolution partner
  tinkerFrom: 60,      // the Tinker's Shed is act-2 work
  camps: 3,            // Excavation Camps, i.e. the gold engine
  forge: true,         // iron, and therefore flares, and therefore hands
  sappersFrom: 15,     // turn to start thinking about the offensive
  digRoadFrom: 20,     // turn to start driving a road at the first spawner
  gang: 6,             // hands held for the road face
  manFromTier: 2,      // fittings are dear now, so a tier-2 gun is worth a hand
  diggerFloor: 4,      // never strip the economy entirely
  goldReserve: 0,      // gold held back from the unmanning upgrade
  repairBelow: 70,
  repairReserve: 250,  // wood kept back when repairing
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
  if (!built(s, 'bunkhouse').length) wish.push({ b: 'bunkhouse' });
  if (camps < 1) wish.push({ b: 'excavation' });
  // The house that supplies the gun line's fitting, before the gun line: a
  // fitting is crafted at a Workshop or bought off a Peculiar Merchant and got
  // nowhere else, so without it every tower below is an order that is refused.
  for (const house of gunHouses(k)) if (!built(s, house).length) wish.push({ b: house });
  for (let i = 0; i < 2; i++) wish.push({ tower: true });
  if (!built(s, 'sappers').length && s.turn >= k.sappersFrom) wish.push({ b: 'sappers' });
  // no evolution without it, and no holding act 3 without an evolution
  if (!built(s, 'tinker').length && s.turn >= k.tinkerFrom) wish.push({ b: 'tinker' });
  // The Forge is the only iron, iron is the only flare, and a flare is the
  // only way the crew ever grows past ten. It goes up early or not at all.
  if (!built(s, 'forge').length && k.forge) wish.push({ b: 'forge' });
  // five hold slots is what caps the climb to tier 5, so the Warehouse is not
  // a late luxury — it is the gun line
  if (!built(s, 'warehouse').length) wish.push({ b: 'warehouse' });
  if (camps < 2) wish.push({ b: 'excavation' });
  for (let i = 2; i < k.maxTowers; i++) wish.push({ tower: true });
  if (camps < k.camps) wish.push({ b: 'excavation' });


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

  for (const w of wish) {
    if (w.tower) {
      if (s.towers.length >= k.maxTowers) continue;
      // the minor kind exists only to be evolved with the major one
      const mate = evolutionPartners(k.towerKind).filter((i) => i < C.TOWERS.length)[0];
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

  // --- 3b · buy the crews back. 50 gold to run a building unmanned returns
  //      two hands for ever, and with a crew of ten that beats eight items.
  if (s.res.gold >= C.CREW_UPGRADE_GOLD + k.goldReserve) {
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
  const mateKind = evolutionPartners(k.towerKind).filter((i) => i < C.TOWERS.length)[0];
  const kinds = [...new Set([k.towerKind, mateKind, ...s.towers.map((t) => t.towerIndex)])]
    .filter((i) => i !== undefined);
  // top the iron up over the counter, if the line is Workshop work and a dock
  // is open: gold is what the camps make, and iron is what the Workshop eats
  if (kinds.some((i) => C.itemSource(i) === 'iron')) {
    const price = B.itemCraftCost(s);
    while (s.res.iron < price * 2
      && s.res.gold > k.goldReserve + C.TRADE.iron.buy * price
      && O.trade(s, { res: 'iron', dir: 'buy', amount: price }).ok) { /* again */ }
  }
  let bought = 0;
  while (kinds.length && bought < 40) {
    const kind = kinds[bought % kinds.length];
    if (!O.enqueue(s, itemOrder(kind)).ok) break;
    bought++;
  }
  // Merging greedily starves the yard. An emplacement takes whatever tier it is
  // handed, so this is no longer a rule it would break — but it is still the
  // right play: the founding spends the lowest tier held, and a stack merged
  // away is a gun that has to be bought again before the next tower goes up.
  const wantMore = s.towers.length < k.maxTowers;
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
    const reachable = s.spawners.filter((sp) => sp.alive && networkReaches(s, sp) &&
      !s.assaults.some((a) => a.targetSpawnerId === sp.id));
    for (const sp of reachable) {
      // the officers whose verb keeps working while they are away lead first
      const leader = ['item', 'assault', 'man', 'clear']
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
      const lead = leader || ['item', 'assault', 'man', 'clear']
        .map((role) => idleOfficer(s, role))
        .find((o) => o && o.quality >= 1) || null;
      const need = A.assaultHands(s) - (lead ? 1 : 0) - St.idleHands(s);
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
  crewUp(s, k.manFromTier, driving ? k.gang : k.diggerFloor, driving ? m.route : null);
  if (driving) m.route = driveRoadGang(s, target, k.gang, 0);

  // anything the digging has uncovered is worth a body for one turn
  workFeatures(s, 3);
  // A clear order is one tile, so the crew goes back on the frontier every
  // turn — each worker taking the nearest face to where they already stand.
  putCrewOnFrontier(s);
  // officers work too. The Master Gunner is worth most behind the best gun;
  // the Master Pioneer is worth three hands cutting ground.
  const holdBack = camp ? (idleOfficer(s, 'item') || idleOfficer(s, 'assault')) : null;
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

export { DEFAULTS, policy };

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

function runCli(args) {
const traceIdx = args.indexOf('--trace');
const seedsIdx = args.indexOf('--seeds');
const nSeeds = seedsIdx >= 0 ? Number(args[seedsIdx + 1]) : 6;
const sweepIdx = args.indexOf('--sweep');

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
} else if (traceIdx >= 0) {
  const seed = Number(args[traceIdx + 1]) || C.DEFAULT_SEED;
  const r = playRun(seed, { trace: true });
  console.log(r.journal.join('\n'));
  console.log(`\n${seed}: ${r.outcome} on turn ${r.turn}, hull ${r.hull}, ${r.spawnersLeft} spawners left`);
} else {
  const rows = [];
  for (let i = 0; i < nSeeds; i++) rows.push(playRun(C.DEFAULT_SEED + i));
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
  const minIdx = args.indexOf('--min');
  const floor = minIdx >= 0 ? Number(args[minIdx + 1]) : 1;
  if (wins < floor) {
    console.log(`FAIL — wanted at least ${floor} win${floor === 1 ? '' : 's'} in ${rows.length}`);
    process.exit(1);
  }
}
}
