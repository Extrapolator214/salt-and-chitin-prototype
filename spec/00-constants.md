# 00 · Constants

Every tunable number in the prototype. Implement this file as `src/sim/config.js`
exporting one frozen object. Nothing anywhere else may hard-code a number that
appears here.

Values marked **[cal]** are calibration targets rather than fixed rules — they
exist to satisfy an acceptance test in `06-acceptance.md` and are expected to move.

---

## 1 · Units and scale

| symbol | meaning |
|---|---|
| **tile** | one hex |
| **turn** | one strategic turn; 300 per run |
| **second** | real-time only, inside a resolve |
| **wood, stone** | build currency |
| **iron, gold** | item currency |
| **power** | a tower's damage per second |

**Resource scale.** Tile yields are integers (`scrub 1 / forest 3 / stone 5`).
All build costs are stated in the same integer units.

---

## 2 · Run frame

| constant | value |
|---|---|
| `TURNS_PER_RUN` | 300 |
| `TURNS_PER_ACT` | 100 |
| `ACTS` | 3 |
| `MAP_RADIUS` | 50 |
| `MAP_TILES` | 7776 |
| `SPAWNER_RING` | 44 |
| `BASE_FOOTPRINT` | 7 tiles (centre + 6 neighbours) |
| `ARMADA_TURN` | 300 — run ends, loss if any spawner still stands |

---

## 3 · Terrain

Yields below are the spec's. The build pays three times each, because a tile is
three turns of one worker's labour rather than one — see `TURNS_PER_TILE`. Two
terrains are not simply tripled, and both are noted in the table.

| terrain | clearable | yield | buildable | passable | advance mult | targetable while virgin | notes |
|---|---|---|---|---|---:|---|---|
| `forest` | yes | 3 wood | yes | yes | 3.0 | **no** | build: 9 wood, 3 turns |
| `canopy` | yes | 3 wood | yes | yes | 3.0 | **no** | blocks line of sight **over** it; build: **10 wood**, 3 turns — 10% more than forest |
| `scrub` | yes | 1 wood | yes | yes | 1.5 | yes | build: 3 wood, **1 turn** — a third of the wood for a third of the work |
| `stone` | yes | 5 stone | yes | **no until cleared** | — | — | boulders span 3–5 tiles |
| `road` | already clear | 0 | yes | yes | 1.0 | yes | what every cleared tile becomes |
| `sand` | **no** | 0 | **no** | yes | 2.0 | yes | |
| `meadow` | **no** | 0 | **yes, uncut** | yes | 1.5 | yes | open grass — crew walk it uncut, and a swarm in contact crosses it. The only ground built on without clearing first, and it never becomes road |
| `salt` | **no** | 0 | **no** | yes | 1.0 | yes | +25% damage taken, no regeneration |
| `freshwater` | bridgeable | 0 | **no, bridged or not** | **no until bridged** | 1.0 bridged | — | shown as *fresh water*; bridge costs 65 wood and buys a crossing, not footing |
| `cliff` | **no** | 0 | **towers only** | **no** | — | — | +1 tower range |
| `saltwater` | no | 0 | no | no | — | — | shown as *salt water*; the ocean, plus 1–2 bays or straits |

`tar` exists in the terrain enum for completeness but does not appear on island 1.

**Cleared tiles become `road`.** Cliff, fresh water, sand, salt and salt water
are never cleared and never become road. **Generation lays no road at all**: the
ship stands on its own beach, and every road tile in a live game is one the
player cut. Fresh water can be bridged; salt water cannot.

---

### The landing, and the sea's intrusions

Build constants; the spec's corridor and apron are gone (see README).

