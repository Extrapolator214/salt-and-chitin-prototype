// Canvas: map, structures, cohorts, units. Reads sim state, never writes it.

import C from '../sim/config.js';
import { key, distance, axialToPixel, axialRound, spiral, neighbours } from '../sim/hex.js';
import { tileAt, towerRange, towerManning, roadNetwork, officerById, canopyShadow } from '../sim/state.js';
import { queuedTiles, projectedAssignments, workableTiles, projectedCrew, crewGroundAtResolve } from '../sim/orders.js';
import { clearCapacity, jobPlace } from '../sim/labour.js';
import { canBuildBuilding, footprintPreview } from '../sim/build.js';
import { cohortTiles, cohortHidden } from '../sim/enemy.js';
import { hexSize, axialToScreen, visibleRows, worldToScreen } from './camera.js';

const SQRT3 = Math.sqrt(3);
const CORNERS = [];
for (let i = 0; i < 6; i++) {
  const a = (Math.PI / 180) * (60 * i - 30);
  CORNERS.push([Math.cos(a), Math.sin(a)]);
}

function hexPath(ctx, cx, cy, S) {
  ctx.moveTo(cx + CORNERS[0][0] * S, cy + CORNERS[0][1] * S);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + CORNERS[i][0] * S, cy + CORNERS[i][1] * S);
  ctx.closePath();
}

const CHUNK = 200;

/** Fill or stroke a list of tiles as hexes, in chunks small enough to stay fast. */
function paint(ctx, list, cam, canvas, S, op) {
  for (let i = 0; i < list.length; i += CHUNK) {
    ctx.beginPath();
    const end = Math.min(i + CHUNK, list.length);
    for (let k = i; k < end; k++) {
      const p = axialToScreen(cam, canvas, list[k].q, list[k].r);
      hexPath(ctx, p.x, p.y, S);
    }
    if (op === 'fill') ctx.fill(); else ctx.stroke();
  }
}

function poly(ctx, cx, cy, S, sides, rot = 0) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rot + (Math.PI * 2 * i) / sides;
    const x = cx + Math.cos(a) * S, y = cy + Math.sin(a) * S;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function render(state, cam, canvas, ui) {
  const ctx = canvas.getContext('2d');
  const S = hexSize(cam);
  // open sea to the horizon, so the grid's own edge never shows
  ctx.fillStyle = C.TERRAIN_COLOUR.saltwater;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Below the mid zooms the whole island can be on screen at once. Painting
  // 7651 hex paths a frame costs ~90 ms, so the static layer is baked once per
  // (zoom, map version) and blitted.
  if (S <= CACHE_UP_TO) drawCachedGround(ctx, state, cam, canvas, S);
  else {
    drawTerrain(ctx, state, cam, canvas, S);
    drawFeatures(ctx, state, cam, canvas, S);
  }
  // Over the ground, because at the low zooms the ground is baked and the baking
  // has already forgotten these: the sim worked them this turn, and the reel has
  // not shown them yet.
  drawPending(ctx, cam, canvas, S, ui);
  drawStructures(ctx, state, cam, canvas, S);
  drawSpawners(ctx, state, cam, canvas, S);
  drawCohorts(ctx, state, cam, canvas, S, ui);
  drawAssaults(ctx, state, cam, canvas, S);
  // Held back for as long as the reel runs. The contact has already happened in
  // the sim, but in reel time the cohort is still walking to it — drawing the
  // fight at the entry now would put its units on the road ahead of the blob
  // that becomes them.
  if (state.combat && !(ui && ui.reel)) drawCombat(ctx, state, cam, canvas, S);
  drawWorkedGround(ctx, state, cam, canvas, S);
  drawQueued(ctx, state, cam, canvas, S);
  drawBatchGlow(ctx, state, cam, canvas, S);
  drawCrew(ctx, state, cam, canvas, S, ui);
  drawPlacement(ctx, state, cam, canvas, S, ui);
  drawHighlights(ctx, state, cam, canvas, S, ui);
}

// ---- the baked ground layer ------------------------------------------------

const CANOPY_SHADE = 'rgba(10, 22, 12, 0.30)';
const CACHE_UP_TO = 8; // hex sizes at or below this get the whole map baked
let ground = { version: -1, size: -1, seed: null, canvas: null, w: 0, h: 0 };

