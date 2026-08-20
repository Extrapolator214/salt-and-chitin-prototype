// The modal stack: one at a time, Esc closes, plain HTML tables.
// Every button here pushes an order; nothing writes sim state directly.

import C from '../sim/config.js';
import { distance } from '../sim/hex.js';
import {
  tileAt, towerRange, towerPower, towerManning, isBuildingManned, handsNeededFor,
  assignmentsFor, arrived, holdCap, holdFree, hasBuilding, idleHands, idleOfficers,
  buildingsOfType, isBuildable, officerById, handCount, crewName, isClearable, isOpenGround,
  memberById,
} from '../sim/state.js';
import * as O from '../sim/orders.js';
import { tileLabel } from '../sim/orders.js';
import * as B from '../sim/build.js';
import * as A from '../sim/assault.js';
import { evolutionPartners } from '../sim/build.js';
import { clearCapacity, nearestIdle, pickNearest, crewRoute, jobPlace } from '../sim/labour.js';
import { outcomeText } from '../sim/turn.js';
import { roadReaches } from '../sim/enemy.js';
import * as art from './ascii.js';

let current = null;

export function isOpen() { return current !== null; }
export function close(ui) { current = null; ui.refresh(); }
export function open(name, props, ui) { current = { name, props }; ui.refresh(); }
export function currentModal() { return current; }

/**
 * The seed a run hands on to the next one. A stride rather than +1, because
 * neighbouring seeds are not neighbouring islands but they are not independent
 * either — the coastline noise is sampled off the seed directly.
 */
export const nextSeed = (seed) => ((seed * 7919 + 13) % 2147483647) || C.DEFAULT_SEED;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const costText = (c) => Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' + ') || '—';

/** Render the open modal into `el`, wiring buttons through `ui`. */
export function renderModal(state, el, backdrop, ui) {
  if (!current) { backdrop.hidden = true; return; }
  backdrop.hidden = false;
  const body = VIEWS[current.name];
  // Which box the caret was in, and where in it. `innerHTML` below throws away
  // the element it was sitting in, and with it the typing position — so it is
  // read off first and put back once the new elements exist.
  const live = el.contains(document.activeElement) ? document.activeElement : null;
  const wasIn = live?.dataset?.prop;
  const caret = live?.selectionStart;
  el.innerHTML = `<button class="close" data-x="close">close</button>` + body(state, current.props, ui);
  // An input's value lives in the modal's own props, not in the DOM: the modal
  // is rebuilt from scratch on every refresh, so anything typed into it and left
  // in the element alone is gone the next time anything else on the screen
  // moves. Written back on every keystroke, it survives the rebuild.
  el.querySelectorAll('[data-prop]').forEach((inp) => {
    inp.oninput = () => { current.props[inp.dataset.prop] = inp.value; };
    if (inp.dataset.submit) {
      inp.onkeydown = (e) => {
        // Stopped here, or the window's own keys read the typing: `s` pans the
        // map and Space ends the turn while the caret is in the box.
        e.stopPropagation();
        if (e.key === 'Enter') ACTIONS[inp.dataset.submit](state, {}, ui);
      };
    }
  });
  const focusMe = wasIn
    ? el.querySelector(`[data-prop="${wasIn}"]`)
    : el.querySelector('[data-focus]');
  if (focusMe) {
    focusMe.focus();
    if (caret != null) focusMe.setSelectionRange(caret, caret);
    else focusMe.select();
  }
  el.querySelectorAll('[data-x]').forEach((btn) => {
    btn.onclick = () => {
      const act = btn.dataset.x;
      if (act === 'close') return close(ui);
      const payload = btn.dataset.arg ? JSON.parse(btn.dataset.arg) : {};
      ACTIONS[act](state, payload, ui);
    };
  });
}

const row = (cells, off, why) =>
  `<tr class="${off ? 'off' : ''}">${cells.map((c) => `<td>${c}</td>`).join('')}` +
  `<td>${why ? `<span class="why">${esc(why)}</span>` : ''}</td></tr>`;

/**
 * "Where is this one standing?" — the question a list of names cannot answer.
 *
 * It points at the body, not at the job: the job's tile is already written in
 * the row beside it, and a worker three turns into a march across the island is
 * nowhere near the tile the row names.
 */
const locateBtn = (state, who) => {
  const m = memberById(state, who);
  return m && m.q !== undefined ? btn('locate', 'locate', { q: m.q, r: m.r }) : '';
};

const btn = (label, action, arg, disabled) =>
  `<button data-x="${action}" data-arg='${esc(JSON.stringify(arg || {}))}'${disabled ? ' disabled' : ''}>${label}</button>`;

// ---- views -----------------------------------------------------------------

