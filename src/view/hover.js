// The tile info panel. Never blocks, never needs a click.

import C from '../sim/config.js';
import { distance } from '../sim/hex.js';
import {
  tileAt, terrainDef, towerRange, towerPower, towerManning, isBuildingManned,
  handsNeededFor, assignmentsFor, arrived, holdCap, underCanopy, membersAt, isClearable,
  isBuildable, isOpenGround, isPassable,
} from '../sim/state.js';
import { cohortTiles, cohortHidden, advanceCost } from '../sim/enemy.js';
import { coverageOf, coveredBuildings } from '../sim/build.js';

const yn = (v) => (v ? 'yes' : 'no');

// The panel is a fixed-width column beside the map and everything in it is a
// short answer, so it reads two facts to the line rather than one. `row` is one
// pair, `pair` is two; anything whose answer is a sentence gets a row to itself.
const L = 12, V = 13;
const row = (label, value) => `  ${label.padEnd(L)}${value}\n`;
const pair = (l1, v1, l2, v2) =>
  (l2 ? `  ${l1.padEnd(L)}${String(v1).padEnd(V)}${l2.padEnd(L)}${v2}\n` : row(l1, v1));

export function renderHover(state, el, hover) {
  if (!hover) { el.textContent = 'hover a tile'; return; }
  const t = tileAt(state, hover.q, hover.r);
  if (!t) { el.textContent = `(${hover.q}, ${hover.r})\n  off the map`; return; }

  const def = terrainDef(t);
  // A bridge is modified fresh water, not a terrain — same as a cleared tile is a
  // modified road. Both read as the ground plus what was done to it.
  const worked = t.bridge ? ' (bridged)' : t.cleared && t.terrain === 'road' ? ' (cleared)' : '';
  let s = `(${t.q}, ${t.r})  ·  ${distance(t, state.base)} from base\n\n`;
  s += `${(C.TERRAIN_NAME[t.terrain] ?? t.terrain).toUpperCase()}${worked}\n`;

  // The ground as it stands now. Cutting a tile turns it to road, and a road
  // answers all of these differently — the panel always describes what is
  // under the cursor, never what it could become.
  const cuts = def.clearable && !t.cleared;
  const yields = Object.entries(def.yield).map(([k, v]) => `${v} ${k}`).join(', ');
  s += pair('clearable', cuts ? `${t.work || 0}/${C.turnsToClear(t.terrain)} cut` : 'no',
    'buildable', t.bridge || isBuildable(state, t) ? 'yes'
      : isBuildable(state, t, true) ? 'towers only' : 'no');
  s += pair('resource', cuts && yields ? yields : '—');

  // The enemy asks two separate questions of the same tile — can a cohort march
  // across it between turns, and can a unit charge over it once the fight is
  // on. One number for both phases, always as a speed: 1.00x is road pace, and
  // a bridge or a cleared tile moves at road pace whatever it was cut from.
  const advancePass = isPassable(state, t, 'advance');
  const assaultPass = isPassable(state, t, 'assault');
  s += pair('enemy pass', `advance ${yn(advancePass)}`, 'assault', yn(assaultPass));
  s += pair('enemy speed', advancePass || assaultPass ? `${(1 / advanceCost(state, t)).toFixed(2)}x` : '—',
    'crew pass', yn(isOpenGround(t)));

  // Boolean, like every other row — the panel says what the tile is, not what
  // it would be if you cut it. The canopy shadow is the one annotated case,
  // because nothing about the tile itself explains that answer.
  const shaded = underCanopy(state, t);
  s += shaded ? row('targetable', 'no (under adjacent canopy)')
    : pair('targetable', yn(t.cleared || t.bridge || def.targetableVirgin));
  if (def.blocksSight && !t.cleared) s += row('sight', 'blocks fire over and beside it');

  s += pair('feature', t.feature ? `${featureName(t.feature)}${t.featureWorked ? ' (worked)' : ''}` : '—');
  if (t.feature && !t.featureWorked && C.featureAction(t.feature)) {
    s += row(C.featureAction(t.feature), isClearable(state, t) ? 'once the tile is cleared' : 'ready — send a hand');
  }
  s += pair('occupant', t.occupant ? t.occupant.kind : '—');
  const standing = membersAt(state, t.q, t.r);
  if (standing.length) s += row('crew here', standing.map((m) => m.name).join(', '));

  if (t.occupant) {
    if (t.occupant.kind === 'tower') s += towerBlock(state, t.occupant.id);
    if (t.occupant.kind === 'building') s += buildingBlock(state, t.occupant.id);
    if (t.occupant.kind === 'spawner') s += spawnerBlock(state, t.occupant.id);
    if (t.occupant.kind === 'base') s += baseBlock(state);
  }

  for (const m of state.cohorts) {
    if (!cohortTiles(state, m).some((x) => x.q === t.q && x.r === t.r)) continue;
    const n = cohortHidden(state, m) ? '?' : m.units.length;
    s += `\nCOHORT\n${pair('units', n, 'arriving', `${estimateTurns(state, m)} turns`)}`;
    break;
  }
  el.textContent = s;
}

