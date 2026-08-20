// Entry: builds state, wires view to sim, starts the loop.
// This is the only place sim/ and view/ meet.

import C from './sim/config.js';
import { createState, tileAt, isBuildable, isClearable, idleHands, roadNetwork } from './sim/state.js';
import * as St from './sim/state.js';
import * as H from './sim/hex.js';
import { resolveTurn, concludeTurn } from './sim/turn.js';
import * as combat from './sim/combat.js';
import * as O from './sim/orders.js';
import * as B from './sim/build.js';
import { createCamera, centreOn, zoomBy, pan, screenToAxial, hexSize } from './view/camera.js';
import { render } from './view/render.js';
import { renderHud } from './view/hud.js';
import { renderHover } from './view/hover.js';
import { renderLog } from './view/log.js';
import * as modals from './view/modals.js';

const canvas = document.getElementById('map');
const hudEl = document.getElementById('hud');
const hoverEl = document.getElementById('hover');
const queueEl = document.getElementById('queue');
const logEl = document.getElementById('log');
const modalEl = document.getElementById('modal');
const backdrop = document.getElementById('backdrop');
const strip = document.getElementById('combat-strip');

const params = new URLSearchParams(location.search);
const seedFromUrl = Number(params.get('seed'));

let state = createState(Number.isFinite(seedFromUrl) && seedFromUrl ? seedFromUrl : C.DEFAULT_SEED);
const cam = createCamera();
const ui = {
  hover: null,
  placing: null,       // a building type following the cursor
  pendingEvents: [],
  revoke: (id) => { O.revoke(state, id); refresh(); },
  place: (building) => { ui.placing = building; refresh(); },
  order: (o) => { const r = O.enqueue(state, o); if (!r.ok) flash(r.why); return r; },
  refresh,
  endTurn: () => endTurn(true),
  // Named seed or none: the modal always names one, so the walk is only the
  // fallback for anything that starts a run without asking which island.
  newRun: (seed) => {
    state = createState(seed || modals.nextSeed(state.seed));
    ui.pendingEvents = [];
    modals.close(ui);
    resize();
    centreOn(cam, canvas, state.base.q, state.base.r);
    refresh();
  },
};

// ---- layout ----------------------------------------------------------------

/**
 * The backing store must match the canvas's own laid-out box, or every
 * mouse coordinate (which arrives in CSS pixels) lands on the wrong hex.
 */
function resize() {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(200, Math.round(rect.width));
  const h = Math.max(200, Math.round(rect.height));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
}
window.addEventListener('resize', resize);
resize();
cam.zoom = 3;
centreOn(cam, canvas, state.base.q, state.base.r);
// once more after layout has settled, keeping the ship centred
requestAnimationFrame(() => { resize(); centreOn(cam, canvas, state.base.q, state.base.r); });

// ---- DOM refresh -----------------------------------------------------------

let flashText = '';
let flashUntil = 0;
function flash(text) {
  flashText = text;
  flashUntil = performance.now() + 2500;
  renderQueue();
}

function refresh() {
  renderHud(state, hudEl);
  renderHover(state, hoverEl, ui.hover);
  renderQueue();
  renderLog(state, logEl);
  modals.renderModal(state, modalEl, backdrop, ui);
  document.getElementById('endturn').disabled = state.phase !== 'player';

  const spare = O.projectedHands(state) + O.projectedIdleOfficers(state).length;
  const bodies = St.crewCount(state);
  document.querySelector('[data-action="crew"]').textContent = `Crew ${bodies}`;
  const note = document.getElementById('crewnote');
  note.textContent = spare > 0 ? `${spare} spare` : 'nobody spare';
  note.className = spare > 0 ? 'dim' : 'bad';
}

function renderQueue() {
  // Who each order will actually take, named on the row. The queue is applied
  // in order and each order takes the nearest body still free, so two "a hand"
  // orders are two different hands — and until this said so, the panel quoted
  // the same one twice.
  //
  // Asked over the ground the crew will be standing on once this turn resolves,
  // which is the ground the resolve itself hands out bodies over. Asked over
  // where they are standing *now*, every job past the frontier had no route and
  // so no body, and the row went out nameless — a queue of eight orders naming
  // three hands, with the work the other five would plainly do disowned.
  const { byOrder } = O.projectedCrew(state, O.crewGroundAtResolve(state));
  const rows = state.orders.map((o) => {
    const label = O.describe(state, o);
    const who = byOrder.get(o.id);
    const name = who ? ` — ${St.crewName(state, who)}` : '';
    return `<div class="q-row"><span>${escape(label)}${escape(name)}</span>`
      + `<button data-revoke="${o.id}">x</button></div>`;
  });
  // The stores and the idle count used to be restated under the rows. Both live
  // in the bar now — the resources there are already spent down by the queue,
  // and the crew button carries the spare bodies — so the panel is the orders.
  queueEl.innerHTML = `<b>QUEUE</b> <span class="dim">(${state.orders.length})</span>\n` +
    (rows.join('') || '<span class="dim">empty — orders apply when the turn ends</span>') +
    (performance.now() < flashUntil ? `\n<span class="bad">${escape(flashText)}</span>` : '');
  queueEl.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = () => { O.revoke(state, b.dataset.revoke); refresh(); };
  });
}

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