function bakeGround(state, S) {
  const R = state.map.radius;
  const pad = Math.ceil(S * 2);
  const w = Math.ceil(SQRT3 * S * (2 * R + 1)) + pad * 2;
  const h = Math.ceil(1.5 * S * (2 * R + 1)) + pad * 2;
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const ox = w / 2, oy = h / 2; // world (0,0) sits at the middle

  const byColour = new Map();
  for (const t of state.map.tiles.values()) {
    const colour = t.bridge ? '#8a6a45' : C.TERRAIN_COLOUR[t.terrain];
    let list = byColour.get(colour);
    if (!list) byColour.set(colour, (list = []));
    list.push(t);
  }
  for (const [colour, list] of byColour) {
    ctx.fillStyle = colour;
    for (let i = 0; i < list.length; i += CHUNK) {
      ctx.beginPath();
      const end = Math.min(i + CHUNK, list.length);
      for (let k = i; k < end; k++) {
        const p = axialToPixel(list[k].q, list[k].r, S);
        hexPath(ctx, ox + p.x, oy + p.y, S);
      }
      ctx.fill();
    }
  }
  // ground that lies under the canopy: nothing there can be fired at
  const shadow = canopyShadow(state);
  ctx.fillStyle = CANOPY_SHADE;
  for (const k of shadow) {
    const t = state.map.tiles.get(k);
    if (!t) continue;
    const p = axialToPixel(t.q, t.r, S);
    ctx.beginPath();
    hexPath(ctx, ox + p.x, oy + p.y, S);
    ctx.fill();
  }
  for (const t of state.map.tiles.values()) {
    if (!t.feature || t.featureWorked) continue;
    const p = axialToPixel(t.q, t.r, S);
    ctx.fillStyle = FEATURE_COLOUR[t.feature];
    diamond(ctx, ox + p.x, oy + p.y, Math.max(2, S * 0.32));
    ctx.fill();
  }
  ground = { version: state.map.version, size: S, seed: state.seed, canvas: off, w, h };
  return ground;
}

function drawCachedGround(ctx, state, cam, canvas, S) {
  if (ground.version !== state.map.version || ground.size !== S || ground.seed !== state.seed) {
    bakeGround(state, S);
  }
  const origin = worldToScreen(cam, canvas, -ground.w / 2, -ground.h / 2);
  ctx.drawImage(ground.canvas, Math.round(origin.x), Math.round(origin.y));
}

// ---- terrain ---------------------------------------------------------------

function drawTerrain(ctx, state, cam, canvas, S) {
  const rows = visibleRows(cam, canvas, state.map.radius);
  const tiles = state.map.tiles;
  const byColour = new Map();
  let count = 0;

  for (const { r, qLo, qHi } of rows) {
    for (let q = qLo; q <= qHi; q++) {
      const t = tiles.get(key(q, r));
      if (!t) continue;
      const colour = t.bridge ? '#8a6a45' : C.TERRAIN_COLOUR[t.terrain];
      let list = byColour.get(colour);
      if (!list) byColour.set(colour, (list = []));
      list.push(t);
      count++;
    }
  }

  // Batched by colour, but in chunks: a single path holding thousands of
  // subpaths is pathological in canvas2d — 3500 hexes in one path costs 72 ms,
  // the same 3500 in chunks of 200 costs 5 ms.
  for (const [colour, list] of byColour) {
    ctx.fillStyle = colour;
    paint(ctx, list, cam, canvas, S, 'fill');
  }
  // the canopy's shadow, where nothing can be fired at
  const shadow = canopyShadow(state);
  if (shadow.size) {
    ctx.fillStyle = CANOPY_SHADE;
    const shaded = [];
    for (const { r, qLo, qHi } of rows) {
      for (let q = qLo; q <= qHi; q++) {
        if (!shadow.has(key(q, r))) continue;
        const t = tiles.get(key(q, r));
        if (t) shaded.push(t);
      }
    }
    paint(ctx, shaded, cam, canvas, S, 'fill');
  }

  if (S > 5) {
    ctx.strokeStyle = 'rgba(0,0,0,0.30)';
    ctx.lineWidth = 1;
    for (const list of byColour.values()) paint(ctx, list, cam, canvas, S, 'stroke');
  }
  return count;
}

// ---- features --------------------------------------------------------------

const FEATURE_COLOUR = { cache: '#d8b24a', spring: '#5ad4d4', officer: '#ffffff', wreck: '#8a6a45' };

function diamond(ctx, x, y, s) {
  ctx.beginPath();
  ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
  ctx.closePath();
}

/**
 * The points of interest, and only the ones still worth walking to. A chest
 * that has been dug up or a wreck that has been searched leaves nothing on the
 * ground — the marker goes, so what is left on the map is the work outstanding.
 * The tile panel still names it, worked, for anyone who wonders what happened
 * there. The spring is not one of these: it has no action to finish, it pays
 * while a hand stands on it, so it never goes.
 */