| constant | value | what it does |
|---|---|---|
| `LANDING_BEACH_SPAN` / `_DEPTH` | 5 / 2 | how far along the shore and back from the water the landing beach reaches |
| `LANDING_BEACH_ARC` | 90° | it stays on the ship's seaward side; sand can never be cut |
| `LANDING_EXITS_MIN` | 3 | cuttable faces the ship's footprint must have, or the island is rerolled |
| `LANDING_CLIFF_RADIUS` | 8 | the cove wall's inner course, from the ship |
| `LANDING_CLIFF_COURSES` | 2 | how many rings deep it stands; the outer one is ragged |
| `LANDING_CLIFF_ARC` | 105° | half-arc round the inland bearing; the sea closes the rest |
| `LANDING_CLIFF_GAPS` | 1–2 | gaps besides the one always on the corridor bearing |
| `LANDING_CLIFF_GAP_HALF` | 10–15° | half-width of a gap |
| `WATER_FEATURE_COUNT` | 1–2 | bays or straits cut into the island |
| `WATER_FEATURE_OFF_LANDING` | 55° | how far they keep from the landing bearing, and from each other |
| `BAY_MOUTH` / `BAY_LENGTH` | 5–8 / 8–16 | a bay is a wide mouth tapering inland |
| `STRAIT_WIDTH` / `STRAIT_LENGTH` | 1–2 / 14–26 | a strait is a narrow channel... |
| `STRAIT_STOP_SHORT` | 3 | ...that stops this short of the far shore, so it divides rather than severs |
| `EDGE_BEACH_COUNT` / `_SIZE` | 3–5 / 8–20 | beaches on the rim besides the landing's |
| `EDGE_BEACH_MIN_APART` | 14 | and how far apart they sit |

---

## 4 · Labour

| constant | value |
|---|---|
| `HANDS_START` | 10 |
| `HANDS_CAP` | 40 |
| `TILES_PER_HAND_PER_TURN` | 1 |
| `LABOUR_RESERVE_FLOOR` | 0.20 — advisory readout, not enforced |

---

## 5 · Flares

| constant | value |
|---|---|
| `FLARE_COST_WOOD` | 250 |
| `FLARE_COST_IRON` | 120 |
| `FLARE_HANDS` | 5 |
| `FLARE_DELAY_TURNS` | 2 (1 with a Powder Store) |
| `FLARE_GATE` | act I: 1 · act II: 2 · act III: 3 (cumulative max 6) |

Price does not escalate. The act gate is the only limiter.

---

## 6 · Ship

| constant | value |
|---|---|
| `HULL_MAX` | 100 |
| `SHIP_DPS` | 14 **[cal]** |
| `SHIP_RANGE` | 12 tiles from the base centre **[cal]** |
| `REPAIR_WOOD_PER_HULL` | 25 |
| `HOLD_SLOTS` | 5 (unlimited with a Warehouse) |

The ship fires **only into cleared ground**, exactly like a tower.

Loss condition: `hull <= 0`.

---

## 7 · Towers

`power(tier) = TIER_BASE ^ (tier - 1)`

| constant | value |
|---|---|
| `TIER_BASE` | 2.5 |
| power by tier | 1 · 2.5 · 6.25 · 15.63 · 39.06 |
| `EVOLVED_MULT` | 2.5 → evolved tier 5 = 97.66 |
| manning by tier | t1–3: 1 hand · t4: 2 · t5: 2 · evolved: 3 |
| footprint | **by tower, not by tier** — 1 to 3 tiles, set in the table below |
| `TOWER_BUILD_COST` | 30 wood + 20 stone, plus one fitting of its kind from the hold, any tier |
| `DISASSEMBLE_REFUND` | 80% of build cost, plus the fitted item returns to inventory (and one being merged in) |
| `TOWER_MERGE_TURNS` | 3 — a matching fitting merged into the gun, which fires throughout |
| `CLIFF_RANGE_BONUS` | +1 tile |

**A tower is built at the tier of the fitting it takes**, and the lowest tier
held is the one taken. It rises from there by having a higher-tier item fitted
in place; the displaced item returns to inventory — or by merging a matching
fitting into the one already in the gun, which takes `TOWER_MERGE_TURNS` turns
and leaves the gun firing at its old tier until the work is done.

An **unmanned tower stands and does not fire.** That is a legal board state.

A tower's **footprint is a property of the gun and never changes.** It is laid
out of `BUILDING_SHAPES` on the tile the player placed it on, exactly as a yard
is, and the whole of it must be free, cleared and buildable before the order is
taken. Tiering a standing tower changes its power and its manning and nothing
else — the better gun goes into the emplacement that is already there.

| constant | value | note |
|---|---|---|
| `SHOT_INTERVAL` | fast 0.16 s · normal 0.42 s · slow 0.85 s | seconds between rounds leaving a gun |
| `PROJECTILE_SPEED` | 11 tiles/s | |
| `PROJECTILE_MAX` | 300 | a ceiling for a fight run out unwatched |
| `IMPACT_SECONDS` | 0.18 | how long the flash where a round lands is drawn |

