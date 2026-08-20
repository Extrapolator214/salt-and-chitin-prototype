# 02 · Map

## Hex maths

Axial coordinates `(q, r)`, **pointy-top** hexes, third coordinate `s = -q - r`.

```
NEIGHBOURS = [[+1,0],[+1,-1],[0,-1],[-1,0],[-1,+1],[0,+1]]

distance(a, b) = (|aq-bq| + |aq+ar-bq-br| + |ar-br|) / 2

tilesInRadius(n) = 3n² + 3n + 1      // radius 50 -> 7651; see §2
```

Pixel conversion, size `S`:

```
x = S * sqrt(3) * (q + r/2)
y = S * 3/2 * r
```

Needed helpers: `neighbours`, `distance`, `ring(centre, radius)`,
`spiral(centre, radius)`, `line(a, b)` (cube-lerp with a +1e-6 nudge to break
ties consistently), `bearing(a, b)` in degrees.

## §2 · Map size

`MAP_RADIUS = 50` gives `3·50² + 3·50 + 1 = 7651` tiles. The design figure is
7776 (6⁵). **Use radius 50 and 7651 tiles.** The difference is 1.6% and no rule
depends on the exact count.

The map is **pure land**. The only water is the landing inlet.

## §3 · Generation, in order

The generator is deterministic from the seed. Run these passes in this order.

### 3.1 Base and inlet

1. Base at `(0,0)`, footprint = centre + 6 neighbours, terrain forced to `road`,
   `occupant = base`.
2. Pick an **inlet bearing** `θ_inlet` uniformly at random.
3. Cut a channel of `saltwater`, **2 tiles wide**, from the rim (r = 50) inward along
   `θ_inlet`, stopping **3 tiles** from the base. The last 5 tiles of the channel
   are the **lagoon**.

> **The build does this differently.** There is no inland disc and no inlet: the
> island is ringed by ocean and the ship is grounded on the shore. Its footprint
> is `sand`, not `road` — **generation lays no road anywhere** — and the beach is
> the ship's standing plus the strip of shore between it and the water, kept to
> the seaward side so the landward faces stay cuttable. Salt water also takes one
> or two bites out of the island: a **bay** (wide mouth, tapering inland) or a
> **strait** (a narrow channel stopping short of the far shore), both kept clear
> of the landing bearing. See README, *The landing is a cove*.

### 3.2 Landing corridor

1. `θ_corridor = θ_inlet + 180°` (± 20° jitter) — inland, away from the inlet.
2. Cut a corridor **3 tiles wide × 10 tiles long** from the base edge along
   `θ_corridor`. Every tile: `cleared = true`, terrain `road`.
3. Record `corridorMouth` = the far end centre tile. Used by 3.3.

> **The build does this differently.** The corridor is a bearing, not a cut: it
> aims the gap in the landing's cliff wall and the canopy stand, and nothing
> along it is cleared. In place of the corridor and the apron the landing gets a
> **broken ring of cliff** 8 tiles out, covering the land side (the sea closes
> the rest), with one gap always on `θ_corridor` and one or two more.

### 3.3 Spawners

Island 1 has **2 fronts**.

1. Bearings: `θ_0` random, `θ_1 = θ_0 + 180°` ± 12° jitter.
2. Place each spawner on the ring at `r = 44` ± 3 tiles of jitter.
3. The **hive** takes the bearing furthest from `corridorMouth`; the **shell
   spawner** takes the other.
4. Footprints: shell spawner **4 tiles**, hive **8 tiles**. Force terrain under the
   footprint — `sand` in the build, the mound they have trodden bare, since no
   road is generated — and mark `occupant = spawner`.
5. Reject and re-roll if the two spawners are within 25° of each other.

### 3.4 Structure pass — Branch Office

Run before the noise fill.

| feature | rule |
|---|---|
| **fresh water** | 3–4 spokes of `freshwater`, 1–2 tiles wide, radiating from the lagoon head to the rim, evenly spaced ± 15° jitter. They divide the map into wedges; **each spawner must end up in its own wedge** — re-roll spoke bearings until true. |
| **cliff** | one ridge, 12–18 tiles long, 1–2 wide, at ~0.5r on one flank, perpendicular to its own radius. |
| **boulders** | loose clusters of `stone`, 3–5 tiles each, until the stone quota is met. |
| **canopy** | one stand of 8–14 tiles adjacent to the landing corridor. |
| **the cove wall** | build only: a broken ring of `cliff` at `LANDING_CLIFF_RADIUS` round the land side of the landing, gapped on `θ_corridor` and at 1–2 more bearings. Counted against the cliff quota, never grown from, and no other cliff may grow into the cove. |

### 3.5 Terrain fill

Layered value noise (3 octaves, seeded) over every unassigned land tile, with
thresholds tuned so the realised mix lands within **±2 points** of:

| forest | canopy | scrub | stone | road | sand | salt | freshwater | cliff |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **42** | 2 | 24 | 10 | 3 | 6 | 1 | 8 | 4 |

Implementation: assign each tile a noise value, sort tiles by value, and cut the
sorted list at the cumulative percentages. This hits the mix exactly and clusters
naturally. Terrain already placed by 3.1–3.4 counts toward its quota.

### 3.6 Features

| feature | count | placement |
|---|---:|---|
| treasure cache | 12 | uniform over land, `distance` 8–46 from base, min 6 apart |
| freshwater spring | 1 | at 0.4–0.6r, in the wedge **between** the two spawner bearings |
| officer site | 1 | at ~0.5r, on a bearing within 30° of a spawner so the march crosses a lane |
| shipwreck | 3 | 5–15 tiles each, on or beside the inlet |

Features are visible from turn 1. There is no fog of war.

### 3.7 Acceptance

Re-roll the whole island if any fails:

1. Realised mix within ±2 points of target and summing to 100.
2. Clearable fraction ≥ 40%.
3. The landing corridor's flanking tiles are ≥ 60% buildable.
4. Each spawner has a passable path to the base at generation time.
5. The two spawners are ≥ 25° apart and in different fresh-water wedges.

Cap at 20 attempts, then throw with the seed in the message.

## §4 · Visibility

**There is no fog of war.** The ground is always fully visible.

What is hidden is the **force**: a cohort standing on `forest` or `canopy` shows
its position and extent but **not its unit count or composition**. Off cover, or
once in a resolve, both are shown.

## §5 · Clearing

- One hand clears one tile per turn. The tile becomes `road`, `cleared = true`.
- The yield is credited on the turn it clears (`00-constants.md` §3).
- Enemy pathing re-evaluates on the **same turn**, so a path opened this turn is
  walkable this turn.
- `sand`, `salt`, `freshwater`, `cliff` and `saltwater` cannot be cleared.
- `freshwater` can be **bridged**: 65 wood, one turn, makes that tile passable and
  buildable. A bridge is not road and yields nothing.
