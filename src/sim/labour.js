// Crew assignment, movement, clearing and the points of interest.

import C from './config.js';
import { distance, key, neighbours } from './hex.js';
import {
  tileAt, terrainDef, isClearable, touchMap, addLog, arrived, nextId, drawPick,
  officerById, memberById, idleMembers, isHand, landCrew, isOpenGround,
  crewHeld, blocksCrew, walkableFromBase,
} from './state.js';
import { Heap } from './enemy.js';

/**
 * A worker clears one tile a turn from each face they are working. A labour
 * officer's extra throughput is that he can hold several faces at once — the
 * Master Pioneer works three, and they have to touch.
 */
export function clearCapacity(state, who) {
  const officer = officerById(state, who);
  if (!officer || officer.role !== 'clear') return 1;
  return Math.max(1, Math.round(C.BUILDER_TILES_PER_TURN * officer.quality));
}

/**
 * A batch is one job, so its faces are cut in step.
 *
 * Work is banked on the tile, not on the worker, so a face joining a batch used
 * to start from whatever was already on it — nothing at all if it was untouched
 * ground, or a turn or two if some hand had been at it earlier. The three tiles
 * he was promised in one go then came free over three separate turns, and a
 * face added on the turn after the first two lagged them by exactly the work
 * they had already done. Levelling to the furthest-along face puts them back in
 * one job: they finish together, and no tile ever loses work somebody has done.
 */
export function levelBatch(state, assignments) {
  const tiles = assignments
    .map((a) => tileAt(state, a.target.q, a.target.r))
    .filter((t) => t && isClearable(state, t));
  if (tiles.length < 2) return;
  const work = Math.max(...tiles.map((t) => t.work || 0));
  for (const t of tiles) t.work = work;
  touchMap(state);
}

/** Turn one tile to road and credit what it holds. */
export function clearTile(state, tile, events) {
  const def = terrainDef(tile);
  const gained = { wood: 0, stone: 0, iron: 0 };
  for (const [res, n] of Object.entries(def.yield)) {
    state.res[res] += n;
    gained[res] = (gained[res] || 0) + n;
    if (res === 'wood') state.stats.woodEarned += n;
    if (res === 'stone') state.stats.stoneEarned += n;
    if (res === 'iron') state.stats.ironEarned += n;
  }
  tile.terrain = C.CLEARED_BECOMES;
  tile.cleared = true;
  tile.work = 0;
  state.stats.tilesCleared++;
  // Whatever the tile was hiding stays where it is. Cutting the ground only
  // uncovers the wreck or the chest; someone still has to go and work it.
  return gained;
}

// ---- points of interest ----------------------------------------------------

/** Is there still a job on this tile, and is the ground open enough to do it? */
export function featureReady(state, tile) {
  if (!tile || !tile.feature || tile.featureWorked) return false;
  if (!C.featureAction(tile.feature)) return false;
  return !isClearable(state, tile);
}

/** One crew member works out what the tile was holding. */
export function workFeature(state, tile, events) {
  if (!tile || !tile.feature || tile.featureWorked) return null;
  tile.featureWorked = true;
  const kind = tile.feature;
  if (kind === 'wreck') {
    state.res.wood += C.FEATURES.wreck.wood;
    state.stats.woodEarned += C.FEATURES.wreck.wood;
    events.push({ kind: 'feature', feature: 'wreck', q: tile.q, r: tile.r, wood: C.FEATURES.wreck.wood });
    addLog(state, `the shipwreck at (${tile.q},${tile.r}) is searched — ${C.FEATURES.wreck.wood} wood`);
  } else if (kind === 'cache') {
    state.res.gold += C.FEATURES.cache.gold;
    state.stats.goldEarned += C.FEATURES.cache.gold;
    events.push({ kind: 'feature', feature: 'cache', q: tile.q, r: tile.r, gold: C.FEATURES.cache.gold });
    addLog(state, `a treasure cache at (${tile.q},${tile.r}) is dug up — ${C.FEATURES.cache.gold} gold`);
  } else if (kind === 'officer') {
    events.push({ kind: 'feature', feature: 'officer', q: tile.q, r: tile.r });
    recruitPirate(state, events, { q: tile.q, r: tile.r });
  }
  touchMap(state);
  return kind;
}