// ---- the turn --------------------------------------------------------------

/**
 * Ending the turn with bodies standing about is nearly always a mistake, so it
 * asks first. `confirmed` is the answer coming back from that modal.
 */
function endTurn(confirmed = false) {
  if (state.phase !== 'player') return;
  const spare = O.projectedHands(state) + O.projectedIdleOfficers(state).length;
  if (spare > 0 && !confirmed) {
    if (modals.currentModal() && modals.currentModal().name === 'idleWarning') return;
    return modals.open('idleWarning', {}, ui);
  }
  modals.close(ui);
  ui.pendingEvents = resolveTurn(state);
  if (state.combat) { renderStrip(); refresh(); return; } // the ticker takes over
  finishTurn();
}

function finishTurn() {
  const events = ui.pendingEvents;
  ui.pendingEvents = [];
  concludeTurn(state, events);
  strip.hidden = true;

  const assault = events.find((e) => e.kind === 'assault');
  if (state.outcome) modals.open('endOfRun', {}, ui);
  else if (assault) modals.open('assaultResult', { event: assault }, ui);
  else modals.open('turnSummary', { events }, ui); // every turn closes with a report
  refresh();
}

// ---- the combat strip ------------------------------------------------------

function renderStrip() {
  const cb = state.combat;
  if (!cb) { strip.hidden = true; return; }
  strip.hidden = false;
  const e = cb.groups[0].entry;
  const alive = cb.groups.reduce((n, g) => n + g.units.filter((u) => u.alive).length, 0);
  strip.innerHTML =
    `CONTACT — entry at (${e.q}, ${e.r})` +
    `        <button data-s="1">1x</button><button data-s="3">3x</button><button data-s="skip">skip</button>\n` +
    `cohort: ${cb.startCount} units (${cb.composition.grub} grub, ${cb.composition.shell} shell` +
    `${cb.composition.elite ? `, ${cb.composition.elite} elite` : ''})     ` +
    `standing ${alive}     killed ${cb.killed}     leaked ${cb.leaked}\n` +
    `elapsed ${cb.elapsed.toFixed(1)} s${cb.groups[0].overland ? '   (no road path — they come overland)' : ''}`;
  strip.querySelectorAll('[data-s]').forEach((b) => {
    b.onclick = () => setSpeed(b.dataset.s);
  });
}

function setSpeed(s) {
  if (!state.combat) return;
  if (s === 'skip') { combat.skip(state); return; }
  state.combat.speed = Number(s);
}

// ---- the frame loop --------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  resize();
  if (state.phase === 'combat' && state.combat) {
    const done = combat.tick(state, dt);
    renderStrip();
    if (done) {
      const summary = combat.finishCombat(state);
      if (summary) ui.pendingEvents.push(summary);
      state.phase = 'resolve';
      finishTurn();
    }
  }
  render(state, cam, canvas, ui);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- input -----------------------------------------------------------------

let dragging = false, dragged = false, lastX = 0, lastY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragging = true; dragged = false;
  lastX = e.offsetX; lastY = e.offsetY;
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (dragged || e.target !== canvas) return;
  const h = screenToAxial(cam, canvas, e.offsetX, e.offsetY);
  if (e.shiftKey) assignClearAt(h);
  else clickTile(h);
});

canvas.addEventListener('mousemove', (e) => {
  if (dragging) {
    const dx = e.offsetX - lastX, dy = e.offsetY - lastY;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    pan(cam, dx, dy);
    lastX = e.offsetX; lastY = e.offsetY;
    return;
  }
  const h = screenToAxial(cam, canvas, e.offsetX, e.offsetY);
  if (!ui.hover || ui.hover.q !== h.q || ui.hover.r !== h.r) {
    ui.hover = h;
    renderHover(state, hoverEl, ui.hover);
  }
});

