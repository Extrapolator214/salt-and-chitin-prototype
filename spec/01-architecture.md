# 01 · Architecture

## File layout

```
index.html
style.css
src/
  main.js              entry: builds state, wires view to sim, starts the loop
  sim/
    config.js          00-constants.md as one frozen object
    rng.js             mulberry32, seeded
    hex.js             axial coords, neighbours, distance, ring, line, spiral
    state.js           createState(seed) -> the whole run
    generate.js        island 1 generator (02-map.md)
    orders.js          the order queue: validate, apply, revoke
    turn.js            resolveTurn(state) -> events[]
    labour.js          hand assignment, clearing, yields
    build.js           towers, items, buildings, manning, flares
    enemy.js           spawners, cohorts, advance, entry points
    combat.js          the real-time resolve (fixed 30 Hz)
    assault.js         assault scheduling and resolution
  view/
    render.js          canvas: map, towers, cohorts, units
    camera.js          pan, zoom, screen<->hex
    hud.js             the persistent bar
    hover.js           the tile info panel
    modals.js          modal stack, one render function per modal
    log.js             the event feed
```

No other files. No `node_modules`.

## Module rules

**`sim/` is pure.** It may not import from `view/`, touch the DOM, call
`Math.random`, `Date.now`, or `new Date()`. Every random draw goes through
`rng.js`. Given the same seed and the same order sequence, a run replays
identically.

**`view/` never mutates sim state.** It reads it and it pushes orders onto the
queue. One direction, always.

`main.js` is the only place the two meet.

## State shape

```js
state = {
  seed, turn, act, phase,          // phase: 'player' | 'resolve' | 'combat' | 'over'
  outcome: null,                   // 'won' | 'lost:hull' | 'lost:armada'

  map: {
    radius, tiles,                 // Map<key, Tile>, key = `${q},${r}`
  },

  base:  { q, r, hull, hold: [] }, // hold: item tiers, max 5 unless warehoused
  res:   { wood, stone, iron, gold },

  crew: {
    hands: 10, cap: 40,
    assignments: [],               // see below
    officers: [ {id, name, verb, assignedTo} ],
    flaresFired: 0, flaresInFlight: [],   // [{landsOnTurn}]
  },

  towers:    [ {id, q, r, towerIndex, tier, evolved, essence, manning:[], footprint:[]} ],
  buildings: [ {id, type, tiles:[], manning:[], unmanned:false, progress} ],
  bridges:   [ {q, r} ],

  spawners: [ {id, kind, q, r, stars, alive, mode, accumulatedTurns, cohort} ],
  cohorts:   [ {id, spawnerId, units:[], q, r, targetEntry, tilesRemaining} ],

  assaults: [ {targetSpawnerId, leader, hands, turnsRemaining, state} ],

  orders: [],                      // the queue, revocable until the turn ends
  log:    [],                      // event strings, newest last
  rngState: 0,
}
```

### Tile

```js
Tile = {
  q, r,
  terrain,            // 'forest' | 'canopy' | 'scrub' | 'stone' | 'road' |
                      // 'sand' | 'salt' | 'freshwater' | 'cliff' | 'saltwater'
  cleared: false,     // once true, terrain becomes 'road'
  feature: null,      // 'cache' | 'spring' | 'officer' | 'wreck'
  featureWorked: false,
  occupant: null,     // {kind:'tower'|'building'|'spawner'|'base', id}
  bridge: false,
}
```

### Assignment

A hand is assigned to a **standing task**, not commanded tile by tile.

```js
Assignment = {
  id,
  kind,        // 'clear' | 'man' | 'assault' | 'idle'
  who,         // 'hand' | officerId
  target,      // clear: {q,r} anchor · man: towerId|buildingId · assault: assaultId
}
```

A `clear` assignment consumes tiles outward from its anchor by nearest-first,
one tile per hand per turn, and persists until the region is exhausted or the
player revokes it.

## The frame loop

```
requestAnimationFrame(frame):
  if state.phase === 'combat':
      combat.tick(state, dt)          // fixed 30 Hz accumulator
  render(state)
```

The strategic game does not tick. It advances only when the player ends the turn.

## Turn transition

```
endTurn():
  state.phase = 'resolve'
  events = turn.resolveTurn(state)    // synchronous, pure
  if events.combat:
      state.phase = 'combat'          // hands control to the 30 Hz ticker
      // on combat end -> phase 'player', turn++
  else:
      state.phase = 'player'; state.turn++
```

`resolveTurn` runs the sequence in `03-turn.md` §3 and returns an event list the
view turns into log lines and modals.

## Determinism

- The RNG is seeded from the URL (`?seed=`) or from a fixed default `20260816`.
- `combat.tick` uses a fixed timestep accumulator: `while (acc >= 1/30) { step(); acc -= 1/30 }`.
  Rendering interpolates; simulation never does.
- No floating-point comparison for game rules — compare with an epsilon of 1e-6
  or work in integers where a rule depends on equality.
