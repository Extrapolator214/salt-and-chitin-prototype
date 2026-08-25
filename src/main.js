// Entry: builds state, wires view to sim, starts the loop.
// This is the only place sim/ and view/ meet.

import C from './sim/config.js';
import { createState, tileAt, isClearable, idleHands } from './sim/state.js';
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
import * as reel from './view/reel.js';
import * as save from './save.js';

const canvas = document.getElementById('map');
const hudEl = document.getElementById('hud');
const hoverEl = document.getElementById('hover');
const queueEl = document.getElementById('queue');
const logEl = document.getElementById('log');
const modalEl = document.getElementById('modal');
const backdrop = document.getElementById('backdrop');
const strip = document.getElementById('combat-strip');
const splash = document.getElementById('splash');
const splashPane = document.getElementById('splash-pane');
const reelPanel = document.getElementById('reel-panel');

const params = new URLSearchParams(location.search);
const seedFromUrl = Number(params.get('seed'));
let wantSeed = Number.isFinite(seedFromUrl) && seedFromUrl ? seedFromUrl : null;

/**
 * The run this page opens on.
 *
 * The stored run wins, because a reload is not a decision — the player pressed
 * F5, or the tab woke up, and losing an hour's island to that is the one thing
 * a prototype with no save at all does worst. `?seed=` still overrides it, but
 * only when it names a *different* island: reloading a seeded URL is as much a
 * reload as any other, and it should come back to where it left off rather than
 * wiping the run every time.
 *
 * With nothing stored and nothing asked for, the seed is today's date, so a
 * fresh visit is a fresh island and two people on the same day get the same one.
 */
function openingState() {
  const stored = save.load();
  if (stored && (wantSeed === null || wantSeed === stored.seed)) return stored;
  if (stored) save.clear();
  return createState(wantSeed ?? save.todaySeed());
}

let state = openingState();
const cam = createCamera();
const ui = {
  hover: null,
  // What is waiting to be put down, following the cursor: either
  // {kind:'building', type} or {kind:'tower', towerIndex}. Both are picked off
  // a panel in the bar and placed with a click on the map.
  placing: null,
  pendingEvents: [],
  reel: null,          // the resolve being played back, or null between turns
  walk: null,          // mid-stride positions, set only during a walk beat
  revealing: null,     // sites worked this turn whose pane has not played yet
  ground: null,        // ground the labour changed, held while the walk plays
  holdSpawners: null,  // spawners killed this turn, still drawn until the box says so
  assaultShown: false, // ...and whether that box has been shown yet this turn
  afterAssault: null,  // what dismissing it goes on to
  // A setting rather than a per-reel control: chosen once and kept for the run.
  // `1`, `3`, or `'skip'` — which is not a speed at all but the same decision
  // made once: resolve the turn and get on with it, with nothing to watch.
  reelSpeed: 1,
  // Settings that outlive the run, off localStorage. `idleWarning` is the box
  // that stops End Turn when somebody is standing about, and the box itself is
  // where it gets turned off.
  prefs: save.loadPrefs(),
  setPref: (k, v) => { ui.prefs[k] = v; save.savePrefs(ui.prefs); },
  // The dev menu's two doors into the sim. They take effect on the spot and are
  // written down on the spot: `refresh` is what saves the run, so a cheat is
  // saved by the same call that redraws the panel it was pressed in.
  dev: {
    flag: (name, on) => { St.setDevFlag(state, name, on); refresh(); },
    grant: (res, amount) => { St.devGrant(state, res, amount); refresh(); },
  },
  located: null,       // a tile pinned by "locate", until the next click
  revoke: (id) => { O.revoke(state, id); refresh(); },
  place: (what) => { ui.placing = what; refresh(); },
  /**
   * Put a tile under the camera and leave a mark on it.
   *
   * The mark is the point: a camera move alone tells you the ground is *near
   * here somewhere*, and on a map of four thousand hexes that is not an answer.
   * It outlives the pointer — the hover outline follows the mouse, so anything
   * carried by hover is gone the instant you look for it — and it is cleared by
   * the next click, which is the moment you have plainly finished with it.
   */
  locate: (at) => {
    ui.located = { q: at.q, r: at.r };
    lookAt = { q: at.q, r: at.r };
    refresh();
  },
  order: (o) => { const r = O.enqueue(state, o); if (!r.ok) flash(r.why); return r; },
  // A standing order on a body rather than an order in the queue: it is read at
  // the top of every turn, so it is part of the run and saved with it.
  // Switched on mid-turn, it starts now: a body standing about with the box
  // just ticked in front of you should not wait for the next turn to be given
  // the face he is standing next to.
  setAutoClear: (who, on) => {
    St.setAutoClear(state, who, on);
    if (on) O.autoClearOrders(state, who);
    refresh();
  },
  // One of the two things that are not orders: goods over the dock's counter,
  // paid for and handed across on the spot. It moves the stores, so it goes through the
  // same refusal path as an order — and through `refresh`, which is what writes
  // the run to storage.
  trade: (t) => { const r = O.trade(state, t); if (!r.ok) flash(r.why); return r; },
  // Nor is standing a worker down: it releases a body and moves nothing, so
  // there is nothing for a resolve to carry out and no reason to make the
  // player wait a turn to put them back to work.
  standDown: (id) => { const r = O.standDown(state, id); if (!r.ok) flash(r.why); return r; },
  refresh,
  endTurn: () => endTurn(true),
  // Named seed or none: the modal always names one, so the walk is only the
  // fallback for anything that starts a run without asking which island.
  newRun: (seed) => start(createState(seed || modals.nextSeed(state.seed))),
  // The same island, from the first turn. A run is a line through one map, and
  // wanting to take that line again is not the same wish as wanting a new map —
  // which is the only thing "New run" could offer until now.
  restart: () => start(createState(state.seed)),
};