const VIEWS = {
  buildTower(state, { q, r }) {
    const site = B.canBuildTower(state, q, r);
    const proj = O.projectedItems(state);
    let h = `<h2>Build a tower at (${q}, ${r})</h2>`;
    if (!site.ok) h += `<p class="why">${esc(site.why)}</p>`;
    h += `<p class="note">${costText(C.TOWER_COST)} for the emplacement` +
      (C.TOWER_NEEDS_ITEM ? ', and a tier-1 fitting out of the hold for the gun' : '') +
      '. Every tower is built at tier 1 and rises only by having a higher-tier fitting of its own kind put in place.</p>';
    h += '<table><tr><th>tower</th><th>range</th><th>fire</th><th>fitting</th><th>held</th><th>cost</th><th></th><th></th></tr>';
    for (const def of C.TOWERS) {
      const order = { type: 'buildTower', q, r, towerIndex: def.i };
      const can = O.canEnqueue(state, order);
      const have = proj.count(def.i, 1);
      h += row([
        `<b style="color:${def.colour}">${def.name}</b>`, def.range, def.fire,
        esc(C.itemName(def.i)), have ? `<b>${have}</b>` : '<span class="why">0</span>',
        costText(C.TOWER_COST), btn('Build', 'order', order, !can.ok),
      ], !can.ok, can.ok ? '' : can.why);
    }
    return h + '</table>';
  },

  tower(state, { id }, ui) {
    const tw = state.towers.find((x) => x.id === id);
    if (!tw) return '<h2>gone</h2>';
    const def = C.TOWERS[tw.towerIndex];
    const m = towerManning(state, tw);
    let h = `<h2>${esc(def.name)} — (${tw.q}, ${tw.r})</h2><table>`;
    h += `<tr><th>tier</th><td>${tw.evolved ? 'evolved' : tw.tier}</td>`;
    h += `<th>power</th><td>${towerPower(state, tw).toFixed(2)} dps</td></tr>`;
    h += `<tr><th>range</th><td>${towerRange(state, tw)}</td><th>fire</th><td>${def.fire}</td></tr>`;
    h += `<tr><th>essence</th><td>${tw.essence.join(' + ')}</td><th>fitted</th><td>${tw.itemTier ? `tier ${tw.itemTier}` : 'none'}</td></tr>`;
    h += `<tr><th>manning</th><td colspan="3">${m.crew.length}/${m.need}${m.gunner ? ' — the Master Gunner alone, +50% power' : ''} ${m.manned ? '' : '<span class="why">not firing</span>'}</td></tr>`;
    h += '</table>';

    h += `<h3>fit a ${esc(C.itemName(tw.towerIndex))}</h3>`;
    const mine = state.base.hold.filter((it) => it.tower === tw.towerIndex);
    if (!mine.length) h += `<p class="note">no ${esc(C.itemName(tw.towerIndex))} in the hold — this tower takes no other kind</p>`;
    h += '<table>';
    for (let tier = 1; tier <= C.MAX_TIER; tier++) {
      const n = mine.filter((it) => it.tier === tier).length;
      if (!n) continue;
      const order = { type: 'fitItem', towerId: id, tier };
      const can = O.canEnqueue(state, order);
      h += row([`tier ${tier}`, `x${n}`,
        `power ${C.power(tier).toFixed(2)}`, `${C.manningFor(tier)} hands, ${C.footprintFor(tier)} tiles`,
        btn('Fit', 'order', order, !can.ok)], !can.ok, can.ok ? '' : can.why);
    }
    h += '</table>';

    h += '<h3>manning</h3><table>';
    for (const w of workerChoices(state)) {
      const order = { type: 'assignMan', who: w.id, targetId: id };
      const can = O.canEnqueue(state, order);
      h += row([w.label, '', '', '', btn('Man', 'order', order, !can.ok)], !can.ok, can.ok ? '' : can.why);
    }
    for (const a of m.crew) {
      h += row([`${a.who} is manning it`, '', '', '', btn('Stand down', 'order', { type: 'unassign', assignmentId: a.id })]);
    }
    h += '</table>';

    const partners = state.towers.filter((p) => p.id !== id && evolutionPartners(tw.towerIndex).includes(p.towerIndex));
    if (partners.length) {
      h += '<h3>evolve</h3><table>';
      for (const p of partners) {
        const order = { type: 'evolve', towerId: id, partnerId: p.id };
        const can = O.canEnqueue(state, order);
        h += row([`with ${C.TOWERS[p.towerIndex].name} (${p.q},${p.r}) tier ${p.tier}`,
          `-> ${C.power(5, true).toFixed(2)} dps`, '', '', btn('Evolve', 'order', order, !can.ok)],
        !can.ok, can.ok ? '' : can.why);
      }
      h += '</table>';
    }

    h += `<h3>disassemble</h3><p class="note">refunds ${Math.round(C.DISASSEMBLE_REFUND * 100)}% of ${costText(C.TOWER_COST)}${tw.itemTier ? ', and the tier-' + tw.itemTier + ' item' : ''}</p>`;
    h += btn('Disassemble', 'orderClose', { type: 'disassembleTower', towerId: id });
    return h;
  },

  building(state, { id }, ui) {
    const b = state.buildings.find((x) => x.id === id);
    if (!b) return '<h2>gone</h2>';
    const def = C.buildingDef(b.type);
    const need = handsNeededFor(state, b);
    const crew = assignmentsFor(state, b.id).filter((a) => arrived(state, a));
    const coming = O.projectedAssignments(state)
      .filter((a) => a.kind === 'man' && a.target === b.id).length - crew.length;

    let h = `<h2>${esc(b.name)} — (${b.q}, ${b.r})</h2><table>`;
    h += `<tr><th>owns</th><td>${esc(def.owns)}</td><th>effect</th><td>${esc(def.effect)}</td></tr>`;
    h += `<tr><th>ground</th><td>${b.tiles.length} tiles</td>`;
    h += `<th>condition</th><td>${b.ruined ? '<span class="why">a ruin</span>'
      : `${Math.ceil(b.hp)} / ${b.maxHp}`}</td></tr>`;
    h += `<tr><th>crew wanted</th><td>${need === 0 ? 'nobody' : need}` +
      `${b.upgraded ? ' <span class="note">(upgraded)</span>' : ''}</td>`;
    h += `<th>working</th><td>${isBuildingManned(state, b) ? 'yes'
      : `<span class="why">no</span> — ${crew.length}/${need} standing${coming > 0 ? `, ${coming} on the way` : ''}`}</td></tr>`;
    if (b.type === 'excavation') h += `<tr><th>dig</th><td colspan="3">${b.progress}/${C.EXCAVATION_TURNS} turns</td></tr>`;
    h += '</table>';

    if (b.ruined) {
      h += `<h3>rebuild</h3><p class="note">A ruin holds its ground and does nothing. Putting it back costs ` +
        `${Math.round(C.RUIN_REBUILD_FRACTION * 100)}% of building it new — ${costText(B.rebuildCost(b.type))}.</p>`;
      const fix = { type: 'repairBuilding', buildingId: b.id };
      const can = O.canEnqueue(state, fix);
      h += btn('Rebuild', 'order', fix, !can.ok) + (can.ok ? '' : ` <span class="why">${esc(can.why)}</span>`);
      return h;
    }

    h += '<h3>manning</h3>';
    if (need === 0) {
      h += `<p class="note">It runs on nobody${def.crew === 0 ? '' : ' — upgraded, or standing inside a Bunkhouse, or both'}.` +
        `${crew.length ? ' Anyone still standing in it is spare.' : ''}</p>`;
    }
    h += '<table>';
    if (need > 0) {
      for (const w of workerChoices(state)) {
        const order = { type: 'assignMan', who: w.id, targetId: b.id };
        const can = O.canEnqueue(state, order);
        h += row([w.label, '', '', '', btn('Man', 'order', order, !can.ok)], !can.ok, can.ok ? '' : can.why);
      }
    }
    // whoever is in it can always be sent away, wanted or not
    for (const a of crew) {
      h += row([`${esc(crewName(state, a.who))} is manning it`, '', '', '',
        btn('Stand down', 'order', { type: 'unassign', assignmentId: a.id })]);
    }
    h += '</table>';

    h += '<h3>crew upgrade</h3>';
    const up = { type: 'upgradeCrew', buildingId: b.id };
    const canUp = O.canEnqueue(state, up);
    h += `<p class="note">${C.CREW_UPGRADE_GOLD} gold on its works, once, and it runs with <b>one hand fewer</b>. ` +
      `It stacks with a Bunkhouse — upgraded and inside one, it wants nobody at all.</p>`;
    h += btn(b.upgraded ? 'Upgraded' : `Upgrade (${C.CREW_UPGRADE_GOLD} gold)`, 'order', up, !canUp.ok) +
      (canUp.ok ? '' : ` <span class="why">${esc(canUp.why)}</span>`);
    return h;
  },

  inventory(state) {
    const cap = holdCap(state);
    const workshop = hasBuilding(state, 'workshop');
    const proj = O.projectedItems(state);
    const held = (tower, tier) => proj.count(tower, tier);

    let h = '<h2>Inventory</h2>';
    h += `<p class="note">hold <b>${proj.hold.length}</b> / ${cap === Infinity ? 'unlimited' : cap}` +
      ' · every tower takes its own fitting, and they are not interchangeable' +
      ' · two of a kind at the same tier merge into the next</p>';
    h += `<p class="${workshop ? 'note' : 'why'}">` +
      (workshop ? 'A Workshop is working — fittings can be crafted from iron.' : 'Crafting needs an active Workshop.') +
      '</p>';
    h += `<p class="note">Only tier 1 is bought or crafted — ${B.itemBuyCost(state)} gold or ` +
      `${B.itemCraftCost(state)} iron. Everything above it is merged.` +
      (B.itemDiscount(state) < 1 ? ' The Weapons Master takes a quarter off both.' : '') + '</p>';

    h += '<div class="shop">';
    for (const def of C.TOWERS) {
      const buy = { type: 'buyItem', tower: def.i };
      const craft = { type: 'craftItem', tower: def.i };
      const cb = O.canEnqueue(state, buy);
      const cc = O.canEnqueue(state, craft);
      const stack = [];
      for (let tier = 1; tier <= C.MAX_TIER; tier++) {
        const n = held(def.i, tier);
        if (n) stack.push(`<span class="t${tier}">t${tier}&times;${n}</span>`);
      }
      h += '<div class="item">';
      h += `<div class="sq" style="border-color:${def.colour}">` +
        `<b style="color:${def.colour}">${esc(C.itemName(def.i))}</b>` +
        `<span>for the ${esc(def.name)}</span>` +
        `<span class="dim">${def.fire}</span>` +
        `<span class="stack">${stack.join(' ') || '<span class="dim">none held</span>'}</span></div>`;
      h += '<div class="btns">';
      h += btn(`buy — ${B.itemBuyCost(state)} gold`, 'order', buy, !cb.ok);
      h += btn(`craft — ${B.itemCraftCost(state)} iron`, 'order', craft, !cc.ok);
      for (let tier = 1; tier < C.MAX_TIER; tier++) {
        const merge = { type: 'mergeItems', tower: def.i, tier };
        const cm = O.canEnqueue(state, merge);
        if (!cm.ok && held(def.i, tier) < 2) continue; // only offer merges in reach
        h += btn(`merge 2&times;t${tier} &rarr; t${tier + 1}`, 'order', merge, !cm.ok);
      }
      h += '</div>';
      h += `<div class="why">${!cb.ok && !cc.ok ? esc(cb.why || cc.why) : ''}</div>`;
      h += '</div>';
    }
    h += '</div>';
    return h;
  },

  economy(state, { q, r }) {
    const spot = q === undefined ? null : { q, r };
    let h = `<h2>Economic buildings</h2>`;
    h += `<p class="note">Every building takes ${C.BUILDING_HANDS} hands to run (1 within ${C.BUNKHOUSE_RADIUS} of a Bunkhouse), ` +
      'and each one is priced for what it does. Pick one and place it on the map — the outline shows green where the ground will take it.</p>';
    h += `<p class="note">A yard needs cleared ground, road beside it joined to the ship, ` +
      `and ${C.BUILDING_GAP} tile clear of the next building. A Palisade needs none of that.</p>`;
    h += `<p class="note">Buildings are not fortifications the way towers are: what stands within reach of a ` +
      `lane gets pulled down. Nothing is ever destroyed outright — a wrecked building is a <b>ruin</b>, doing ` +
      `nothing and holding its ground, and rebuilding one costs ${Math.round(C.RUIN_REBUILD_FRACTION * 100)}% of building it new.</p>`;
    h += '<table><tr><th>building</th><th>tiles</th><th>cost</th><th>effect</th><th>state</th><th></th><th></th></tr>';
    for (const def of C.BUILDINGS) {
      const built = buildingsOfType(state, def.type);
      const stateOf = (b) => (b.ruined ? 'a ruin' : isBuildingManned(state, b)
        ? (handsNeededFor(state, b) === 0 ? 'working — no crew' : 'working')
        : `idle — ${assignmentsFor(state, b.id).filter((a) => arrived(state, a)).length}/${handsNeededFor(state, b)} crew`);
      let state_ = built.length ? built.map(stateOf).join(', ') : '—';
      let action = '';
      let why = '';
      const already = built.length && !def.repeatable;
      const cost = C.buildingCost(def.type);
      if (!already) {
        const afford = O.projectedRes(state);
        const poor = Object.entries(cost).find(([k, v]) => afford[k] < v);
        action = btn('Build', 'place', { building: def.type }, !!poor);
        if (poor) why = `needs ${poor[1]} ${poor[0]}`;
      }
      // Each building has a panel of its own — manning, its upgrade and its
      // condition live there, and so does the click on its tile.
      let extra = '';
      for (const b of built) {
        extra += ' ' + btn(built.length > 1 ? `${b.name} (${b.q},${b.r})` : 'Open', 'openBuilding', { id: b.id });
      }
      h += row([`<b>${def.name}</b>`, def.tiles, costText(cost), def.effect, state_, action + extra],
        !!built.length && !def.repeatable, why);
    }
    return h + '</table>';
  },

  crew(state) {
    const tasks = O.projectedAssignments(state);
    const idleOff = O.projectedIdleOfficers(state);
    let h = `<h2>Crew</h2><p class="note">${handCount(state)} hands (cap ${state.crew.cap + state.crew.capBonus}), ` +
      `${O.projectedHands(state)} idle once the queue runs · officers replace a hand one for one · ` +
      'a short walk is free — the worker gets there and starts the same turn; a longer one costs a turn, ' +
      'a march across the island two. It is the way round that counts, not the straight line</p>';
    h += '<table><tr><th>who</th><th>task</th><th>target</th><th>state</th><th></th></tr>';
    for (const a of tasks) {
      const officer = officerById(state, a.who);
      const who = officer ? `<b>${esc(crewName(state, a.who))}</b>` : esc(crewName(state, a.who));
      const target = a.kind === 'man' ? manTargetName(state, a.target)
        : a.target && a.target.q !== undefined ? tileLabel(state, a.target) : String(a.target);
      const when = taskState(state, a);
      const stop = a.queued
        ? `<button data-x="revoke" data-arg='${esc(JSON.stringify({ id: a.id }))}'>x</button>`
        : a.kind === 'assault' ? ''
          : btn('Idle', 'order', { type: 'reassign', assignmentId: a.id, kind: 'idle' });
      h += `<tr class="${a.queued ? 'queued' : ''}"><td>${who}</td><td>${a.kind}</td>` +
        `<td>${target}</td><td>${when}</td><td>${stop} ${locateBtn(state, a.who)}</td></tr>`;
    }
    // everyone else is standing about somewhere, which is where their next walk
    // is measured from
    const busy = new Set(tasks.map((a) => a.who));
    for (const m of state.crew.members) {
      if (busy.has(m.id)) continue;
      const officer = officerById(state, m.id);
      h += row([officer ? `<b>${esc(m.name)}</b>` : esc(m.name), 'idle',
        officer ? `<span class="note">${esc(officer.verb)}</span>` : `standing at (${m.q},${m.r})`,
        'free', locateBtn(state, m.id)]);
    }
    h += '</table>';
    h += '<p class="note">To put someone to work: shift-click a tile to clear it, or open a tower or building and man it. ' +
      'A worker has to be able to walk there, so ground cut off by river, cliff or boulder cannot be worked until a way is opened.</p>';
    return h;
  },

  /** Ending the turn while bodies stand about: who they are, and a way past. */
  idleWarning(state) {
    const tasks = O.projectedAssignments(state);
    const busy = new Set(tasks.map((a) => a.who));
    const spare = state.crew.members.filter((m) => !busy.has(m.id));
    const hands = spare.filter((m) => m.kind === 'hand');
    const officers = spare.filter((m) => m.kind === 'officer');
    let h = '<h2>Nobody has told them what to do</h2>';
    h += `<p class="why">${spare.length} of the company ` +
      `${spare.length === 1 ? 'is' : 'are'} standing about — a turn they spend idle is a turn nobody gets back.</p>`;
    h += '<table>';
    for (const m of officers) {
      const o = officerById(state, m.id);
      h += row([`<b>${esc(m.name)}</b>`, `<span class="note">${esc(o ? o.verb : '')}</span>`, `(${m.q},${m.r})`, '', '']);
    }
    if (hands.length) {
      h += row([`${hands.length} hand${hands.length === 1 ? '' : 's'}`,
        `<span class="note">${esc(hands.slice(0, 6).map((m) => m.name).join(', '))}` +
        `${hands.length > 6 ? `, and ${hands.length - 6} more` : ''}</span>`, '', '', '']);
    }
    h += '</table>';
    h += `<p>${btn('End the turn anyway', 'endTurn')} ${btn('Go back', 'close')}</p>`;
    h += '<p class="note">Shift-click a tile to put the next hand on it, or open a tower or building and man it.</p>';
    return h;
  },

  flare(state) {
    const cost = B.flareCost(state);
    const order = { type: 'fireFlare' };
    const can = O.canEnqueue(state, order);
    const used = state.crew.flaresFired + state.crew.flaresInFlight.length;
    let h = `<h2>Flare</h2><table>`;
    h += `<tr><th>cost</th><td>${costText(cost)}</td></tr>`;
    h += `<tr><th>brings</th><td>${C.FLARE_HANDS} hands</td></tr>`;
    h += `<tr><th>lands in</th><td>${B.flareDelay(state)} turns</td></tr>`;
    h += `<tr><th>used</th><td>${used} of ${B.flareAllowance(state)} allowed in act ${'I'.repeat(state.act)}</td></tr>`;
    h += `<tr><th>in flight</th><td>${state.crew.flaresInFlight.map((f) => `lands turn ${f.landsOnTurn}`).join(', ') || '—'}</td></tr>`;
    h += '</table><p>' + btn('Fire', 'orderClose', order, !can.ok) + (can.ok ? '' : ` <span class="why">${esc(can.why)}</span>`) + '</p>';
    h += '<p class="note">The price never escalates. The act gate is the only limiter.</p>';
    return h;
  },

  assault(state) {
    let h = `<h2>Bug Sabotage mission</h2><p class="note">A spawner can only be destroyed by a sabotage team. ` +
      `${A.assaultHands(state)} hands, ${C.MARCH_TURNS} turns out. Nobody dies; failure costs ${A.downtimeTurns(state)} turns of downtime.</p>`;
    h += '<table><tr><th>target</th><th>road path</th><th>leader</th><th>success</th><th></th><th></th></tr>';
    for (const sp of state.spawners.filter((x) => x.alive)) {
      for (const leader of [null, ...state.crew.officers.map((o) => o.id)]) {
        const order = { type: 'scheduleAssault', spawnerId: sp.id, leader };
        const can = O.canEnqueue(state, order);
        const name = leader ? state.crew.officers.find((o) => o.id === leader).name : 'nobody';
        h += row([`${sp.name} (${sp.q}, ${sp.r})`, roadWord(state, sp), name,
          `${Math.round(A.successChance(state, leader) * 100)}%`, btn('Send', 'orderClose', order, !can.ok)],
        !can.ok, can.ok ? '' : can.why);
      }
    }
    for (const a of state.assaults) {
      const sp = state.spawners.find((x) => x.id === a.targetSpawnerId);
      h += row([`under way -> ${sp ? sp.name : '?'}`, a.state, a.leader || 'nobody', `${a.turnsRemaining} turns left`, '']);
    }
    return h + '</table>';
  },

  ship(state) {
    let h = `<h2>The ship</h2><table>`;
    h += `<tr><th>hull</th><td>${state.base.hull} / ${C.HULL_MAX}</td></tr>`;
    h += `<tr><th>guns</th><td>${C.SHIP_DPS} dps into cleared ground within ${C.SHIP_RANGE} tiles</td></tr>`;
    h += `<tr><th>hold</th><td>${state.base.hold.length} / ${holdCap(state) === Infinity ? 'unlimited' : C.HOLD_SLOTS}</td></tr>`;
    h += '</table><h3>repair</h3><table>';
    for (const n of [1, 5, 10, B.repairable(state)]) {
      if (n <= 0) continue;
      const order = { type: 'repairHull', points: n };
      const can = O.canEnqueue(state, order);
      h += row([`+${n} hull`, `${n * C.REPAIR_WOOD_PER_HULL} wood`, '', '', btn('Repair', 'order', order, !can.ok)], !can.ok, can.ok ? '' : can.why);
    }
    return h + '</table>';
  },

  clearTile(state, { q, r }) {
    const t = tileAt(state, q, r);
    let h = `<h2>${esc(tileLabel(state, { q, r }))}</h2>`;

    const already = O.workersOn(state, { q, r });
    if (already.length) {
      h += '<h3>already spoken for</h3><table>';
      for (const a of already) {
        const officer = officerById(state, a.who);
        const who = officer ? `<b>${esc(crewName(state, a.who))}</b>` : esc(crewName(state, a.who));
        const stop = a.queued
          ? `<button data-x="revoke" data-arg='${esc(JSON.stringify({ id: a.id }))}'>x</button>`
          : btn('Stand down', 'order', { type: 'reassign', assignmentId: a.id, kind: 'idle' });
        h += `<tr class="${a.queued ? 'queued' : ''}"><td>${who}</td><td>${a.kind}</td>` +
          `<td>${taskState(state, a)}</td><td></td><td>${stop}</td></tr>`;
      }
      h += '</table>';
    }

    // One face, one worker. While someone has it, there is nothing to offer —
    // stand them down above and the choices come back.
    if (!already.length) {
      // Whatever the tile is holding, shut or open, said once and drawn once.
      // Shut, this replaces what used to be a second table with a row per worker
      // and "clear the tile first" written against every one of them — a grid of
      // refusals saying a single thing that was not about any of the workers.
      if (t && t.feature && !t.featureWorked) h += featureNote(state, t);

      // Who can be sent, how far they walk, when the work starts, and what they
      // can actually do here. One table: the choice is which body, and every
      // job this tile offers is a button on that body's row.
      const rows = [];
      for (const w of workerChoices(state, { q, r })) {
        const jobs = tileJobs(state, t, { q, r });
        if (!jobs.length) break;                       // nothing on offer to anybody
        const buttons = jobs.map((j) => {
          const can = O.canEnqueue(state, { ...j.order, who: w.id });
          return { html: btn(j.label, 'orderClose', { ...j.order, who: w.id }, !can.ok), can };
        });
        const walk = walkCells(state, w, { q, r });
        const off = buttons.every((b) => !b.can.ok);
        const why = off ? (buttons.find((b) => b.can.why) || {}).can.why : '';
        rows.push(row([w.label, walk.far, walk.when, buttons.map((b) => b.html).join(' ')], off, why));
      }
      if (rows.length) {
        h += '<table><tr><th>who</th><th>distance</th><th>work starts</th><th></th><th></th></tr>'
          + rows.join('') + '</table>';
        h += '<p class="note">A worker takes one job and is free again, standing where the work left them.</p>';
      }
    }

    // ground with nothing on it and nothing to cut: say so rather than show a
    // box with nothing in it
    if (!already.length && !(t && isClearable(state, t)) && !(t && t.feature && !t.featureWorked)
        && !(t && t.terrain === 'freshwater' && !t.bridge)) {
      h += `<p class="note">Nothing to do here. ${t && isOpenGround(t)
        ? 'The crew can walk over this ground, but there is nothing on it to work.'
        : 'This ground cannot be cut, built on or crossed.'}</p>`;
    }
    if (t && t.terrain === 'freshwater' && !t.bridge) {
      const order = { type: 'buildBridge', q, r };
      const can = O.canEnqueue(state, order);
      h += '<h3>bridge it</h3><table>';
      h += row(['a bridge over this river tile', `${C.BRIDGE_COST_WOOD} wood`, '', '', btn('Bridge', 'orderClose', order, !can.ok)], !can.ok, can.ok ? '' : can.why);
      h += '</table>';
    }
    return h;
  },

  /**
   * Every turn ends with this, whether anything happened or not. A quiet turn
   * is still worth a beat, and what is under way is worth saying when there is
   * nothing else to report.
   */
  turnSummary(state, { events }) {
    let h = `<h2>Turn ${state.turn - 1}</h2><table>`;
    const lines = summarise(events);
    for (const l of lines) h += `<tr><td>${esc(l)}</td></tr>`;
    if (!lines.length) h += '<tr><td>a quiet turn — nothing came of it</td></tr>';
    h += '</table>';

    const tasks = state.crew.assignments;
    // counted the same way the rows are worded: on the road until they are on it
    const working = tasks.filter((a) => standingOnJob(state, a)).length;
    const walking = tasks.length - working;
    const under = [];
    if (working) under.push(`${working} at work`);
    if (walking) under.push(`${walking} on the way`);
    const spare = O.projectedHands(state) + O.projectedIdleOfficers(state).length;
    if (spare) under.push(`<span class="why">${spare} standing about</span>`);
    const cohorts = state.cohorts.length;
    if (cohorts) under.push(`${cohorts} cohort${cohorts === 1 ? '' : 's'} on the move`);
    if (under.length) h += `<p class="note">${under.join(' · ')}</p>`;
    return h;
  },

  assaultResult(state, { event }) {
    const e = event;
    let h = `<h2>Bug Sabotage mission — ${e.result}</h2>`;
    const narration = e.result === 'success'
      ? [`The team reaches the ${e.target} in the dark.`,
        'Charges go in under the mound; the ground lifts and settles.',
        'Whatever was breeding in there is not breeding now.']
      : [`The ${e.target} was awake.`,
        'The team gets within sight of the mound and no further.',
        `Nobody dies. They are unfit for ${e.downtime} turns.`];
    h += narration.map((n) => `<p>${esc(n)}</p>`).join('');
    h += `<p class="note">led by ${e.leader || 'nobody'} — ${Math.round(e.chance * 100)}% chance</p>`;
    return h;
  },

  /**
   * A fresh island, on a seed of the player's choosing.
   *
   * Prefilled with the seed a new run would take anyway, so this is still one
   * press for anyone who does not care which island they get; typing over it is
   * for going back to one already played, since the map is the seed and nothing
   * else.
   */
  newRun(state, props) {
    let h = '<h2>New run</h2>';
    h += '<p class="note">The island is the seed and nothing else — the same number lays out the same ground every time.</p>';
    h += '<p><label><span class="k">seed</span> '
      + `<input data-prop="seed" data-submit="startRun" data-focus="1" type="text" inputmode="numeric"`
      + ` size="12" value="${esc(props.seed ?? nextSeed(state.seed))}"></label> `
      + btn('Roll', 'rollSeed') + '</p>';
    // Checked when it is submitted rather than as it is typed: live checking
    // means re-rendering the modal on every keystroke, and this box is read once.
    if (props.why) h += `<p class="why">${esc(props.why)}</p>`;
    h += '<p>' + btn('Start run', 'startRun') + '</p>';
    h += '<p class="note">The run on the screen is lost. Nothing persists between runs.</p>';
    return h;
  },

  endOfRun(state) {
    let h = `<h2>${esc(outcomeText(state.outcome))}</h2><table>`;
    const st = state.stats;
    const rows = [
      ['outcome', state.outcome],
      ['turns taken', state.turn],
      ['tiles cleared', st.tilesCleared],
      ['peak power', st.peakPower.toFixed(1)],
      ['wood earned', st.woodEarned],
      ['stone earned', st.stoneEarned],
      ['iron earned', st.ironEarned],
      ['gold earned', st.goldEarned],
      ['waves fought', st.wavesFought],
      ['units killed', st.unitsKilled],
      ['units leaked', st.unitsLeaked],
      ['hull left', `${state.base.hull} / ${C.HULL_MAX}`],
    ];
    for (const [k, v] of rows) h += `<tr><th>${k}</th><td>${esc(v)}</td></tr>`;
    h += '</table><p>' + btn('New run', 'newRun') + '</p>';
    h += '<p class="note">Nothing persists between runs.</p>';
    return h;
  },
};

