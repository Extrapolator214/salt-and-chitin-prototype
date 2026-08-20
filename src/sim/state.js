// createState(seed) -> the whole run, plus the map queries every other
// sim module needs. Nothing here touches the DOM or Math.random.

import C from './config.js';
import { generateIsland } from './generate.js';
import { key, parseKey, distance, neighbours, spiral } from './hex.js';
import { createRng, next } from './rng.js';

export function createState(seed) {
  const island = generateIsland(seed);
  const state = {
    seed,
    turn: 1,
    act: 1,
    phase: 'player',
    outcome: null,

    map: { radius: C.MAP_RADIUS, tiles: island.tiles, version: 1 },
    island: {
      centre: { q: 0, r: 0 },
      corridorMouth: island.corridorMouth,
      corridorBearing: island.corridorBearing,
      landingBearing: island.landingBearing,
      inlandBearing: island.inlandBearing,
      footprint: island.baseFootprint,
      stats: island.stats,
    },

    base: { q: island.base.q, r: island.base.r, hull: C.HULL_MAX, hold: [] },
    res: { wood: 0, stone: 0, iron: 0, gold: 0 },

    crew: {
      cap: C.HANDS_CAP,
      capBonus: 0,
      assignments: [],
      // every body on the island stands somewhere; `members` is the roster
      members: [],
      // quality 1 is a unique lieutenant; the pirate found on the island is less
      officers: C.OFFICERS.map((o) => ({ id: o.id, name: o.name, verb: o.verb, role: o.role, quality: 1 })),
      flaresFired: 0,
      flaresInFlight: [],
      lastFlareTurn: null,
    },

    towers: [],
    buildings: [],
    bridges: [],

    spawners: island.spawners.map((s) => ({
      id: s.id, kind: s.kind, name: s.name, q: s.q, r: s.r,
      stars: s.stars, cap: s.cap, grubShare: s.grubShare, alive: true,
      bearing: s.bearing, footprint: s.footprint,
      mode: 'accumulate', accumulatedTurns: 0, eliteNext: false,
    })),
    cohorts: [],
    assaults: [],
    combat: null,

    orders: [],
    log: [],
    rngState: (seed * 2654435761) >>> 0,
    ids: 0,

    stats: { tilesCleared: 0, woodEarned: 0, stoneEarned: 0, ironEarned: 0, goldEarned: 0, peakPower: 0, unitsKilled: 0, unitsLeaked: 0, wavesFought: 0 },
  };
  // the company comes ashore: officers first, then the hands, spread over the
  // landing rather than stacked on the ship's own tile
  for (const o of state.crew.officers) landCrew(state, o.id, 'officer');
  for (let i = 0; i < C.HANDS_START; i++) landCrew(state, `h${i + 1}`, 'hand');
  return state;
}

// ---- the roster ------------------------------------------------------------

/**
 * Where a new body goes: outward from the ship, at most `CREW_PER_TILE` to a
 * tile, over ground somebody could actually stand on.
 */
export function landingSpot(state, from = state.base) {
  const here = new Map();
  for (const m of state.crew.members) {
    const k = key(m.q, m.r);
    here.set(k, (here.get(k) || 0) + 1);
  }
  for (const h of spiral(from, 8)) {
    const t = tileAt(state, h.q, h.r);
    if (!t || !isOpenGround(t)) continue;
    if (t.occupant && t.occupant.kind !== 'base') continue;
    if ((here.get(key(h.q, h.r)) || 0) >= C.CREW_PER_TILE) continue;
    return { q: h.q, r: h.r };
  }
  return { q: from.q, r: from.r }; // nowhere to spread to: they crowd the ship
}

/** A name nobody else on the roster is using. */
function drawHandName(state) {
  const taken = new Set(state.crew.members.map((m) => m.name));
  const free = C.HAND_NAMES.filter((n) => !taken.has(n));
  if (!free.length) return `Hand ${state.crew.members.length + 1}`;
  return free[drawInt(state, free.length)];
}