/** Put a freshly built run on the screen, over whatever was there. */
function start(next) {
  save.clear();
  state = next;
  // Keep `?seed=` naming the run that is actually on the screen. Without this,
  // rolling a new island from a seeded URL left the address bar pointing at the
  // old one — and since a URL seed that disagrees with the stored run is read as
  // "give me that island instead", the next reload would have thrown the new run
  // away and rebuilt the one the player had just left.
  if (wantSeed !== null && next.seed !== wantSeed) {
    params.set('seed', String(next.seed));
    history.replaceState(null, '', `${location.pathname}?${params}`);
    wantSeed = next.seed;
  }
  ui.pendingEvents = [];
  ui.located = null;
  ui.placing = null;
  lookAt = null;
  endReel();
  modals.close(ui);
  resize();
  centreOn(cam, canvas, state.base.q, state.base.r);
  refresh();
}

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
  renderReelPanel();
  // The whole row, not only End Turn: while the resolve is being shown there is
  // nothing on it that can be acted on, and a live-looking button that quietly
  // does nothing is worse than one that says it is out of reach.
  document.querySelectorAll('#actions button').forEach((b) => { b.disabled = handsOff(); });

  const spare = O.projectedHands(state) + O.projectedIdleOfficers(state).length;
  const bodies = St.crewCount(state);
  document.querySelector('[data-action="crew"]').textContent = `Crew ${bodies}`;
  const note = document.getElementById('crewnote');
  note.textContent = spare > 0 ? `${spare} spare` : 'nobody spare';
  note.className = spare > 0 ? 'dim' : 'bad';

  // Written here rather than at a handful of call sites, because `refresh` is
  // already the one thing that means "the run changed": anything that moves the
  // run redraws the panels, so hanging the save off it is what makes it
  // impossible to change the run without recording it. It costs 3 KB and a
  // fraction of a millisecond, and it declines to write anything at all unless
  // the state is at a turn boundary.
  save.save(state);
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
 * asks first. `confirmed` is the answer coming back from that modal — and the
 * player can turn the asking off from inside the box, which is the only place
 * anybody ever wants to turn it off from.
 */
function endTurn(confirmed = false) {
  if (state.phase !== 'player') return;
  const spare = O.projectedHands(state) + O.projectedIdleOfficers(state).length;
  if (spare > 0 && !confirmed && ui.prefs.idleWarning) {
    if (modals.currentModal() && modals.currentModal().name === 'idleWarning') return;
    return modals.open('idleWarning', {}, ui);
  }
  modals.close(ui);

  // Taken before the resolve, because the resolve moves them: the reel needs
  // where everyone stood — crew and cohorts both — and by the time it can be
  // built neither is there any more.
  const before = reel.snapshotMovers(state);
  ui.pendingEvents = resolveTurn(state);
  // A spawner that died this turn stays drawn until the mission's box opens —
  // see `drawSpawners`. Set before the reel plays, because the reel is where
  // the player would otherwise watch it quietly disappear.
  ui.holdSpawners = new Set(ui.pendingEvents
    .filter((e) => e.kind === 'spawnerDied').map((e) => e.id));
  ui.assaultShown = false;

  // Skipping is the setting, not a button pressed halfway through: there is no
  // reel to build, so nothing takes the camera and nothing has to be got past.
  ui.reel = ui.reelSpeed === 'skip' ? null : reel.build(state, ui.pendingEvents, before);
  if (ui.reel) {
    ui.reel.speed = ui.reelSpeed;
    camBeforeReel = { x: cam.x, y: cam.y };
    showBeat();
    refresh();
    return;                                              // the reel takes over
  }
  afterReel();
}

