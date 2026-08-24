// Assault scheduling and resolution. Spawners die only this way.

import C from './config.js';
import { addLog, nextId, draw, hasBuilding, idleHands, idleOfficers, officerById } from './state.js';
import { assign } from './labour.js';
import { networkReaches, killSpawner } from './enemy.js';

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

export function canSchedule(state, spawnerId, leaderId) {
  const sp = state.spawners.find((s) => s.id === spawnerId);
  if (!sp || !sp.alive) return no('no such spawner');
  if (!hasBuilding(state, 'sappers')) return no("needs a manned Sappers' Camp");
  if (state.assaults.some((a) => a.targetSpawnerId === spawnerId && a.state !== 'done')) return no('already under way');
  if (!networkReaches(state, sp)) return no('no open ground reaches it');
  const need = assaultHands(state, leaderId) - (leaderId ? 1 : 0);
  if (idleHands(state) < need) return no(`needs ${need} idle hands`);
  if (leaderId && !idleOfficers(state).some((o) => o.id === leaderId)) return no('that officer is busy');
  return ok;
}

export function schedule(state, spawnerId, leaderId) {
  const assault = {
    id: nextId(state, 'at'),
    targetSpawnerId: spawnerId,
    leader: leaderId || null,
    hands: assaultHands(state, leaderId) - (leaderId ? 1 : 0),
    turnsRemaining: C.MARCH_TURNS,
    state: 'march',
  };
  state.assaults.push(assault);
  const workers = [];
  for (let i = 0; i < assault.hands; i++) workers.push('hand');
  if (leaderId) workers.push(leaderId);
  for (const who of workers) assign(state, { kind: 'assault', who, target: assault.id });
  addLog(state, `a sabotage team sets out for the ${state.spawners.find((s) => s.id === spawnerId).kind}`);
  return assault;
}

function release(state, assault) {
  state.crew.assignments = state.crew.assignments.filter((a) => !(a.kind === 'assault' && a.target === assault.id));
}

/** Step 6 of the resolve: march ticks, arrivals resolve. */
export function tickAssaults(state, events) {
  for (const a of state.assaults.slice()) {
    if (a.state === 'done') continue;
    a.turnsRemaining--;
    if (a.turnsRemaining > 0) continue;

    if (a.state === 'march') {
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