// ---- helpers ---------------------------------------------------------------

/**
 * What a worker is doing, as the player can see it on the map.
 *
 * Not `arrived`, which is a statement about the coming resolve rather than about
 * now: it goes true on the turn the walk finishes, because `runMovement` runs
 * before the labour and the arrival turn is a working turn. Read as a label it
 * was a lie for exactly one turn — the dots plainly strung out along the route
 * and every panel saying "working". The honest test is where the body is
 * standing, so that is what this asks.
 */
export function taskState(state, a) {
  if (a.queued) return 'queued';
  if (standingOnJob(state, a)) return 'working';
  return arrived(state, a) ? 'travelling — arrives this turn'
    : `travelling — arrives turn ${a.arrivesOnTurn}`;
}

function standingOnJob(state, a) {
  const m = memberById(state, a.who);
  const to = jobPlace(state, a);
  return !!m && !!to && m.q === to.q && m.r === to.r;
}

/**
 * Workers who could take this job, counting the queue. A labour officer stays
 * on the list while he has faces left to work.
 *
 * Given where the job is, the list comes out nearest first — the choice a
 * player almost always wants is the body already standing next to the work,
 * not whoever happens to be first on the roster.
 */
function workerChoices(state, to) {
  const out = [];
  const free = O.projectedHands(state);
  // one walk model for the whole panel: the ground the crew will be standing on
  // once this turn resolves, which is what the resolve itself routes over
  const held = to ? O.crewGroundAtResolve(state) : null;
  // Whoever the queue has already spoken for is not offered again: the register
  // is computed once here and carried on every row, because working it out per
  // row would rebuild it for each comparison the sort makes.
  const spoken = O.projectedCrew(state).taken;
  out.push({ id: 'hand', label: `a hand (${Math.max(0, free)} idle)`, spoken });
  const tasks = O.projectedAssignments(state);
  for (const o of state.crew.officers) {
    const mine = tasks.filter((a) => a.who === o.id);
    if (!mine.length) { out.push({ id: o.id, spoken, label: `<b>${esc(o.name)}</b> — ${esc(o.verb)}` }); continue; }
    const cap = clearCapacity(state, o.id);
    const clears = mine.filter((a) => a.kind === 'clear');
    if (cap > 1 && clears.length === mine.length && clears.length < cap) {
      const left = cap - clears.length;
      // his spare faces are free only on the ground he is already cutting
      const held = tileAt(state, clears[0].target.q, clears[0].target.r);
      out.push({
        id: o.id,
        batch: clears.map((a) => a.target),
        batchGround: held ? held.terrain : null,
        spoken,
        label: `<b>${esc(o.name)}</b> — ${left} more face${left === 1 ? '' : 's'} to work`,
      });
    }
  }
  if (!to) return out;
  for (const w of out) w.held = held;
  // stable, so equal walks keep the roster order and the plain hand stays first
  return out.sort((a, b) => walkRank(state, a, to) - walkRank(state, b, to));
}