Damage is a rate and is applied every tick. The rounds above carry none of it:
they are how the fight is told, thrown on each gun's own cadence at the spot the
target was standing on when the trigger went.

### The eight towers (indices 0–7)

Island 1 ships the Gunnery and Beasts shelves only.

| # | tower | shelf | range | tiles | rate | fire | essence lent |
|---:|---|---|---:|---:|---|---|---|
| 0 | Swivel Gun Post | gunnery | 3 | 1 | fast | fast single target | Scatter |
| 1 | Culverin Battery | gunnery | 8 | 2 | slow | slow single target | Bore |
| 2 | Chain-Shot Gallery | gunnery | 5 | 2 | normal | pierces a file along the road | Rake |
| 3 | Dynamite Throwers | gunnery | 5 | 2 | slow | slow blast, radius 1 | Blast |
| 4 | Parrot Swarm Aviary | beasts | 5 | 3 | fast | many weak hits, up to 4 targets | Swarm |
| 5 | Alligator Guards | beasts | 1 | 2 | normal | holds what it hits in place | Snag |
| 6 | Krakenling Well | beasts | 1 | 1 | normal | hits every adjacent road tile | Sweep |
| 7 | Monkey Riggers | beasts | 3 | 1 | normal | yields 2 gold per kill | Plunder |

`tiles` is the gun's yard; `rate` is its cadence on the map, which is a telling
and not a damage number.

All eight deal `power(tier)` damage per second within range. The `fire` column is
the shape of the damage, not a separate number:

| shape | rule |
|---|---|
| single target | full power to one unit |
| blast | full power split over all units within radius 1 of the target |
| file | full power to every unit on the target's road tile and the two behind it |
| multi-target | full power split over up to 4 units |
| adjacent | full power to every unit on the 6 adjacent tiles |

### Evolution

Tower *i* evolves with *i+1* or *i+7* (mod 20), never mutually. Within the
starting eight that yields **8 live recipes**: (0,1) (1,2) (2,3) (3,4) (4,5)
(5,6) (6,7) (0,7).

Requirements: both towers at tier 5, a **Tinker's Shed** built and manned. The
partner tower is consumed. The result is `power(5) × EVOLVED_MULT` and gains the
partner's essence effect.

---

## 8 · Items

| constant | value |
|---|---|
| `ITEM_CRAFT_IRON` | 6 (Workshop) |
| `ITEM_BUY_GOLD` | 8 (Peculiar Merchant) |
| merge | 2 items of tier *n* → 1 of tier *n+1* |
| tier-*n* cost | `2^(n-1)` tier-1 items |

Items merge in the inventory only — never on the board. Merging is free.

**One house per fitting** (build rule). Neither price is a shop the ship carries
with it. Each tower's fitting names its `source`, and there is exactly one route
to it: the ironwork — Swivel Gun, Culverin, Chain-Shot — is crafted at a
**Workshop** for `ITEM_CRAFT_IRON`, and the other five are bought off a
**Peculiar Merchant** for `ITEM_BUY_GOLD`. What is crafted cannot be bought and
what is bought cannot be crafted, so a shelf of the gun catalogue is shut until
its house stands and is manned. Merging needs no house.

---

## 8b · The dock counter (build rule)

Wood, stone and iron bought and sold to order at a manned **Trading Dock**, in
whatever amount. A trade is instant: it costs no turn, takes no hand and never
enters the order queue — but it is struck against what the queue has *not*
already spent, so wood a queued building is counting on cannot be sold.

| good | dock pays | dock asks |
|---|---|---|
| wood | 1 gold / 12 | 2 gold / 12 |
| stone | 1 gold / 12 | 2 gold / 12 |
| iron | 1 gold / 1 | 2 gold / 1 |

Whole gold both ways, rounded against the player: `floor` on a sale and `ceil`
on a purchase, so a handful of wood is worth nothing and is refused rather than
taken for nothing. The wood and stone sale rate is `DOCK_INPUT` for
`DOCK_GOLD_OUT` — the counter pays exactly what the dock's own standing trade
pays, so trading by hand is a matter of timing, not of rate.

