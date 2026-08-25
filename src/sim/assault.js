// Assault scheduling and resolution. Spawners die only this way.

import C from './config.js';
import { distance, ring } from './hex.js';
import {
  addLog, nextId, draw, hasBuilding, idleHands, idleOfficers, officerById,
  tileAt, isCrewGround, arrived, memberById,
} from './state.js';
import { assign, crewRoute } from './labour.js';
import { killSpawner } from './enemy.js';

const no = (why) => ({ ok: false, why });
const ok = { ok: true };

export const downtimeTurns = (state) => (hasBuilding(state, 'hospital') ? C.DOWNTIME_HOSPITAL : C.DOWNTIME_TURNS);

/** The man whose trade this is, if he is the one going. */
const captainLeading = (state, leaderId) => {
  const officer = leaderId ? officerById(state, leaderId) : null;
  return !!officer && officer.role === 'assault' && officer.quality >= 1;
};

/**
 * A unique lieutenant places the charges at 65%, and the Sapper Captain — whose
 * trade it is — at 90%. A pirate off the island, or nobody at all, manages the
 * generic 40%, which is the campaign's whole progression lever.
 *
 * Every one of these is about who is *going*, not who is on the roster: the
 * charges are carried by hand, and a captain left at the ship has not placed
 * anything.
 */
export function successChance(state, leaderId) {
  const officer = leaderId ? officerById(state, leaderId) : null;
  if (!officer || officer.quality < 1) return C.SUCCESS_GENERIC;
  return captainLeading(state, leaderId) ? C.SUCCESS_CAPTAIN : C.SUCCESS_NAMED;
}

/**
 * The size of the team, which is also the Captain's doing and also only when he
 * leads it: two hands under him where anyone else takes four. He used to shrink
 * every team in the run from wherever he happened to be standing, which made a
 * man whose whole trade is going on the mission worth having without going.
 */
export function assaultHands(state, leaderId) {
  return captainLeading(state, leaderId) ? C.ASSAULT_HANDS_CAPTAIN : C.ASSAULT_HANDS;
}

/**
 * Where the team gathers before the charges go in.
 *
 * The mission used to be a number: four hands left the ship and thirty-two
 * turns later a die was rolled somewhere off the map. Nothing about it was on
 * the island — you could not see the team, could not see where they were, and
 * the ground between the ship and the spawner mattered only through a rule that
 * said a road had to exist somewhere along it.
 *
 * Now they walk. The staging ground is a tile `STAGING_DISTANCE` out from the
 * spawner's body: close enough that the last dash is the mission, far enough
 * that it is ground you have to have opened. The team walks there by the same
 * rule every other worker walks by, and the mission begins when the last of
 * them arrives — so the length of a mission is the length of your road, which
 * is a thing the player can see, plan and shorten.
 *
 * Nearest to the ship of the legal ones, because that is the walk the player
 * would pick.
 */