/** Put one body on the island. Officers keep their own id, hands take h1, h2, … */
export function landCrew(state, id, kind, from = state.base) {
  const at = landingSpot(state, from);
  const m = { id, kind, q: at.q, r: at.r, name: null };
  if (kind === 'hand') m.name = drawHandName(state);
  else m.name = (officerById(state, id) || {}).name || id;
  state.crew.members.push(m);
  return m;
}

/** What to call a worker in the interface. */
export function crewName(state, who) {
  const m = memberById(state, who);
  if (m && m.name) return m.name;
  const o = officerById(state, who);
  return o ? o.name : who;
}

/** `n` fresh hands ashore, lowest free number first. */
export function landHands(state, n, from = state.base) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(landCrew(state, nextHandId(state), 'hand', from));
  return out;
}

export function nextHandId(state) {
  const taken = new Set(state.crew.members.map((m) => m.id));
  for (let i = 1; ; i++) if (!taken.has(`h${i}`)) return `h${i}`;
}

export const memberById = (state, id) => state.crew.members.find((m) => m.id === id);
export const handCount = (state) => state.crew.members.filter((m) => m.kind === 'hand').length;
export const crewCount = (state) => state.crew.members.length;

/** Everyone standing on a tile, for the map's dots. */
export function membersAt(state, q, r) {
  return state.crew.members.filter((m) => m.q === q && m.r === r);
}

// ---- ids, rng, log ---------------------------------------------------------

export const nextId = (state, prefix) => `${prefix}${++state.ids}`;

export function draw(state) {
  const rng = { s: state.rngState };
  const v = next(rng);
  state.rngState = rng.s;
  return v;
}
export const drawInt = (state, n) => Math.floor(draw(state) * n);
export const drawPick = (state, arr) => arr[drawInt(state, arr.length)];

export function addLog(state, text) {
  state.log.push({ turn: state.turn, text });
  if (state.log.length > 200) state.log.shift();
}

// ---- map queries -----------------------------------------------------------

export const tileAt = (state, q, r) => state.map.tiles.get(key(q, r));
export const tileOf = (state, p) => state.map.tiles.get(key(p.q, p.r));
export const terrainDef = (tile) => C.TERRAIN[tile.terrain];

export function touchMap(state) { state.map.version++; }

/**
 * Passable for an enemy, and which kind of enemy movement is asking.
 *
 * `advance` is the turn-based march across the island; `assault` is the
 * real-time resolve, once they are in contact and coming at the hull. A tile
 * can allow one and refuse the other. Either way a tower or a building on it
 * is a wall.
 */
export function isPassable(state, tile, phase = 'advance') {
  if (!tile) return false;
  if (tile.occupant && (tile.occupant.kind === 'tower' || tile.occupant.kind === 'building')) return false;
  if (tile.bridge) return true;
  const def = C.TERRAIN[tile.terrain];
  return phase === 'assault' ? !!def.assaultPassable : !!def.passable;
}

/** A road tile, or a bridge — the thing an advancing cohort enters. */
export const isRoad = (tile) => !!tile && (tile.bridge || (tile.terrain === 'road' && tile.cleared));

export const isClearable = (state, tile) =>
  !!tile && !tile.cleared && C.TERRAIN[tile.terrain].clearable && !tile.occupant;

/** Can a structure stand here? `forTower` also allows cliff. */
export function isBuildable(state, tile, forTower = false) {
  // an unworked spring or officer site is not ground to build over
  if (!tile || tile.occupant) return false;
  if (!tile.featureWorked && (tile.feature === 'spring' || tile.feature === 'officer')) return false;
  if (tile.bridge) return true;
  const def = C.TERRAIN[tile.terrain];
  if (def.buildable === 'towers') return forTower;
  if (!def.buildable) return false;
  // Virgin ground must be cut open first — but only ground that has something
  // on it to cut. A meadow is already open and can never be cleared, so asking
  // for `cleared` on one is asking for a state it can never reach: it is built
  // on as it stands, which is the whole of what a natural clearing is worth.
  return tile.cleared || (!def.clearable && isOpenGround(tile));
}