---

## 9 · Economic buildings

Each costs **120 wood + 80 stone** and **2 hands** (1 inside a Bunkhouse radius),
unless its own entry in `C.BUILDINGS` names a `cost` or a `crew` of its own.

**Shape** (build rule). Every building has one fixed shape for its tile count
(`C.BUILDING_SHAPES`): the anchor tile plus its neighbours in ring order, so the
shape is compact, every tile touches the anchor, and the anchor is the tile the
player clicked. Footprints are never grown to fit the ground — a plot takes the
whole shape or the placement is refused — so a building is the same silhouette
everywhere and can carry one picture.

**Manning** (build rules). A building wants `BUILDING_HANDS` — or its own `crew`,
where it names one, as the Peculiar Merchant's single hand — one fewer inside a
Bunkhouse's radius (never more than it wanted to begin with), and one fewer again once its **crew upgrade** is bought for
`CREW_UPGRADE_GOLD`. The two stack, so an upgraded yard standing inside a
Bunkhouse's radius wants nobody at all — which is as far down as it goes, and the
upgrade is refused for a building already there. The spec's "upgrade to run
unmanned" is this, one step at a time, rather than one purchase that empties the
whole roster.

A job has as many places as it has places: manning orders are counted against
the crew wanted, standing and queued together, for buildings and towers alike. A
building that wants two takes two, and the third order is refused.

| building | tiles (spec) | tiles (build) | effect |
|---|---:|---:|---|
| Warehouse | 3 | 5 | inventory becomes unlimited |
| Forge | 2 | 4 | 3 stone → 1 iron per turn |
| Workshop | 3 | 5 | the iron fittings craftable at 6 iron |
| Trading Dock | 3 | 5 | 12 wood or stone → 1 gold per turn, and the counter of §8b |
| Peculiar Merchant | — | 3 | the gold fittings buyable at 8 gold; 1 hand |
| Tinker's Shed | 3 | 4 | evolutions can be performed |
| Sappers' Camp | 3 | 6 | assault teams can be raised |
| Hospital | 2 | 3 | assault downtime 3 turns → 1 |
| Powder Store | 2 | 3 | flare cost −25%, lands in 1 turn |
| Excavation Camp | 3 | 4 | works one treasure cache; 100 gold over 10 turns |
| Bunkhouse | 2 | 3 | buildings within radius 3 cost 1 hand |
| Palisade | — | 1 | the enemy will not cross it; no crew · **45 wood + 30 stone**, a third of the flat price |

Excavation Camp, Bunkhouse and Palisade are repeatable; the rest are one each.

**Under attack** (build rules). A tower is a fortification and nothing in the
resolve attacks one; an economic building is not.

| constant | value | what it does |
|---|---|---|
| `BUILDING_HP_PER_TILE` | 150 | a building's strength is its footprint × this |
| `BUILDING_DAMAGE_MULT` | 0.35 | of a unit's hull damage, per second, while it holds a face |
| `ATTACK_SLOTS_PER_SIDE` | 3 | six sides, three a side — 18 on a lone single-tile building; faces inside a multi-tile footprint take nobody |
| `RUIN_REBUILD_FRACTION` | 0.4 | a building at zero is **ruined**, never destroyed: it keeps its ground, does nothing, and is rebuilt for this fraction of its price |

**Where one may stand** (build rules; the Palisade is exempt from both, since a
wall that needed a road beside it and could not touch its neighbour would not be
a wall):

| rule | constant | why |
|---|---|---|
| road beside it, joined to the ship | — | a yard sits on your supply line, not in the woods |
| `BUILDING_GAP` tiles clear of the next building | 1 | any tile does; it stops the economy being poured into one blob |

Footprints are roughly double the spec's so that the whole economy **cannot** be
built inside the landing's cliff wall: fully cleared, the cove takes 7–8 of the
9 non-repeatable yards, so the rest go out through a gap and are defended where
they stand.

---

## 10 · Assaults