/**
 * The officer site: a random pirate, not one of the four who sailed. He is a
 * lesser version of one of their trades — same verb, weaker hand — and he
 * leads an assault at the generic rate, not a lieutenant's.
 */
export function recruitPirate(state, events, at = null) {
  if (state.crew.officers.length > C.OFFICERS.length) return;
  const trade = drawPick(state, C.OFFICERS);
  const pirate = {
    id: 'pirate',
    name: drawPick(state, C.PIRATE_NAMES),
    verb: `${trade.verb} — but a pirate, not a lieutenant`,
    role: trade.role,
    quality: C.PIRATE_QUALITY,
  };
  state.crew.officers.push(pirate);
  // he joins where he is found, not at the ship: it is his rescue, and a
  // castaway who materialised on the beach made the walk out to him free
  landCrew(state, pirate.id, 'officer', at || state.base);
  events.push({ kind: 'officer', name: pirate.name, trade: trade.name });
  addLog(state, `${pirate.name}, a pirate, joins the company — ${trade.name}'s trade, and less of it`);
}

// ---- movement --------------------------------------------------------------

/** Where a job actually stands on the map, or null for one that has no place. */
export function jobPlace(state, assignment) {
  const t = assignment.target;
  if (!t) return null;
  if (t.q !== undefined) return { q: t.q, r: t.r };
  if (assignment.kind === 'man') {
    const s = state.towers.find((x) => x.id === t) || state.buildings.find((x) => x.id === t);
    if (!s) return null;
    return s.q !== undefined ? { q: s.q, r: s.r } : { q: s.tiles[0].q, r: s.tiles[0].r };
  }
  return null;
}

// ---- the way they walk -----------------------------------------------------

/**
 * What it costs a worker to step onto this tile, or null for ground they do not
 * walk at all.
 *
 * The crew walk open ground: the cleared blob, the road in it, the bridges, the
 * beach and the salt flat. They walk through anything of their own that stands
 * on it — the ship, a workshop, a tower on its cliff — the one exception being
 * a palisade, which is a wall from both sides. And they walk a tile one of them
 * is standing on, whatever it is made of: the way past a worker on his face is
 * past him.
 *
 * Standing wood and rock are not walked. They used to be forceable at a price,
 * so that a body cut off behind an unopened face could still come home, and the
 * price bought a bug instead: `wayPoint` drew the march over them, which left
 * workers parked in deep forest with no open ground beside them, quoted as the
 * nearest body for jobs they had no business taking. Nothing is sealed in
 * without it — the tile a worker stands on is reach, so the ground at his elbow
 * can always be queued and he cuts his own way out.
 */
function stepCost(state, tile, held) {
  if (!tile) return null;
  if (blocksCrew(state, tile)) return null; // a palisade first: it is a building too
  const on = tile.occupant && tile.occupant.kind;
  if (on === 'spawner') return null;
  if (held.has(key(tile.q, tile.r))) return 1;
  if (on === 'tower' || on === 'building' || on === 'base') return 1;
  return isOpenGround(tile) ? 1 : null;
}

/**
 * The way a worker actually walks, and what it costs them.
 *
 * A* over the ground the crew keep to, rather than the straight line the walk
 * used to be drawn along. A hand sent round a stand of forest goes round it, and
 * the turns the walk costs are the turns of that route, so a job on the far side
 * of a wood is priced as the walk round rather than as the crow's flight.
 *
 * `held` is the ground bodies are standing on — see `crewHeld`. The order queue
 * passes a larger one, holding the faces workers will have reached by the time
 * this turn resolves, so a chain of jobs laid out in a single phase routes
 * through itself: movement is resolved before labour, so the man ahead is
 * standing on his face before the man behind needs to walk past him.
 *
 * A walk that does not exist is reported as one: `reachable: false`, cost
 * `Infinity`, and the steps go nowhere. It used to fall back to the straight
 * line, which reads as a perfectly ordinary two-turn march and let jobs be
 * handed to bodies who could not get to them.
 */