export function stagingTile(state, spawner) {
  let best = null, bestCost = Infinity;
  const seen = new Set();
  for (const f of spawner.footprint) {
    for (const p of ring(f, C.STAGING_DISTANCE)) {
      const k = `${p.q},${p.r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const tile = tileAt(state, p.q, p.r);
      if (!tile || tile.occupant || !isCrewGround(state, tile)) continue;
      // ...and not so close to another face of the same spawner that the "two
      // tiles out" is a fiction: measured against the whole body, not one tile.
      if (spawner.footprint.some((g) => distance(g, p) < C.STAGING_DISTANCE)) continue;
      const route = crewRoute(state, state.base, p);
      if (!route.reachable || route.cost >= bestCost) continue;
      bestCost = route.cost;
      best = { q: p.q, r: p.r };
    }
  }
  return best;
}

/**
 * The hive is last. It is the bigger of the two fronts and the one the island
 * is named for, and a run that opens by putting the charges under it skips
 * everything the flank was for. So the flank falls first and the hive is not a
 * legal target until nothing else is standing.
 */
const hiveHeldBack = (state, spawner) =>
  spawner.kind === 'hive' && state.spawners.some((s) => s.alive && s.kind !== 'hive');

/**
 * Is this spawner a mission's target at all — leaving aside who is free to go?
 *
 * The two questions are worth separating. "Nobody is idle" is a refusal that
 * next turn may lift; "the hive is last" and "your crew cannot walk to it" are
 * refusals about the island, and a caller that treats them the same will keep
 * standing hands down to make room for a mission that was never going to be
 * legal. The AI player did exactly that, and it cost it every mission in the
 * run: the hive is first in the spawner list, its refusal is permanent, and the
 * loop that hit it stopped before it reached the flank that was ready to go.
 */
export const targetable = (state, sp) => !!sp && sp.alive && !hiveHeldBack(state, sp)
  && !!stagingTile(state, sp);

export function canSchedule(state, spawnerId, leaderId) {
  const sp = state.spawners.find((s) => s.id === spawnerId);
  if (!sp || !sp.alive) return no('no such spawner');
  if (!hasBuilding(state, 'sappers')) return no("needs a manned Sappers' Camp");
  if (state.assaults.some((a) => a.targetSpawnerId === spawnerId && a.state !== 'done')) return no('already under way');
  if (hiveHeldBack(state, sp)) return no('the other spawner falls first');
  if (!stagingTile(state, sp)) return no('no ground your crew can walk to within reach of it');
  const need = assaultHands(state, leaderId) - (leaderId ? 1 : 0);
  if (idleHands(state) < need) return no(`needs ${need} idle hands`);
  if (leaderId && !idleOfficers(state).some((o) => o.id === leaderId)) return no('that officer is busy');
  return ok;
}

export function schedule(state, spawnerId, leaderId) {
  const sp = state.spawners.find((s) => s.id === spawnerId);
  const staging = stagingTile(state, sp);
  const assault = {
    id: nextId(state, 'at'),
    targetSpawnerId: spawnerId,
    leader: leaderId || null,
    hands: assaultHands(state, leaderId) - (leaderId ? 1 : 0),
    staging,
    turnsRemaining: 0,
    state: 'gather',
  };
  state.assaults.push(assault);
  const workers = [];
  for (let i = 0; i < assault.hands; i++) workers.push('hand');
  if (leaderId) workers.push(leaderId);
  // The team is a set of ordinary assignments with an ordinary destination, so
  // they walk the crew's own roads, are drawn where they actually are, and are
  // counted as busy by everything that counts hands.
  for (const who of workers) assign(state, { kind: 'assault', who, target: { ...staging }, at: staging });
  addLog(state, `a sabotage team sets out for the ${sp.name} — gathering at (${staging.q}, ${staging.r})`);
  return assault;
}

/**
 * A mission *ordered* onto this tile but not yet under way.
 *
 * An order applies when the turn ends, so between pressing Send and pressing
 * End Turn there is no mission on the state at all — and the staging ground,
 * which the player chose nothing about and has never seen, was invisible for
 * exactly as long as it was still a decision they could take back. So the tile
 * is worked out from the queued order too, and everything that draws or
 * describes a mission asks for both.
 */
export function plannedStagingAt(state, q, r) {
  for (const o of state.orders) {
    if (o.type !== 'scheduleAssault') continue;
    const sp = state.spawners.find((x) => x.id === o.spawnerId);
    if (!sp) continue;
    const at = stagingTile(state, sp);
    if (at && at.q === q && at.r === r) return { order: o, spawner: sp, staging: at };
  }
  return null;
}

/** Every mission the queue is about to start, with the ground it will gather on. */
export const plannedStagings = (state) => state.orders
  .filter((o) => o.type === 'scheduleAssault')
  .map((o) => {
    const sp = state.spawners.find((x) => x.id === o.spawnerId);
    const at = sp && stagingTile(state, sp);
    return at ? { order: o, spawner: sp, staging: at } : null;
  })
  .filter(Boolean);

/** The mission gathering on this tile, if one is. */
export const assaultStagingAt = (state, q, r) => state.assaults
  .find((a) => a.staging && a.staging.q === q && a.staging.r === r && a.state !== 'done');

/** The bodies walking to it, in the order the panel should name them. */
export const assaultTeam = (state, assault) => state.crew.assignments
  .filter((a) => a.kind === 'assault' && a.target
    && a.target.q === assault.staging.q && a.target.r === assault.staging.r)
  .map((a) => a.who);

/** Is every member of the team standing on the staging ground? */
function gathered(state, assault) {
  const team = state.crew.assignments.filter((a) => a.kind === 'assault' && a.target
    && a.target.q === assault.staging.q && a.target.r === assault.staging.r);
  if (team.length < assault.hands) return false;
  return team.every((a) => {
    const m = memberById(state, a.who);
    return arrived(state, a) && m && m.q === assault.staging.q && m.r === assault.staging.r;
  });
}

/**
 * Call it off. The team stands down where it is and walks back to work.
 *
 * Instant, like standing a worker down, and for the same reason: it is not an
 * order about next turn, it is the player taking four bodies back. A mission
 * that has already gone in cannot be recalled — by then the charges are placed
 * or they are not.
 */
export function cancel(state, assaultId) {
  const a = state.assaults.find((x) => x.id === assaultId);
  if (!a) return no('no such mission');
  if (a.state !== 'gather') return no('too late — they are going in');
  const sp = state.spawners.find((x) => x.id === a.targetSpawnerId);
  release(state, a);
  state.assaults.splice(state.assaults.indexOf(a), 1);
  addLog(state, `the sabotage team bound for the ${sp ? sp.name : 'spawner'} is called off`);
  return ok;
}

function release(state, assault) {
  state.crew.assignments = state.crew.assignments.filter((a) => !(a.kind === 'assault' && a.target
    && a.target.q === assault.staging.q && a.target.r === assault.staging.r));
}

/** Step 6 of the resolve: march ticks, arrivals resolve. */
export function tickAssaults(state, events) {
  for (const a of state.assaults.slice()) {
    if (a.state === 'done') continue;

    if (a.state === 'gather') {
      // No clock at all: they are ready when they are all there. A team held up
      // by ground that has not been cut yet waits on the road, in the open,
      // where the player can see them.
      if (!gathered(state, a)) continue;
      a.state = 'strike';
      a.turnsRemaining = C.STRIKE_TURNS;
      addLog(state, 'the sabotage team is in position — the charges go in');
      events.push({ kind: 'assaultReady', id: a.id, q: a.staging.q, r: a.staging.r });
      continue;
    }

    a.turnsRemaining--;
    if (a.turnsRemaining > 0) continue;

    if (a.state === 'strike') {
      const sp = state.spawners.find((s) => s.id === a.targetSpawnerId);
      const chance = successChance(state, a.leader);
      const roll = draw(state);
      const won = sp && sp.alive && roll < chance;
      const leaderName = a.leader ? state.crew.officers.find((o) => o.id === a.leader)?.name : null;
      if (won) {
        killSpawner(state, sp, events);
        a.state = 'done';
        release(state, a);
        state.assaults.splice(state.assaults.indexOf(a), 1);
        events.push({ kind: 'assault', result: 'success', target: sp.name, leader: leaderName, chance });
      } else {
        a.state = 'downtime';
        a.turnsRemaining = downtimeTurns(state);
        events.push({ kind: 'assault', result: 'failure', target: sp ? sp.name : 'the spawner', leader: leaderName, chance, downtime: a.turnsRemaining });
        addLog(state, 'the sabotage team is beaten back — nobody dies');
      }
    } else if (a.state === 'downtime') {
      a.state = 'done';
      release(state, a);
      state.assaults.splice(state.assaults.indexOf(a), 1);
      addLog(state, 'the sabotage team returns to duty');
      events.push({ kind: 'assaultReturn' });
    }
  }
}
