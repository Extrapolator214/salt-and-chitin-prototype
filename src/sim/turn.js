// The turn structure. resolveTurn runs 03-turn.md §3 steps 1-9 and returns the
// event list; concludeTurn runs step 10 and hands control back to the player.

import C from './config.js';
import { tileAt, addLog, isBuildingManned, handsCap, handCount, totalPower, touchMap, landHands } from './state.js';
import { applyQueue, autoClearOrders } from './orders.js';
import { runLabour, runMovement, standDownSurplus } from './labour.js';
import { tickTowerMerges } from './build.js';
import { runSpawners, advanceCohorts, escalate } from './enemy.js';
import { tickAssaults } from './assault.js';
import { beginCombat } from './combat.js';

// 3 · construction: towers, buildings, bridges complete
function completeConstruction(state, events) {
  for (const t of state.towers) if (!t.complete) { t.complete = true; }
  for (const b of state.buildings) if (!b.complete) { b.complete = true; }
  // A Bunkhouse standing is a requirement dropped everywhere it reaches, so the
  // crew it just made surplus walk out on the same turn — here rather than in
  // the orders, because a crew upgrade bought in step 1 frees a hand the same
  // way and both are settled by one look at what each house still wants.
  standDownSurplus(state, events);
  // A gun being raised is construction too — it is worked in its own yard while
  // it fires, and it changes tier on the turn the work runs out.
  tickTowerMerges(state, events);
  touchMap(state);
}

// 4 · buildings produce
function produce(state, events) {
  const gained = { iron: 0, gold: 0 };
  for (const b of state.buildings) {
    if (!isBuildingManned(state, b)) continue;
    if (b.type === 'forge' && state.res.stone >= C.FORGE_STONE_IN) {
      state.res.stone -= C.FORGE_STONE_IN;
      state.res.iron += C.FORGE_IRON_OUT;
      state.stats.ironEarned += C.FORGE_IRON_OUT;
      gained.iron += C.FORGE_IRON_OUT;
    }
    if (b.type === 'dock') {
      const from = state.res.wood >= state.res.stone ? 'wood' : 'stone';
      if (state.res[from] >= C.DOCK_INPUT) {
        state.res[from] -= C.DOCK_INPUT;
        state.res.gold += C.DOCK_GOLD_OUT;
        state.stats.goldEarned += C.DOCK_GOLD_OUT;
        gained.gold += C.DOCK_GOLD_OUT;
      }
    }
    if (b.type === 'excavation' && b.progress < C.EXCAVATION_TURNS) {
      b.progress++;
      if (b.progress >= C.EXCAVATION_TURNS) {
        state.res.gold += C.EXCAVATION_GOLD;
        state.stats.goldEarned += C.EXCAVATION_GOLD;
        gained.gold += C.EXCAVATION_GOLD;
        events.push({ kind: 'cache', gold: C.EXCAVATION_GOLD });
        addLog(state, `a treasure cache pays out ${C.EXCAVATION_GOLD} gold`);
      }
    }
  }
  if (gained.iron || gained.gold) events.push({ kind: 'produced', ...gained });
}

// 5 · flares in flight land; hands added
function landFlares(state, events) {
  const landed = state.crew.flaresInFlight.filter((f) => f.landsOnTurn <= state.turn);
  if (!landed.length) return;
  state.crew.flaresInFlight = state.crew.flaresInFlight.filter((f) => f.landsOnTurn > state.turn);
  for (const _ of landed) {
    const room = Math.max(0, handsCap(state) - handCount(state));
    landHands(state, Math.min(room, C.FLARE_HANDS));
    state.crew.flaresFired++;
  }
  events.push({ kind: 'flareLanded', count: landed.length, hands: handCount(state) });
  addLog(state, `a boat lands — ${landed.length * C.FLARE_HANDS} hands, ${handCount(state)} in all`);
}

/** Steps 1-9. Returns the event list; sets phase to 'combat' if contact happened. */
export function resolveTurn(state) {
  const events = [];
  state.phase = 'resolve';

  applyQueue(state, events);                                   // 1
  runMovement(state, events);                                  // 1b — walking first
  runLabour(state, events);                                    // 2
  completeConstruction(state, events);                         // 3
  produce(state, events);                                      // 4
  landFlares(state, events);                                   // 5
  tickAssaults(state, events);                                 // 6
  if (state.turn % C.ESCALATION_TURNS === 0) escalate(state, events); // 7
  // An act does not merely begin — it arrives. The regular star lands on the
  // clock; the turn that ends an act puts `ACT_ESCALATION` more on top of it,
  // so what the player meets on the first turn of act 2 is a different enemy
  // rather than the same one a little later. The stars are dealt one at a time
  // by the same rule as the clock's, which is what keeps them spread across the
  // two spawners instead of all landing on the hive.
  if (C.actOf(state.turn + 1) > C.actOf(state.turn)) {
    for (let i = 0; i < C.ACT_ESCALATION; i++) escalate(state, events);
  }
  runSpawners(state, events);                                  // 8
  const contacts = advanceCohorts(state, events);               // 9

  state.stats.peakPower = Math.max(state.stats.peakPower, totalPower(state));

  // `beginCombat` answers null when not one of the contacts can find a way to
  // the hull; there is then no resolve to play and no damage to take.
  if (contacts.length && beginCombat(state, contacts, events)) {
    events.combat = true;
  }
  return events;
}

/** Step 10, then the clock moves. */
export function concludeTurn(state, events = []) {
  if (state.base.hull <= 0) {
    state.outcome = 'lost:hull';
  } else if (state.spawners.every((s) => !s.alive)) {
    state.outcome = 'won';
  } else if (state.turn >= C.ARMADA_TURN) {
    state.outcome = 'lost:armada';
  }

  if (state.outcome) {
    state.phase = 'over';
    events.push({ kind: 'over', outcome: state.outcome });
    addLog(state, outcomeText(state.outcome));
    return events;
  }

  state.turn++;
  state.act = C.actOf(state.turn);
  state.phase = 'player';
  // The standing orders, run once the new turn is the player's: anyone on
  // auto-clear with nothing to do is put on the nearest face. They go into the
  // queue like any other order, so the first thing the player sees is what was
  // decided for them, with a × beside it.
  autoClearOrders(state);
  return events;
}

export const outcomeText = (outcome) => ({
  won: 'both spawners are destroyed — the island is yours',
  'lost:hull': 'the hull is breached — the ship is lost',
  'lost:armada': 'turn 300 passes with a spawner alive — the armada arrives',
}[outcome] || outcome);