function drawFeatures(ctx, state, cam, canvas, S) {
  if (S < 4) return;
  const rows = visibleRows(cam, canvas, state.map.radius);
  for (const { r, qLo, qHi } of rows) {
    for (let q = qLo; q <= qHi; q++) {
      const t = state.map.tiles.get(key(q, r));
      if (!t || !t.feature || t.featureWorked) continue;
      const p = axialToScreen(cam, canvas, q, r);
      ctx.fillStyle = FEATURE_COLOUR[t.feature];
      diamond(ctx, p.x, p.y, Math.max(2, S * 0.32));
      ctx.fill();
    }
  }
}

/**
 * Sites worked this resolve whose moment on the reel has not come yet.
 *
 * Drawn exactly as `drawFeatures` would have drawn them, so the marker the
 * player has been looking at all game does not change shape on the one turn it
 * matters — it simply stays until its pane has said what it was.
 */
function drawPending(ctx, cam, canvas, S, ui) {
  const list = ui && ui.revealing;
  if (!list || S < 4) return;
  for (const f of list) {
    const p = axialToScreen(cam, canvas, f.q, f.r);
    if (p.x < -S || p.y < -S || p.x > canvas.width + S || p.y > canvas.height + S) continue;
    ctx.fillStyle = FEATURE_COLOUR[f.feature] || FEATURE_COLOUR.cache;
    diamond(ctx, p.x, p.y, Math.max(2, S * 0.32));
    ctx.fill();
  }
}

// ---- player structures -----------------------------------------------------

