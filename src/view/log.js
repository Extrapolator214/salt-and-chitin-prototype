// The event feed: the newest events, at the bottom of a full-height strip.

// Enough to fill the strip on any window worth playing on, rather than a count
// chosen to look right at one height. The column is pinned to its own bottom
// and clipped at the top, so a surplus costs a few hidden divs and a short one
// would leave the top of the strip empty.
const LINES = 80;

/**
 * One element per line, because the feed is a flex column pinned to its own
 * bottom — newest line last, older ones clipped off the top as they fall out of
 * the strip. A single string of newlines could not be laid out that way.
 */
export function renderLog(state, el) {
  el.innerHTML = state.log.slice(-LINES)
    .map((l) => `<div class="l"><span class="t">t${l.turn}</span> ${escape(l.text)}</div>`)
    .join('');
}

const escape = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