/**
 * Where the body who would actually take this job is standing, or null.
 *
 * Out of whoever is left once the queue has taken its crew — not whoever is
 * idle this instant. Ask for two tiles in one phase and the second is quoted
 * for the second-nearest hand, because that is who will walk it.
 */
function wouldTake(state, w, to) {
  const pool = state.crew.members.filter((m) => !(w.spoken && w.spoken.has(m.id))
    && (w.id === 'hand' ? m.kind === 'hand' : m.id === w.id));
  return pickNearest(state, pool, to, w.held) || nearestIdle(state, w.id, to, w.held);
}

/**
 * The walk to the job for whoever would take it: how far, and how many turns.
 *
 * Measured over the route they would actually walk, because that is what the
 * sim charges. Quoting the straight line here made the panel promise a walk it
 * could not keep — "10 tiles away, 0 turns, work starts this turn" for a job
 * round the far side of a wood that the resolve then billed a turn for.
 */
function walkFor(state, w, to) {
  const ground = tileAt(state, to.q, to.r);
  const sameTrip = !!(w.batch && w.batch.some((p) => distance(p, to) === 1)
    && ground && ground.terrain === w.batchGround);
  const m = wouldTake(state, w, to);
  if (!m) return null;
  const route = crewRoute(state, m, to, w.held);
  if (!route.reachable) return { tiles: 0, turns: Infinity, sameTrip: false, reachable: false };
  return {
    tiles: route.steps.length - 1, turns: sameTrip ? 0 : C.travelTurns(route.cost), sameTrip, reachable: true,
  };
}