const featureName = (f) => ({
  cache: 'treasure cache', spring: 'freshwater spring', officer: 'officer site', wreck: 'shipwreck',
}[f] || f);

function towerBlock(state, id) {
  const tw = state.towers.find((x) => x.id === id);
  if (!tw) return '';
  const def = C.TOWERS[tw.towerIndex];
  const m = towerManning(state, tw);
  let s = `\n${def.name.toUpperCase()}${tw.complete ? '' : ' (building)'}\n`;
  s += pair('tier', tw.evolved ? 'evolved' : tw.tier, 'power', towerPower(state, tw).toFixed(2));
  s += pair('range', towerRange(state, tw), 'item', tw.itemTier ? `tier ${tw.itemTier}` : 'none');
  s += row('fire', def.fire);
  if (tw.merging) {
    s += row('being raised', `to tier ${tw.merging.toTier}, ${tw.merging.turnsLeft} turn`
      + `${tw.merging.turnsLeft === 1 ? '' : 's'} left — it fires throughout`);
  }
  s += row('essence', tw.essence.join(' + '));
  s += row('manned by', `${m.crew.map((a) => a.who).join(', ') || 'nobody'} (${m.crew.length}/${m.need})`);
  return s;
}

function buildingBlock(state, id) {
  const b = state.buildings.find((x) => x.id === id);
  if (!b) return '';
  const def = C.buildingDef(b.type);
  const need = handsNeededFor(state, b);
  const crew = assignmentsFor(state, b.id).filter((a) => arrived(state, a)).length;
  let s = `\n${b.name.toUpperCase()}\n`;
  s += pair('condition', b.ruined ? 'A RUIN' : `${Math.ceil(b.hp)}/${b.maxHp}`,
    'working', b.ruined ? 'rebuild it' : yn(isBuildingManned(state, b)));
  s += pair('manning', need === 0 ? 'wants nobody' : `${crew}/${need}${b.upgraded ? ' (up)' : ''}`,
    ...(b.type === 'excavation' ? ['dig', `${b.progress}/${C.EXCAVATION_TURNS} turns`] : []));
  s += row('owns', def.owns);
  s += row('effect', def.effect);
  // A Bunkhouse is the one building whose worth is somewhere other than where it
  // stands, so hovering it has to answer "which yards is this one actually
  // paying for" — the question you asked when you placed it and cannot ask
  // again afterwards. The reach itself is drawn on the map at the same time.
  const radius = C.buildingRadius(b.type);
  if (radius) {
    const covered = coveredBuildings(state, coverageOf(state, b.type, b.tiles));
    // Short labels on purpose: the panel is one line wide and `takes in 3 yards`
    // was the pair that spilled onto a second one.
    s += pair('reach', `${radius} tiles`, 'yards in it', String(covered.length));
    if (!covered.length) s += row('', 'nothing within reach of it yet');
    for (const c of covered.slice(0, COVER_LIST)) {
      s += row('', `${c.name}${c.id === b.id ? ' (itself)' : ''} (${c.q},${c.r})`
        + `${c.complete ? '' : ' — building'}`);
    }
    if (covered.length > COVER_LIST) s += row('', `and ${covered.length - COVER_LIST} more`);
    if (!b.complete) s += row('', 'it takes nobody off anything until it stands');
  }
  return s;
}

// How many of the yards a Bunkhouse covers are named before the panel gives up
// and counts the rest. Enough for every yard a sane plot takes in.
const COVER_LIST = 6;

function spawnerBlock(state, id) {
  const sp = state.spawners.find((x) => x.id === id);
  if (!sp) return '';
  let s = `\n${sp.name.toUpperCase()}\n`;
  s += pair('stars', `${sp.stars} / ${sp.cap}`, 'alive', yn(sp.alive));
  // One line for the whole cycle. It only ever accumulates and then releases —
  // the old `mode  accumulating` row was a constant — and the wave, its size
  // and its mix are read together or not at all.
  if (sp.alive) {
    s += row('releases', `${C.ACCUMULATE_TURNS - sp.accumulatedTurns} turns · `
      + `${sp.stars * C.UNITS_PER_STAR} units · ${Math.round(sp.grubShare * 100)}% grub`);
  }
  return s;
}

function baseBlock(state) {
  const counts = {};
  for (const it of state.base.hold) {
    const k = `${C.itemShort(it.tower)} t${it.tier}`;
    counts[k] = (counts[k] || 0) + 1;
  }
  const hold = Object.entries(counts).map(([k, n]) => `${n}x ${k}`).join(', ') || 'empty';
  const cap = holdCap(state);
  let s = '\nTHE SHIP\n';
  s += pair('hull', `${state.base.hull} / ${C.HULL_MAX}`,
    'guns', `${C.SHIP_DPS} dps, r${C.SHIP_RANGE}`);
  s += row('hold', `${hold}  (${state.base.hold.length}/${cap === Infinity ? '∞' : cap})`);
  return s;
}

function estimateTurns(state, cohort) {
  // a rough readout: distance left over the tiles-per-turn a cohort makes on mixed ground
  return Math.max(1, Math.ceil(cohort.tilesRemaining / 2.5));
}