/** Line of sight: canopy blocks fire over itself. Endpoints do not block. */
export function hasSight(state, from, to, lineFn) {
  const l = lineFn(from, to);
  for (let i = 1; i < l.length - 1; i++) {
    const t = tileAt(state, l[i].q, l[i].r);
    if (t && t.terrain === 'canopy' && !t.cleared) return false;
  }
  return true;
}

/**
 * Ground lying under the canopy: any tile touching a standing canopy tile.
 * Nothing there can be fired at — the branches close over it. Cleared canopy
 * is road and casts no shadow.
 *
 * On `cacheFor` like every other derived view. It used to keep a module-level
 * cache of its own keyed on (seed, version) — the exact shape the note above
 * `cacheFor` says is wrong, and for the exact reason: two states of the same
 * seed reach the same version numbers and were handed each other's shadow, so
 * a tower fired at ground that was still under standing canopy on its own map.
 */
export function canopyShadow(state) {
  const cache = cacheFor(state, 'canopy');
  if (cache.version === state.map.version) return cache.value;
  const set = new Set();
  for (const t of state.map.tiles.values()) {
    if (t.terrain !== 'canopy' || t.cleared) continue;
    for (const n of neighbours(t.q, t.r)) set.add(key(n.q, n.r));
  }
  cache.version = state.map.version;
  cache.value = set;
  return set;
}

export const underCanopy = (state, tile) =>
  !!tile && canopyShadow(state).has(key(tile.q, tile.r));

/** Towers fire only into cleared ground, and never under the canopy. */
export function isTargetable(state, tile) {
  if (!tile) return false;
  if (underCanopy(state, tile)) return false;
  if (tile.cleared || tile.bridge) return true;
  return C.TERRAIN[tile.terrain].targetableVirgin;
}

/**
 * Derived views of the map, cached until the map changes.
 *
 * The cache hangs off the state, not off the module. Keying it on seed and
 * version looked equivalent and is not: two states of the same seed — a test
 * fixture beside a live run, two runs side by side — reach the same version
 * numbers and were handed each other's answers.
 */
const cacheFor = (state, name) => {
  if (!state.derived) state.derived = {};
  return (state.derived[name] = state.derived[name] || { version: -1, value: null });
};

/** Road tiles connected to the base through road or bridge. */
export function roadNetwork(state) {
  const cache = cacheFor(state, 'net');
  if (cache.version === state.map.version) return cache.value;
  const set = new Set();
  // The ship's own standing is the root of the network. It is beach, not road —
  // no road is generated anywhere — so seeding from every tile it covers is what
  // lets the first road the player cuts anywhere along its side join up.
  const seeds = (state.island?.footprint ?? [{ q: state.base.q, r: state.base.r }])
    .map((p) => tileAt(state, p.q, p.r)).filter(Boolean);
  if (seeds.length) {
    const queue = [...seeds];
    for (const t of seeds) set.add(key(t.q, t.r));
    while (queue.length) {
      const cur = queue.pop();
      for (const n of neighbours(cur.q, cur.r)) {
        const k = key(n.q, n.r);
        if (set.has(k)) continue;
        const t = state.map.tiles.get(k);
        if (!isRoad(t)) continue;
        if (t.occupant && t.occupant.kind === 'spawner') continue;
        set.add(k);
        queue.push(t);
      }
    }
  }
  cache.version = state.map.version;
  cache.value = set;
  return set;
}

/** Can a worker cross this tile without cutting it open first? Terrain only. */
export const isOpenGround = (tile) =>
  !!tile && (tile.bridge || tile.cleared || C.WORK_OPEN_TERRAIN.includes(tile.terrain));

