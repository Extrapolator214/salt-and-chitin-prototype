// The real-time resolve. Fixed 30 Hz timestep; the player gives no input.

import C from './config.js';
import { key, distance, neighbours, line } from './hex.js';
import {
  tileAt, isTargetable, hasSight, addLog, towerPower, towerRange,
} from './state.js';
import { roadPath, findPath, advanceCost } from './enemy.js';
import { damageBuilding } from './build.js';

const DT = 1 / C.TICK_HZ;

function makeUnit(state, spec, index) {
  const def = C.UNITS[spec.type];
  const hp = def.hp * (spec.elite ? C.ELITE_HP_MULT : 1) * (spec.grown || 1);
  return {
    id: `u${index}`,
    type: spec.type,
    elite: spec.elite,
    role: spec.role,
    hp,
    maxHp: hp,
    armour: Math.round(def.armour * (spec.grown || 1)),
    speed: def.speed * (spec.elite ? C.ELITE_SPEED_MULT : 1),
    hullDamage: spec.elite ? C.ELITE_HULL_DAMAGE : def.hullDamage,
    shieldHp: spec.role === 'shield' ? C.SHIELD_HP : 0,
    pos: -index * 0.45,
    alive: true,
    held: false,
    tile: null,
    // what it is pulling down, and which face of it it has hold of
    onBuilding: null,
    onFace: null,
  };
}

// ---- buildings under attack ------------------------------------------------

/**
 * A unit's reach from where it stands: the economic buildings whose ground it
 * is touching. Towers are fortifications and are never in this list — the swarm
 * goes round one rather than at it — and neither is the ship, which is what the
 * walk is for.
 */
function buildingsBeside(state, tile) {
  const out = [];
  if (!tile) return out;
  for (const n of neighbours(tile.q, tile.r)) {
    const t = tileAt(state, n.q, n.r);
    if (!t || !t.occupant || t.occupant.kind !== 'building') continue;
    const b = state.buildings.find((x) => x.id === t.occupant.id);
    if (!b || b.ruined) continue;
    const def = C.buildingDef(b.type);
    if (def && def.economic === false) continue; // a palisade is a wall, not a yard
    out.push({ b, face: `${key(t.q, t.r)}>${key(tile.q, tile.r)}` });
  }
  return out;
}

/**
 * Put whoever is in reach of a building onto it, three to a side, and let them
 * work. A unit holding a face does not walk; it lets go when the building is
 * ruined, and then carries on toward the hull.
 */
function workBuildings(state) {
  const cb = state.combat;
  const onFace = new Map();
  const held = [];
  for (const group of cb.groups) {
    for (const u of group.units) {
      if (!u.alive) continue;
      if (u.onBuilding) {
        const b = state.buildings.find((x) => x.id === u.onBuilding);
        if (!b || b.ruined) { u.onBuilding = null; u.onFace = null; continue; }
        onFace.set(u.onFace, (onFace.get(u.onFace) || 0) + 1);
        held.push({ u, b });
      }
    }
  }
  for (const group of cb.groups) {
    for (const u of group.units) {
      if (!u.alive || u.onBuilding || u.pos < 0) continue;
      for (const { b, face } of buildingsBeside(state, u.tile)) {
        if ((onFace.get(face) || 0) >= C.ATTACK_SLOTS_PER_SIDE) continue;
        onFace.set(face, (onFace.get(face) || 0) + 1);
        u.onBuilding = b.id;
        u.onFace = face;
        held.push({ u, b });
        break;
      }
    }
  }
  for (const { u, b } of held) {
    if (b.ruined) continue;
    if (damageBuilding(state, b, u.hullDamage * C.BUILDING_DAMAGE_MULT * DT)) {
      cb.ruined.push({ id: b.id, name: b.name, q: b.q, r: b.r });
      addLog(state, `${b.name} is pulled down — a ruin until it is rebuilt`);
    }
  }
}

/** Set up a resolve from this turn's contacts. */
export function beginCombat(state, contacts, events) {
  const groups = [];
  let idx = 0;
  for (const { cohort, entry } of contacts) {
    // the resolve is the assault phase: ground that lets a cohort march past on
    // its way in does not necessarily let a unit charge over it
    let path = roadPath(state, entry, state.base, 'assault');
    let overland = false;
    if (!path) {
      path = findPath(state, entry, state.base, 'assault');
      overland = true;
    }
    if (!path) path = [{ q: entry.q, r: entry.r }];
    const units = cohort.units.map((u) => makeUnit(state, u, idx++));
    groups.push({ entry, path, units, overland, spawnerId: cohort.spawnerId });
  }
  const all = groups.flatMap((g) => g.units);
  state.combat = {
    groups,
    elapsed: 0,
    acc: 0,
    speed: 1,
    killed: 0,
    leaked: 0,
    hullBefore: state.base.hull,
    startCount: all.length,
    composition: {
      grub: all.filter((u) => u.type === 'grub').length,
      shell: all.filter((u) => u.type === 'shell').length,
      elite: all.filter((u) => u.elite).length,
    },
    shots: [],
    ruined: [],
    done: false,
  };
  state.phase = 'combat';
  state.stats.wavesFought++;
  const e = groups[0].entry;
  events.push({ kind: 'contact', q: e.q, r: e.r, units: all.length, spawnerId: groups[0].spawnerId });
  addLog(state, `a cohort of ${all.length} reaches your road at (${e.q},${e.r})`);
  return state.combat;
}