/**
 * What happens once the reel has played, or straight away on a turn with
 * nothing to show. The contact is the reel's last act — it has its own strip
 * and its own clock and always did — so it runs after, not inside.
 */
function afterReel() {
  endReel();

  // The mission's own box, before the wave. It is the answer to the thing the
  // player did on purpose, and it used to arrive after the fight it had just
  // changed the terms of — with the mound already gone from the map, so the
  // news was never news. Dismissing it is what lets the contact in.
  const assault = ui.pendingEvents.find((e) => e.kind === 'assault');
  if (assault && !ui.assaultShown) {
    ui.assaultShown = true;
    ui.holdSpawners = null;                  // the island changes as the box opens
    ui.afterAssault = () => { ui.afterAssault = null; afterReel(); };
    modals.open('assaultResult', { event: assault, more: true }, ui);
    refresh();
    return;
  }
  ui.holdSpawners = null;

  if (state.combat) {
    // The pace is the player's standing choice, not a decision about this
    // cohort: whoever watched the last fight at 3x is not asking to be put back
    // to 1x for the next one. The sim opens every contact at 1x — it knows
    // nothing about who is watching — so the setting is applied here, where the
    // fight reaches the screen.
    state.combat.speed = contactSpeed();
    renderStrip();
    refresh();
    return;                                              // the ticker takes over
  }
  finishTurn();
}

// The paces a contact plays back at. 10x is not a fourth speed so much as a way
// of watching a long fight at all: an act-3 wave is two hundred units walking a
// forty-tile road, which is minutes of real time at 1x.
const CONTACT_SPEEDS = [1, 3, 10];

/** The remembered contact pace, and a guard on whatever storage handed back. */
const contactSpeed = () => {
  const want = Number(ui.prefs.contactSpeed);
  return CONTACT_SPEEDS.includes(want) ? want : 1;
};

// ---- the resolve reel ------------------------------------------------------

// A tile the camera is easing toward, or null. Eased rather than cut, and the
// target is kept as a tile rather than as a world point so that a zoom part way
// through still lands on the same ground.
let lookAt = null;

// Where the player had the map pointed before the reel took the camera off them.
let camBeforeReel = null;

/**
 * A pane under the pointer does not time out.
 *
 * The splash closes itself, which is right for a reel you are watching and
 * wrong the moment you lean in to read one — the pane you are studying is
 * precisely the one about to disappear. Reaching for the pointer is what
 * somebody does when they want a closer look, so that is the signal.
 *
 * Bound once, to an element that outlives every beat: only the pane's contents
 * are rebuilt, never the pane itself.
 */
let paneHeld = false;
splashPane.addEventListener('mouseenter', () => { paneHeld = true; markHeld(); });
splashPane.addEventListener('mouseleave', () => { paneHeld = false; markHeld(); });
const markHeld = () => splashPane.classList.toggle('paused', paneHeld && !splash.hidden);

/**
 * Put the reel away and give the map back — including the view.
 *
 * The focus is a loan, not a move: a reel that ends twenty tiles from where the
 * player was working has cost them their place, and they did not ask to be taken
 * there. Zoom is left alone throughout for the same reason it is not animated —
 * the map is baked per zoom level, and stepping it mid-reel throws that away.
 */
function endReel() {
  ui.reel = null;
  ui.walk = null;
  ui.revealing = null;
  ui.ground = null;
  splash.hidden = true;
  markHeld();
  if (camBeforeReel) { cam.x = camBeforeReel.x; cam.y = camBeforeReel.y; }
  camBeforeReel = null;
}

/**
 * Draw the current beat: its splash, if it has one, and the side panel either
 * way. Called when the beat changes, not per frame — the walk has no picture at
 * all, which is what puts the map back on screen for it.
 */
function showBeat() {
  const r = ui.reel;
  if (!r) return;
  r.dirty = false;
  const pane = reel.paneHtml(r);
  splash.hidden = !pane;
  markHeld();
  if (pane) {
    splashPane.innerHTML = pane;
    // Its own handler rather than the panel's: the pane is rebuilt every beat,
    // so the button on it is a different element each time.
    const btn = splashPane.querySelector('[data-r="next"]');
    if (btn) btn.onclick = () => nextBeat();
  }
  renderReelPanel();
}