export function crewRoute(state, from, to, held = crewHeld(state)) {
  const startK = key(from.q, from.r), goalK = key(to.q, to.r);
  if (startK === goalK) return { steps: [{ q: from.q, r: from.r }], cost: 0, reachable: true };
  const nowhere = { steps: [{ q: from.q, r: from.r }], cost: Infinity, reachable: false };
  // A goal nothing joins would otherwise drain the whole walkable island before
  // giving up — 46% of the map, six milliseconds, in one frame. Two guards: a
  // goal with no way in at all is refused for the price of six lookups, and
  // the search is bounded besides, generously enough that no route anyone
  // actually walks comes near it.
  const goalTile = state.map.tiles.get(goalK);
  const wayIn = goalTile && neighbours(to.q, to.r)
    .some((n) => stepCost(state, state.map.tiles.get(key(n.q, n.r)), held) !== null);
  if (!wayIn) return nowhere;
  const cap = Math.max(256, 32 * distance(from, to));
  const g = new Map([[startK, 0]]);
  const prev = new Map();
  const open = new Heap();
  const closed = new Set();
  open.push({ k: startK, q: from.q, r: from.r, f: distance(from, to) });
  while (open.size && closed.size < cap) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    if (cur.k === goalK) break;
    const base = g.get(cur.k);
    for (const n of neighbours(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (closed.has(nk)) continue;
      const t = state.map.tiles.get(nk);
      // The job's own tile is the end of the walk, not ground to be crossed: it
      // costs the one step that arrives on it, whatever it is made of. It is
      // usually the standing face they were sent to cut, and refusing it here
      // would refuse every clear order there is.
      const step = nk === goalK ? (t ? 1 : null) : stepCost(state, t, held);
      if (step === null) continue;
      const ng = base + step;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        prev.set(nk, cur.k);
        open.push({ k: nk, q: n.q, r: n.r, f: ng + distance(n, to) });
      }
    }
  }
  if (!prev.has(goalK)) return nowhere;
  const steps = [];
  let k = goalK;
  while (k) {
    const [q, r] = k.split(',').map(Number);
    steps.push({ q, r });
    if (k === startK) break;
    k = prev.get(k);
  }
  return { steps: steps.reverse(), cost: g.get(goalK), reachable: true };
}

/**
 * Step 1b of the resolve: the walking happens before any of the work, so a
 * worker who arrives this turn puts in a turn's labour on arrival.
 *
 * The last leg of a walk is therefore free of a turn of its own: a job close
 * enough to reach inside the turn it is ordered is reached and worked in that
 * same turn, so clearing scrub next door costs one turn, not one to walk and
 * one to cut.
 *
 * A walk of more than that is walked, not waited out — each turn puts the
 * worker further along the *route* to the job, so a long march is turns of
 * watching someone follow their own road across the island.
 */
export function runMovement(state, events) {
  let moved = 0;
  for (const a of state.crew.assignments) {
    const m = memberById(state, a.who);
    const to = jobPlace(state, a);
    if (!m || !to) continue;
    if (arrived(state, a)) {
      if (m.q !== to.q || m.r !== to.r) { m.q = to.q; m.r = to.r; moved++; }
      continue;
    }
    const at = wayPoint(state, a, to);
    if (at && (m.q !== at.q || m.r !== at.r)) { m.q = at.q; m.r = at.r; moved++; }
  }
  return moved;
}

/**
 * How far along the walk they are at the end of this turn. The turn they set
 * out counts, and arrival is the turn after the last step, so a k-turn walk
 * shows k evenly spaced positions on the way.
 */
export function wayPoint(state, a, to) {
  const from = a.from;
  if (!from) return null;
  const total = a.arrivesOnTurn - a.leftOn;
  if (total <= 0) return { q: to.q, r: to.r };
  // recomputed each turn rather than kept on the assignment: ground opens
  // behind them as the gang cuts, and the walk should take the new road
  const route = crewRoute(state, from, to);
  if (!route.reachable) return null;  // the way has closed; he waits where he is
  const path = route.steps;
  const done = (state.turn - a.leftOn + 1) / (total + 1);
  const i = Math.max(0, Math.min(path.length - 1, Math.round(done * (path.length - 1))));
  return { q: path[i].q, r: path[i].r };
}