| constant | value |
|---|---|
| `ASSAULT_HANDS` | 4 — **2 when the Sapper Captain is the one leading it**, and only then |
| `SUCCESS_CAPTAIN` | 0.90 — led by the Sapper Captain, whose trade it is |
| `SUCCESS_NAMED` | 0.65 — led by any other unique lieutenant |
| `SUCCESS_GENERIC` | 0.40 — led by nobody, or by a pirate off the island |
| `MARCH_TURNS` | 10 |
| `DOWNTIME_TURNS` | 3 (1 with a Hospital) |
| `EXCLUSION_RADIUS` | 7 tiles — no tower may be built within this of a spawner |

**Requires:** a Sappers' Camp, and a continuous road path from the base to a tile
adjacent to the target spawner. Scheduled in the player phase, resolved in the
resolve phase, shown as a modal.

**Nobody dies.** A failure disables the team for `DOWNTIME_TURNS`.

**Killing a spawner** stops it producing and sends its currently accumulating
cohort advancing on that same turn. Its stars transfer to the surviving spawners.

---

## 11 · Spawners and the enemy

### Island 1 configuration

| | count | stars at start | star cap |
|---|---:|---:|---:|
| hive | 1 | 2 | 6 |
| shell spawner | 1 | 1 | 5 |

| constant | value |
|---|---|
| `ESCALATION_TURNS` | 50 — one random spawner gains a star |
| `ACCUMULATE_TURNS` | 6 |
| `ADVANCE_TILES_PER_TURN` | 6, divided by the mean advance multiplier of the tiles crossed |
| `UNITS_PER_STAR` | 8 |
| `SPAWNER_FOOTPRINT` | 4 tiles (hive 8) |
| `grubShare` | hive 0.90, shell spawner 0.45 — each front's grub/shell split |

A spawner with *S* stars releases `S × UNITS_PER_STAR` units per cohort, split by
that spawner's own `grubShare`: the hive sends the fast column, the shell
spawner sends the armoured one. Weighted by their star caps the island still
averages the 70/30 below.

### Unit types

Island 1 fields the **Shells** family and the **column** baseline only.

| unit | share | HP | armour | road speed | hull damage on arrival |
|---|---:|---:|---:|---:|---:|
| Grub *(the column)* | 70% | 10 | 0 | 1.2 tiles/s | 4 |
| Shell | 30% | 30 | 3 flat per hit | 0.6 tiles/s | 9 |

| modifier | rule |
|---|---|
| **elite** | ×10 HP, ×0.5 speed, hull damage 30. One elite rides the next cohort of any spawner that has just gained a star. |
| **shield-bearer** | appears once a spawner reaches 3 stars. Projects 60 shield HP over units within 2 tiles; the shield absorbs before HP. |
| **healer** | appears once a spawner reaches 3 stars. Heals 3 HP/s to units within 2 tiles. Suppressed on `salt`. |

Terrain effects on units: `sand` ×0.5 speed, `salt` ×1.25 damage taken and no
healing.

---

## 12 · Treasure and features

| feature | count | effect |
|---|---:|---|
| treasure cache | 12 | 100 gold, worked by an Excavation Camp over 10 turns |
| freshwater spring | 1 | +3 to `HANDS_CAP` while a hand stands on it |
| officer site | 1 | at ~0.5r, visible from turn 1; reaching it with a hand recruits a 4th officer |
| shipwreck | 3 | 60 wood, 30 iron, 10 gold on first clear, then a buildable platform |

---

## 13 · Officers

Three, all available from turn 1, all assignable to any manning slot.

| officer | verb | |
|---|---|---|
| **Master Pioneer** | clears 3 tiles a turn by himself | a job |
| **Weapons Master** | items cost 25% less | **passive** |
| **Master Gunner** | mans one tower alone and gives it +50% power | a job |

A passive trade applies because the officer is in the company; it is shown as
`(passive)` beside the verb. Only the Weapons Master's is one — the Pioneer has
to be sent to cut, the Gunner has to be stood in a tower, and the Sapper Captain
has to go with the charges, so his 90% and his team of two are both his only
while he is leading the mission.

An officer **replaces a hand one for one** and gives their bonus only in their
own role. The 4th officer, from the map site, is a randomised copy of one of the
three.

---

## 14 · Real-time resolve

| constant | value |
|---|---|
| `TICK_HZ` | 30 |
| `RESOLVE_CAP_SECONDS` | 60 — after this the remainder auto-resolves |
| `SPEED_OPTIONS` | 1× · 3× · skip |

The player gives no input during a resolve.