/** Sort key: turns of walking first, then raw distance; nobody to send is last. */
function walkRank(state, w, to) {
  const walk = walkFor(state, w, to);
  if (!walk || !walk.reachable) return Infinity;   // nobody to send goes last
  return walk.turns * 1000 + walk.tiles;
}

/**
 * Every job this tile has on offer, whoever ends up taking it.
 *
 * A point of interest is only offered once the ground over it is open. Under
 * standing forest it is not a job that is merely refused — there is nothing to
 * dig at yet — so it is described rather than listed, and `buriedNote` does
 * that once instead of a table doing it once per worker.
 */
function tileJobs(state, t, at) {
  if (!t) return [];
  const jobs = [];
  if (isClearable(state, t)) {
    jobs.push({ label: 'clear tile', order: { type: 'assignClear', target: { q: at.q, r: at.r } } });
  }
  const open = t.feature && !t.featureWorked && !isClearable(state, t);
  const action = open ? C.featureAction(t.feature) : null;
  if (action) {
    jobs.push({ label: `${action} the ${featureWord(t.feature)}`, order: { type: 'workFeature', target: { q: at.q, r: at.r } } });
  }
  // The spring is held, not worked: nobody finishes with it, and it pays only
  // for as long as somebody is standing there.
  if (open && t.feature === 'spring') {
    jobs.push({ label: 'hold the spring', order: { type: 'assignGarrison', target: { q: at.q, r: at.r } } });
  }
  return jobs;
}