/**
 * Turns of walking between a worker and a job, or `Infinity` for a job they
 * cannot get to at all. Callers have to tell those apart: a walk nobody can
 * make is a refusal, not a long march.
 */
export function travelTurnsFor(state, who, to, held) {
  const m = memberById(state, who);
  if (!m || !to) return Infinity;
  const route = crewRoute(state, m, to, held);
  return route.reachable ? C.travelTurns(route.cost) : Infinity;
}

/**
 * What the walk to one place costs from everywhere, in a single search.
 *
 * Dijkstra outward from the job rather than a route in from each body. The
 * question the panel and the resolve both ask is "which of these thirty people
 * is nearest to this one tile", and asking it as thirty A* searches is thirty
 * floods of the same ground. One flood answers all of them, exactly: the map is
 * keyed by tile and holds the cost of the forward walk from that tile to `to`.
 *
 * The walk is priced by the ground it *enters*, so the start tile is free and
 * the job's own tile costs its one step whatever it is made of — which is what
 * lets a worker be sent to cut a standing face. Reversed, that means the edge
 * into a tile is paid when the flood leaves it. A tile nothing walks is still
 * recorded, so a body stranded on one is quoted a walk out; it is simply not
 * crossed on the way to anywhere else.
 */
export function walkCostsTo(state, to, held = crewHeld(state)) {
  const goalK = key(to.q, to.r);
  const dist = new Map([[goalK, 0]]);
  const open = new Heap();
  const closed = new Set();
  open.push({ k: goalK, q: to.q, r: to.r, f: 0 });
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur.k)) continue;
    closed.add(cur.k);
    const here = state.map.tiles.get(cur.k);
    // the step that *enters* this tile, paid by whoever walks in from outside
    const enter = cur.k === goalK ? (here ? 1 : null) : stepCost(state, here, held);
    if (enter === null) continue;                 // recorded, but not crossed
    const base = dist.get(cur.k) + enter;
    for (const n of neighbours(cur.q, cur.r)) {
      const nk = key(n.q, n.r);
      if (closed.has(nk) || !state.map.tiles.has(nk)) continue;
      if (base < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, base);
        open.push({ k: nk, q: n.q, r: n.r, f: base });
      }
    }
  }
  return dist;
}

/**
 * The worker who would take a job here: whoever is nearest to it by the walk
 * they would actually make, so a crew chewing along a frontier keeps working
 * instead of marching about. Nobody who cannot get there at all is offered.
 *
 * Every candidate is weighed, not a shortlist of the nearest by crow's flight.
 * The shortlist was safe while standing ground could be forced — everyone could
 * reach everything, and the only question was the price. Now that the crew keep
 * to open ground the five nearest as the crow flies can every one of them be on
 * the wrong side of a wood, and the body who can actually walk it is the sixth.
 */
export function pickNearest(state, pool, to, held) {
  if (!pool.length) return null;
  if (!to) return pool[0];
  const costs = walkCostsTo(state, to, held);
  let best = null;
  for (const m of pool) {
    const cost = costs.get(key(m.q, m.r));
    if (cost === undefined) continue;
    if (!best || cost < best.cost) best = { m, cost };
  }
  return best ? best.m : null;
}

/** The same choice, out of whoever is idle right now. */
export function nearestIdle(state, who, to, held) {
  return pickNearest(state, idleMembers(state)
    .filter((m) => (who === 'hand' ? m.kind === 'hand' : m.id === who)), to, held);
}

// ---- the work --------------------------------------------------------------

/**
 * Step 2 of the resolve: every clear order is one tile, and every feature order
 * is one point of interest.
 *
 * A worker does the job they were sent to and is then free again, standing
 * where the job left them — they do not wander on into ground nobody asked for.
 */