function drawStructures(ctx, state, cam, canvas, S) {
  // base: a white hull over its footprint on the beach
  ctx.fillStyle = 'rgba(240,240,235,0.88)';
  ctx.beginPath();
  for (const t of state.island.footprint) {
    const p = axialToScreen(cam, canvas, t.q, t.r);
    hexPath(ctx, p.x, p.y, S);
  }
  ctx.fill();
  const b = axialToScreen(cam, canvas, state.base.q, state.base.r);
  // hull bar above it
  const w = S * 3.4, h = Math.max(3, S * 0.35);
  const frac = state.base.hull / C.HULL_MAX;
  ctx.fillStyle = '#000';
  ctx.fillRect(b.x - w / 2, b.y - S * 3.1, w, h);
  ctx.fillStyle = frac > 0.6 ? '#6fa86a' : frac > 0.3 ? '#d9a441' : '#c8503a';
  ctx.fillRect(b.x - w / 2, b.y - S * 3.1, w * frac, h);

  for (const bd of state.buildings) {
    // a Palisade is ground, not premises: it fills its hex like terrain
    if (bd.type === 'wall') {
      ctx.fillStyle = bd.complete ? '#6b4f2e' : 'rgba(107,79,46,0.45)';
      for (const t of bd.tiles) {
        const p = axialToScreen(cam, canvas, t.q, t.r);
        ctx.beginPath();
        hexPath(ctx, p.x, p.y, S * 0.94);
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(30,20,10,0.8)';
      ctx.lineWidth = 1;
      for (const t of bd.tiles) {
        const p = axialToScreen(cam, canvas, t.q, t.r);
        ctx.beginPath();
        hexPath(ctx, p.x, p.y, S * 0.94);
        ctx.stroke();
      }
      continue;
    }
    // a ruin is drawn as what it is: the same ground, gone dark and broken up
    ctx.fillStyle = bd.ruined ? 'rgba(74,66,60,0.85)'
      : bd.complete ? 'rgba(150,150,148,0.85)' : 'rgba(150,150,148,0.4)';
    for (const t of bd.tiles) {
      const p = axialToScreen(cam, canvas, t.q, t.r);
      if (bd.ruined) {
        ctx.fillRect(p.x - S * 0.6, p.y - S * 0.6, S * 1.2, S * 0.5);
        ctx.fillRect(p.x - S * 0.2, p.y + S * 0.05, S * 0.8, S * 0.55);
      } else {
        ctx.fillRect(p.x - S * 0.6, p.y - S * 0.6, S * 1.2, S * 1.2);
      }
    }
    // what is left of it, over the first tile
    if (!bd.ruined && bd.complete && bd.hp < bd.maxHp && S >= 8) {
      const p = axialToScreen(cam, canvas, bd.tiles[0].q, bd.tiles[0].r);
      const frac2 = Math.max(0, bd.hp / bd.maxHp);
      ctx.fillStyle = 'rgba(20,22,26,0.8)';
      ctx.fillRect(p.x - S * 0.6, p.y - S * 0.78, S * 1.2, S * 0.16);
      ctx.fillStyle = frac2 > 0.5 ? '#6fa86a' : frac2 > 0.25 ? '#d9a441' : '#c8503a';
      ctx.fillRect(p.x - S * 0.6, p.y - S * 0.78, S * 1.2 * frac2, S * 0.16);
    }
    if (S >= 12) {
      const p = axialToScreen(cam, canvas, bd.tiles[0].q, bd.tiles[0].r);
      ctx.fillStyle = bd.ruined ? '#8c8078' : '#14161a';
      ctx.font = `bold ${Math.round(S * 0.8)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(bd.ruined ? '×' : bd.name[0], p.x, p.y);
    }
  }

  for (const tw of state.towers) {
    const p = axialToScreen(cam, canvas, tw.q, tw.r);
    const def = C.TOWERS[tw.towerIndex];
    const manned = towerManning(state, tw).manned;
    const size = S * (0.6 + 0.12 * (tw.evolved ? 5 : tw.tier));
    poly(ctx, p.x, p.y + size * 0.2, size, 3, -Math.PI / 2);
    if (manned) {
      ctx.fillStyle = def.colour;
      ctx.fill();
    } else {
      ctx.globalAlpha = 0.4;
      ctx.strokeStyle = def.colour;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (S >= 12) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(S * 0.6)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(tw.evolved ? 'E' : String(tw.tier), p.x, p.y + size * 0.35);
    }
  }
}

// ---- spawners and cohorts ---------------------------------------------------

/**
 * The tile "locate" pointed at, marked until the next click.
 *
 * Deliberately not the hover outline: that one is thin and white and follows
 * the mouse, so a mark drawn the same way would be lost the moment the pointer
 * moved and unreadable if it happened to sit still. Amber, heavier, and doubled
 * with a ring outside the hex, which reads as a pin rather than as a cursor.
 */
function drawLocated(ctx, cam, canvas, S, ui) {
  const at = ui && ui.located;
  if (!at) return;
  const p = axialToScreen(cam, canvas, at.q, at.r);
  ctx.save();
  ctx.strokeStyle = 'rgba(240, 190, 90, 0.95)';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  hexPath(ctx, p.x, p.y, S);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(240, 190, 90, 0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, S * 1.45, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawSpawners(ctx, state, cam, canvas, S) {
  for (const sp of state.spawners) {
    if (!sp.alive) continue;
    ctx.fillStyle = 'rgba(160,40,36,0.9)';
    ctx.beginPath();
    for (const t of sp.footprint) {
      const p = axialToScreen(cam, canvas, t.q, t.r);
      hexPath(ctx, p.x, p.y, S);
    }
    ctx.fill();

    const c = axialToScreen(cam, canvas, sp.q, sp.r);
    // the accumulating cohort, growing each turn of the window
    const grow = sp.accumulatedTurns / C.ACCUMULATE_TURNS;
    ctx.strokeStyle = 'rgba(230,90,70,0.9)';
    ctx.lineWidth = Math.max(1, S * 0.15);
    ctx.beginPath();
    ctx.arc(c.x, c.y, S * (1.6 + grow * 1.8), 0, Math.PI * 2);
    ctx.stroke();

    if (S >= 8) {
      ctx.fillStyle = '#ffd76a';
      const pipR = Math.max(1.5, S * 0.16);
      for (let i = 0; i < sp.stars; i++) {
        ctx.beginPath();
        ctx.arc(c.x - (sp.stars - 1) * pipR * 1.6 + i * pipR * 3.2, c.y - S * 2.6, pipR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawCohorts(ctx, state, cam, canvas, S, ui) {
  const walk = ui && ui.walk && ui.walk.cohorts;
  for (const m of state.cohorts) {
    // Mid-march the blob is centred between hexes, so its own tiles come out
    // fractional and the map can no longer be asked whether it holds them. The
    // hex each one rounds to is what gets asked instead, which keeps the shape
    // clipped to the island rather than dropping every tile of it.
    const at = walk && walk.get(m.id);
    const tiles = cohortTiles(state, at ? { ...m, q: at.q, r: at.r } : m);
    ctx.fillStyle = 'rgba(200,60,50,0.32)';
    ctx.beginPath();
    for (const t of tiles) {
      const h = at ? axialRound(t.q, t.r) : t;
      if (!state.map.tiles.has(key(h.q, h.r))) continue;
      const p = axialToScreen(cam, canvas, t.q, t.r);
      hexPath(ctx, p.x, p.y, S);
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,80,64,0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    if (S >= 8) {
      const p = axialToScreen(cam, canvas, at ? at.q : m.q, at ? at.r : m.r);
      ctx.fillStyle = '#fff';
      ctx.font = `bold ${Math.round(S * 0.9)}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cohortHidden(state, m) ? '?' : String(m.units.length), p.x, p.y);
    }
  }
}