/** Step past the pane in front of you, ending the reel if it was the last. */
function nextBeat() {
  if (!ui.reel) return;
  reel.next(ui.reel);
  return ui.reel.done ? afterReel() : showBeat();
}

/**
 * The reel's panel in the side column, drawn whether or not one is playing.
 *
 * It sits outside the splash on purpose: the splash stops at the side column,
 * so these buttons stay lit and clickable through a pane, and the speed can be
 * set on a quiet turn rather than only while something is already running.
 */
function renderReelPanel() {
  reelPanel.innerHTML = reel.panelHtml(ui.reel, ui.reelSpeed);
  reelPanel.querySelectorAll('[data-r]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.r;
      ui.reelSpeed = v === 'skip' ? 'skip' : Number(v);
      // Pressed while one is playing, the setting answers that reel too — the
      // player asking never to watch these has plainly finished with this one.
      if (ui.reel) {
        if (ui.reelSpeed === 'skip') return skipReel();
        ui.reel.speed = ui.reelSpeed;
      }
      renderReelPanel();                               // repaint the pressed state
    };
  });
}

/** Abandon the rest of the reel and get on with the turn. */
function skipReel() {
  if (!ui.reel) return;
  reel.skip(ui.reel);
  afterReel();
}

/** One frame of the reel: the clock, the camera, the walkers, the drain bar. */
function tickReel(dt) {
  const r = ui.reel;
  // The camera still eases while a pane is held — it is following the beat
  // already on screen, not running ahead to the next one.
  reel.glide(cam, reel.cameraTarget(r, hexSize(cam)), dt);
  const done = reel.tick(r, dt, paneHeld);
  ui.walk = reel.walkPositions(r);
  ui.revealing = reel.pending(r);
  ui.ground = reel.groundBefore(r);
  if (done) return afterReel();
  if (r.dirty) return showBeat();
  const b = reel.beat(r);
  if (!b) return;
  const left = `${Math.max(0, 100 - (r.t / b.seconds) * 100)}%`;
  const panelBar = reelPanel.querySelector('#reel-bar > i');
  if (panelBar) panelBar.style.width = left;
  const paneBar = splashPane.querySelector('.pane-bar > i');
  if (paneBar) paneBar.style.width = left;
}

function finishTurn() {
  const events = ui.pendingEvents;
  ui.pendingEvents = [];
  // The turn the star landed on, kept before `concludeTurn` moves the clock:
  // the act turns on the turn after it, and the box says which.
  const turn = state.turn;
  concludeTurn(state, events);
  strip.hidden = true;

  // An ordinary star is a pane on the reel and nothing here — it closes itself,
  // and skipping the reel skips it, like every other thing the resolve shows.
  // The act turning is the exception: it is the one moment in a run whose rules
  // change, so it is a modal, it waits to be dismissed, and it is shown whatever
  // the reel is set to. The end of the run is exempt for the same reason.
  const act = events.find((e) => e.kind === 'escalation' && e.endsAct);
  const report = ui.reelSpeed !== 'skip';
  if (state.outcome) modals.open('endOfRun', {}, ui);
  else if (act) modals.open('escalation', { events, turn, report }, ui);
  else if (report) turnReport(events);               // every turn closes with a report
  refresh();
}

/**
 * The resolve's own report. The mission's box is not part of it any more — that
 * one is shown before the contact, where the news is still news.
 */
function turnReport(events) {
  modals.open('turnSummary', { events }, ui);
  refresh();
}

// ---- the combat strip ------------------------------------------------------

// The strip is written every frame, so nothing inside it that can be pressed may
// be written every frame: an element replaced between the mousedown and the
// mouseup never gets a click, which is why the speeds did nothing. The markup
// stands in index.html and is bound here once; only the text is written.
const stripTitle = document.getElementById('strip-title');
const stripBody = document.getElementById('strip-body');
const stripSpeeds = [...strip.querySelectorAll('[data-s]')];
stripSpeeds.forEach((b) => { b.onclick = () => setSpeed(b.dataset.s); });