/**
 * What the tile is holding, as prose and a picture.
 *
 * The picture is the reel's own, which is the point: the chest you are told is
 * down there is the chest you will be shown being dug up. It is drawn whether
 * the ground is shut or open — a site you are about to work is the one moment
 * you most want to see what it is, and the row of buttons only names it.
 *
 * The prose is what changes. Shut, it says the ground has to come off first;
 * open, it says what the work is worth and what it costs.
 */
function featureNote(state, t) {
  const kind = t.feature;
  const prize = featurePrize(kind);
  const action = C.featureAction(kind);
  const shut = isClearable(state, t);
  const held = `It is held rather than worked: a body standing on it raises the hand cap by ${C.FEATURES.spring.handsCap}, and only for as long as they stand there.`;

  const where = (shut ? BURIED_PHRASE : OPEN_PHRASE)[kind]
    || (shut ? `A ${featureWord(kind)} lies under this standing ground` : `The ${featureWord(kind)} is in the open`);
  const what = `${where}${prize ? ` — ${prize}` : ''}.`;
  const then = shut
    ? `Cut the tile first. ${action ? 'Working it is a turn of its own after that, and one worker does both.' : held}`
    : (action ? "One turn's work for whoever goes." : held);

  return `<pre class="art">${esc(art.forFeature(kind))}</pre>`
    + `<p class="note">${esc(what)} ${esc(then)}</p>`;
}