function drawAssaults(ctx, state, cam, canvas, S) {
  if (!state.assaults.length) return;
  const from = axialToScreen(cam, canvas, state.base.q, state.base.r);
  ctx.save();
  ctx.setLineDash([6, 5]);
  for (const a of state.assaults) {
    const sp = state.spawners.find((s) => s.id === a.targetSpawnerId);
    if (!sp) continue;
    const to = axialToScreen(cam, canvas, sp.q, sp.r);
    ctx.strokeStyle = a.state === 'march' ? 'rgba(240,220,150,0.8)' : 'rgba(200,90,70,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.fillStyle = '#f0dc96';
    ctx.font = '12px monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(`${a.state} ${a.turnsRemaining}`, (from.x + to.x) / 2, (from.y + to.y) / 2);
  }
  ctx.restore();
}

// ---- the resolve -----------------------------------------------------------

function unitScreen(cam, canvas, group, u) {
  const i = Math.max(0, Math.min(group.path.length - 1, Math.floor(u.pos)));
  const j = Math.min(group.path.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, u.pos - i));
  const a = axialToScreen(cam, canvas, group.path[i].q, group.path[i].r);
  const b = axialToScreen(cam, canvas, group.path[j].q, group.path[j].r);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

function drawCombat(ctx, state, cam, canvas, S) {
  const cb = state.combat;
  for (const g of cb.groups) {
    ctx.strokeStyle = 'rgba(255,240,200,0.55)';
    ctx.lineWidth = 1;
    for (const shot of cb.shots) {
      if (shot.group !== g) continue;
      const target = g.units.find((u) => u.id === shot.toId);
      if (!target) continue;
      const a = axialToScreen(cam, canvas, shot.from.q, shot.from.r);
      const b = unitScreen(cam, canvas, g, target);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (const u of g.units) {
      if (!u.alive) continue;
      const p = unitScreen(cam, canvas, g, u);
      const rad = (u.elite ? 6 : 3) * Math.max(0.6, S / 12);
      ctx.fillStyle = C.UNITS[u.type].colour;
      ctx.beginPath();
      ctx.arc(p.x, p.y, rad, 0, Math.PI * 2);
      ctx.fill();
      if (u.elite) {
        ctx.strokeStyle = '#ffd76a';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 2, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (u.role) {
        ctx.strokeStyle = u.role === 'healer' ? '#7fd07f' : '#7fa8d0';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, rad + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

// ---- the order queue on the map --------------------------------------------

/**
 * Tiles part-way cut. Three turns of work is long enough that the progress has
 * to be on the map, not just in the panel: a wedge of the hex fills as the
 * work banks up.
 */
function drawWorkedGround(ctx, state, cam, canvas, S) {
  if (S < 5) return;
  ctx.save();
  ctx.fillStyle = 'rgba(226, 208, 160, 0.55)';
  for (const t of state.map.tiles.values()) {
    if (!t.work || t.cleared) continue;
    const p = axialToScreen(cam, canvas, t.q, t.r);
    if (p.x < -S || p.y < -S || p.x > canvas.width + S || p.y > canvas.height + S) continue;
    const frac = Math.min(1, t.work / C.turnsToClear(t.terrain));
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.arc(p.x, p.y, S * 0.55, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Ground that is spoken for. Amber is a hand, blue is an officer; dashed means
 * the order is still in the queue, solid means they are on it.
 */
const CREW_COLOUR = { hand: [255, 226, 138], officer: [120, 180, 255] };

function drawQueued(ctx, state, cam, canvas, S) {
  const marks = new Map(); // one mark per tile, an officer's wins
  const mark = (q, r, who, queued) => {
    const k = `${q},${r}`;
    const cur = marks.get(k);
    if (cur && cur.who === 'officer') return;
    marks.set(k, { q, r, who, queued });
  };

  for (const a of projectedAssignments(state)) {
    if (!a.target || a.target.q === undefined) continue;
    const who = officerById(state, a.who) ? 'officer' : 'hand';
    mark(a.target.q, a.target.r, who, a.queued);
  }
  // buildings, towers and bridges the queue has placed
  for (const t of queuedTiles(state)) {
    if (t.kind === 'assignClear' || t.kind === 'assignGarrison') continue;
    mark(t.q, t.r, 'hand', true);
  }
  if (!marks.size) return;

  ctx.save();
  ctx.lineWidth = 2;
  for (const m of marks.values()) {
    const [r0, g0, b0] = CREW_COLOUR[m.who];
    ctx.setLineDash(m.queued ? [4, 3] : []);
    ctx.strokeStyle = `rgba(${r0}, ${g0}, ${b0}, 0.95)`;
    ctx.fillStyle = `rgba(${r0}, ${g0}, ${b0}, ${m.queued ? 0.14 : 0.1})`;
    const p = axialToScreen(cam, canvas, m.q, m.r);
    ctx.beginPath();
    hexPath(ctx, p.x, p.y, S * 0.86);
    ctx.fill();
    ctx.stroke();
  }
  drawFacesLeft(ctx, state, cam, canvas, S);
  ctx.restore();
}

/**
 * A labour officer works several faces at once. Mark how many he still has
 * spare, on the last tile he was put on.
 */
function drawFacesLeft(ctx, state, cam, canvas, S) {
  if (S < 8) return;
  const tasks = projectedAssignments(state);
  for (const o of state.crew.officers) {
    const cap = clearCapacity(state, o.id);
    if (cap <= 1) continue;
    const mine = tasks.filter((a) => a.who === o.id);
    const clears = mine.filter((a) => a.kind === 'clear');
    if (!clears.length || clears.length !== mine.length) continue;
    const left = cap - clears.length;
    if (left <= 0) continue;
    const last = clears[clears.length - 1];
    const p = axialToScreen(cam, canvas, last.target.q, last.target.r);
    const rad = Math.max(6, S * 0.42);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(p.x + S * 0.55, p.y - S * 0.55, rad, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20, 32, 52, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#cfe4ff';
    ctx.font = `bold ${Math.round(rad * 1.2)}px ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(left), p.x + S * 0.55, p.y - S * 0.55 + 1);
  }
}

// ---- the crew --------------------------------------------------------------

/** Where the bodies standing on one tile sit inside it. */
function dotSpots(n, S) {
  if (n <= 1) return [[0, 0]];
  const ring = Math.min(n, 4);
  const out = [];
  for (let i = 0; i < ring; i++) {
    const a = (Math.PI * 2 * i) / ring - Math.PI / 2;
    out.push([Math.cos(a) * S * 0.40, Math.sin(a) * S * 0.40]);
  }
  if (n > 4) out.push([0, 0]);
  return out;
}

const EMPTY = new Map();

// Same key as the batch glow: version, turn, both counts and `state.ids`, which
// is what catches a revoke-and-requeue that leaves every count where it was.
const projectionKey = (state) =>
  `${state.map.version}|${state.turn}|${state.orders.length}|${state.crew.assignments.length}|${state.ids}`;

let lineCache = { key: null, map: EMPTY };

/**
 * Who is bound for a tile they are not standing on, and which tile.
 *
 * The test is where the body actually is, not what the arrival turn says. An
 * assignment's `arrivesOnTurn` is a statement about the coming resolve rather
 * than about now — it reads as "this turn" for the whole of the turn the walk
 * finishes on, because movement runs before the labour and the arrival turn is
 * a working turn. Trusting it drew no line for an officer plainly six tiles
 * short of his job. `taskState` refuses it for the same reason.
 *
 * Queued orders and assignments under way are taken from one list, because to
 * the eye they are the same thing: somebody is going somewhere. Which body
 * walks a queued order is only known by asking the projection — the same answer
 * the queue panel prints beside the row, so the line and the row agree.
 *
 * One line per body. An officer cutting a batch has several faces queued and
 * would otherwise sprout a line to each; the batch glow already shows the rest
 * of his ground, and a fan of lines out of one dot reads as confusion rather
 * than as information.
 *
 * Cached, because it asks the projection — which walks the crew's reachable
 * ground — and this is called every frame.
 */
export function jobLines(state) {
  const k = projectionKey(state);
  if (lineCache.key === k) return lineCache.map;
  const out = new Map();
  const { byOrder } = projectedCrew(state, crewGroundAtResolve(state));
  for (const a of projectedAssignments(state)) {
    if (a.kind === 'assault') continue;               // away with the team
    const who = a.queued ? byOrder.get(a.id) : a.who;
    if (!who || out.has(who)) continue;
    const to = jobPlace(state, a);
    if (!to) continue;
    const m = state.crew.members.find((x) => x.id === who);
    if (!m || (m.q === to.q && m.r === to.r)) continue;   // already standing on it
    out.set(who, to);
  }
  lineCache = { key: k, map: out };
  return out;
}

/**
 * Every body on the island, standing where they are. Hands are bone, officers
 * are blue and a shade larger; anyone bound for a tile they have not reached is
 * joined to it by a thin line, so an outline on a far tile also says who is
 * going to it.
 */
function drawCrew(ctx, state, cam, canvas, S, ui) {
  if (S < 5) return;
  if (ui && ui.walk) return drawWalkers(ctx, state, cam, canvas, S, ui.walk.crew);
  const byTile = new Map();
  const away = new Set();
  for (const a of state.crew.assignments) if (a.kind === 'assault') away.add(a.who);
  // Only while the player has the turn. During a resolve the bodies are moving
  // and the lines would be drawn to ground they are halfway across; the reel
  // draws no lines at all, and this is the other half of that rule.
  const lines = state.phase === 'player' ? jobLines(state) : EMPTY;
  for (const m of state.crew.members) {
    if (away.has(m.id)) continue;
    const k = `${m.q},${m.r}`;
    let list = byTile.get(k);
    if (!list) byTile.set(k, (list = []));
    list.push(m);
  }
  if (!byTile.size) return;

  ctx.save();
  const rad = Math.max(1.6, S * 0.15);
  for (const list of byTile.values()) {
    const p = axialToScreen(cam, canvas, list[0].q, list[0].r);
    if (p.x < -S || p.y < -S || p.x > canvas.width + S || p.y > canvas.height + S) continue;
    const spots = dotSpots(list.length, S);
    list.forEach((m, i) => {
      const [dx, dy] = spots[Math.min(i, spots.length - 1)];
      const bound = lines.get(m.id);
      if (bound) {
        const to = axialToScreen(cam, canvas, bound.q, bound.r);
        // Drawn twice: a dark backing under a light hairline. One faint stroke
        // was legible over forest and invisible over sand and salt, which is
        // exactly the ground a long line crosses — and a line you cannot follow
        // to its end is not telling you where anybody is going.
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(p.x + dx, p.y + dy);
        ctx.lineTo(to.x, to.y);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = 'rgba(10, 13, 18, 0.45)';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(236, 242, 252, 0.8)';
        ctx.stroke();
        ctx.setLineDash([]);
      }
      const officer = m.kind === 'officer';
      ctx.beginPath();
      ctx.arc(p.x + dx, p.y + dy, officer ? rad * 1.35 : rad, 0, Math.PI * 2);
      ctx.fillStyle = officer ? '#8fc0ff' : '#efe4c8';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(18, 22, 28, 0.85)';
      ctx.stroke();
    });
  }
  ctx.restore();
}

/**
 * The same bodies mid-stride, during the resolve reel.
 *
 * A separate pass rather than a branch inside the one above, because almost
 * every assumption changes: `walk` holds fractional axial coordinates, so there
 * is no tile to group by and no need for the spot offsets that keep four bodies
 * on one hex apart — a walker is between hexes and stands on its own. The
 * dashed line to the job is dropped too; the dot is visibly going there.
 */
function drawWalkers(ctx, state, cam, canvas, S, walk) {
  ctx.save();
  const rad = Math.max(1.6, S * 0.15);
  for (const m of state.crew.members) {
    const at = walk.get(m.id) || m;
    const p = axialToScreen(cam, canvas, at.q, at.r);
    if (p.x < -S || p.y < -S || p.x > canvas.width + S || p.y > canvas.height + S) continue;
    const officer = m.kind === 'officer';
    const moving = walk.has(m.id);
    ctx.beginPath();
    ctx.arc(p.x, p.y, officer ? rad * 1.35 : rad, 0, Math.PI * 2);
    // Anyone standing still this turn is dimmed rather than hidden, so the eye
    // has the whole company for scale and only the movers pull it.
    ctx.globalAlpha = moving ? 1 : 0.35;
    ctx.fillStyle = officer ? '#8fc0ff' : '#efe4c8';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(18, 22, 28, 0.85)';
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

/**
 * A labour officer's spare faces. Once one of his tiles is queued the rest of
 * the batch is free, so the ground he could add glows — touching what he holds,
 * and the same ground as it, because the batch is one job at one rate.
 */
let glowCache = { key: null, tiles: [] };

function batchTiles(state) {
  const tasks = projectedAssignments(state);
  const out = [];
  for (const o of state.crew.officers) {
    const cap = clearCapacity(state, o.id);
    if (cap <= 1) continue;
    const mine = tasks.filter((a) => a.who === o.id);
    const clears = mine.filter((a) => a.kind === 'clear');
    if (!clears.length || clears.length !== mine.length || clears.length >= cap) continue;
    const held = tileAt(state, clears[0].target.q, clears[0].target.r);
    for (const f of workableTiles(state)) {
      if (held && f.terrain !== held.terrain) continue;
      if (clears.some((c) => distance(c.target, f) === 1)) out.push({ q: f.q, r: f.r });
    }
  }
  return out;
}

function drawBatchGlow(ctx, state, cam, canvas, S) {
  // `state.ids` is in the key because revoking one order and queuing another
  // leaves version, turn and both lengths untouched — and the glow then stayed
  // on the abandoned tile's neighbours. Every enqueue draws a fresh id.
  const k = `${state.map.version}|${state.turn}|${state.orders.length}|${state.crew.assignments.length}|${state.ids}`;
  if (glowCache.key !== k) glowCache = { key: k, tiles: batchTiles(state) };
  if (!glowCache.tiles.length) return;

  const pulse = 0.55 + 0.35 * Math.sin(performance.now() / 320);
  ctx.save();
  ctx.lineWidth = 2;
  ctx.shadowColor = 'rgba(150, 210, 255, 0.95)';
  ctx.shadowBlur = Math.max(6, S * 0.9);
  ctx.strokeStyle = `rgba(190, 230, 255, ${pulse.toFixed(3)})`;
  ctx.fillStyle = `rgba(140, 200, 255, ${(pulse * 0.12).toFixed(3)})`;
  for (const t of glowCache.tiles) {
    const p = axialToScreen(cam, canvas, t.q, t.r);
    ctx.beginPath();
    hexPath(ctx, p.x, p.y, S * 0.9);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The building being placed, following the cursor. The silhouette never
 * reshapes itself around an obstacle — it is drawn tile by tile, each one green
 * or red on its own account, so "1 short" points at the tile that is short
 * instead of condemning the other three with it.
 *
 * A refusal that is about no one tile — the type is already built, the plot is
 * inside its neighbour's halo — has no tile to point at, so the whole shape
 * goes red and the line of text above it says which.
 */
function drawPlacement(ctx, state, cam, canvas, S, ui) {
  if (!ui.placing || !ui.hover) return;
  const def = C.buildingDef(ui.placing);
  if (!def) return;
  const { q, r } = ui.hover;
  const check = canBuildBuilding(state, ui.placing, q, r);
  const tiles = footprintPreview(state, q, r, def.tiles, false, ui.placing);
  const blanket = !check.ok && tiles.every((t) => t.ok);
  const takes = (t) => t.ok && !blanket;

  for (const t of tiles) {
    const p = axialToScreen(cam, canvas, t.q, t.r);
    ctx.fillStyle = takes(t) ? 'rgba(90, 200, 110, 0.35)' : 'rgba(210, 70, 55, 0.35)';
    ctx.beginPath();
    hexPath(ctx, p.x, p.y, S);
    ctx.fill();
  }
  ctx.lineWidth = 2.5;
  for (const t of tiles) {
    const p = axialToScreen(cam, canvas, t.q, t.r);
    ctx.strokeStyle = takes(t) ? 'rgba(120, 240, 140, 0.95)' : 'rgba(240, 90, 70, 0.95)';
    ctx.beginPath();
    hexPath(ctx, p.x, p.y, S);
    ctx.stroke();
  }

  const anchor = axialToScreen(cam, canvas, q, r);
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const text = check.ok ? `${def.name} — click to place` : (check.why || 'cannot build here');
  ctx.fillStyle = 'rgba(10,12,15,0.8)';
  const w = ctx.measureText(text).width + 10;
  ctx.fillRect(anchor.x - w / 2, anchor.y - S * 2.6, w, 16);
  ctx.fillStyle = check.ok ? '#8ef0a0' : '#f07a66';
  ctx.fillText(text, anchor.x, anchor.y - S * 2.6 + 13);
}

// ---- hover, selection, rings ----------------------------------------------

function ringAt(ctx, cam, canvas, q, r, radius, S, style, dashed) {
  ctx.save();
  if (dashed) ctx.setLineDash([5, 4]);
  ctx.strokeStyle = style;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const c = axialToScreen(cam, canvas, q, r);
  ctx.arc(c.x, c.y, (radius + 0.5) * SQRT3 * S, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawHighlights(ctx, state, cam, canvas, S, ui) {
  drawLocated(ctx, cam, canvas, S, ui);
  const h = ui.hover;
  if (!h) return;
  const t = tileAt(state, h.q, h.r);
  if (!t) return;

  const p = axialToScreen(cam, canvas, h.q, h.r);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  hexPath(ctx, p.x, p.y, S);
  ctx.stroke();

  if (t.occupant && t.occupant.kind === 'tower') {
    const tw = state.towers.find((x) => x.id === t.occupant.id);
    if (tw) ringAt(ctx, cam, canvas, tw.q, tw.r, towerRange(state, tw), S, 'rgba(255,255,255,0.5)');
  }
  if (t.occupant && t.occupant.kind === 'spawner') {
    const sp = state.spawners.find((x) => x.id === t.occupant.id);
    if (sp) ringAt(ctx, cam, canvas, sp.q, sp.r, C.EXCLUSION_RADIUS, S, 'rgba(230,90,70,0.8)', true);
  }
  if (t.occupant && t.occupant.kind === 'base') {
    ringAt(ctx, cam, canvas, state.base.q, state.base.r, C.SHIP_RANGE, S, 'rgba(200,220,255,0.5)');
  }
}