function renderStrip() {
  const cb = state.combat;
  if (!cb) { strip.hidden = true; return; }
  strip.hidden = false;
  const e = cb.groups[0].entry;
  const alive = cb.groups.reduce((n, g) => n + g.units.filter((u) => u.alive).length, 0);
  stripTitle.textContent = `CONTACT — entry at (${e.q}, ${e.r})`;
  stripBody.textContent =
    `cohort: ${cb.startCount} units (${cb.composition.grub} grub, ${cb.composition.shell} shell` +
    `${cb.composition.elite ? `, ${cb.composition.elite} elite` : ''})     ` +
    `standing ${alive}     killed ${cb.killed}     leaked ${cb.leaked}\n` +
    `elapsed ${cb.elapsed.toFixed(1)} s${cb.groups[0].overland ? '   (no road path — they come overland)' : ''}`;
  stripSpeeds.forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === cb.speed));
}

function setSpeed(s) {
  if (!state.combat) return;
  // Skipping is a thing done to this fight, not a pace to be remembered — the
  // next contact is not asking to be skipped because this one was.
  if (s === 'skip') { combat.skip(state); return; }
  state.combat.speed = Number(s);
  ui.setPref('contactSpeed', state.combat.speed);
}

// ---- the frame loop --------------------------------------------------------

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  resize();
  if (lookAt && !ui.reel) {
    const p = H.axialToPixel(lookAt.q, lookAt.r, hexSize(cam));
    reel.glide(cam, p, dt);
    if (Math.abs(cam.x - p.x) < 0.5 && Math.abs(cam.y - p.y) < 0.5) lookAt = null;
  }
  if (ui.reel) {
    tickReel(dt);
  } else if (state.phase === 'combat' && state.combat) {
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

/**
 * Whether the resolve has the floor.
 *
 * Between End Turn and the next player phase the run is being *shown*, not
 * played: the reel is running, or a cohort is on the road being fought. Orders
 * given in that window would be given to a state the player cannot see the
 * whole of — the queue has already been applied, the ground has already moved —
 * so the map stops taking clicks and the action row goes dark for the duration.
 *
 * Looking is not touching. Panning, zooming and hovering all stay live: a fight
 * is the one time a player most wants to move the camera, and moving it changes
 * nothing about the run.
 */
const handsOff = () => !!ui.reel || state.phase !== 'player';

let dragging = false, dragged = false, lastX = 0, lastY = 0;

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || ui.reel) return;
  dragging = true; dragged = false;
  lastX = e.offsetX; lastY = e.offsetY;
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;
  if (dragged || e.target !== canvas || handsOff()) return;
  ui.located = null;                   // a click is the end of looking for it
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
  if (handsOff()) return;
  // Carrying a shape, the right button puts it down again — nothing else on the
  // map wants a right-click while a silhouette is following the cursor, and Esc
  // is a long way from a hand that is already on the mouse.
  if (ui.placing) { ui.placing = null; refresh(); return; }
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
  // something waiting to be put down: the click puts it there
  if (ui.placing) {
    const order = ui.placing.kind === 'tower'
      ? { type: 'buildTower', q: h.q, r: h.r, towerIndex: ui.placing.towerIndex, tier: ui.placing.tier }
      : { type: 'buildBuilding', building: ui.placing.type, q: h.q, r: h.r };
    const r = O.enqueue(state, order);
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
  // Open ground opens the tile's own panel. It used to open the tower catalogue
  // instead, which put the whole gunnery shelf behind a click on any cleared
  // hex and hid it entirely behind ground that was not cleared yet — the guns
  // are picked off the bar now, and a click on a tile is about that tile.
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
  if (handsOff()) return;              // nothing on the row acts mid-resolve
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
  // The reel owns the keyboard while it plays: Esc gives up on it, Space cuts to
  // the next beat rather than ending a turn that is still being shown.
  if (ui.reel) {
    if (e.key === 'Escape') { e.preventDefault(); skipReel(); return; }
    if (e.key === ' ') { e.preventDefault(); nextBeat(); return; }
    return;
  }
  if (e.key === 'Escape') { ui.placing = null; modals.close(ui); refresh(); return; }
  if (e.key === ' ') { e.preventDefault(); endTurn(); return; }
  // The contact adds keys, it does not take the map away: a fight you are only
  // watching is exactly when you want to pan over to it, and the number keys do
  // not collide with anything the camera uses.
  if (state.phase === 'combat') {
    if (e.key === '1') setSpeed('1');
    if (e.key === '2') setSpeed('3');
    if (e.key === '3') setSpeed('10');
    if (e.key === '4') setSpeed('skip');
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
    ui, C, O, B, St, H, modals, reel, cam, canvas,
    endTurn, refresh,
    closeModal: () => modals.close(ui),
  };
}

refresh();