/**
 * Their own palisade — the one thing they built that they do not walk through.
 * A wall is a wall from both sides, which is what makes a line of them a
 * decision about ground rather than a free fence.
 */
export function blocksCrew(state, tile) {
  if (!tile || !tile.occupant || tile.occupant.kind !== 'building') return false;
  const b = state.buildings.find((x) => x.id === tile.occupant.id);
  return !!b && !!(C.buildingDef(b.type) || {}).blocksCrew;
}

/**
 * Ground a worker may stand on: open terrain, minus what is standing on it.
 *
 * A spawner's mound is sand and reads as cleared, so on terrain alone the reach
 * flooded straight over a hive and offered work on the far side of it — ground
 * whose only join was across the enemy's own tiles. `roadNetwork` had always
 * excluded them; the exclusion simply never reached the walk. A palisade is
 * refused here for the same reason the walk refuses it.
 */
export function isCrewGround(state, tile) {
  if (!isOpenGround(tile)) return false;
  if (tile.occupant && tile.occupant.kind === 'spawner') return false;
  return !blocksCrew(state, tile);
}

/**
 * Everywhere a worker can get to from the ship over open ground.
 *
 * Standing forest is not a road. A hand cuts its way in, so the ground you can
 * put someone to work on is the fringe of what you have already opened — which
 * is what keeps the cleared blob a single growing thing rather than letting
 * work start anywhere on the island.
 */
export function walkableFromBase(state) {
  const cache = cacheFor(state, 'walk');
  if (cache.version === state.map.version) return cache.value;
  const set = new Set();
  const start = tileAt(state, state.base.q, state.base.r);
  if (start) {
    set.add(key(start.q, start.r));
    const queue = [start];
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const n of neighbours(cur.q, cur.r)) {
        const k = key(n.q, n.r);
        if (set.has(k)) continue;
        const t = state.map.tiles.get(k);
        if (!isCrewGround(state, t)) continue;
        set.add(k);
        queue.push(t);
      }
    }
  }
  cache.version = state.map.version;
  cache.value = set;
  return set;
}

/**
 * The tiles the crew are holding: ground a body is standing on, and the face a
 * body has got to. A held tile is walked like open ground whatever it is made
 * of, because someone is demonstrably standing in it.
 *
 * Two ways in. Every body holds the ground under it, and a worker whose walk is
 * over also holds the tile of the job — read off the assignment, not off the
 * member, because the member is only walked onto the job by `runMovement`
 * during the resolve. The panel calls him "working" the moment he arrives, and
 * until this read the assignment the reach still had him at last turn's
 * waypoint: the tile beside a face somebody was plainly cutting answered "no
 * way to walk there".
 *
 * Every body, with no test of what they are standing on, because there is no
 * longer any way to be somewhere illegitimate: a march follows `crewRoute`,
 * which keeps to open ground and to what the crew already hold, so a waypoint
 * is reach by another name. It used to be a real question — the walk forced
 * standing wood where there was no way round, and a body could be parked in
 * deep forest — and the answer was to count nobody in transit, which left a
 * worker stood down on the face he had been cutting with no ground beside him
 * anybody could reach and no way to cut himself out.
 */
export function crewHeld(state) {
  const set = new Set();
  for (const a of state.crew.assignments) {
    if (!arrived(state, a)) continue;
    const p = jobTile(state, a);
    if (p) set.add(key(p.q, p.r));
  }
  for (const m of state.crew.members) set.add(key(m.q, m.r));
  return set;
}

/**
 * Where an assignment stands on the map. The same question `jobPlace` answers
 * in labour.js, kept here too so `crewHeld` does not have to reach across for
 * it — state.js is below labour.js in the import order.
 */
function jobTile(state, a) {
  const t = a.target;
  if (!t) return null;
  if (t.q !== undefined) return { q: t.q, r: t.r };
  const s = state.towers.find((x) => x.id === t) || state.buildings.find((x) => x.id === t);
  if (!s) return null;
  return s.q !== undefined ? { q: s.q, r: s.r } : { q: s.tiles[0].q, r: s.tiles[0].r };
}