const tileFor = (state, group, unit) => {
  const i = Math.max(0, Math.min(group.path.length - 1, Math.floor(unit.pos)));
  return tileAt(state, group.path[i].q, group.path[i].r);
};

function damage(state, group, unit, amountPerSecond, source) {
  const tile = unit.tile;
  let amount = amountPerSecond * DT;
  if (tile && tile.terrain === 'salt' && !tile.cleared) amount *= C.SALT_DAMAGE_MULT;

  // a shield-bearer within 2 tiles absorbs before HP
  if (unit.shieldHp <= 0) {
    for (const other of group.units) {
      if (!other.alive || other.shieldHp <= 0 || other === unit) continue;
      if (Math.abs(other.pos - unit.pos) > C.SHIELD_RADIUS) continue;
      const take = Math.min(other.shieldHp, amount);
      other.shieldHp -= take;
      amount -= take;
      if (amount <= 0) return;
    }
  } else {
    const take = Math.min(unit.shieldHp, amount);
    unit.shieldHp -= take;
    amount -= take;
    if (amount <= 0) return;
  }

  unit.hp -= amount;
  if (unit.hp <= 0) {
    unit.alive = false;
    state.combat.killed++;
    state.stats.unitsKilled++;
    if (source && source.plunder) {
      state.res.gold += C.PLUNDER_GOLD_PER_KILL;
      state.stats.goldEarned += C.PLUNDER_GOLD_PER_KILL;
    }
  }
}

/** Armour subtracts a flat amount per damage application, floored at 1. */
const afterArmour = (portion, armour) => Math.max(Math.min(portion, C.ARMOUR_FLOOR), portion - armour);

function targetsFor(state, group, shooter, primary) {
  const shape = shooter.shape;
  const alive = group.units.filter((u) => u.alive);
  if (shape === 'single') return [primary];
  if (shape === 'blast') {
    return alive.filter((u) => distance(u.tile, primary.tile) <= C.BLAST_RADIUS);
  }
  if (shape === 'file') {
    // the target's tile and the two behind it, along the road
    return alive.filter((u) => u.pos <= primary.pos + C.EPSILON && u.pos > primary.pos - C.FILE_LENGTH);
  }
  if (shape === 'multi') {
    return alive
      .filter((u) => distance(u.tile, shooter.tile) <= shooter.range)
      .sort((a, b) => b.pos - a.pos)
      .slice(0, C.MULTI_TARGETS);
  }
  if (shape === 'adjacent') {
    const ring = new Set(neighbours(shooter.tile.q, shooter.tile.r).map((n) => key(n.q, n.r)));
    return alive.filter((u) => ring.has(key(u.tile.q, u.tile.r)));
  }
  return [primary];
}

function fire(state, group, shooter) {
  const inRange = group.units.filter((u) => {
    if (!u.alive || !u.tile) return false;
    if (distance(u.tile, shooter.tile) > shooter.range) return false;
    if (!isTargetable(state, u.tile)) return false;
    return hasSight(state, shooter.tile, u.tile, line);
  });
  if (!inRange.length) return;
  // shoot whatever is furthest along, i.e. closest to the base
  const primary = inRange.reduce((a, b) => (b.pos > a.pos ? b : a));
  const targets = targetsFor(state, group, shooter, primary).filter((u) => u && u.alive);
  if (!targets.length) return;
  const portion = shooter.power / targets.length;
  for (const t of targets) {
    damage(state, group, t, afterArmour(portion, t.armour), shooter);
    if (shooter.snag) t.held = true;
  }
  state.combat.shots.push({ from: shooter.tile, toId: primary.id, group });
}

