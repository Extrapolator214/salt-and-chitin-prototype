// 02-map.md — the island 1 (Branch Office) generator.
// Deterministic from the seed.
//
// Layout: a round-ish island with a ragged shore, ringed by open ocean. The
// grid is centred on the island. The ship has just landed on the first tile of
// the south beach; the hive stands across the island on the north shore.

import C from './config.js';
import { key, spiral, ring, line, distance, neighbours, atBearing, bearing, angleDiff, axialToPixel } from './hex.js';
import { createRng, next, nextInt, range, intRange, pick, shuffle, fbm } from './rng.js';

const CENTRE = { q: 0, r: 0 }; // the island's centre, not the base
const SOUTH = () => C.LANDING_BEARING;
const NORTH = () => C.LANDING_BEARING + 180;

const newTile = (q, r) => ({
  q, r,
  terrain: null,
  cleared: false,
  feature: null,
  featureWorked: false,
  work: 0,          // turns of cutting banked on this tile
  occupant: null,
  bridge: false,
  fixed: false, // placed by a structure pass; the noise fill skips it
  noise: 0,
});

const get = (tiles, q, r) => tiles.get(key(q, r));
const isFree = (t) => t && !t.fixed && t.terrain === null;

function setTerrain(t, terrain, { cleared = false, fixed = true } = {}) {
  t.terrain = terrain;
  t.cleared = cleared || terrain === 'road';
  t.fixed = fixed;
}

/**
 * Ground that is placed works rather than natural terrain: the ship's
 * standing, the landing corridor, the apron cut around it, and the spawners'
 * own mounds. The terrain mix describes what the island grows, so these sit
 * outside it — on an island this size they would otherwise swamp the 3% road
 * quota on their own.
 */
function setWorks(t, terrain) {
  setTerrain(t, terrain, { cleared: true });
  t.works = true;
}

/** Grow a region outward from seed tiles until it holds `target` tiles. */
function growRegion(tiles, seedKeys, target, score, allow = () => true) {
  const taken = new Set(seedKeys);
  const frontier = new Map();
  const pushNeighbours = (t) => {
    for (const n of neighbours(t.q, t.r)) {
      const nt = get(tiles, n.q, n.r);
      if (isFree(nt) && allow(nt) && !taken.has(key(n.q, n.r))) frontier.set(key(n.q, n.r), nt);
    }
  };
  for (const k of seedKeys) {
    const t = tiles.get(k);
    if (t) pushNeighbours(t);
  }
  const out = [];
  while (out.length < target && frontier.size > 0) {
    let best = null, bestScore = -Infinity;
    for (const t of frontier.values()) {
      const s = score(t);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    frontier.delete(key(best.q, best.r));
    taken.add(key(best.q, best.r));
    out.push(best);
    pushNeighbours(best);
  }
  return out;
}

const passableTerrain = (t) => t && t.terrain && C.TERRAIN[t.terrain].passable;

function reachableFrom(tiles, start) {
  const seen = new Set([key(start.q, start.r)]);
  const queue = [start];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const n of neighbours(cur.q, cur.r)) {
      const k = key(n.q, n.r);
      if (seen.has(k)) continue;
      const t = tiles.get(k);
      if (!passableTerrain(t)) continue;
      seen.add(k);
      queue.push(t);
    }
  }
  return seen;
}

/** Dijkstra that may cross impassable ground at a price, to open a sealed path. */
function carveOpen(tiles, from, to) {
  const cost = new Map(), prev = new Map();
  const startK = key(from.q, from.r), goalK = key(to.q, to.r);
  cost.set(startK, 0);
  const open = [{ k: startK, t: from, c: 0 }];
  while (open.length) {
    open.sort((a, b) => a.c - b.c);
    const cur = open.shift();
    if (cur.c > (cost.get(cur.k) ?? Infinity)) continue;
    if (cur.k === goalK) break;
    for (const n of neighbours(cur.t.q, cur.t.r)) {
      const nk = key(n.q, n.r);
      const nt = tiles.get(nk);
      if (!nt || nt.terrain === 'saltwater') continue;
      const nc = cur.c + (passableTerrain(nt) ? 1 : 400);
      if (nc < (cost.get(nk) ?? Infinity)) {
        cost.set(nk, nc);
        prev.set(nk, cur.k);
        open.push({ k: nk, t: nt, c: nc });
      }
    }
  }
  if (!prev.has(goalK) && startK !== goalK) return 0;
  let k = goalK, carved = 0;
  while (k && k !== startK) {
    const t = tiles.get(k);
    if (t && !passableTerrain(t)) { t.terrain = 'scrub'; t.cleared = false; carved++; }
    k = prev.get(k);
  }
  return carved;
}