/**
 * The walk, split into the two questions a player actually asks: how far away
 * is the body, and when does the work start. They were one sentence, which read
 * fine on its own and could not be scanned down a column against four others.
 */
function walkCells(state, w, to) {
  const walk = walkFor(state, w, to);
  if (!walk) return { far: '<span class="dim">nobody to send</span>', when: '' };
  if (!walk.reachable) return { far: '<span class="bad">cannot get to it</span>', when: '' };
  if (walk.sameTrip) return { far: 'the same trip', when: 'this turn' };
  if (walk.tiles === 0) return { far: 'standing on it', when: 'this turn' };
  const far = `${walk.tiles} tile${walk.tiles === 1 ? '' : 's'} away`;
  return {
    far,
    when: walk.turns === 0 ? 'this turn'
      : `after ${walk.turns} turn${walk.turns === 1 ? '' : 's'} walking`,
  };
}

// Where the thing is, in its own words. One phrase per site rather than one
// sentence with the word swapped in: a chest is buried, a castaway is not, and
// "there is a castaway under this ground" is a sentence about a grave.
const BURIED_PHRASE = {
  wreck: 'A wreck lies under this standing ground',
  cache: 'A chest lies buried under this standing ground',
  officer: 'A castaway is somewhere in this standing ground',
  spring: 'A spring rises under this standing ground',
};
const OPEN_PHRASE = {
  wreck: 'The wreck lies open to the sky',
  cache: 'The chest lies open to the sky',
  officer: 'The castaway is in the open',
  spring: 'The spring runs in the open',
};