/**
 * Everywhere a worker can walk: the open ground the ship reaches, plus every
 * tile the crew hold, plus everything open that opens off those.
 *
 * The crew keep to open ground. Standing forest and rock are not walked at all
 * — a hand cuts his way in — which is what keeps the cleared blob a single
 * growing thing rather than letting work start anywhere on the island. The one
 * exception is a tile somebody is standing on: the way past a worker on his
 * face is past him, so the flood runs on through it.
 *
 * `held` is passed in by the order queue, which knows about jobs that have not
 * become assignments yet: a body who can get to their new face inside this turn
 * will be standing on it when the work starts, and the ground at their elbow is
 * ground the crew will have reached. Left out, it falls back to what the crew
 * hold right now.
 *
 * Not cached: the crew move without the map changing, so this walks out from
 * the cached base set rather than keeping a set of its own. Everything already
 * reachable is skipped, so the extra work is the size of the cut-off scraps.
 */
export function walkableForWork(state, held = crewHeld(state)) {
  const set = new Set(walkableFromBase(state));
  const queue = [];
  for (const k of held) {
    if (set.has(k)) continue;
    set.add(k);
    const p = parseKey(k);
    const t = tileAt(state, p.q, p.r);
    if (t) queue.push(t);
  }
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const n of neighbours(cur.q, cur.r)) {
      const k = key(n.q, n.r);
      if (set.has(k)) continue;
      const t = state.map.tiles.get(k);
      if (!isCrewGround(state, t) && !held.has(k)) continue;
      set.add(k);
      queue.push(t);
    }
  }
  return set;
}

/**
 * Tile counts by terrain over the island, ocean excluded. Recomputed only when
 * the map changes, so clearing a forest tile shows up as road straight away.
 */
export function terrainCensus(state) {
  const cache = cacheFor(state, 'census');
  if (cache.version === state.map.version) return cache.value;
  const counts = {};
  let land = 0;
  let bridges = 0;
  for (const t of state.map.tiles.values()) {
    if (t.terrain === 'saltwater') continue;
    counts[t.terrain] = (counts[t.terrain] || 0) + 1;
    if (t.bridge) bridges++;
    land++;
  }
  const pct = {};
  for (const [k, n] of Object.entries(counts)) pct[k] = (n / land) * 100;
  const value = { land, counts, pct, bridges };
  cache.version = state.map.version;
  cache.value = value;
  return value;
}

// ---- crew ------------------------------------------------------------------

export const officerById = (state, id) => state.crew.officers.find((o) => o.id === id);

/** The best officer holding this role, or null. Bonuses apply only in role. */
export function officerFor(state, role) {
  return state.crew.officers
    .filter((o) => o.role === role)
    .sort((a, b) => b.quality - a.quality)[0] || null;
}

export const assignmentsFor = (state, targetId) =>
  state.crew.assignments.filter((a) => a.kind === 'man' && a.target === targetId);

export const arrived = (state, a) => a.arrivesOnTurn <= state.turn;

/** A worker is either an anonymous hand (h1, h2, ...) or a named officer. */
export const isHand = (who) => who === 'hand' || /^h\d+$/.test(who);

// An assignment row exists only while its worker has a job; when the job ends
// the row goes and the worker is idle again, standing where the job left them.
export function handsUsed(state) {
  return state.crew.assignments.filter((a) => isHand(a.who)).length;
}
export function idleHands(state) {
  return handCount(state) - handsUsed(state);
}
/** Everyone with nothing to do, hands and officers alike, where they stand. */
export function idleMembers(state) {
  const busy = new Set(state.crew.assignments.map((a) => a.who));
  return state.crew.members.filter((m) => !busy.has(m.id));
}
export function idleOfficers(state) {
  const busy = new Set(state.crew.assignments.map((a) => a.who));
  return state.crew.officers.filter((o) => !busy.has(o.id));
}
export function handsCap(state) {
  return state.crew.cap + state.crew.capBonus;
}
/** How many of the crew are cutting ground this turn. */
export function crewClearing(state) {
  return state.crew.assignments.filter((a) => a.kind === 'clear').length;
}

