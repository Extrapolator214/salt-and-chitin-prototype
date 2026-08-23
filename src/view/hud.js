// The persistent bar.

import C from '../sim/config.js';
import { totalPower, terrainCensus } from '../sim/state.js';
import { projectedRes, incomeNextTurn } from '../sim/orders.js';

const ROMAN = ['', 'I', 'II', 'III'];
const RES = ['wood', 'stone', 'iron', 'gold'];

/** One `label value` pair. The label is dimmed; the value carries the markup. */
const row = (label, value, cls = '') =>
  `<span class="k">${label}</span> ${cls ? `<span class="${cls}">${value}</span>` : value}`;

/** One box of the bar, its pairs run along a single line. */
const col = (rows, cls = '') => `<div class="col ${cls}">${rows.join('   ')}</div>`;

/**
 * The stores, as they will stand when the turn ends.
 *
 * Two things are folded in, because both are already decided and neither is
 * visible anywhere else on the screen. A queued building has spent its wood the
 * moment it is queued — the queue cannot be overspent, so the number the bar
 * shows has to be the one the next order is checked against. And the work
 * already under way pays out on the coming resolve, shown as `(+n)`: only what
 * lands when End Turn is pressed, not the eventual yield of every face in the
 * queue, because a forest tile queued this turn is three turns from paying.
 */
function stores(state) {
  const have = projectedRes(state);
  const soon = incomeNextTurn(state);
  return RES.map((k) => {
    const gain = soon[k] ? ` <span class="soon">(+${soon[k]})</span>` : '';
    return row(k, `<b>${have[k]}</b>${gain}`);
  });
}

/**
 * The island's ground, by terrain, as it stands now. Salt water is not counted.
 *
 * This is reference, not a number anyone plays off turn to turn, and it is the
 * only thing in the bar that grows with the map — nine swatches wide on a fresh
 * island, wider as ground is cut. So it lives behind the island box and is shown
 * on hover, which keeps the bar four short columns instead of a wrapping line.
 */
function censusList(census) {
  const listed = new Set(Object.keys(C.TERRAIN_MIX));
  const order = [
    ...Object.keys(C.TERRAIN_MIX),
    ...Object.keys(census.counts).filter((t) => !listed.has(t) && t !== 'saltwater'),
  ];
  // Two aligned columns rather than a run of entries: a wrapping line broke
  // swatches away from their own percentages half way across the box.
  const parts = order
    .filter((t) => census.counts[t])
    .map((t) => {
      const swatch = `<span class="sw" style="color:${C.TERRAIN_COLOUR[t]}">■</span>`;
      const name = C.TERRAIN_NAME[t] ?? t;
      return `<span title="${census.counts[t]} tiles">${swatch}${name}</span>`
        + `<span class="pct" title="${census.counts[t]} tiles"><b>${census.pct[t].toFixed(1)}</b>%</span>`;
    });
  const bridges = census.bridges
    ? `<span class="wide">${census.bridges} bridged</span>` : '';
  return `${parts.join('')}${bridges}`;
}

export function renderHud(state, el) {
  const hull = state.base.hull;
  const hullClass = hull < 30 ? 'bad' : hull < 60 ? 'warn' : '';
  const census = terrainCensus(state);

  // Four boxes on one line, each one thing the player asks about separately:
  // where the run is, what it can spend, what it is made of, what it is standing
  // on. One line, because the bar is glanced at and the map wants the room.
  el.innerHTML =
    col([
      row('turn', `<b>${state.turn}</b> / ${C.TURNS_PER_RUN}`),
      row('act', ROMAN[state.act]),
    ], 'turn')
    + col(stores(state), 'stores')
    + col([
      row('hull', `${hull}/${C.HULL_MAX}`, hullClass),
      row('power', totalPower(state).toFixed(1)),
      row('items', String(state.base.hold.length)),
    ])
    + `<div class="col island">${[
      row('seed', String(state.seed)),
      row('island', `<b>${census.land}</b> tiles`),
    ].join('   ')}<div class="census">${censusList(census)}</div></div>`
    // Sit with the seed rather than down among the turn's buttons: starting a
    // run is a thing you do to the whole run, and the seed both of them take is
    // read off the box they stand next to. Restart is the same island again —
    // the seed on the left of it — where New run is a different one.
    + `<button id="restartmap" data-hud-action="restartMap">Restart map</button>`
    + `<button id="newrun" data-hud-action="newRun">New run</button>`;
}
