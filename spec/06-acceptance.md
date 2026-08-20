# 06 · Build order and acceptance

## §1 · Build order

Each step is independently runnable and independently checkable. Do not start a
step before the one above it passes.

| # | step | done when |
|---:|---|---|
| 1 | `hex.js`, `rng.js`, `config.js` | unit checks in §3.1 pass |
| 2 | `generate.js` + `render.js` + `camera.js` | the island draws, pans and zooms at 60 fps |
| 3 | `hover.js` | every tile reports correct terrain data |
| 4 | `state.js`, `orders.js`, `turn.js` with labour only | hands clear tiles, resources rise, turns advance |
| 5 | `build.js` — towers and items | a tier-5 tower is reachable by buying and merging |
| 6 | `enemy.js` — spawners, cohorts, advance, entry | a cohort crosses the map and reaches the corridor |
| 7 | `combat.js` | the ship kills wave 1 unaided |
| 8 | economic buildings, flares | the act I fork is playable |
| 9 | `assault.js` | a spawner can be destroyed |
| 10 | modals, log, end-of-run | a full 300-turn run completes |

Steps 1–7 are the prototype's spine. If time runs out, 8–10 are the part to cut.

## §2 · What this prototype is for

It exists to answer four questions that cannot be answered on paper:

1. **Does the two-mode turn read?** Does a player understand, without being told,
   that clearing outward moves the fight outward?
2. **Is a 7651-tile map legible at the zoom levels a player actually uses?**
3. **Does the act I fork feel like a fork** — one strong line against an economy?
4. **Is the real-time resolve worth watching**, or does it want to be a number?

Anything that does not serve one of these can be cut without argument.

## §3 · Acceptance checks

### 3.1 Hex and RNG

- `tilesInRadius(50) === 7651`.
- `distance(a,b)` is symmetric and satisfies the triangle inequality on 1000
  random pairs.
- `ring(c, n).length === 6n` for n in 1..10.
- `line(a,b)` returns `distance(a,b)+1` tiles, starting at `a`, ending at `b`.
- Two runs with the same seed produce byte-identical state after 50 turns of the
  same order sequence.

### 3.2 Generation

- The realised terrain mix is within ±2 points of target on 50 consecutive seeds.
- Clearable fraction ≥ 40% on all 50.
- Both spawners land at distance 41–47 from the base, ≥ 25° apart, in different
  fresh-water wedges.
- The landing corridor is 3 × 10 and fully cleared at turn 1.
- 12 caches, 1 spring, 1 officer site, 3 wrecks exist and are ≥ 6 tiles apart.

### 3.3 Labour and economy

- 10 hands on shovels clear exactly 10 tiles per turn.
- Clearing a forest tile credits exactly 3 wood and turns it to road.
- Buying 16 tier-1 items and merging them yields exactly one tier-5 item.
- The hold blocks a 6th item unless a Warehouse exists.

**The income-against-bill check.** Run 300 turns with a scripted policy: every
hand on shovels except those needed to man what gets built, all 6 flares fired as
soon as affordable, 10 economic buildings, ~20 towers, ~5 bridges. Then:

| | units |
|---|---:|
| flares 6 × 250 | 1500 |
| tower structures ~20 × 50 | 1000 |
| bridges ~5 × 65 | 325 |
| economic buildings 10 × 200 | 2000 |
| **bill** | **4825** |
| earned, at 2.64 wood-and-stone per cleared tile | **≈ 1830 tiles** |

The run must clear **1700–2000 tiles** and finish with a wood-and-stone surplus
between **0 and 25%**. A large surplus means the yields are too generous; a
shortfall means the costs are. This is the single most load-bearing calibration
in the build — fix it before tuning anything else in the economy.

### 3.4 The enemy

- The first cohort releases on turn 6 with `stars × 8` units.
- A cohort crosses from r=44 to the corridor in **14–20 turns** on Branch Office
  terrain.
- **The entry-point rule:** clear a tile off the corridor on the far side of the
  base from a spawner. The next cohort must still arrive at the corridor. If it
  diverts to the new tile, the pathing is "nearest road" and is wrong.
- Clear a tile *outward along the approach line* and the next contact must happen
  at that tile.
- Two cohorts whose tiles overlap on one turn merge into one.
- Killing a spawner releases its accumulating cohort on the same turn and transfers
  its stars.

### 3.5 Combat calibration **[cal]**

With no player action at all:

| wave | required outcome |
|---:|---|
| 1 | ship clears it, hull 100 |
| 2 | ship holds, hull ends **40–60** |
| 3 | hull reaches 0, at **turn 60–90** |

If this does not hold, adjust `SHIP_DPS` first, then `UNITS_PER_STAR`, then unit
HP. Do not adjust the corridor.

### 3.6 Towers

- A tier-1 tower with one hand deals exactly 1.0 damage per second.
- A tier-5 tower deals 39.06; evolved, 97.66.
- An unmanned tower deals 0 and still occupies its tiles.
- A tower cannot be placed within 7 tiles of a living spawner.
- A tower on cliff has range +1.
- A tower cannot fire at a unit on virgin forest, or through a canopy tile.

### 3.7 The full run

- A run of 300 turns completes without an exception on 20 consecutive seeds
  played by ending the turn repeatedly with no orders.
- All three outcomes are reachable: won, lost-hull, lost-armada.
- Frame time stays under 16 ms at every zoom level with a 40-unit resolve
  running.

## §4 · Deliberately absent

Do not implement any of these, and do not leave hooks for them:

metaprogression · chitin · the upgrade tree · save/load · islands 2–7 · relics ·
the officer roster beyond three · enemy families beyond Shells · burrowers,
flyers, sappers, runners, auditors, jumpers · the title screen · the ship screen
· island select · sound · tutorial text.

## §5 · Known simplifications

Stated so they are not mistaken for bugs.

| simplification | why |
|---|---|
| radius 50 gives 7651 tiles, not 7776 | 6⁵ is not a hex number; the difference is 1.6% |
| items are generic — tier only, no identity | which tower an item becomes is chosen at build time |
| the 4th officer is a copy of one of the three | the roster of 15 belongs to the campaign layer |
| essences are named but only their firing shape is implemented | status effects are step 11 |
| the advance multiplier is averaged over the tiles crossed per turn, not per tile | one number per turn is legible; per-tile is not |
| cohorts are drawn as outlines, not as units, until contact | the design says the count is hidden under cover anyway |