// ---- buildings -------------------------------------------------------------

export const buildingsOfType = (state, type) => state.buildings.filter((b) => b.type === type);

/**
 * The crew a building wants: BUILDING_HANDS, one fewer inside a Bunkhouse's
 * radius, and one fewer again once its crew upgrade is bought. The two stack,
 * so an upgraded yard beside a Bunkhouse runs on nobody at all. A Palisade is
 * not a workshop and never wants anyone.
 */
export function handsNeededFor(state, b) {
  const def = C.buildingDef(b.type);
  if (def && def.crew === 0) return 0;
  const near = state.buildings.some(
    (x) => x.type === 'bunkhouse' && x.complete && !x.ruined
      && x.tiles.some((bt) => b.tiles.some((t) => distance(bt, t) <= C.BUNKHOUSE_RADIUS)),
  );
  const base = near ? C.BUILDING_HANDS_BUNKHOUSE : C.BUILDING_HANDS;
  return Math.max(0, base - (b.upgraded ? 1 : 0));
}

/** How many are actually standing in it, queue not counted. */
export const buildingCrew = (state, b) =>
  assignmentsFor(state, b.id).filter((a) => arrived(state, a)).length;

export function isBuildingManned(state, b) {
  if (!b.complete || b.ruined) return false; // a ruin does nothing until it is rebuilt
  const need = handsNeededFor(state, b);
  if (need <= 0) return true;
  return buildingCrew(state, b) >= need;
}

/** Does a working building of this type exist? */
export function hasBuilding(state, type) {
  return state.buildings.some((b) => b.type === type && isBuildingManned(state, b));
}

// ---- towers ----------------------------------------------------------------

export function towerManning(state, tower) {
  const crew = assignmentsFor(state, tower.id).filter((a) => arrived(state, a));
  const gunner = crew
    .map((a) => officerById(state, a.who))
    .filter((o) => o && o.role === 'man')
    .sort((a, b) => b.quality - a.quality)[0] || null;
  const need = C.manningFor(tower.tier, tower.evolved);
  // a full Master Gunner works a tower alone; a pirate of his trade does not
  const alone = !!gunner && gunner.quality >= 1;
  return { crew, gunner, alone, need, manned: alone || crew.length >= need };
}

export function towerPower(state, tower) {
  const { gunner, manned } = towerManning(state, tower);
  if (!manned) return 0;
  const bonus = gunner ? C.GUNNER_POWER_BONUS * gunner.quality : 0;
  return C.power(tower.tier, tower.evolved) * (1 + bonus);
}

export function towerRange(state, tower) {
  const def = C.TOWERS[tower.towerIndex];
  const tile = tileAt(state, tower.q, tower.r);
  const onCliff = tile && tile.terrain === 'cliff';
  return def.range + (onCliff ? C.CLIFF_RANGE_BONUS : 0);
}

export const totalPower = (state) => state.towers.reduce((sum, t) => sum + towerPower(state, t), 0);

// ---- inventory -------------------------------------------------------------

export const holdCap = (state) => (hasBuilding(state, 'warehouse') ? Infinity : C.HOLD_SLOTS);
export const holdCount = (state, tower, tier) =>
  state.base.hold.filter((it) => it.tower === tower && (tier === undefined || it.tier === tier)).length;
export const holdFree = (state) => holdCap(state) - state.base.hold.length;

// ---- misc ------------------------------------------------------------------

export const baseTiles = (state) => state.island.footprint;
export const distToBase = (state, p) => distance(p, state.base);
