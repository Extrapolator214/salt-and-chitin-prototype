// The run, kept across reloads. Browser glue: `sim/` may not touch the clock or
// the DOM, and this does both, so it lives beside main.js rather than under it.
//
// Two keys, because the two halves of a run change at wildly different rates.
// The map is 6211 tiles and ~850 KB of JSON, and it only changes when the
// labour changes it — once a turn at most, which `map.version` already tracks.
// Everything else is 3.3 KB and changes on every click, since the order queue
// is part of the run and a reload that dropped it would still have lost the
// player's place. Writing them together would mean 850 KB per queued order.
//
// Only a player-phase state is written. A reload during a resolve comes back to
// the top of that turn with its queue intact and plays it again — the same
// result, since the RNG is part of the state — rather than to a half-stepped
// fight nobody could have reasoned about.

const MAP_KEY = 'salt-n-chitin/map';
const RUN_KEY = 'salt-n-chitin/run';
// Settings, not a run. Kept in a key of its own and never cleared with the run:
// a player who has said "stop asking me" has said it about the game, not about
// the island they happened to be on when they said it.
const PREFS_KEY = 'salt-n-chitin/prefs';
// Bumped when a stored run stops meaning what it says: `decode` refuses anything
// written under an older number rather than trying to translate it. 2 dropped
// the `unassign` order, which standing down no longer queues — a run stored
// mid-phase with one in its queue would have been resolved by a table that has
// no entry for it.
const VERSION = 2;

/** What was last written, so an unchanged map is not serialised again. */
let written = { seed: null, version: -1 };
let broken = false;   // quota, private browsing, no storage at all

const store = () => {
  try { return window.localStorage; } catch { return null; }
};

/**
 * Today, as a seed: 20260821 for the 21st of August 2026.
 *
 * A fresh visit should not be the same island every time, and a date reads as
 * something rather than as a number — two people on the same day get the same
 * island and can talk about it, and tomorrow is a different one. It stays well
 * inside the 31-bit range the generator's arithmetic wants.
 */
export function todaySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/**
 * Everything but the tiles — small, and rewritten whenever anything moves.
 *
 * `derived` is dropped rather than saved. It holds the map's cached views —
 * the road network, the ground the crew can walk — as `Set`s keyed on
 * `map.version`, and `JSON.stringify` turns a Set into `{}`. Saved and read
 * back, the version still matched, so the cache handed out an empty object
 * where a Set was expected and the first order to ask "can anyone walk there"
 * brought the turn down. A cache is the one thing that must never be persisted:
 * it is worth nothing and it can only be wrong.
 */
const runPart = (state) => ({
  ...state,
  map: { radius: state.map.radius, version: state.map.version },
  derived: undefined,
  combat: null,
});

/**
 * The run as two JSON strings: the map, and everything else.
 *
 * Kept apart from the storage below so the round trip can be exercised without a
 * browser — this is the half that can be wrong in a way nobody notices until a
 * player reloads, and `localStorage` is the half that cannot be tested at all
 * from a headless harness.
 */
export function encode(state) {
  return {
    map: JSON.stringify({
      v: VERSION, seed: state.seed, version: state.map.version, tiles: [...state.map.tiles],
    }),
    run: JSON.stringify({ v: VERSION, run: runPart(state) }),
  };
}

/** The inverse, or null if the two halves do not describe one run. */
export function decode(raw) {
  if (!raw || !raw.map || !raw.run) return null;
  const map = JSON.parse(raw.map);
  const run = JSON.parse(raw.run);
  if (map.v !== VERSION || run.v !== VERSION) return null;
  const state = run.run;
  if (!state || state.seed !== map.seed || state.map.version !== map.version) return null;
  const tiles = new Map(map.tiles);
  if (!tiles.size) return null;
  state.map = { radius: state.map.radius, version: state.map.version, tiles };
  delete state.derived;   // rebuilt on demand; a stored one would be a dead Set
  state.combat = null;
  return state;
}

/**
 * Write the run down, if it is at a point worth coming back to.
 *
 * Returns false when nothing was written, which is the normal answer mid-resolve
 * rather than a failure.
 */
export function save(state) {
  const ls = store();
  if (!ls || broken || !state) return false;
  if (state.phase !== 'player' && !state.outcome) return false;
  try {
    // The map only when it has actually changed: it is 850 KB and `map.version`
    // is exactly the flag for "the labour moved the ground".
    if (written.seed !== state.seed || written.version !== state.map.version) {
      ls.setItem(MAP_KEY, encode(state).map);
      written = { seed: state.seed, version: state.map.version };
    }
    ls.setItem(RUN_KEY, JSON.stringify({ v: VERSION, run: runPart(state) }));
    return true;
  } catch (e) {
    // A full quota is the likely one. Give the space back and stop trying:
    // half a saved run is worse than none, and it must not take the game down.
    broken = true;
    try { ls.removeItem(MAP_KEY); ls.removeItem(RUN_KEY); } catch { /* nothing left to do */ }
    console.warn('[save] giving up on saving this run:', e && e.message);
    return false;
  }
}

/**
 * The run as it was left, or null.
 *
 * The two halves are checked against each other before either is trusted: they
 * are written at different moments, so a reload in the gap between them can find
 * a map from one run and a roster from the next.
 */
export function load() {
  const ls = store();
  if (!ls) return null;
  try {
    const state = decode({ map: ls.getItem(MAP_KEY), run: ls.getItem(RUN_KEY) });
    if (!state) return null;
    written = { seed: state.seed, version: state.map.version };
    return state;
  } catch (e) {
    console.warn('[save] the stored run would not load:', e && e.message);
    return null;
  }
}

/**
 * The settings, with the defaults for anything never set.
 *
 * `idleWarning` is the only one so far: whether ending a turn with somebody
 * standing about stops to say so. It survives a new run and a reload, which is
 * the whole point of a box that can be turned off.
 */
export const PREF_DEFAULTS = { idleWarning: true };

export function loadPrefs() {
  const ls = store();
  if (!ls) return { ...PREF_DEFAULTS };
  try {
    const raw = JSON.parse(ls.getItem(PREFS_KEY) || '{}');
    return { ...PREF_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...PREF_DEFAULTS };
  }
}

export function savePrefs(prefs) {
  const ls = store();
  if (!ls) return false;
  try { ls.setItem(PREFS_KEY, JSON.stringify(prefs)); return true; } catch { return false; }
}

/** Throw the stored run away — a new run is starting over the top of it. */
export function clear() {
  const ls = store();
  written = { seed: null, version: -1 };
  if (!ls) return;
  try { ls.removeItem(MAP_KEY); ls.removeItem(RUN_KEY); } catch { /* nothing to do */ }
}