function attempt(seed, attemptNo) {
  const rng = createRng(seed + attemptNo * 7919);
  const R = C.MAP_RADIUS;
  const ISLE = C.ISLAND_RADIUS;
  const tiles = new Map();
  for (const h of spiral(CENTRE, R)) tiles.set(key(h.q, h.r), newTile(h.q, h.r));
  for (const t of tiles.values()) {
    const p = axialToPixel(t.q, t.r, 1);
    t.noise = fbm(p.x, p.y, seed + attemptNo * 131, 3, 1 / 11);
  }
  const notes = { carved: 0 };

  // ---- 3.1 The coastline --------------------------------------------------
  // The shore radius wanders with two noises: broad lobes that make bays and
  // headlands, and a per-tile jag that keeps the waterline ragged.
  const coastSeed = seed + attemptNo * 977;
  const lobeAt = (deg) => {
    const rad = (deg * Math.PI) / 180;
    return fbm(Math.cos(rad) * 4 + 100, Math.sin(rad) * 4 + 100, coastSeed, 2, 1);
  };
  for (const t of tiles.values()) {
    const d = distance(t, CENTRE);
    if (d === 0) { t.terrain = null; continue; }
    const lobe = (lobeAt(bearing(CENTRE, t)) - 0.5) * 2 * C.COAST_LOBES;
    const jag = (t.noise - 0.5) * 2 * C.COAST_JAG;
    if (d > ISLE + lobe + jag) setTerrain(t, 'saltwater');
  }
  // ---- 3.1a Bays and straits ---------------------------------------------
  // One or two intrusions of salt water, cut before the landmass is settled so
  // that anything they sever is tidied away with the rafts below.
  const waterFeatures = [];
  {
    const wasSea = new Set();
    for (const t of tiles.values()) if (t.terrain === 'saltwater') wasSea.add(key(t.q, t.r));
    const nearOldSea = (p, d) => spiral(p, d).some((h) => wasSea.has(key(h.q, h.r)));
    const want = intRange(rng, C.WATER_FEATURE_COUNT[0], C.WATER_FEATURE_COUNT[1]);
    for (let i = 0, guard = 0; i < want && guard < 300; guard++) {
      const theta = next(rng) * 360;
      if (angleDiff(theta, SOUTH()) < C.WATER_FEATURE_OFF_LANDING) continue;
      if (waterFeatures.some((f) => angleDiff(f.bearing, theta) < C.WATER_FEATURE_OFF_LANDING)) continue;
      // the mouth: the outermost land tile on this bearing
      let mouth = null;
      for (let d = R; d >= 1 && !mouth; d--) {
        const p = atBearing(CENTRE, theta, d);
        const t = get(tiles, p.q, p.r);
        if (t && t.terrain !== 'saltwater') mouth = p;
      }
      if (!mouth) continue;
      const inward = bearing(mouth, CENTRE);
      const kind = next(rng) < 0.5 ? 'bay' : 'strait';
      const cut = [];
      if (kind === 'bay') {
        // wide at the sea, tapering to nothing inland
        const mouthW = intRange(rng, C.BAY_MOUTH[0], C.BAY_MOUTH[1]);
        const len = intRange(rng, C.BAY_LENGTH[0], C.BAY_LENGTH[1]);
        for (let d = 0; d <= len; d++) {
          const centre = atBearing(mouth, inward, d);
          const w = Math.round((mouthW / 2) * (1 - d / (len + 1)));
          for (const h of spiral(centre, Math.max(0, w))) {
            const t = get(tiles, h.q, h.r);
            if (t && t.terrain !== 'saltwater' && !t.occupant) cut.push(t);
          }
        }
      } else {
        // a narrow channel, stopped short of whatever water lies beyond it so
        // the island is divided rather than severed
        const w = intRange(rng, C.STRAIT_WIDTH[0], C.STRAIT_WIDTH[1]);
        const len = intRange(rng, C.STRAIT_LENGTH[0], C.STRAIT_LENGTH[1]);
        for (let d = 0; d <= len; d++) {
          const centre = atBearing(mouth, inward, d);
          if (d > 3 && nearOldSea(centre, C.STRAIT_STOP_SHORT)) break;
          const across = w === 1 ? [centre] : [centre, atBearing(centre, inward + 90, 1)];
          for (const c of across) {
            const t = get(tiles, c.q, c.r);
            if (t && t.terrain !== 'saltwater' && !t.occupant) cut.push(t);
          }
        }
      }
      if (cut.length < 6) continue;
      for (const t of cut) setTerrain(t, 'saltwater');
      waterFeatures.push({ kind, bearing: theta, q: mouth.q, r: mouth.r, tiles: cut.length });
      i++;
    }
  }

  // no lakes and no rafts: keep only the landmass connected to the centre
  const landBody = new Set();
  {
    const start = get(tiles, 0, 0);
    const queue = [start];
    landBody.add(key(0, 0));
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      for (const n of neighbours(cur.q, cur.r)) {
        const k = key(n.q, n.r);
        if (landBody.has(k)) continue;
        const t = tiles.get(k);
        if (!t || t.terrain === 'saltwater') continue;
        landBody.add(k);
        queue.push(t);
      }
    }
    for (const t of tiles.values()) {
      if (t.terrain === null && !landBody.has(key(t.q, t.r))) setTerrain(t, 'saltwater');
    }
  }

  // ---- 3.1b The landing ---------------------------------------------------
  // Walk in from the rim on the landing bearing; the first land tile is where
  // the ship grounds.
  let base = null;
  for (let d = R; d >= 1 && !base; d--) {
    const p = atBearing(CENTRE, SOUTH(), d);
    const t = get(tiles, p.q, p.r);
    if (t && t.terrain !== 'saltwater' && landBody.has(key(p.q, p.r))) base = t;
  }
  if (!base) return null;

  // the base holds 7 tiles: the beach tile it stands on, then inland
  const foot = [base];
  for (const h of spiral(base, 2)) {
    if (foot.length >= C.BASE_FOOTPRINT) break;
    const t = get(tiles, h.q, h.r);
    if (!t || t === base || t.terrain === 'saltwater') continue;
    if (!foot.some((f) => distance(f, t) === 1)) continue;
    foot.push(t);
  }
  if (foot.length < C.BASE_FOOTPRINT) return null;
  // The ship is beached, not parked on a road. Its standing is sand — open
  // ground a hand can walk, and ground no road will ever run over, so the first
  // road out of the landing is a tile the player chose to cut.
  for (const t of foot) {
    setWorks(t, 'sand');
    t.beach = true;
    t.occupant = { kind: 'base', id: 'base' };
  }
  const inlandBearing = bearing(base, CENTRE);

  // ---- 3.1c Beaches -------------------------------------------------------
  // How far back from the waterline a tile sits, out to the depth a beach can
  // reach. Everything past that is inland by definition.
  const shore = new Map();
  {
    const depth = Math.max(C.LANDING_BEACH_DEPTH, 2);
    const queue = [];
    for (const t of tiles.values()) {
      if (t.terrain === 'saltwater') { shore.set(key(t.q, t.r), 0); queue.push(t); }
    }
    let head = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      const d = shore.get(key(cur.q, cur.r));
      if (d >= depth) continue;
      for (const n of neighbours(cur.q, cur.r)) {
        const nk = key(n.q, n.r);
        const nt = tiles.get(nk);
        if (!nt || shore.has(nk)) continue;
        shore.set(nk, d + 1);
        queue.push(nt);
      }
    }
  }
  const onShore = (t, depth) => (shore.get(key(t.q, t.r)) ?? 99) <= depth;

  // Beach is a place, not a rule about coastlines: the cove the ship was run
  // into, and a handful more round the rim. The rest of the island grows right
  // down to the water. Beaches sit outside the terrain mix, which is measured
  // over the ground the island actually grows.
  const beaches = [base];
  const makeBeach = (t) => { setTerrain(t, 'sand'); t.beach = true; };
  const seaward = inlandBearing + 180;
  for (const h of spiral(base, C.LANDING_BEACH_SPAN)) {
    const t = get(tiles, h.q, h.r);
    if (!isFree(t) || !onShore(t, C.LANDING_BEACH_DEPTH)) continue;
    if (angleDiff(bearing(base, t), seaward) > C.LANDING_BEACH_ARC) continue;
    makeBeach(t);
  }
  // ---- 3.1d The apron -----------------------------------------------------
  // A tile of sand all the way round the ship's standing, landward face and
  // all. What it buys is that nothing is ever jammed against the hull: no
  // cliff, no standing wood, no stream, and no cove wall closing on the ramp.
  // A hand walks off the ship in any direction and has ground under them.
  //
  // Sand can never be cut, so an apron would once have sealed the ship off
  // from every road it was ever going to cut. It no longer does: the network is
  // open ground rather than road (see `shipNetwork`), so the apron joins the
  // hull to the first road cut at its edge. The sea is left where it is — the
  // ship is beached, and its back is to the water.
  const inFoot = new Set(foot.map((t) => key(t.q, t.r)));
  const apron = [];
  for (const f of foot) {
    for (const h of spiral(f, C.LANDING_APRON)) {
      const t = get(tiles, h.q, h.r);
      if (!t || inFoot.has(key(t.q, t.r)) || t.terrain === 'saltwater') continue;
      if (apron.includes(t)) continue;
      makeBeach(t);
      apron.push(t);
    }
  }

  // The ship has to be able to start a road, and now it starts one at the
  // apron's edge rather than against the hull. A landing whose apron opens onto
  // nothing but more sand, cliff and water is a dead run — reroll instead.
  const exits = new Set();
  for (const a of apron) {
    for (const n of neighbours(a.q, a.r)) {
      const t = get(tiles, n.q, n.r);
      if (isFree(t)) exits.add(key(t.q, t.r));
    }
  }
  if (exits.size < C.LANDING_EXITS_MIN) return null;
  const edgeBeaches = intRange(rng, C.EDGE_BEACH_COUNT[0], C.EDGE_BEACH_COUNT[1]);
  for (let i = 0, guardB = 0; i < edgeBeaches && guardB < 400; guardB++) {
    const theta = next(rng) * 360;
    let seed = null;
    for (let d = R; d >= 1 && !seed; d--) {
      const p = atBearing(CENTRE, theta, d);
      const t = get(tiles, p.q, p.r);
      if (isFree(t) && onShore(t, 1)) seed = t;
    }
    if (!seed || beaches.some((b) => distance(b, seed) < C.EDGE_BEACH_MIN_APART)) continue;
    beaches.push(seed);
    i++;
    makeBeach(seed);
    const size = intRange(rng, C.EDGE_BEACH_SIZE[0], C.EDGE_BEACH_SIZE[1]);
    const grown = growRegion(
      tiles, [key(seed.q, seed.r)], size - 1,
      (t) => -distance(t, seed) + t.noise,
      (t) => onShore(t, C.LANDING_BEACH_DEPTH),
    );
    for (const t of grown) makeBeach(t);
  }

  // ---- 3.2 Landing corridor ----------------------------------------------
  // The corridor is the way inland, not a road laid down for you. Nothing here
  // is cut or cleared: it names the bearing the cove wall leaves a gap on, the
  // ground the canopy is planted beside, and the line the player's first road
  // will most likely follow.
  const corridorBearing = inlandBearing + range(rng, -20, 20);
  const perp = (deg) => deg + 90;
  const corridorTiles = [];
  for (let d = 2; d <= 11; d++) {
    const p = atBearing(base, corridorBearing, d);
    const a = atBearing(p, perp(corridorBearing), 1);
    const b = atBearing(p, perp(corridorBearing) + 180, 1);
    for (const c of [p, a, b]) {
      const t = get(tiles, c.q, c.r);
      if (t && t.terrain !== 'saltwater' && !t.occupant) corridorTiles.push(t);
    }
  }
  const corridorMouth = atBearing(base, corridorBearing, 11);

  // ---- 3.3 Spawners -------------------------------------------------------
  // The hive stands across the island from the landing; the shell spawner
  // flanks it, both just inside the far shore.
  let spawnerPlan = null;
  for (let tries = 0; tries < 80 && !spawnerPlan; tries++) {
    const hiveBearing = NORTH() + range(rng, -C.HIVE_JITTER, C.HIVE_JITTER);
    const side = next(rng) < 0.5 ? -1 : 1;
    const flankBearing = NORTH() + side * range(rng, C.FLANK_OFFSET[0], C.FLANK_OFFSET[1]);
    const plan = [];
    let good = true;
    for (const [idx, theta] of [hiveBearing, flankBearing].entries()) {
      const def = C.SPAWNERS[idx]; // SPAWNERS[0] is the hive
      // slide in from the shore until the whole footprint is on clear land
      let placed = null;
      for (let d = ISLE + Math.ceil(C.COAST_LOBES); d >= ISLE - 8 && !placed; d--) {
        const at = atBearing(CENTRE, theta, d - C.SPAWNER_INSET);
        const f = spiral(at, 2).slice(0, def.footprint);
        const ok = f.every((x) => {
          const t = get(tiles, x.q, x.r);
          return t && t.terrain !== 'saltwater' && !t.occupant && landBody.has(key(x.q, x.r));
        });
        if (ok) placed = { at, foot: f };
      }
      if (!placed) { good = false; break; }
      plan.push({ def, theta, at: placed.at, foot: placed.foot });
    }
    if (!good) continue;
    // as seen from the ship the two must be a real fork, not one target
    const b0 = bearing(base, plan[0].at), b1 = bearing(base, plan[1].at);
    if (angleDiff(b0, b1) < C.SPAWNER_MIN_SEPARATION_DEG) continue;
    if (plan.some((p) => distance(p.at, base) < ISLE)) continue;
    spawnerPlan = plan;
  }
  if (!spawnerPlan) return null;

  const spawners = spawnerPlan.map((p, i) => {
    for (const f of p.foot) {
      const t = get(tiles, f.q, f.r);
      setWorks(t, 'sand'); // the mound they have trodden bare, not a road
      t.occupant = { kind: 'spawner', id: `sp${i}` };
    }
    return {
      id: `sp${i}`, kind: p.def.kind, name: p.def.name, q: p.at.q, r: p.at.r,
      stars: p.def.stars, cap: p.def.cap, grubShare: p.def.grubShare, alive: true,
      bearing: bearing(base, p.at),
      footprint: p.foot.map((f) => ({ q: f.q, r: f.r })),
      mode: 'accumulate', accumulatedTurns: 0,
    };
  });

  const waterCount = [...tiles.values()].filter((t) => t.terrain === 'saltwater').length;
  const landCount = tiles.size - waterCount;

  // ---- quotas (over the ground the island still has to grow) -------------
  const all = [...tiles.values()];
  const outsideMix = all.filter((t) => t.beach || t.works).length;
  const naturalCount = all.filter((t) => t.terrain === null).length;
  const quota = {};
  for (const [terr, pct] of Object.entries(C.MIX_NATURAL)) quota[terr] = Math.round((pct / 100) * naturalCount);
  const placed = () => {
    const n = {};
    for (const t of tiles.values()) if (t.terrain && !t.beach && !t.works) n[t.terrain] = (n[t.terrain] || 0) + 1;
    return n;
  };

  // ---- 3.4 Structure pass — Branch Office --------------------------------
  const clearOfBase = (t) => distance(t, base) > C.STRUCTURE_KEEPOUT;

  // ---- the cove wall ------------------------------------------------------
  // A broken ring of cliff round the land side of the landing. The sea closes
  // the rest, so the ship sits in a cove rather than in the open. The wall is
  // impassable to a cohort, so what it really places is the gaps: one on the
  // corridor bearing — the way inland is never sealed — and one or two more,
  // each a lane a gun line can be built to cover.
  const gapHalf = () => range(rng, C.LANDING_CLIFF_GAP_HALF[0], C.LANDING_CLIFF_GAP_HALF[1]);
  const gaps = [{ deg: corridorBearing, half: gapHalf() }];
  const wantGaps = intRange(rng, C.LANDING_ENTRANCES[0], C.LANDING_ENTRANCES[1]);
  for (let i = 1, guardG = 0; i < wantGaps && guardG < 200; guardG++) {
    const deg = inlandBearing + range(rng, -C.LANDING_CLIFF_ARC, C.LANDING_CLIFF_ARC);
    if (gaps.some((g) => angleDiff(g.deg, deg) < g.half + 22)) continue;
    gaps.push({ deg, half: gapHalf() });
    i++;
  }
  const inGap = (deg) => gaps.some((g) => angleDiff(g.deg, deg) < g.half);
  // The wall counts against the cliff quota but is never grown from: it is a
  // wall, and a wall that thickens into a headland closes the gaps it exists to
  // leave. For the same reason no other cliff is allowed to grow into the cove.
  const wallTiles = [];
  const clearOfLanding = (t) => distance(t, base) > C.LANDING_CLIFF_RADIUS + C.LANDING_CLIFF_COURSES + 1;
  for (let course = 0; course < C.LANDING_CLIFF_COURSES; course++) {
    for (const p of ring(base, C.LANDING_CLIFF_RADIUS + course)) {
      const t = get(tiles, p.q, p.r);
      if (!isFree(t) || !clearOfBase(t)) continue;
      const deg = bearing(base, p);
      if (angleDiff(deg, inlandBearing) > C.LANDING_CLIFF_ARC) continue;
      if (inGap(deg)) continue;
      // the outer courses are ragged, so the wall reads as broken rock rather
      // than as a drawn arc
      if (course > 0 && t.noise < 0.2 + 0.25 * course) continue;
      setTerrain(t, 'cliff');
      wallTiles.push(t);
    }
  }

  // fresh water: streams draining from a hub inland of the landing out to the coast
  const freshHub = atBearing(base, inlandBearing, C.STRUCTURE_KEEPOUT + 1);
  const spokeCount = intRange(rng, 3, 4);
  const LAND_HALF_ARC = 105;
  // One spoke is aimed deliberately between the two spawners, so the wedge each
  // sits in is a different one and the fork is a real fork.
  const midSpoke = (() => {
    const a = bearing(freshHub, spawners[0]), b = bearing(freshHub, spawners[1]);
    let mid = (a + b) / 2;
    if (angleDiff(mid, a) > 90) mid = (mid + 180) % 360;
    return mid;
  })();
  let spokeBearings = null;
  for (let tries = 0; tries < 60 && !spokeBearings; tries++) {
    const bs = [midSpoke];
    for (let i = 0; i < spokeCount - 1; i++) {
      const t = spokeCount === 2 ? 1 : i / (spokeCount - 2);
      const spread = -LAND_HALF_ARC + t * 2 * LAND_HALF_ARC;
      const b = (midSpoke + 180 + spread * 0.6 + range(rng, -15, 15) + 360) % 360;
      if (bs.every((x) => angleDiff(x, b) > 20)) bs.push(b);
    }
    bs.sort((a, b) => a - b);
    const wedgeOf = (deg) => {
      const d = ((deg % 360) + 360) % 360;
      let w = 0;
      for (let i = 0; i < bs.length; i++) if (d >= bs[i]) w = i + 1;
      return w % bs.length;
    };
    const w0 = wedgeOf(bearing(freshHub, spawners[0]));
    const w1 = wedgeOf(bearing(freshHub, spawners[1]));
    const clearOfCorridor = bs.every((b) => angleDiff(b, corridorBearing) > 14);
    if (w0 !== w1 && clearOfCorridor) spokeBearings = bs;
  }
  if (!spokeBearings) return null;

  const freshSeeds = [];
  for (const b of spokeBearings) {
    const width = intRange(rng, 1, 2);
    const far = atBearing(freshHub, b, R + 5);
    for (const p of line(freshHub, far)) {
      if (distance(p, CENTRE) > R) break;
      const across = width === 1 ? [p] : [p, atBearing(p, perp(b), 1)];
      for (const c of across) {
        const t = get(tiles, c.q, c.r);
        if (isFree(t) && clearOfBase(t)) { setTerrain(t, 'freshwater'); freshSeeds.push(key(t.q, t.r)); }
      }
    }
  }
  const freshGap = quota.freshwater - freshSeeds.length;
  if (freshGap > 0) {
    for (const t of growRegion(tiles, freshSeeds, freshGap, (t) => -t.noise, clearOfBase)) setTerrain(t, 'freshwater');
  }

  // cliff: one ridge at ~0.5 of the island radius, perpendicular to its radius
  const cliffBearing = next(rng) * 360;
  const ridgeCentre = atBearing(CENTRE, cliffBearing, Math.round(ISLE * 0.5));
  const ridgeLen = intRange(rng, 12, 18);
  const ridgeWidth = intRange(rng, 1, 2);
  const cliffSeeds = [];
  const cliffOk = (t) => clearOfBase(t) && clearOfLanding(t);
  for (const sign of [0, 180]) {
    const far = atBearing(ridgeCentre, perp(cliffBearing) + sign, Math.ceil(ridgeLen / 2));
    for (const p of line(ridgeCentre, far)) {
      const across = ridgeWidth === 1 ? [p] : [p, atBearing(p, cliffBearing, 1)];
      for (const c of across) {
        const t = get(tiles, c.q, c.r);
        if (isFree(t) && cliffOk(t)) { setTerrain(t, 'cliff'); cliffSeeds.push(key(t.q, t.r)); }
      }
    }
  }
  const cliffGap = quota.cliff - cliffSeeds.length - wallTiles.length;
  if (cliffGap > 0 && cliffSeeds.length) {
    for (const t of growRegion(tiles, cliffSeeds, cliffGap, (t) => t.noise, cliffOk)) setTerrain(t, 'cliff');
  }

  // boulders: loose clusters of 3-5 stone until the stone quota is met
  let stoneLeft = quota.stone;
  let guard = 0;
  while (stoneLeft > 0 && guard++ < 8000) {
    const p = atBearing(CENTRE, next(rng) * 360, intRange(rng, 1, ISLE));
    const seed = get(tiles, p.q, p.r);
    if (!isFree(seed) || !clearOfBase(seed)) continue;
    const size = Math.min(stoneLeft, intRange(rng, 3, 5));
    setTerrain(seed, 'stone');
    stoneLeft--;
    for (const t of growRegion(tiles, [key(seed.q, seed.r)], size - 1, (t) => t.noise, clearOfBase)) {
      setTerrain(t, 'stone');
      stoneLeft--;
    }
  }

  // iron: the same idea as boulders but meaner — seams of 1-3, scattered, and
  // never within the keep-out, so the ore is something you go and find
  let ironLeft = quota.iron || 0;
  guard = 0;
  while (ironLeft > 0 && guard++ < 8000) {
    const p = atBearing(CENTRE, next(rng) * 360, intRange(rng, 1, ISLE));
    const seed = get(tiles, p.q, p.r);
    if (!isFree(seed) || !clearOfBase(seed)) continue;
    const size = Math.min(ironLeft, intRange(rng, 1, 3));
    setTerrain(seed, 'iron');
    ironLeft--;
    for (const t of growRegion(tiles, [key(seed.q, seed.r)], size - 1, (t) => t.noise, clearOfBase)) {
      setTerrain(t, 'iron');
      ironLeft--;
    }
  }

  // canopy: one stand of 8-14 tiles adjacent to the landing corridor
  const canopyStand = intRange(rng, 8, 14);
  const corridorEdge = [];
  for (const t of corridorTiles) {
    for (const n of neighbours(t.q, t.r)) {
      const nt = get(tiles, n.q, n.r);
      if (isFree(nt)) corridorEdge.push(key(nt.q, nt.r));
    }
  }
  if (corridorEdge.length) {
    const seedK = pick(rng, corridorEdge);
    setTerrain(tiles.get(seedK), 'canopy');
    for (const t of growRegion(tiles, [seedK], canopyStand - 1, (t) => t.noise)) setTerrain(t, 'canopy');
  }

  // ---- 3.5 Terrain fill ---------------------------------------------------
  const unassigned = [...tiles.values()].filter((t) => t.terrain === null).sort((a, b) => a.noise - b.noise);
  const have = placed();
  // Ordered along the same gradient the sort above puts the tiles in: the
  // driest, flattest ground first and the deepest wood last. The meadow sits
  // between the sand and the scrub, which is what makes it come out in patches
  // rather than scattered — neighbouring noise values are neighbouring ground.
  const fillOrder = ['salt', 'sand', 'meadow', 'scrub', 'forest', 'canopy'];
  const want = fillOrder.map((terr) => Math.max(0, quota[terr] - (have[terr] || 0)));
  const wantTotal = want.reduce((a, b) => a + b, 0);
  want[fillOrder.indexOf('forest')] += unassigned.length - wantTotal;
  let cursor = 0;
  for (let i = 0; i < fillOrder.length; i++) {
    for (let n = 0; n < want[i] && cursor < unassigned.length; n++, cursor++) {
      setTerrain(unassigned[cursor], fillOrder[i], { fixed: false });
    }
  }
  for (; cursor < unassigned.length; cursor++) setTerrain(unassigned[cursor], 'forest', { fixed: false });

  // ---- the cove's entrances -----------------------------------------------
  // The wall is only worth having if there is more than one way through it: two
  // ways in is a choice about where to stand, one is a corridor. The passes
  // above can silt a gap up — a stream spoke crosses it, a boulder field grows
  // into it — so every gap is walked once the ground is settled and dug back
  // open if it has closed. Salt water is the one thing that cannot be undone,
  // and an island that ends up short of entrances is rejected.
  {
    // A lane has to run the whole depth of the wall on one bearing: a hole in
    // the inner course and another in the outer one, twenty degrees apart, is
    // not a way through.
    // The lane is the radial line out through the wall band, so its tiles are
    // adjacent by construction — two holes on roughly the same bearing but not
    // touching are not a way through.
    const outer = C.LANDING_CLIFF_RADIUS + C.LANDING_CLIFF_COURSES - 1;
    const laneOf = (g) => line(base, atBearing(base, g.deg, outer + 1))
      .filter((p) => distance(p, base) >= C.LANDING_CLIFF_RADIUS && distance(p, base) <= outer)
      .map((p) => get(tiles, p.q, p.r))
      .filter(Boolean);
    let open = 0;
    for (const g of gaps) {
      const lane = laneOf(g);
      const shut = lane.filter((t) => !C.TERRAIN[t.terrain].passable);
      if (shut.some((t) => t.terrain === 'saltwater' || t.occupant)) continue; // the sea took this one
      for (const t of shut) setTerrain(t, 'scrub', { fixed: false });
      open++;
    }
    if (open < C.LANDING_ENTRANCES[0]) return null;
    notes.entrances = open;
  }

  // ---- the ship's road exits ----------------------------------------------
  // The apron's edge is where the first road is cut, so there has to be ground
  // out there worth cutting. The fill can drop sand, salt or meadow all round
  // it, and none of the three can ever be cut, so a landing can end up open on
  // every side and with nowhere to start a road.
  // Whatever is left there is turned back into scrub — thin ground, one turn of
  // work, but ground a road can begin on.
  {
    const faces = [];
    for (const a of apron) {
      for (const n of neighbours(a.q, a.r)) {
        const t = get(tiles, n.q, n.r);
        if (!t || t.occupant || t.terrain === 'saltwater') continue;
        if (t.beach || t.works || faces.includes(t)) continue;
        faces.push(t);
      }
    }
    const clearable = () => faces.filter((t) => C.TERRAIN[t.terrain].clearable).length;
    for (const t of faces) {
      if (clearable() >= C.LANDING_EXITS_MIN) break;
      if (C.TERRAIN[t.terrain].clearable) continue;
      setTerrain(t, 'scrub', { fixed: false });
    }
    if (clearable() < C.LANDING_EXITS_MIN) return null;
  }

  // ---- connectivity -------------------------------------------------------
  for (const sp of spawners) {
    const seen = reachableFrom(tiles, base);
    if (!seen.has(key(sp.q, sp.r))) notes.carved += carveOpen(tiles, get(tiles, sp.q, sp.r), base);
  }

  // ---- 3.6 Features -------------------------------------------------------
  const features = [];
  const featureOk = (t) => {
    if (!t || t.feature || t.occupant) return false;
    if (!passableTerrain(t) || t.terrain === 'road') return false;
    return features.every((f) => distance(f, t) >= C.FEATURE_MIN_APART);
  };
  const placeFeature = (t, kind) => {
    t.feature = kind;
    features.push({ q: t.q, r: t.r, kind });
  };
  const fromBase = (deg, dist) => {
    const p = atBearing(base, deg, dist);
    return get(tiles, p.q, p.r);
  };

  // Treasure is layered. A tile is three turns of cutting, so a chest eighteen
  // tiles inland is most of an act away — and gold buys a gun outright, where
  // iron wants a Forge and a Workshop standing first. `CACHE_NEAR` guarantees
  // the first few are within reach of the landing; the rest are scattered
  // across the island as before.
  const [lo, hi] = C.CACHE_DIST;
  const [nearLo, nearHi] = C.CACHE_NEAR;
  let caches = 0;
  for (let i = 0; i < 20000 && caches < C.CACHE_NEAR_COUNT; i++) {
    const t = fromBase(next(rng) * 360, intRange(rng, nearLo, nearHi));
    if (featureOk(t)) { placeFeature(t, 'cache'); caches++; }
  }
  for (let i = 0; i < 40000 && caches < C.FEATURES.cache.count; i++) {
    const t = fromBase(next(rng) * 360, intRange(rng, lo, hi));
    if (featureOk(t)) { placeFeature(t, 'cache'); caches++; }
  }
  if (caches < C.FEATURES.cache.count) return null;

  // spring: half way inland, in the wedge between the two spawner bearings
  const between = (() => {
    const a = spawners[0].bearing, b = spawners[1].bearing;
    let mid = (a + b) / 2;
    if (angleDiff(mid, a) > 90) mid = (mid + 180) % 360;
    return mid;
  })();
  let spring = null;
  for (let i = 0; i < 8000 && !spring; i++) {
    const t = fromBase(between + range(rng, -35, 35), Math.round(range(rng, 0.4 * 2 * ISLE, 0.6 * 2 * ISLE)));
    if (featureOk(t)) { placeFeature(t, 'spring'); spring = t; }
  }
  if (!spring) return null;

  // officer site: half way out, within 30 degrees of a spawner so the march
  // crosses a lane
  let officerSite = null;
  for (let i = 0; i < 8000 && !officerSite; i++) {
    const sp = pick(rng, spawners);
    const t = fromBase(sp.bearing + range(rng, -30, 30), Math.round(range(rng, 0.45 * 2 * ISLE, 0.55 * 2 * ISLE)));
    if (featureOk(t)) { placeFeature(t, 'officer'); officerSite = t; }
  }
  if (!officerSite) return null;

  // shipwrecks: along the beach near the landing
  // A wreck has to be ground a hand can end up standing on, or it is scenery for
  // the whole run: either ground that can be cut open, or ground that is already
  // walkable. Cliff and fresh water are neither, and used to take one wreck in
  // six between them.
  const workable = (t) => C.TERRAIN[t.terrain].clearable || C.WORK_OPEN_TERRAIN.includes(t.terrain);
  const onBeach = shuffle(rng, [...tiles.values()].filter((t) => {
    const d = distance(t, base);
    if (d < 4 || d > 16) return false;
    if (t.occupant || t.feature || t.terrain === 'saltwater') return false;
    if (!workable(t)) return false;
    return neighbours(t.q, t.r).some((n) => get(tiles, n.q, n.r)?.terrain === 'saltwater');
  }));
  let wrecks = 0;
  for (const apart of [6, 5, 4]) {
    for (const t of onBeach) {
      if (wrecks >= C.FEATURES.wreck.count) break;
      if (t.feature) continue;
      if (features.every((f) => distance(f, t) >= apart)) { placeFeature(t, 'wreck'); wrecks++; }
    }
    if (wrecks >= C.FEATURES.wreck.count) break;
  }
  if (wrecks < C.FEATURES.wreck.count) return null;

  // ---- 3.7 Acceptance -----------------------------------------------------
  const counts = placed();
  const naturalTotal = Object.keys(C.MIX_NATURAL).reduce((n, terr) => n + (counts[terr] || 0), 0);
  const mix = {};
  for (const terr of Object.keys(C.MIX_NATURAL)) mix[terr] = ((counts[terr] || 0) / naturalTotal) * 100;
  for (const terr of Object.keys(C.MIX_NATURAL)) {
    if (Math.abs(mix[terr] - C.MIX_NATURAL[terr]) > C.MIX_TOLERANCE) return null;
  }
  const clearable = [...tiles.values()].filter((t) => C.TERRAIN[t.terrain].clearable && !t.cleared).length;
  if (clearable / landCount < C.CLEARABLE_FLOOR) return null;

  const flank = new Set();
  for (const t of corridorTiles) {
    for (const n of neighbours(t.q, t.r)) {
      const nt = get(tiles, n.q, n.r);
      if (nt && nt.terrain !== 'road' && nt.terrain !== 'saltwater') flank.add(nt);
    }
  }
  const buildableFlank = [...flank].filter((t) => C.TERRAIN[t.terrain].buildable === true).length;
  if (flank.size && buildableFlank / flank.size < 0.6) return null;

  const reach = reachableFrom(tiles, base);
  for (const sp of spawners) if (!reach.has(key(sp.q, sp.r))) return null;
  if (angleDiff(spawners[0].bearing, spawners[1].bearing) < C.SPAWNER_MIN_SEPARATION_DEG) return null;

  for (const t of tiles.values()) { delete t.fixed; delete t.noise; delete t.beach; delete t.works; }

  return {
    tiles,
    base: { q: base.q, r: base.r },
    baseFootprint: foot.map((t) => ({ q: t.q, r: t.r })),
    spawners, features, waterFeatures,
    corridorMouth,
    corridorBearing: ((corridorBearing % 360) + 360) % 360,
    landingBearing: SOUTH(),
    inlandBearing,
    freshHub, spokeBearings,
    stats: {
      mix, landCount, naturalCount, beachAndWorks: outsideMix, clearable, carved: notes.carved, attempt: attemptNo,
      waterFeatures: waterFeatures.map((f) => `${f.kind} ${f.tiles}t at ${Math.round(f.bearing)}deg`),
      entrances: notes.entrances,
      spawnerDistances: spawners.map((s) => distance(s, base)),
    },
  };
}

export function generateIsland(seed) {
  for (let i = 0; i < 30; i++) {
    const island = attempt(seed, i);
    if (island) return island;
  }
  throw new Error(`island generation failed after 30 attempts (seed ${seed})`);
}