const FEATURE_WORD = { cache: 'chest', wreck: 'wreck', officer: 'castaway', spring: 'spring' };
const featureWord = (kind) => FEATURE_WORD[kind] || kind;

function featurePrize(kind) {
  if (kind === 'wreck') return `${C.FEATURES.wreck.wood} wood`;
  if (kind === 'cache') return `${C.FEATURES.cache.gold} gold`;
  if (kind === 'officer') return 'a fifth officer joins the company';
  return '';
}

function manTargetName(state, id) {
  const tw = state.towers.find((x) => x.id === id);
  if (tw) return `${C.TOWERS[tw.towerIndex].name} (${tw.q}, ${tw.r})`;
  const b = state.buildings.find((x) => x.id === id);
  return b ? `${b.name} (${b.tiles[0].q}, ${b.tiles[0].r})` : id;
}

function roadWord(state, sp) {
  return roadReaches(state, sp) ? '<span class="good">yes</span>' : '<span class="bad">no</span>';
}

export function summarise(events) {
  const out = [];
  for (const e of events) {
    switch (e.kind) {
      case 'cleared': out.push(`cleared ${e.tiles} tiles: +${e.wood} wood, +${e.stone} stone`); break;
      case 'built': out.push(`${e.what} stands at (${e.q}, ${e.r})`); break;
      case 'produced': out.push(`production: ${e.iron ? `+${e.iron} iron ` : ''}${e.gold ? `+${e.gold} gold` : ''}`); break;
      case 'cache': out.push(`a treasure cache pays out ${e.gold} gold`); break;
      case 'flareLanded': out.push(`a boat lands — ${e.count * C.FLARE_HANDS} hands, ${e.hands} in all`); break;
      case 'escalation': out.push(`the ${e.spawner} gains a star (${e.stars})`); break;
      case 'cohort': out.push(`the ${e.spawner} releases a cohort of ${e.units}`); break;
      case 'merged': out.push(`two cohorts merge — ${e.units} units`); break;
      case 'contact': out.push(`contact at (${e.q}, ${e.r}) — ${e.units} units`); break;
      case 'combatEnd':
        out.push(`the resolve: ${e.killed} killed, ${e.leaked} leaked, hull ${e.hullBefore} -> ${e.hullAfter}`);
        for (const r of e.ruined || []) out.push(`${r.name} was pulled down at (${r.q}, ${r.r}) — a ruin until it is rebuilt`);
        break;
      case 'rebuilt': out.push(`${e.what} is rebuilt out of its own ruin`); break;
      case 'spawnerDied': out.push(`the ${e.spawner} is destroyed`); break;
      case 'refused': out.push(`order refused — ${e.why}`); break;
      case 'feature':
        if (e.feature === 'wreck') out.push(`the shipwreck is searched — ${e.wood} wood`);
        else if (e.feature === 'cache') out.push(`a chest is dug up — ${e.gold} gold`);
        else if (e.feature === 'officer') out.push('the castaway is saved');
        break;
      case 'officer': out.push(`${e.name} joins the company`); break;
      case 'fitted': out.push(`a tier-${e.tier} item is fitted${e.displaced ? `, a tier-${e.displaced} item returns to the hold` : ''}`); break;
      case 'evolved': out.push(`${e.name} evolves`); break;
      default: break;
    }
  }
  return out;
}

// ---- actions ---------------------------------------------------------------

const ACTIONS = {
  openBuilding(state, payload, ui) { open('building', { id: payload.id }, ui); },
  order(state, payload, ui) { ui.order(payload); ui.refresh(); },
  orderClose(state, payload, ui) { ui.order(payload); close(ui); },
  revoke(state, payload, ui) { ui.revoke(payload.id); ui.refresh(); },
  place(state, payload, ui) { ui.place(payload.building); close(ui); },
  locate(state, payload, ui) { close(ui); ui.locate(payload); },
  newRun(state, payload, ui) { open('newRun', {}, ui); },
  rollSeed(state, payload, ui) {
    open('newRun', { seed: 1 + Math.floor(Math.random() * 2147483646) }, ui);
  },
  startRun(state, payload, ui) {
    // Off the props, not off the payload: a button carries the arguments it was
    // rendered with, and this one's argument is whatever has since been typed
    // into the box beside it.
    const seed = Number(String(current.props.seed ?? '').trim() || nextSeed(state.seed));
    // Bounded at the top as well as the bottom: the generator's own arithmetic
    // is the 31-bit range, and a seed past it silently stops being the number
    // that was typed.
    if (!Number.isInteger(seed) || seed <= 0 || seed > 2147483646) {
      return open('newRun', {
        seed: current.props.seed,
        why: 'a seed is a whole number from 1 to 2147483646',
      }, ui);
    }
    ui.newRun(seed);
  },
  endTurn(state, payload, ui) { current = null; ui.endTurn(); },
};
