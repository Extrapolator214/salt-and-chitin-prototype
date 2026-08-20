// The event feed: the last 6 events, newest at the bottom.

const LINES = 6;

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