export function runLabour(state, events) {
  let tiles = 0, progressed = 0;
  const gained = { wood: 0, stone: 0, iron: 0 };
  const done = [];

  for (const a of state.crew.assignments) {
    if (!arrived(state, a)) continue;
    if (a.kind === 'clear') {
      const t = tileAt(state, a.target.q, a.target.r);
      if (!t || !isClearable(state, t)) { done.push(a); continue; }
      // turns of one worker's labour, banked on the tile rather than on the
      // worker — stand them down and the cut work is still there. How many
      // depends on the ground: scrub is one turn, everything else is three.
      t.work = (t.work || 0) + 1;
      if (t.work < C.turnsToClear(t.terrain)) { progressed++; continue; }
      const g = clearTile(state, t, events);
      gained.wood += g.wood;
      gained.stone += g.stone;
      gained.iron += g.iron;
      tiles++;
      done.push(a);
    } else if (a.kind === 'feature') {
      const t = tileAt(state, a.target.q, a.target.r);
      if (t && featureReady(state, t)) workFeature(state, t, events);
      done.push(a);
    }
  }

  // the job was that tile; done or impossible, the worker goes back in the pool
  for (const a of done) unassign(state, a.id);

  if (progressed) touchMap(state); // the part-cut tiles want redrawing
  if (tiles > 0) {
    touchMap(state);
    events.push({ kind: 'cleared', tiles, ...gained });
    addLog(state, `cleared ${tiles} tile${tiles === 1 ? '' : 's'} (+${gained.wood} wood, +${gained.stone} stone`
      + `${gained.iron ? `, +${gained.iron} iron` : ''})`);
  }
  recomputeCapBonus(state);
  return { tiles, gained };
}

/** The freshwater spring lifts the cap while a hand stands on it. */
export function recomputeCapBonus(state) {
  const onSpring = state.crew.assignments.some((a) => {
    if (a.kind !== 'garrison' || !arrived(state, a)) return false;
    const t = tileAt(state, a.target.q, a.target.r);
    return t && t.feature === 'spring';
  });
  state.crew.capBonus = onSpring ? C.FEATURES.spring.handsCap : 0;
}

// ---- assignment ------------------------------------------------------------

/**
 * Put a worker on a job. The nearest spare body takes it, and the walk is
 * measured from where that body is actually standing.
 *
 * `sameTripAs` is the labour officer's batch: his three faces are one trip, so
 * the second and third tiles cost him nothing beyond the first.
 *
 * `held` is the ground the crew will be standing on once this turn resolves —
 * see `crewRoute`. The queue passes it so that a chain laid out in one phase
 * routes through itself, and so that the body the resolve picks is the body the
 * order panel quoted.
 *
 * A job nobody can walk to is refused rather than taken by somebody who then
 * marches over standing forest to reach it.
 */
export function assign(state, { kind, who, target, at, sameTripAs, held }) {
  // An officer is not on the idle list once he has a job, and his extra faces
  // are jobs he takes while holding it — so he is fetched by name when the idle
  // list has nobody. Refusing that outright was the whole Master Pioneer batch
  // refused at the resolve: eighty-six orders in a hundred and twenty turns,
  // faces two and three of every batch he was given.
  const m = nearestIdle(state, who, at, held) || (isHand(who) ? null : memberById(state, who));
  if (!m) return null;
  let turns = 0;
  if (sameTripAs !== undefined) turns = sameTripAs;
  else if (at) {
    const route = crewRoute(state, m, at, held);
    if (!route.reachable) return null;
    turns = C.travelTurns(route.cost);
  }
  const a = {
    id: nextId(state, 'as'),
    kind,
    who: m.id,
    target,
    from: { q: m.q, r: m.r },
    leftOn: state.turn,
    arrivesOnTurn: state.turn + turns,
  };
  state.crew.assignments.push(a);
  return a;
}

export function unassign(state, id) {
  const i = state.crew.assignments.findIndex((a) => a.id === id);
  if (i >= 0) return state.crew.assignments.splice(i, 1)[0];
  return null;
}