canvas.addEventListener('mouseleave', () => { ui.hover = null; renderHover(state, hoverEl, null); });

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  assignClearAt(screenToAxial(cam, canvas, e.offsetX, e.offsetY));
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  zoomBy(cam, canvas, e.deltaY < 0 ? 1 : -1, e.offsetX, e.offsetY);
}, { passive: false });

/** An unworked point of interest with a job still on it. */
const poiReady = (s, t) => !!(t.feature && !t.featureWorked && C.featureAction(t.feature));

/**
 * Shift-click: put the next hand on whatever this tile needs — cut it if it
 * still wants cutting, otherwise work what the cutting uncovered.
 */
function assignClearAt(h) {
  const t = tileAt(state, h.q, h.r);
  const type = t && !isClearable(state, t) && poiReady(state, t) ? 'workFeature' : 'assignClear';
  const r = O.enqueue(state, { type, who: 'hand', target: { q: h.q, r: h.r } });
  if (!r.ok) flash(r.why);
  refresh();
}

function clickTile(h) {
  const t = tileAt(state, h.q, h.r);
  if (!t) return;
  // placing a building: the click puts it down
  if (ui.placing) {
    const r = O.enqueue(state, { type: 'buildBuilding', building: ui.placing, q: h.q, r: h.r });
    if (!r.ok) { flash(r.why); return; }
    ui.placing = null;
    refresh();
    return;
  }
  if (t.occupant) {
    if (t.occupant.kind === 'tower') return modals.open('tower', { id: t.occupant.id }, ui);
    if (t.occupant.kind === 'building') return modals.open('building', { id: t.occupant.id }, ui);
    if (t.occupant.kind === 'spawner') return modals.open('assault', {}, ui);
    if (t.occupant.kind === 'base') return modals.open('ship', {}, ui);
  }
  // a chest or a wreck still to be worked comes before an empty building plot
  if (!poiReady(state, t) && isBuildable(state, t, true)) return modals.open('buildTower', { q: h.q, r: h.r }, ui);
  modals.open('clearTile', { q: h.q, r: h.r }, ui);
}

// The bar carries one button, and it is not an order: it throws the run away and
// lays out another. Delegated, because the bar is rebuilt on every refresh.
hudEl.addEventListener('click', (e) => {
  const action = e.target.dataset && e.target.dataset.hudAction;
  if (!action) return;
  ui.placing = null;
  modals.open(action, {}, ui);
});

document.getElementById('actions').addEventListener('click', (e) => {
  const action = e.target.dataset && e.target.dataset.action;
  if (!action) return;
  ui.placing = null;
  if (action === 'endturn') return endTurn();
  modals.open(action, {}, ui);
});

window.addEventListener('keydown', (e) => {
  // Typing is not driving: `a` and `d` pan the map and Space ends the turn, and
  // all three are letters someone may want in a box. Esc still closes.
  const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  if (typing && e.key !== 'Escape') return;
  if (e.key === 'Escape') { ui.placing = null; modals.close(ui); refresh(); return; }
  if (e.key === ' ') { e.preventDefault(); endTurn(); return; }
  if (state.phase === 'combat') {
    if (e.key === '1') setSpeed('1');
    if (e.key === '2') setSpeed('3');
    if (e.key === '3') setSpeed('skip');
    return;
  }
  const step = 60;
  const k = e.key.toLowerCase();
  if (k === 'arrowleft' || k === 'a') pan(cam, step, 0);
  if (k === 'arrowright' || k === 'd') pan(cam, -step, 0);
  if (k === 'arrowup' || k === 'w') pan(cam, 0, step);
  if (k === 'arrowdown' || k === 's') pan(cam, 0, -step);
  if (k === '+' || k === '=' || k === 'e') zoomBy(cam, canvas, 1, canvas.width / 2, canvas.height / 2);
  if (k === '-' || k === 'q') zoomBy(cam, canvas, -1, canvas.width / 2, canvas.height / 2);
});

backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) modals.close(ui); });

/**
 * A handle on the running game, for driving it from the console. Opt in with
 * `?dev=1`. It gives no powers the interface does not — every order still goes
 * through the same queue and the same checks — it only saves the mouse.
 */
if (params.get('dev') === '1') {
  window.game = {
    get state() { return state; },
    ui, C, O, B, St, H, modals, cam, canvas,
    endTurn, refresh,
    closeModal: () => modals.close(ui),
  };
}

refresh();