function shooters(state) {
  const out = [];
  for (const tower of state.towers) {
    if (!tower.complete) continue;
    const power = towerPower(state, tower);
    if (power <= 0) continue;
    const def = C.TOWERS[tower.towerIndex];
    const shapes = new Set([def.shape]);
    if (tower.evolved) {
      for (const ess of tower.essence) {
        const partner = C.TOWERS.find((t) => t.essence === ess);
        if (partner) shapes.add(partner.shape);
      }
    }
    for (const shape of shapes) {
      out.push({
        tile: tileAt(state, tower.q, tower.r),
        range: towerRange(state, tower),
        power, shape,
        snag: tower.essence.includes('Snag'),
        plunder: tower.essence.includes('Plunder'),
        id: tower.id,
      });
    }
  }
  out.push({
    tile: tileAt(state, state.base.q, state.base.r),
    range: C.SHIP_RANGE,
    power: C.SHIP_DPS,
    shape: 'single',
    snag: false, plunder: false,
    id: 'ship',
  });
  return out;
}

function step(state) {
  const cb = state.combat;
  cb.shots.length = 0;

  for (const group of cb.groups) {
    const end = group.path.length - 1;
    for (const u of group.units) {
      if (!u.alive) continue;
      u.tile = tileFor(state, group, u);
      if (u.onBuilding) { u.held = false; continue; } // busy pulling a yard down
      if (!u.held && u.pos >= 0) {
        // the ground drags on a charge exactly as it drags on a march: the
        // advance multiplier is a cost there and its reciprocal here
        const t = u.tile;
        u.pos += (u.speed / (t ? advanceCost(state, t) : 1)) * DT;
      } else if (u.pos < 0) {
        u.pos += u.speed * DT;
      }
      u.held = false;
      if (u.pos >= end) {
        u.alive = false;
        cb.leaked++;
        state.stats.unitsLeaked++;
        state.base.hull = Math.max(0, state.base.hull - u.hullDamage);
      }
    }
  }

  workBuildings(state);

  const guns = shooters(state);
  for (const group of cb.groups) {
    for (const g of guns) if (g.tile) fire(state, group, g);
    // healers mend what is near them, but not on salt
    for (const h of group.units) {
      if (!h.alive || h.role !== 'healer') continue;
      for (const u of group.units) {
        if (!u.alive || u.hp >= u.maxHp) continue;
        if (Math.abs(u.pos - h.pos) > C.HEAL_RADIUS) continue;
        if (u.tile && u.tile.terrain === 'salt' && !u.tile.cleared) continue;
        u.hp = Math.min(u.maxHp, u.hp + C.HEAL_PER_SECOND * DT);
      }
    }
  }

  cb.elapsed += DT;
}

const allDown = (cb) => !cb.groups.some((g) => g.units.some((u) => u.alive));

// A long road means a long walk. The fight is stepped out however long it
// takes; the cap only bounds how much of it the player has to sit through.
const HARD_STEPS = 300 * C.TICK_HZ;

/** Run the rest of the fight with nobody watching. */
function runOut(state) {
  const cb = state.combat;
  let guard = 0;
  while (!allDown(cb) && guard++ < HARD_STEPS) step(state);
}

/** Advance the resolve by `dt` real seconds at the current speed multiplier. */
export function tick(state, dt) {
  const cb = state.combat;
  if (!cb || cb.done) return true;
  cb.acc += Math.min(dt, 0.25) * cb.speed;
  let steps = 0;
  while (cb.acc >= DT && !cb.done && steps < 600) {
    step(state);
    cb.acc -= DT;
    steps++;
    if (allDown(cb) || cb.elapsed >= C.RESOLVE_CAP_SECONDS) cb.done = true;
  }
  return cb.done;
}

/** Jump to the end and apply the result instantly. */
export function skip(state) {
  if (!state.combat) return;
  runOut(state);
  state.combat.done = true;
}

/**
 * Close the resolve.
 *
 * RESOLVE_CAP_SECONDS bounds what the player watches, not the fight itself: the
 * remainder is run out here rather than teleporting whoever is still walking
 * into the hull. That matters once the player has cut a road to a spawner —
 * a 50-tile approach takes a shell 80 seconds to walk, and the design's stated
 * cost of that road is that cohorts come down it, not that they arrive by magic.
 * Anything still standing after HARD_STEPS is a stuck unit and is written off.
 */
export function finishCombat(state) {
  const cb = state.combat;
  if (!cb) return null;
  runOut(state);
  for (const group of cb.groups) {
    for (const u of group.units) {
      if (!u.alive) continue;
      u.alive = false;
      cb.leaked++;
      state.stats.unitsLeaked++;
      state.base.hull = Math.max(0, state.base.hull - u.hullDamage);
    }
  }
  const summary = {
    kind: 'combatEnd',
    killed: cb.killed,
    leaked: cb.leaked,
    ruined: cb.ruined.slice(),
    hullBefore: cb.hullBefore,
    hullAfter: state.base.hull,
    elapsed: cb.elapsed,
    entry: cb.groups[0].entry,
  };
  addLog(state, `contact: ${cb.killed} killed, ${cb.leaked} leaked, hull ${cb.hullBefore} -> ${state.base.hull}`);
  state.combat = null;
  return summary;
}
