# Salt & Chitin — bare-bones prototype

A playable single-island prototype of the v6 design. HTML + vanilla JavaScript,
no build step, no dependencies, no art.

Design source: `/source/game-research/v6-single-map.md`. This directory carries
**specifications only** — the numbers and rules to implement, not the reasoning
behind them.

## Scope

**In:** Island 1 (Branch Office) · one run of 300 turns · the whole island in one grid ·
clearing, resources, towers, items, economic buildings, flares, assaults ·
two-spawner enemy · real-time wave resolve · win and loss conditions.

**Out:** metaprogression of any kind (no chitin, no upgrade tree, no unlocks, no
save between runs) · islands 2–7 · relics · the officer roster beyond the four
lieutenants who sail and the pirate found on the island · enemy families beyond
Shells · art, audio, animation beyond position interpolation.

Everything visible is a flat-coloured polygon, a circle, or text.

## Spec files, in reading order

| file | contents |
|---|---|
| [`spec/00-constants.md`](spec/00-constants.md) | every tunable number in one table — the single source of truth |
| [`spec/01-architecture.md`](spec/01-architecture.md) | file layout, module boundaries, state shape, the frame loop |
| [`spec/02-map.md`](spec/02-map.md) | hex maths, terrain, the island generator, tile data |
| [`spec/03-turn.md`](spec/03-turn.md) | the turn structure, labour, spawners, pathing, the real-time resolve |
| [`spec/04-economy.md`](spec/04-economy.md) | resources, items, towers, buildings, manning, flares, assaults |
| [`spec/05-ui.md`](spec/05-ui.md) | canvas rendering, the hover panel, the HUD, every modal |
| [`spec/06-acceptance.md`](spec/06-acceptance.md) | build order and the checklist that says it works |

## Running it

Static files. Any HTTP server, because ES modules will not load from `file://`:

```
cd /source/salt-n-chitin-prototype
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## The run keeps itself

The run lives in the browser's `localStorage` — nothing is written to disk — and
a reload comes back to where you left off, queue included. Two keys, because the
two halves change at wildly different rates: `salt-n-chitin/map` is 850 KB of
tiles and is rewritten only when `map.version` says the labour moved the ground,
`salt-n-chitin/run` is 3 KB of everything else and is rewritten whenever anything
moves. Only a player-phase state is written, so a reload during a resolve comes
back to the top of that turn and plays it again — the same result, since the RNG
is part of the state.

With nothing stored and no `?seed=`, **the seed is today's date** — 20260821 on
the 21st of August 2026 — so a fresh visit is a fresh island and two people on
the same day get the same one. `?seed=` still names an island, but reloading a
seeded URL resumes rather than restarting, and starting a new run from one
rewrites the seed in the address bar so the two never disagree.

One thing had to be kept out of the save: **`state.derived`**, the map's cached
road network and walkable ground. They are `Set`s keyed on `map.version`, and
`JSON.stringify` turns a Set into `{}` — the version still matched after a
reload, so the cache handed back an empty object where a Set was expected and
the first order that asked "can anyone walk there" brought the turn down. The
acceptance suite now walks a played state and refuses to find a Set or a Map
anywhere except the tiles, and checks that a decoded run can answer for its
ground *before* it plays a turn, which is the only window in which a stale cache
is visible at all.

## Controls

| input | effect |
|---|---|
| hover | the tile panel |
| left-click | the tile's own modal — points of interest first, then what can be cut there |
| Restart map | the same island again from turn 1; **New run** is a different island |
| Towers / Economy in the bar | pick a gun or a yard; its outline then follows the cursor and a click puts it down |
| shift-click | put the nearest idle hand on the tile: cut it, or work what the cutting uncovered |
| right-click | the same as shift-click |
| drag | pan |
| `W` `A` `S` `D`, arrows | pan |
| wheel, `Q` `E`, `+` `-` | zoom, six steps from 3 px to 24 px hexes |
| `Space` | end the turn (confirms first if anyone is idle) |
| `Esc` | close a modal, or cancel a building placement |
| `1` `2` `3` | resolve speed, during combat |

## Playing it headlessly

`tests/play.mjs` is an honest AI player — no free resources, no patched hull.
It plays through the same order queue a human uses and tries to win.

```
node tests/play.mjs --seeds 12          # win rate over 12 seeds
node tests/play.mjs --trace 20260816    # turn-by-turn journal for one seed
node tests/play.mjs --sweep --seeds 5   # sweep the road-vs-guns trade-off
```

Its best line wins **2 of 6 seeds**, on turns 178 and 256: rush a road at the
nearer spawner from turn 20, keep six hands on the road face, hold **five guns
of two kinds** — the minor pair fed to an evolution — and buy the building crews
back at 50 gold a time.
See "What the simulations found" below.

The harness is a diagnostic, not a benchmark — every rule change since it was
written has cost it win rate until it was re-tuned for the new rule, which is
usually the signal that the rule bites.

## Checking it

`tests/acceptance.mjs` runs every check in `spec/06-acceptance.md` §3 headlessly.
It imports `sim/` only and is a development harness, not part of the game.

```
node tests/acceptance.mjs        # all of it, ~80 seconds
node tests/acceptance.mjs 3.4    # one section
node tests/view.mjs              # the view, against a stub canvas, ~1 second
node tests/play.mjs              # the reference policy over 6 seeds, ~5 minutes
```

A section that throws inside its own fixtures is reported as one failure rather
than killing the run: an unguarded `.find()[0]` used to abort the process and
take every later assertion with it, silently, leaving a short green-looking
report. `tests/view.mjs` exists because `src/view` is otherwise untested and is
the half of the build that breaks quietly — it imports nine symbols out of four
sim modules, so renaming one that nothing in `sim/` uses takes the game down at
module-load time while the acceptance suite stays green. It draws real states
through every branch that decides what is drawn and asserts only that the
drawing happens. `tests/play.mjs` exits non-zero if the reference policy wins
nothing at all (`--min N` for a stricter bar); it used to exit 0 whatever
happened, so a change that made the game unwinnable was invisible.

## Where the build departs from the spec

The spec is the design's word; these are the places the code does something
else, and why. Nothing here is a bug.

### The map is an island, not an inland disc

`spec/02-map.md` puts the base at the centre of a 7651-tile disc with a narrow
water inlet. The build instead makes a **round island with a ragged coast,
ringed by open ocean, with the ship landed on the first tile of the south
beach and the hive across the island on the north shore**. This was a direct
instruction and it changes several derived numbers:

| | spec | build |
|---|---|---|
| grid | radius 50 around the base | radius 45 around the island's centre |
| land | 7651 tiles | 3,732–3,957 tiles |
| base | map centre | south shore, water beside it |
| hive | ring 44, bearing furthest from the corridor | across the island, 66–73 from the ship |
| shell spawner | ring 44, opposite the hive | flanking, 50–60 from the ship |
| the landing | corridor 3×10 cut, apron cleared round the ship | a beach the ship fits on, walled by cliff |
| roads | corridor and apron laid at generation | **none anywhere**; every road tile is one you cut |
| beach | — | the landing cove and 3–5 more on the rim, not the whole shoreline |
| salt water | the landing inlet | open ocean, plus one or two bays or straits cut into the island |

`ISLAND_RADIUS` (36) is the one knob. It is set where it is because it fixes
two spec numbers at once: a mass crosses to the road inside the **17–27 turns**
the design runs on (mean 22.5 over eight seeds), and the island's timber and
stone covers the **5465** build-out bill with room to spare. Raising it
lengthens the approach; lowering it starves the economy — dropping it from 33
to 28 once halved the win rate, which is why it went up rather than down.

The surplus is no longer inside the spec's 0–25% band: it measures **~52%**.
The band was written against a 4825 bill on a smaller island whose wrecks were
half unreachable; footprints have doubled since, the bill is 5465, and the
harness deliberately no longer enforces the band. What it enforces is that the
build-out is payable at all, and that paying for it does not strip the island.

### The landing is a cove, and nothing on the island is cut for you

The spec opens the run with ground already cleared: a corridor 3 wide and 10
long, and an apron round the ship. The build lays **no road at all**. What the
generator gives you is a place to stand and a shape to fight in:

- **A beach the ship fits on.** The ship's own 7 tiles are sand, plus the strip
  of shore between it and the water (`LANDING_BEACH_SPAN`, `LANDING_BEACH_DEPTH`)
  — 7 to 29 tiles across 50 seeds. It stays on the *seaward* side
  (`LANDING_BEACH_ARC`): sand can never be cut, so beach laid across the landward
  face would wall the ship in against its own road for good. The generator also
  guarantees at least `LANDING_EXITS_MIN` cuttable faces on the footprint, and
  rerolls the island if it cannot.
- **A broken wall of cliff round the land side** (`LANDING_CLIFF_*`), 8 tiles
  out, outside the fresh water's keep-out so the guns keep their arcs. 50–82% of
  the landward ring is cliff. A mass cannot climb cliff, so every approach
  funnels through a gap, and there are **`LANDING_ENTRANCES` of them — 2 to 3**,
  never one: one way in is a corridor, two is a choice about where to stand. One
  gap always sits on the corridor bearing, so the way inland is never sealed.
  The gaps are cut as bearings before the ground is settled and walked again
  once it is: a stream spoke or a boulder field that has silted one up is dug
  back open along the radial line, and an island that still cannot offer two is
  rejected. Measured over 50 seeds the wall ends up with 2–4 doorways.
- **The corridor as a bearing, not a road.** `corridorBearing` and
  `corridorMouth` still exist; they aim the cliff gap and the canopy stand, and
  nothing along them is cleared.

Two consequences worth knowing. First, the crew starts with only the faces the
ship's own footprint touches — 9 on the reference seed, not the ten hands' worth
the apron used to hand over. Second, with no road built, a mass has nothing to
enter but the ship itself: contact happens *on* the hull and the whole fight is
at point-blank. Cutting a road out to one of the cliff gaps is what buys back a
kill zone, which is the point — the shape of the defence is now a decision
rather than a starting condition. `SHIP_DPS` was recalibrated 21 → 25 for the
lost stand-off; see **Calibrated values**.

### An economic building is a yard on the road

Three rules, all of them build-only, and all three about where the economy is
allowed to sit rather than what it costs:

1. **Footprints are roughly double the spec's** — a Sappers' Camp is 6 tiles, a
   Warehouse 5, the smallest 3. The point is the cove: open every tile the
   landing's cliff wall encloses and it still takes only **5–7 of the 9**
   non-repeatable yards (it was 6–7 before the ship kept her own gap). The rest have to be built out through a gap and held
   where they stand, so the economy is exposed ground rather than something you
   tuck in behind the wall.
2. **It needs road beside it, joined to the ship.** Membership of the ship's
   road network, not merely a road tile — a patch cut in the field draws no
   supply, the same rule the enemy's approach already uses.
3. **It may not touch another economic building, or the ship** (`BUILDING_GAP`,
   1 tile). Any tile will do for the gap: road, forest, a stream. This is checked
   while the footprint grows rather than after it, so the placement outline shows
   you the legal shape as you move the cursor.

   The ship counts as a yard here because she behaves like one: the biggest plot
   on the island, the root of the road network, and the thing every building
   crowds towards. Without her gap the first Workshop went up against her hull
   and the cove silted up around her — and a wave that reaches the beach is then
   in among the whole economy at once. The refusal names her: *leave 1 tile clear
   of the ship*.

4. **It may not stand on ground the queue has already taken.** A queued building
   is not on the map — nothing occupies its tiles and it casts no halo — so the
   placement ghost drew a second yard green straight over the first one's
   footprint, and both orders were legal until the turn ran and the second was
   refused for ground the first had just taken. `queuedPlots` folds the queue
   into the halo, into `buildingPlan`'s per-tile verdict, into `canBuildTower`
   ("a building is queued there"), and into the non-repeatable check, which now
   says *already in the queue* rather than letting you order two Workshops.

   It is safe for `build.js` to read `state.orders` directly because `applyQueue`
   empties the queue before it applies anything, so a building never blocks
   itself.

The **Palisade is exempt from both 2 and 3** — it is one tile of ground the enemy
will not cross, and a wall that needed a road beside it and could not touch its
neighbour would not be a wall. It may still be laid against the hull.

`tests/play.mjs` had to learn a new habit for this: it used to wait for a legal
spot to appear along whatever the crew happened to cut, which works when a
building is 2–3 tiles and does not when it is 5–6. It now **clears a yard**
beside the road for the building it wants. Without that it won 0 of 6 seeds;
with it, 3 of 6 — the same as before the change.

### A building has one shape

`footprintAt` used to *grow* a footprint: the anchor, then whichever neighbours
happened to be buildable, until it had enough tiles. So the same Forge was a
different silhouette on every plot and changed under the cursor as you moved it.
That is fine for a prototype drawing grey squares and wrong for anything that
will later have a picture.

Each building now has **one fixed shape** (`C.BUILDING_SHAPES`, by tile count):
the anchor plus its neighbours in ring order, so every shape is compact, every
tile of it touches the anchor, and the anchor is the tile you clicked. A plot
either takes the whole shape or the placement is refused — `its 6 tiles will not
fit here — 3 short` — and the outline keeps its shape and turns red rather than
quietly reshaping around the obstacle. `buildingPlan()` returns that shape with a
per-tile verdict, and it is the single thing the preview, the check and the build
all read, so what goes down is always what was shown. `footprintAt` — the
greedy grower — is gone; `footprintPreview` is now a two-line dispatch onto
`buildingPlan` or `towerPlan`.

| tiles | shape |
|---:|---|
| 1 | the tile |
| 3 | anchor + 2 petals |
| 4 | anchor + 3 |
| 5 | anchor + 4 |
| 6 | anchor + 5 |
| 7 | the full hex flower |

Both harnesses had to learn it: they used to wait for a legal blob to appear and
now cut the shape's own tiles (`clearPad` in `tests/play.mjs`, `padFor` in
`tests/acceptance.mjs`). That turned out to be *more* efficient than the greedy
growth it replaced — the reference policy went from 2 wins in 6 seeds back to
**3**, because clearing exactly the six tiles a Sappers' Camp needs beats hoping
six of the right ones fall out of a road gang. Towers take the same table: each
gun's yard is one to three tiles, laid as a fixed shape on the tile the player
placed it on.

### A gun's yard belongs to the gun, not to the tier

Footprint used to be a function of tier: one tile to tier 3, two at tier 4, three
once evolved, grown greedily out of whatever neighbours happened to be free. Two
things were wrong with it. The first is that it made a fitting refusable for a
reason the player could not see coming — buy a tier-4 Culverin, walk it to a gun
that has had a yard built up against it since, and the fit is refused for ground.
The second is that a silhouette that changes under you cannot be placed: there
was nothing to draw on the map before the click.

So `tiles` moved onto the tower definition, 1 to 3, out of `BUILDING_SHAPES` like
everything else. The whole shape must be free, cleared and buildable when the
order is taken; after that it never changes, and tiering only moves power and
manning. An evolution consumes the partner's ground and the survivor keeps its
own.

The shapes are small on purpose. A gun is a thing you put on a corner of a lane,
and a battery of them should read as a line of guns rather than as a compound —
so no tower needs the gap rule that keeps yards apart, and two may stand
shoulder to shoulder.

### A Bunkhouse is placed for its reach, so the reach is on the cursor

A Bunkhouse takes a hand off every yard within `BUNKHOUSE_RADIUS`, which makes
*where* it goes the whole decision — and nothing on screen said where that was
until it was already standing. The placement outline now carries the reach.

Not a circle on the anchor: `handsNeededFor` asks whether **any** tile of a yard
is within the radius of **any** tile of the Bunkhouse, so a three-tile Bunkhouse
covers a longer blob than a ring drawn on its middle — 48 hexes against 37, and
a circle would have called yards out of reach that the rule takes in.
`coverageOf` builds the real union and the map shades it; `coveredBuildings`
rings the yards inside it and the label counts them, because "covers 2 yards" is
the thing actually being decided. The acceptance suite walks every legal anchor
around a Forge and checks the outline's promise against what standing a real
Bunkhouse there does to that Forge's crew.

### Which fitting to spend is the player's call

A tower is built at the tier of the fitting it takes, and the **lowest** held was
always the one spent — deliberately, because a standing tower rises by having a
better fitting put in, so the tier-1 route reaches the same place for less and
taking the cheapest never costs a tier that could have been had.

That is a good default and it was a bad rule. A tier-4 gun held with nothing
pressing to fit it to is worth more in the ground today than raised at tier 1 and
fitted again next turn, and there was no way to ask for that: the high fitting
was not spendable at all. The Towers panel now shows **a Build button per tier
held**, and the tier rides along with the placement — on the order, on the label
under the cursor, and through the queue's projection, where two towers named at
one tier want two fittings of it. Naming no tier still spends the cheapest.

### The guns are picked off the bar, and placed like a yard

Left-clicking open buildable ground used to open the whole gunnery catalogue.
That put the eight towers behind whatever hex was under the pointer: unreachable
until something had been cleared, and then unavoidable on every cleared tile
whether or not a gun was wanted. **Towers** now sits in the bar beside
**Economy** and works the same way — pick the gun, carry its silhouette over the
map, click. The outline shows the yard green or red per tile and draws the arc
it would cover, cliff bonus included, which is the question actually being
asked. A click on a tile is about that tile again.

The catalogue has no tile to offer, so its rows grey out for price and hold only:
`canOrderAnywhere` is `canEnqueue` minus the site check.

### Rounds, not lines

A tower's power is a rate spent every tick, and drawing it was a one-pixel line
from gun to target for two frames — eight towers pointing at the swarm, with
nothing in the air. Each gun now throws a **round** on its own cadence
(`SHOT_INTERVAL` by the tower's `rate`) at the spot its target stood on when the
trigger went, flying at `PROJECTILE_SPEED` and leaving a ring flash where it
lands, wider for a blast gun. The rounds carry no damage — the arithmetic is
untouched — and they lead nothing and chase nothing, so a target that dies
mid-flight still gets its round.

Every living unit also carries a **health bar** at hex size 8 and up, with a
shield-bearer's plate as its own band above it. A cohort that thins out tells you
the tally afterwards; a rank of bars draining tells you which end of the road is
doing the killing while it is still happening.

**What the fixed yard cost the harness.** Over seeds 20260816–20260821 the
reference policy went from **4 of 6** to **1 of 6** the moment a gun needed its
whole shape open: `towerKind` is the Culverin Battery, two tiles, and beside a
one-tile road there is no second tile. Teaching it to ask per kind and to cut a
gun's yard the way it already cuts a building's (`gunShape`, `clearGunPad`) puts
it back to **2 of 6**. The rest of the gap is the rule biting, not a bug — the
policy still favours the wide kinds, and re-picking `towerKind` for the new shape
rule is tuning nobody has done yet.

### Manning is counted, and the crew upgrade is one hand

Three fixes that belong together, all of them found by playing rather than by
testing:

- **A job has as many places as it has places.** Manning orders are now checked
  against the crew wanted, counting what is queued as well as what is standing
  (`checkAgainstQueue`). A Workshop that wants two hands took three before, one
  order at a time, and the third was silently wasted. Towers are counted the
  same way.
- **The crew upgrade is bought once.** It could be queued eight times over,
  because the check only asked whether the building was *already* upgraded and
  never looked at the queue.
- **The upgrade takes one hand off, not all of them.** `00-constants.md` §9 sells
  it as "run unmanned"; this build makes it **`-1` to the crew wanted**, stacking
  with the Bunkhouse's own `-1`. Two hands normally, one inside a Bunkhouse's
  radius, none for a building that is both — which is the only way to get a yard
  down to nobody, and makes the Bunkhouse worth planning around rather than a
  rounding error. It costs the reference policy a seed (`tests/play.mjs` 3 wins
  in 6 -> 2): the upgrade used to free two hands and now frees one, and the crew
  is the binding constraint on how fast the gun line climbs. Pricing it lower
  does not buy the seed back — at 30 gold it is still 2 — because what is short
  is the hand, not the gold.

### Standing a worker down is not an order

The queue exists to hold back what changes the world, so that any of it can be
taken back before the turn ends. Taking a worker off a job changes nothing out
there: it moves nobody — they go on standing exactly where the job left them —
it costs nothing, and there is no state of the world in which it can fail. So it
is done on the spot, like a trade over the dock's counter, and for the same
reason. `O.standDown(state, assignmentId)`, not an entry in `ORDERS`.

Queued, it was three separate pieces of make-believe: `handFreed` crediting a
hand back to `projectedHands`, a case in `projectedAssignments` that dropped the
row again, and a branch in `projectedCrew` that un-took the body. Each described
a release that had not happened yet, and each was somewhere the panels could
disagree with the resolve about who was free — the first two had already been
bugs once (below). Doing it now deletes all three, and the answer they were
approximating is simply the truth: the body is loose, put them somewhere else
this phase.

One consequence is worth naming, because it looks at first like a loss. Stand
the last hand out of the Workshop and the Workshop stops being manned *now*, so
a craft order queued after it is refused on the spot rather than accepted and
then dropped by the resolve — which is what used to happen, since `applyQueue`
re-checks every order in the order it was given and the release came first. The
panel and the resolve now say the same thing at the same time, which is the
whole point of doing it at once.

**A house is manned from whichever of its tiles you are standing on.** Which
matters here, because the release has to be its own undo — a hand stood down off
a five-tile Workshop is still standing on the Workshop, and manning it again
must not be a walk. `jobPlace` took the structure's anchor tile, which is a
record-keeping detail rather than a doorway, so a body on the far corner was
quoted a walk across ground he was already on. Given the body who is doing the
job, it now answers with the footprint tile he is on, and `assign` asks it again
once it knows which body took the order. He stays where he is, no line is drawn
across the yard to himself, and the crew panel calls him working.

### The bar and the crew panel count the same company

The bar said **1 spare** while the crew panel listed **5 free** — and four of the
five were named against orders in the queue beside it.

An order that asks for "a hand" carries the literal string `hand` as its `who`:
which hand is not decided until the queue runs and each order takes the nearest
body still free. `projectedAssignments` passes that string through, so the
panel's busy set matched no member and every hand the queue was about to take
was also listed as standing about. The bar was right — it works the count out by
subtracting each order's appetite from the idle hands — and it was the only one
of the two that was.

`projectedCrew` already resolves each order to the body that will take it, in
the same order and by the same rule as the resolve; that is how the queue panel
has been naming rows all along. `projectedRoster` folds that answer back into
the roster, and the crew panel and the idle-turn warning now both read it — so
the table and the count come off one list and cannot disagree. A queued row
names its hand, and that hand is not also standing about.

Measured over three seeds and ninety turns: the old computation disagreed with
the bar on **110 of 120** checks, so this was the normal case rather than an
edge one. The acceptance suite now asserts the two agree on every turn of a run.

### A queued plot can be taken back from the ground it is standing on

Two halves of the same oversight, both about the gap between placing a structure
and the turn that raises it.

- **Clicking a queued plot said "road".** Nothing occupies the tiles until the
  queue runs, so the tile panel found bare ground and offered nothing — with the
  yard outlined on that very hex and its order in the panel beside it. Taking it
  back is the only thing anyone wants from a plot they have changed their mind
  about, and with the catalogue moved to the bar a click on the tile was the one
  gesture still pointing at the thing they placed. `queuedStructuresAt` answers
  which order claimed a hex — from **any** tile of the footprint, not just the
  anchor — and the panel leads with it and a Cancel button.
- **The Economy list did not read the queue.** `canBuildBuilding` refused a
  second Forge with "already in the queue" while the list showed a lit Build
  button and a state of `—`. It now counts what is queued alongside what is
  built (`queuedBuildingsOfType`), so a queued yard reads `queued at (-18, 29)`
  and the row greys out with the reason the outline was already giving.

Each building also has **a panel of its own** now (click its tile): what it owns,
its condition, its crew standing and on the way, the upgrade, and the rebuild
button if it is a ruin. The Economy list went back to being a list — what it
offers is Build, and a way into each building's panel.

**A cache bug came out of writing the tests for this.** `roadNetwork`,
`walkableFromBase` and `terrainCensus` cached on a module-level `{seed, version}`
key, which looks equivalent to caching per state and is not: two states of the
same seed — a fixture beside a live run, or two runs side by side — reach the
same version numbers and were handed each other's answers. The caches now hang
off the state.

### A yard can be pulled down; a tower cannot

Towers are **fortifications** — nothing in the resolve ever attacks one. The
swarm goes round. Economic buildings are not: what stands within reach of the
lane gets pulled down.

- **Slots.** A hex has six sides and three attackers can get at a side at once,
  so a free-standing single-tile building can be worked on by **18** at most
  (`ATTACK_SLOTS_PER_SIDE`). A face shared with another tile of the same
  building is inside it and takes nobody, so a 4-tile Forge has 14 exposed faces
  and 42 slots — of which only the faces actually touching the lane ever fill,
  which in practice is three of them.
- **Damage.** A unit deals `BUILDING_DAMAGE_MULT` of its hull damage per second
  while it holds a face, and it stops walking to do it. A yard beside the lane
  is therefore a decoy as well as a loss: the wave that is pulling it down is a
  wave that is not at the hull.
- **Ruin, never rubble.** A building at zero is **ruined**, not destroyed: the
  walls stand, it holds its ground so nothing can be built over it, its crew walk
  out, and everything it did stops (`isBuildingManned` returns false, which is
  the single gate the whole economy already ran through). Rebuilding costs
  `RUIN_REBUILD_FRACTION` — 40% — of building it new, and it stands again at the
  end of the turn like any other build.
- **Toughness** is `BUILDING_HP_PER_TILE` × footprint: 150 a tile, so a 4-tile
  Forge is 600 and nine shells with hold of it take about twenty seconds. It is
  set there so a yard outlasts a wave the guns are working on and does not
  outlast one they are not.

This lands hard on top of the road rule above, and deliberately: a yard must sit
on your supply line, and your supply line is where the enemy walks. Siting the
economy is now a question with a wrong answer. In `tests/play.mjs` the reference
policy went from 3 wins in 6 seeds to **2**; on the seeds that flipped, a yard
sat square on the contact lane and was pulled down eleven and fifty-nine times
over the run. Those runs kept their hull — the yards ate the waves — and lost the
offence's tempo to the rebuild bill instead. The policy now gives up on ground
that has been fought over three times (`b.ruinedCount`), which is the lesson the
mechanic is teaching.

### Bays and straits

Salt water takes one or two bites out of the island (`WATER_FEATURE_COUNT`),
cut before the landmass is settled so anything they sever is tidied away with
the rafts. A **bay** is a wide mouth tapering inland; a **strait** is a narrow
channel that runs deep and stops `STRAIT_STOP_SHORT` of the far shore, so it
divides the ground without cutting the island in two. Both keep
`WATER_FEATURE_OFF_LANDING` degrees clear of the landing bearing — a ship put
ashore inside a bay is a ship with nowhere to go. Salt water cannot be bridged,
so what these place is a permanent detour: the mass walks round, and so does
your road.

### The terrain mix is measured over natural ground

`road` leaves the mix — generation lays none, so every road tile in a live game
is ground the player cleared. The ship's standing, the spawners' mounds and the
beaches are *works* or coastal features. All sit outside the mix, whose
remaining nine terrains are renormalised to 100 (`C.MIX_NATURAL`). Realised mix
is within **0.2 points** of target on 50 consecutive seeds (the harness allows 2).

### The officer roster

Four unique lieutenants sail with the run, and a fifth is found on the island:

| officer | verb | |
|---|---|---|
| Master Pioneer | clears 3 tiles a turn unaided | a job: he has to be sent to cut |
| Weapons Master | items cost 25% less | **passive** — from the roster |
| Master Gunner | mans one tower alone, +50% power | a job: he has to stand in the tower |
| Sapper Captain | leads a sabotage team: 90%, and 2 hands rather than 4 | a job: he has to go with the charges |

Only the Weapons Master works whether or not he is given anything to do, and the
interface says so: `C.officerVerb` marks a passive trade `(passive)` wherever a
verb is shown, rather than the mark being written into the verbs — so the pirate
copy of a passive trade carries it too. The Sapper Captain's used to be two
roster-wide effects, which made a man whose whole trade is going on the mission
worth having without going; both now hang on him leading it.

The Sapper Captain is the fourth because `00-constants.md` §10 already names him
("2 with a Sapper Captain — not in this build"). The other candidates from the
design's roster of 15 are Bosun, Roadwright, Surgeon and Press-Ganger; swapping
him out is a one-line change to `C.OFFICERS`.

The **officer site** yields a random pirate, not a fifth lieutenant: he takes a
random one of those four trades at `PIRATE_QUALITY` 0.55 — two tiles a turn
instead of three, +27% on a gun instead of +50%, no manning a tower alone — and
he leads an assault at the generic **40%**, never a lieutenant's 65% and never
the Sapper Captain's 90%. The design fixes his quality at 0.55 and his assault
rate at 40% but says nothing about how his verb scales; scaling it linearly by
quality is this build's invention.

### Calibrated values

- **`SHIP_DPS` 25**, not the spec's 14. `06-acceptance.md` §3.5 marks it `[cal]`
  and says to move it first, which is what has happened. It sat at 21 while the
  landing came with an apron: a mass entered the player's road five to eleven
  tiles out, and the guns had the walk in to work with. With nothing cleared the
  mass arrives on the ship instead, and at 21 that left wave 1 clean on 2 seeds
  in 10 and the ship dead by turn 49. At 25 wave 1 is clean on all 10 and the
  median death is turn 77. The curve is a cliff, not a slope — 24 gives 5 clean
  and a median of 62 — because at point-blank the wave is either broken before it
  lands or it is not.
- A **keep-out** for fresh water, cliff and stone (`STRUCTURE_KEEPOUT`) around
  the landing. Without it the stream spokes seal the ship in and leave its guns
  no arc, and wave 1 becomes a lottery decided by where the noise happened to
  run. The cove wall stands outside it, at `LANDING_CLIFF_RADIUS`.
- **`FLARE_COST_IRON` 40**, not the spec's 120, and **`FLARE_COST_WOOD` 300**,
  not 250. The iron cut is the experiment under "What the simulations found"
  made permanent: at 120 a real player could fire exactly one flare in 300
  turns, which made the act structure unreachable rather than expensive.
- **`FLARE_COOLDOWN` 10** — a floor of ten turns between boats on top of the
  act gate, with its own refusal line ("the last boat left N turns ago"). The
  act allowance says how many; this says they cannot all arrive at once.
- **`EXCAVATION_GOLD` 220**, matched to `FEATURES.cache.gold`. The two have to
  be equal for the Excavation Camp argument below to be about anything: the
  building and the single hand dig the same chest for the same gold.
- **`HANDS_CAP` 40.** The cap is reachable in principle; what the runs show is
  that nothing in the reference policy ever needs it.

### The two spawners field different armies

`04-economy.md` treats the spawners as one kind of thing. They are not, and the
difference is a design rule that currently lives only in a config comment: the
hive runs **90% grubs**, the shell spawner **45%**, and escalation grows each
unit's hp and armour on a curve — `1 + 0.078 x (stars - 1)²` (`UNIT_DANGER_SCALE`
and `UNIT_DANGER_EXP`, applied in `enemy.js`). Because the exponent is 2, the
first few stars barely move and the last few move a great deal. That is what
makes acts 1 and 2 a game about numbers and act 3 a game about power, and it is
why a gun line sized for wave 4 is not a gun line sized for wave 12.

### The approach model

`03-turn.md` §4 says a mass keeps to its line to the base and enters at the
first road on it, and warns "do not substitute nearest road". The build does
substitute it, on instruction. The rule now is:

1. A mass makes for the **nearest tile of the player's road** — road meaning
   whatever is joined to the ship by road or bridge.
2. **If the ship is nearer than any of that road, it comes straight for the
   ship** and crosses the open ground.
3. **Contact fires on any road tile joined to the ship.** A patch cut out in
   the field draws nothing until it is linked up.

So the shape of cleared ground still decides where the fight happens, but by
proximity rather than by approach line: drive a road out and the contact
follows it out; leave a patch unjoined and it is ignored. Rule 2 is now the
opening state of every run rather than an edge case — the island starts with no
road at all, so until you cut one the ship itself is the only thing a mass can
walk into. Contact fires on the ship's own standing, which is the root of the
road network for exactly this reason.

`tests/acceptance.mjs` §3.4 checks all three: a road behind the ship pulls
nothing, driving a road outward moves the contact from distance 1 to 67, an
unjoined patch at distance 40 is ignored, and a mass with no road to head for
targets the ship.

### Items belong to towers

`04-economy.md` §4 says "items are generic — an item has a tier and nothing
else. Which of the eight towers it becomes is chosen at build time." The build
does the opposite: **every tower takes its own fitting, and they are not
interchangeable**. A Culverin does nothing in a Krakenling Well.

| # | tower | fitting |
|---:|---|---|
| 0 | Swivel Gun Post | Swivel Gun |
| 1 | Culverin Battery | Culverin |
| 2 | Chain-Shot Gallery | Chain-Shot |
| 3 | Dynamite Throwers | Powder Charge |
| 4 | Parrot Swarm Aviary | Parrot Cage |
| 5 | Alligator Guards | Alligator Egg |
| 6 | Krakenling Well | Krakenling Spawn |
| 7 | Monkey Riggers | Monkey Troop |

**The names are invented — the design names no items at all**, for any of the
20 towers. The only item vocabulary in the corpus is v5's, explicitly voided:
eight portable weapons (`culverin, carronade, mortar, chainshot, swivel,
harpoon, firepot, stinkpot`) and four tier adjectives (Salvaged / Refitted /
Master-wrought / Named). The gunnery names above borrow from that list because
it is the same world; the beasts are new.

What the design *does* say, and this build now follows:

- **Only tier-1 items have a price** — "everything above is merged, which keeps
  the shop one line instead of five". 8 gold or 6 iron, a quarter off with the
  Weapons Master. Which of the two a fitting costs is not a choice; see *A
  fitting has one house* below.
- **Two of a kind at the same tier merge into one of the next**, to a ceiling of
  tier 5 (16 tier-1 fittings).
- **A tower needs an item to be built** — the emplacement is 30 wood + 20 stone,
  the gun is a tier-1 fitting out of the hold. `C.TOWER_NEEDS_ITEM` turns this
  off and falls back to `04-economy.md`, where the emplacement is the whole cost.
- Tower-specific is only ever *implied* in the design, never stated: the whole
  corpus talks about "lines" — "the 5-item hold is exactly one tower line", "one
  line climbs to tier 5 inside the hold, two lines break at 14 items bought" —
  which is meaningless unless items belong to towers. Cross-type merging is
  likewise never ruled on; the hold arithmetic silently assumes it cannot
  happen, and this build forbids it.

This makes the item economy a real decision. Gold split across eight kinds buys
nothing that matters, because sixteen tier-1 fittings of *one* kind are what
make a tier-5. When the change first landed the AI player dropped to 0/6 with
every tower stuck at tier 2; making it build a single tower type took it to
7/12. Specialising the gun line is now load-bearing.

### A fitting has one house, and the dock has a counter

`04-economy.md` §4 sells and crafts every item over the same two prices — "8
gold at the ship or a Trading Dock, 6 iron at a Workshop" — which made the two
routes interchangeable and made both available on the beach, before anything at
all was built. This build splits them, and shuts both until a house is standing.

**Each fitting names its `source`, and there is exactly one route to it.**

| crafted at a Workshop, 6 iron | bought off a Peculiar Merchant, 8 gold |
|---|---|
| Swivel Gun · Culverin · Chain-Shot | Powder Charge · Parrot Cage · Alligator Egg · Krakenling Spawn · Monkey Troop |

The line is what the thing *is*. A barrel, a bore and a length of chain are
ironwork, and a crew with a forge and a workshop makes ironwork. Powder,
parrots, alligator eggs, krakenling spawn and a troop of monkeys are not made by
anybody on this ship at any price — they are bought, off somebody peculiar
enough to be selling them on this island. So a Culverin cannot be bought and a
Parrot Cage cannot be crafted, and half the gun catalogue is shut until its
house stands and is manned.

**The Peculiar Merchant** is the new building that opens the other half: 3
tiles, 90 wood + 60 stone, and the only yard on the shelf that runs on **one
hand** rather than two (`crew` in `C.BUILDINGS`, which `handsNeededFor` now
reads for any building that names one). It is deliberately the cheapest real
yard on the list. It gates five of the eight guns, and a gate that costs a fifth
of the company to open is a gate nobody opens in time.

**The Trading Dock gained a counter.** Its standing trade is unchanged — 12 of
the larger of wood and stone into 1 gold, every turn, asking nobody — and beside
it there is now a shop: wood, stone and iron bought and sold to order, in
whatever amount. It is one of the two things the player can do that are **not
orders** (standing a worker down is the other). Goods over a counter are handed
across and paid for on the spot; there is nothing in a trade for a resolve to
carry out, so it costs no turn, takes no body, and never enters the queue.
Because it moves the stores it is the only panel in the game with a **confirm
step**: everything else sits in the queue with an x beside
it until the turn ends, and this moves the stores the instant it is pressed, so
it says what it is about to do in gold and in goods and waits.

| good | the dock pays | the dock asks |
|---|---|---|
| wood | 1 gold / 12 | 2 gold / 12 |
| stone | 1 gold / 12 | 2 gold / 12 |
| iron | 1 gold / 1 | 2 gold / 1 |

Whole gold both ways and rounded against the player — `floor` on a sale, `ceil`
on a purchase — so a handful of wood is refused rather than taken for nothing.
The sell side is `DOCK_INPUT` for `DOCK_GOLD_OUT` exactly, so the counter never
beats the dock's own trade; selling by hand is a matter of timing, not of rate.
What is on the counter is `projectedRes`, not `state.res`: the stores in the bar
are already spent down by everything queued against them, and wood a queued
Workshop is counting on cannot be sold out from under it.

**What it cost.** The change is a real gate, and `tests/play.mjs` measures it.
Over the same six seeds the honest player went **2/6 → 1/6**. The route it
takes changed too, and the counter is what saved it:

| policy | wins |
|---|---|
| before the split — gold buys any fitting, no house | 2/6 |
| the gold shelf (Dynamite + Parrots), Merchant built | 0/6 |
| the same, with the Merchant at 90w 60s and one hand | 0/6 |
| the Culverin line, Workshop built, iron bought over the counter | **1/6** |

The gold shelf loses on range: what kills a run is a lane the guns cannot reach
across, and the Culverin's arc of 4 is the widest on the shelf. But a Culverin
is six iron, and one Forge makes one iron a turn — so on its own the iron line
raises a gun every six turns and is not a line at all. The counter is what makes
it: gold out of the chests, over the counter, back as iron at 2 gold apiece.
That is the shape the split was worth having — the two halves of the economy
now have to be plumbed into each other, rather than gold buying anything on its
own from turn one.

### The canopy shadows what it stands over

`03-turn.md` §5 says canopy blocks line of sight *over* itself. This build adds
a second rule: **nothing on a tile touching a standing canopy tile can be fired
at at all.** The branches close over the ground beside the trunk.

- `canopyShadow(state)` is the set of tiles adjacent to uncleared canopy,
  cached on the map version; `isTargetable` refuses anything in it.
- The map shades those tiles; the hover panel reads
  `targetable   no (under adjacent canopy)`.
- Clearing the canopy lifts the shadow, so a stand near your gun line is a
  clearing job before it is a firing problem.

It is a much bigger constraint than the 2% canopy figure suggests: a stand of
60 canopy tiles shadows ~180 more, so on a typical seed about 5% of the island
is ground your guns cannot cover.

### No "shovels"

`05-ui.md` §4 makes shovels a first-class HUD readout — "hands on shovels ... as
a fraction and as a bar", bolded under the 20% `LABOUR_RESERVE_FLOOR`. That is
gone, along with the constant, which existed only to colour it.

There are no separate instruments in this game: a body is a body, and you put it
wherever it is wanted. The count of who is currently cutting ground survives as
`crewClearing(state)`, because the AI still reasons about it, but it is not a
class of worker and the interface does not name one.

The HUD no longer carries hands either — the crew is one click away and the
button carries the number. The bar is now turn, act, resources / hull, power,
items, seed / the island census; the action bar reads `Crew 14` with `3 spare`
beside it, red when nothing is spare.

### A clear order is one tile

`01-architecture.md` says a clear assignment "consumes tiles outward from its
anchor by nearest-first ... and persists until the region is exhausted". This
build does not: **an order is the tile you gave it and nothing else.** The
worker cuts it and is then free for the next order. They never wander into
ground nobody asked for, and the tile stops being highlighted the moment the job
is done. A clear order on ground that is not clearable is refused outright,
rather than being read as an anchor to work outward from.

The cost is that clearing is now given every turn rather than set once.
`putCrewOnFrontier` in `tests/route.mjs` is what both harnesses use to refill the
frontier each turn.

### The crew stand somewhere

Every body in the company is a real thing on the map with a position, drawn as a
dot: bone for a hand, blue and a shade larger for an officer. They come ashore
spread over the landing, **at most `C.CREW_PER_TILE` (5) to a tile**, so ten
hands and four officers occupy three hexes rather than stacking on the ship.
Fresh hands off a flare land the same way, and the pirate found on the island
joins where he is saved.

Hands are named. `C.HAND_NAMES` is a list of pirate names, drawn without repeats
from the run's own RNG, so the crew list reads as people rather than `h7`.

Because they stand somewhere, `04-economy.md` §3's redeployment ladder means
something again and is back as `C.TRAVEL` — with its first rung halved: **a walk
of 5 or less costs no turn of its own, up to 25 costs one, beyond that two.**

The spec puts that first rung at 10, the whole of a turn's march
(`C.CREW_TILES_PER_TURN`), and that was too generous once the route was measured
over ground the crew actually walk rather than the straight line: the panel
quoted a hand ten tiles out as *0 turns, work starts this turn* — a full turn's
walking and a full turn's cutting inside one turn. The arrival turn is still a
working turn, so the last leg is still free; it just has to be a short leg.
Anything more than half a turn's walk still standing between a worker and the
job is a leg of its own, and the work starts next turn.

What is measured is the route they would actually walk, not the straight line —
see below. The walk starts from where the worker actually is, and the interface
quotes it at every button — "standing on it — work starts this turn", "6 tiles
away — 1 turn walking before the work". Giving a job picks the nearest spare
body, so a crew chewing along a frontier keeps cutting instead of marching.

**"Working" means standing on it.** Every panel used to word a worker's state
from `arrived`, and `arrived` is a statement about the coming resolve rather
than about now: it goes true on the turn the walk *finishes*, because
`runMovement` runs before the labour and the arrival turn is a working turn. Read
as a label that was a lie for exactly one turn — the dots plainly strung out
along the route, and the tile panel, the crew list and the turn report all saying
*working*. `taskState` asks the honest question instead, which is where the body
is standing: **working** on the job's own tile, **travelling — arrives this
turn** on the last leg, **travelling — arrives turn n** before that. The turn
report's "n at work · n on the way" split is counted the same way.

Two rules make that work:

- **Movement resolves before work.** The resolve is now `applyQueue`,
  `runMovement`, then the labour — so a worker whose walk finishes this turn puts
  in a turn's work on arrival rather than losing it.
- **A walk of more than a turn is walked, not waited out.** `runMovement` steps
  a traveller along the route to the job each turn, cutting it into `turns + 1`
  equal legs — so a k-turn march shows k evenly spaced positions on the way
  rather than holding them at the start and teleporting them at the end, and the
  last leg is the one that shares its turn with the work. The assignment carries
  `from` and `leftOn` for exactly this; a redeployment mid-walk restarts from
  wherever they have got to.
- **They walk their own ground, not the straight line.** The route used to be
  `line(from, to)` — drawn over whatever was in the way, so a hand crossed
  standing forest as if it were road, and the walk was priced by the crow's
  flight. `crewRoute` is an A* over the ground the crew keep to: cleared tiles,
  the road in them, bridges, beach and salt flat, a step apiece. That route is
  what the dots follow and what `C.TRAVEL` is fed, so a job on the far side of a
  wood is priced as the walk round it.

  Standing wood and rock, fresh water, cliff and the sea are not walked at all.
  They used to be forceable at a price — `CREW_PUSH_COST`, 6 — so that a body cut
  off behind an unopened face could still come home, and if even that left no
  route the walk fell back to the straight line. Both escapes bought worse than
  they sold, and are gone; see **A walk is a walk or it is nothing** below.

  Three things are walked that the terrain alone would refuse. **Their own works**
  — the ship, a workshop, a tower on its cliff — because they built them, and a
  tower nobody could reach is a tower nobody can man; `canBuildTower` now holds
  the other end of that, and refuses a crag with no reachable neighbour. **A tile one of the crew is
  standing on**, whatever it is made of, on the same principle as the reach rule:
  he is on it, so the way past him is past him rather than round the whole stand.
  And nothing walks through a **Palisade** (`blocksCrew` on its def): it is a wall
  from both sides, which is what makes a line of them a decision about ground
  rather than a free fence. A spawner's own tiles are nobody's shortcut either.

  `pickNearest` routes every candidate rather than shortlisting the five nearest
  as the crow flies. The shortlist was safe while standing ground could be
  forced — everybody could reach everything and only the price differed. Now
  that the crew keep to open ground, all five of the nearest can be on the wrong
  side of a wood and the body who can actually walk it is the sixth.
- **The queue is a register of who goes where.** Two orders that both ask for
  "a hand" are two different hands: the queue is applied in order and each order
  takes the nearest body still free, so the second cannot have the one the first
  took. `projectedCrew(state)` walks the queue with that same rule and returns
  the allocation, which is what the assign panel quotes and what the queue rows
  name — `clear forest (-15,36) — Spare Parts Finn`.

  Until it existed, the panel chose from whoever was idle *at that instant*. Put
  one hand near the work and the rest back at the ship, open two tiles beside
  each other, and both were quoted the near hand's walk — "1 tile away, work
  starts this turn", twice — while the resolve sent the near hand to one and
  somebody from the ship to the other. The count in the row was already
  projected (`3 idle`, then `2 idle`); only the body was not. Now the first tile
  reads *1 tile away* and the second *3 tiles away*, because that is who walks it.
- **The labour officer's faces are one trip, on one kind of ground.** The Master
  Pioneer's three tiles are a batch: the first costs him the walk and the other
  two cost nothing, shown as "free — the same trip". They have to touch a tile he
  is already going to, and they have to be the same terrain as it. Mixing was the
  hole: scrub is one turn of work and forest is three, so a batch of two trees
  and a shrub handed him the shrub on the back of the trees, and the cheap tile
  came free at the expensive tile's rate. Now he works forest with forest and
  scrub with scrub, and the refusal says which ground he is on. While one of his
  tiles is queued and he has faces spare, every tile he could add **glows** on
  the map — and only the ones he could actually take.

  It costs him real throughput, which is the point: on `tests/play.mjs` the
  reference policy goes from 3 wins in 6 seeds to **2**, after teaching it to
  pick a first face with enough of its own ground beside it to fill the batch
  (starting on a lone tile of forest in the scrub wastes two thirds of him).

  **A batch is one body, and the register has to say so.** `projectedCrew` walks
  the queue reserving a worker per order, and an officer is spoken for the moment
  his first face is queued — so it had nobody left to hand the other two to and
  left them unassigned. That showed as a nameless row in the queue panel and was
  ignorable while the reach only cared about where bodies already stood. It
  stopped being ignorable when the reach started asking *who is going where*: a
  face with no worker holds no ground, so the third tile of a line the Pioneer
  was plainly about to cut answered "no way to walk there". His extra faces are
  now mapped back to him, which is what they always were.

  It only bites on a line. A batch clustered around one tile has every face
  touching ground the crew can already reach, so the missing worker cost
  nothing; a line runs away from the ship and the third tile touches only the
  second.

  **The faces are also cut in step.** Work is banked on the tile rather than on
  the worker, so a face joining a batch used to start from whatever was already
  on it — nothing on untouched ground, a turn or two on ground some hand had
  been at. Fill two faces this turn and the third the next, which is exactly
  what the glow invites, and the tile added second came free two turns after the
  other two: one trip, one rate, three separate clearings. A joining face now
  takes up the work already done on the rest of the batch, so they finish
  together and no tile ever loses work somebody has done.

An assignment row still exists only while its worker has a job. When the job
ends the row goes and the worker is idle *where the work left them*, which is
where their next walk starts from.

**Ending the turn with anyone standing about opens a confirmation first.** It
names the idle officers and lists the idle hands, and takes "End the turn
anyway" or "Go back". Nothing in the spec asks for this; an idle turn is the one
mistake in this game that costs something and leaves no trace, so it is the one
thing worth interrupting for. It replaced a `noSpare` event that warned on the
opposite condition — that *nothing* was spare — and only after the turn had run.

### The stores live in the bar, and they are already spent

The queue panel used to restate the run's resources under its rows — `left to
spend`, `idle hands`, and a second line for what the queued work would earn once
it was done. Three numbers about the queue, in the one place a player is not
looking when they decide whether they can afford a Forge: the decision is made
against the bar at the top of the screen, and the bar was showing raw
`state.res`, which the queue had already spoken for.

So the bar shows the projection instead, and the panel is the orders:

```
wood 218 (+57)  stone 0  iron 0  gold 220
```

- `projectedRes` — costs only, and it is what the bar prints. This is what gates
  further orders, and it must stay costs-only: `applyQueue` runs before
  `runLabour`, so a tower queued behind a clear order cannot be paid for out of
  that tile's timber, and counting the timber would only earn a refusal at the
  resolve. Queue a building and the wood goes now.
- `incomeNextTurn` — the `(+n)`. What the **coming resolve** pays out, which is
  a narrower question than the old second line asked: a forest face queued this
  turn is three turns of cutting away, and quoting its timber as though it were
  arriving made the bar read like money in hand. It counts the faces whose last
  turn of work falls on this pass — walk over, batch levelled — and the wrecks
  and chests somebody is already standing on.

  It reads the queue through `projectedAssignments`, not the raw assignment
  list, because a face somebody is two turns into pays nothing if the queue has
  already pulled them off it. It is a forecast and it can be a tile out, in the
  cases where the resolve's `nearestIdle` picks a different body than the
  panel's `pickNearest` shortlist did; across three full runs it agreed with the
  resolve on 97-99% of turns.

`projectedAfterWork` — costs paid and every queued tile, wreck and chest brought
in, whenever it lands — is still there for anything that wants the eventual
total rather than the next payment.

The bar is four boxes on one line, ruled apart and spread evenly across the
window: **where the run is** (turn, act), **what it can spend** (the four
stores), **what it is made of** (hull, power, items), **what it is standing on**
(seed, island).

The terrain census used to be a line of its own, and it is the only thing here
that grows with the map — nine swatches on a fresh island, more as ground is cut
— so it was the thing pushing the turn counter about. It hangs under the island
box now and is shown on hover, as an aligned two-column list. That is the right
weight for it: it is reference, not a number anyone plays off turn to turn.

The buttons are the **last** thing in the column, so they sit on the bottom of
the screen and never move — they are what the player reaches for every turn.

The event feed moved out of the band it used to hold under them and onto the
map's left edge: absolutely positioned, bottom-anchored, and mostly transparent,
so the ground still reads underneath. It is `pointer-events: none`, which is
what makes that honest — the 340px strip it covers is still map you can click,
and the feed writes newest-last and clips off the top, so nobody ever needs to
reach for it. Between the two, the map gained about 150px of height.

### Every building has its own price, and every turn has a report

Two small departures from the spec's uniformity.

`00-constants.md` §9 prices all ten economic buildings at **120 wood + 80
stone** and gives them all the same small footprint. This build charges each for
what it does — the Sappers' Camp is the only route to a win at 380+260, a
Bunkhouse is an enabler nobody should ration at 50+40 — and makes each one a
yard rather than a hut. With the Peculiar Merchant (below) the shelf is eleven,
and they sum to **1490 wood and 1000 stone** against the flat price's 1320 and
880, which puts 06-acceptance.md §3.3's build-out bill at **5655** against the
5025 the spec's own flat price would give for eleven — inside the harness's ±15%
band rather than identical to it. The harness sums the shelf rather than
multiplying one price, and restates the spec's anchor from the shelf's length,
so adding a building moves neither silently.

| building | tiles | cost | | building | tiles | cost |
|---|---:|---|---|---|---:|---|
| Sappers' Camp | 6 | 380w 260s | | Forge | 4 | 110w 70s |
| Warehouse | 5 | 150w 100s | | Powder Store | 3 | 100w 70s |
| Workshop | 5 | 150w 100s | | Excavation Camp | 4 | 100w 60s |
| Trading Dock | 5 | 140w 90s | | Peculiar Merchant | 3 | 90w 60s |
| Tinker's Shed | 4 | 130w 90s | | Hospital | 3 | 90w 60s |
| | | | | Bunkhouse | 3 | 50w 40s |

(The Palisade is a twelfth building and not one of the eleven: 1 tile, 45w 30s,
and no part of the economy. It was 140w 90s — dearer than a Bunkhouse for one
tile of wall, which priced the first one out rather than the tenth.)

**Every resolve now ends with a modal**, not only the eventful ones. A quiet
turn says so — "a quiet turn — nothing came of it" — and then reports what is
under way: how many are at work, how many are walking, how many are standing
about, and how many masses are on the move. A turn where nothing happens is
still information, and it used to pass in silence.

Unless the player has asked not to be shown any of it. **`skip` is the third of
the resolve reel's speed settings**, beside 1x and 3x, and is set the same way:
chosen, a turn resolves with no panes, no walk and no report, and the next
player phase begins at once. It used to be a fourth kind of control, one that
could only be pressed while a reel was already running — which is to say it was
greyed out at every moment a player might decide they had seen enough of these.
The decision is about resolves in general, so it belongs among the settings. The
end of the run is the one modal it does not suppress: there is no next phase to
get on with, and how it went is the only thing left to say. `Esc` still abandons
the reel in front of you without touching the setting.

### A point of interest is a job of its own

The spec pays a shipwreck out as a side effect of clearing its tile. That is a
bug on this map, because a wreck generated on **sand** sits on ground that can
never be cleared, so a wreck on a typical seed was sometimes unreachable
for the whole run.

So the payout is its own order. Each point of interest has a verb, in
`C.FEATURES[kind].action`:

| feature | action | what it gives |
|---|---|---|
| shipwreck | search | 60 wood, 30 iron, 10 gold |
| treasure cache | dig up | 220 gold |
| officer site | save | the fifth officer joins |
| freshwater spring | *(held, not worked)* | +3 hands cap while someone stands on it |

The job is available **once there is nothing left to cut on the tile** — so a
chest under forest is two turns, one to clear and one to dig, and a wreck on
sand is workable from turn one. Clearing no longer pays a feature out, and
shift-click puts a hand on whichever of the two the tile currently wants.

**A finished one leaves the map.** The marker used to stay and turn grey, which
made the map read as a list of everything that had ever been there rather than
of the work still outstanding — twelve chests' worth of grey diamonds to look
past by the late game. Now a dug chest, a searched wreck and a saved castaway
simply go, at both zoom levels (the live pass and the baked ground). The tile
panel still names it — `treasure cache (worked)` — for anyone who wonders what
happened there. The spring is not one of these and never goes: it has no action
to finish, and pays while a hand stands on it.

`04-economy.md` §3 lists what a hand can be doing: "clearing, manning a tower,
manning a building, on an assault, or idle". This build adds two more kinds,
`feature` and `garrison` — working a point of interest, and holding the spring.

**This makes the Excavation Camp dead content.** `04-economy.md` gives caches to
that building — 4 tiles in this build, 100 wood and 60 stone, a crew to man it and 10 turns for
the same 220 gold a single hand now digs in one. The two compete for the same 12
caches and the hand wins every time. The camp is left in place rather than
deleted, because which one survives is a design call: gate hand-digging behind
the camp, pay the hand less than the camp, or drop the camp.

### Terrain properties that differ from the table

`00-constants.md` §3 gives one table with one `passable` column. This build
keeps every value in it and adds two, so the table it renders from is not the
one in the spec:

| terrain | property | spec | build | why |
|---|---|---|---|---|
| *all* | `assaultPassable` | — | new flag | the resolve asks a different question from the march |
| `scrub` | `assaultPassable` | — | **no** | thin enough to march through, not to charge into |
| *all* | crew passability | — | `WORK_OPEN_TERRAIN` | a worker cuts their way in; a mass does not |
| `sand` | crew passability | — | **yes** | you landed on it, and a wreck on sand is uncuttable |
| `salt` | crew passability | — | **yes** | walkable and uncuttable, exactly like the beach |
| `tar` | `passable` | unspecified | **no** | a mass will not march into it |
| `tar` | `assaultPassable` | unspecified | **yes** | a swarm already in contact wades across |
| `tar` | `advance` | unspecified | **5.0**, i.e. `0.20x` | five times slower than road; the heaviest ground anything crosses |
| `canopy` | yield | same as forest | **12 wood**, +33% | old timber pays more than young; felling it is worth doing for the wood, not only to lift its shadow |
| `scrub` | clearing time | `TURNS_PER_TILE` | **1 turn** (`turns` on the terrain) | it is a third of forest's wood, so it is a third of the work |
| `iron` | *the whole terrain* | absent | **new**, 2% of the mix | a seam you can dig instead of smelting for it |

**There is an eleventh terrain the spec does not have: `iron`.** Two points of
the natural mix, carved out of forest and scrub, cleared like a boulder — three
turns, impassable to a mass until it is cut — and it pays **10 iron** a tile.
It matters more than 2% suggests, because iron is otherwise the scarcest thing
in the game: one Forge makes 1 a turn, and a flare wants 40. A seam inside the
road you were going to cut anyway is most of a flare. It is also why the natural
mix renormalises over nine terrains rather than eight.


Clearing time is per-terrain now (`C.turnsToClear`), not one global number.
Scrub at one turn keeps the wood per worker per turn identical to forest's — 3
wood a turn either way — so it changes no economy total. What it changes is
tempo: a road driven through scrub reaches three times as far for the same
labour, which turns the thin ground from something to avoid into something to
route along. The canopy's +33% works the other way round: same three turns, more
wood, so the stand that was worth cutting only for line of sight now pays for
itself as timber.

The spec gives `tar` no properties at all — §3 says it "exists in the terrain
enum for completeness but does not appear on island 1", and the generator still
never places it. Everything above is a mechanism waiting for a map that uses it.

`03-turn.md` also gives two per-terrain unit effects: `sand` ×0.5 speed and
`salt` ×1.25 damage taken. The salt rule is implemented as written. The sand
rule is **generalised**: every terrain now drags a charging unit by
`1 / advance`, and because `sand.advance` is 2.0 that reproduces ×0.5 exactly
while giving the other ten terrains an answer they did not have. It cost a
hardcoded `SAND_SPEED_MULT` constant and moved the median death turn 76 → 69.

### Names and the action bar

`05-ui.md` §1 draws the action bar as
`[Build] [Buy] [Economy] [Flare] [Assault] [End Turn]`. This build reads
`[Inventory] [Economy] [Crew N] [Flare] [Bug Sabotage mission] [End Turn]`:

| spec | build | why |
|---|---|---|
| `Build` | *(gone)* | it always targeted (0,0); towers are placed by clicking ground |
| `Buy` | `Inventory` | a shop of per-tower fittings, not a list of tiers |
| — | `Crew N` | the HUD no longer carries the hand count, so the button does |
| `Assault` | `Bug Sabotage mission` | a rename, everywhere it faces the player |

The sabotage rename reaches the button, the modal, the result screen, the queue
line, the log and the Sapper Captain's verb. **The code still says assault** —
`scheduleAssault`, `sim/assault.js`, `a.kind === 'assault'` — because renaming
those buys nothing the player can see and touches both harnesses.

### The tile panel names two kinds of passable

`05-ui.md` lists one `passable` row. This build splits it, because the answer is
different depending on who is asking, and conflating them was the source of a
real bug:

```
FOREST
  clearable      yes
  cut            0 / 3 turns of work
  resource       9 wood
  buildable      no

  enemy advance pass (turn-based) yes
  enemy assault pass              yes
  enemy speed                     0.33x

  crew can pass  no
  targetable     no
```

There are **three** passability rows, not one, because three different things
ask the question and they do not have to agree:

- `enemy advance pass (turn-based)` — `C.TERRAIN[...].passable`, the march
  across the island between turns.
- `enemy assault pass` — `C.TERRAIN[...].assaultPassable`, the real-time
  resolve, once a mass is in contact and coming at the hull. `findPath` and
  `roadPath` take a phase and `isPassable(state, tile, phase)` answers it.
  `enemy speed` applies to both.
- `crew can pass` — `isOpenGround`: your own cleared ground, your bridges, the
  beach and the salt flats.

`enemy speed` is one number for both phases, and it is always shown as a
**speed**: road is `1.00x` and anything slower is below it — forest `0.33x`, tar
`0.20x`. `00-constants.md` §3 writes the same quantity the other way up, as an
"advance mult" cost of 3.0 and 5.0, and `C.TERRAIN[...].advance` still stores
the spec's number; `C.enemySpeed` is its reciprocal and is what the panel reads.
One number, one direction, no arithmetic in the player's head.

Applying it to the resolve at all is the deviation. It replaced a
`SAND_SPEED_MULT: 0.5` special case, which was exactly `1 / sand.advance`
written out by hand.

**Tar is the one terrain where the two enemy flags disagree**: a mass will not
march through it on the way in (`passable: false`), but a swarm already in
contact wades across it (`assaultPassable: true`) at 5.0x drag — a fifth of
charging speed, slower than anything else on the map bar fresh water. It is a brake
on the final rush rather than a wall. Nothing generates tar yet, so it is a
mechanism waiting for a map that uses it. Every row describes the tile **as it stands**, never what it could
become: cutting forest turns it to road, and the road answers all seven
differently, so no row hedges about what a tile could turn into. Every value is
a plain yes/no bar two: `buildable` also has `towers only`, which is a present
restriction rather than a future one, and `targetable` has
`no (under adjacent canopy)` — the one answer nothing about the tile itself
explains.

### Work grows from ground you have opened

Nothing in the spec stops a hand being sent to ground it cannot get to. This
build refuses it: **a clear, a garrison or a bridge is only legal on the fringe
of ground the ship can already reach** — the tile itself, or a tile touching it,
because a boulder is cut from the ground beside it.

The load-bearing part is what counts as reachable. **Passability is a rule about
enemy units, not about workers.** A mass walks through forest at a 3.0
multiplier; a hand does not — it cuts its way in. So reach runs over *open*
ground: your cleared tiles, your bridges, the beach and the salt flats
(`C.WORK_OPEN_TERRAIN`).

That distinction is the whole rule. Measured on the reference seed — 3,813 land
tiles, 2,984 of them clearable:

| what counts as reachable | clearable tiles you may work on turn 1 |
|---|---:|
| any passable terrain (forest, scrub included) | 2,482 — effectively no rule at all |
| **cleared ground, bridges, beach and salt** | **9** — the ring around the cove, and nothing else |
| cleared ground and bridges only | 5 — and the wrecks on sand are then unreachable for ever |

The middle row used to read 266. That was measured when sand ringed the whole
island; the landing is a cove now, so what the rule opens on turn 1 is the
handful of faces the ship's own footprint touches. Counting every beach on the
map regardless of whether anything joins it still only gives 300–410 — the
connected cove is what the rule actually uses.

**The beach is open ground**, and that was a deliberate reversal. It plainly is
walkable — you landed on it — and sand can never be cut, so a wreck generated on
sand is unreachable for the whole run under any stricter rule. On a typical seed
that is usually none or one of the three wrecks (12 of 60 over 20 seeds) and
about one of the twelve chests.

Sand no longer rings the island — it is the landing cove and three to five
beaches on the rim, about a fifth to a third of the coastline — so this opens
those stretches from turn one and no more. It buys less than it looks like even
there: **no road will ever run over sand**,
because sand is not clearable, so a beach walk never becomes a supply line and
an assault still needs a road cut inland the hard way. What it opens is the
coastal fringe and everything the sea has washed up on it.

Queued orders extend the reach within the turn, so a chain can be laid out in
one player phase: queue the outer stone of a boulder field and the one behind it
becomes legal immediately, and a queued bridge does the same across fresh water.
Only a tile that will actually be cut open counts — a "clear" order on fresh water
tile does not conjure a crossing, and is refused anyway.

**Reach is where the crew will be when the work starts, not where they are now.**
The resolve walks everybody first and only then sets them to work, so the ground
an order should be checked against is the ground at the end of this turn's
movement. `crewGroundAtResolve` builds it: every tile the crew hold already,
plus the face of any queued job its worker can walk to inside this turn, plus a
bridge queued this turn. `walkableForWork` floods open ground out from that, and
a tile is legal if it is in the flood or touching it.

The second part is a fixed point, and deliberately so. A hand who reaches his
face this turn is standing on it when the work starts, so the man behind him can
walk *past* him to the next face along, and the man behind him past that one. A
gang can be pointed at a line of forest in one phase because the resolve will
walk them there in that order. It costs a route per queued job per pass and the
queue is a handful of orders; it is cheap enough to ask honestly.

What it will not do is run ahead of the bodies. A face nobody reaches this turn
holds nothing, so the reach stops where the crew stop.

This replaced a rule that grew a ring at a time from where bodies actually
stood, and it read as a bug at the table in both directions:

*A worker plainly cutting a face was told there was no way to walk to the tile at
his elbow.* `crewHeld` read the **member's** position, and the member is only
walked onto the job by `runMovement` during the resolve. So between arriving and
the next resolve the panel called him working while the reach still had him at
last turn's waypoint, two tiles back. It reads the assignment now.

*And a hand who would reach his face this turn opened nothing beyond it*, so the
chain could not be laid out even though the resolve would have walked it in
order.

**Where the crew are standing is reach, all of it.** Every body holds the ground
under it, with no test of what that ground is made of — there is no longer any
way to be somewhere illegitimate, because a march follows `crewRoute` and that
keeps to open ground and to what the crew already hold. A waypoint is reach by
another name.

That used to be a real question, and the answer used to be *count nobody in
transit*: the walk forced standing wood where there was no way round, so a body
could be parked in deep forest with nothing open beside it, and counting them
would have let work start along a line nobody had opened. The cost of that
answer was a worker stood down on the face he had been cutting — held by
neither rule, with no ground beside him anybody could reach, and no way to cut
himself out.

**A walk is a walk or it is nothing.** `crewRoute` had two escapes and both sold
worse than they bought. Standing wood and rock could be forced at
`CREW_PUSH_COST`; where even that left no route, the walk fell back to the
straight line. Between them:

- `wayPoint` drew marches over standing forest, so workers were parked in deep
  ground with no open tile beside them — and then quoted as the nearest body for
  jobs they had no business taking, because `pickNearest` priced the push;
- a tower could go up on a crag ringed by trees and a hand would step over them
  to man it, because the straight-line fallback fires exactly when no route
  exists.

Now the crew walk open ground, what they hold, and their own works, and nothing
else. An impossible walk is reported as one — `reachable: false`, cost
`Infinity` — and every caller has to decide what to do about it: `assign`
refuses the job, `wayPoint` leaves the body where it is, the order panel prints
*no way to walk there* on that row. Nothing is sealed in by it, because the tile
a worker stands on is reach: the ground at his elbow can always be queued and he
cuts his own way out.

The one place this bit a rule rather than a bug was towers. A crag is by nature
ringed by ground the crew do not walk, so `canBuildTower` now refuses one with
no reachable neighbour — *open the ground beside it first*. That is the rule the
walk section already claimed: a tower nobody can reach is a tower nobody can man.

`walkableFromBase(state)` is cached on the map version; `walkableForWork(state)`
walks out from that cached set to pick up the crew, uncached because bodies move
without the map changing — it only ever explores the cut-off scraps.
`workableTiles(state)` returns the whole frontier, which is what both harnesses
expand from.

`pickNearest` floods once outward from the job rather than routing in from each
body. The question it answers is "which of these thirty people is nearest to this
one tile", and thirty A* searches are thirty floods of the same ground; one
Dijkstra from the goal answers all of them exactly. The walk is priced by the
ground it *enters*, so reversed, the edge into a tile is paid when the flood
leaves it.

### Bugs found by auditing this document against the code

Everything in this section was found by reading the code against the README and
the harness output, and every one was demonstrated with a script before it was
touched. They are recorded because the *class* of each is likely to recur.

- **A freed hand the queue could not see.** `reassign kind:'idle'` — what both
  "Stand down" buttons emit — declared no `hands`, while `unassign` declared
  `-1`. Standing a worker down therefore freed nobody as far as `projectedHands`
  was concerned: the next clear order was refused "no idle hands" while the
  end-of-turn warning listed that same hand as spare. Two parts of the interface
  disagreeing about one worker.
- **A phantom hand, and an order that vanished.** `unassign` credited `-1`
  unconditionally, so freeing an *officer* added a hand that did not exist.
  `assign()` then returned `null`, and all four `apply` sites ignored the return
  — the order was consumed with no refusal and no log line, and the tile simply
  never got worked. Both fixed by asking whether the body is a hand
  (`handFreed`), and by routing every assignment through `place()`, which says
  so out loud when there is nobody to send. Both of those are moot now: standing
  down is instant and is no longer an order at all, so there is nothing to
  project and nothing to credit (above). `place()` stays.
- **One cache kept the shape the others had already abandoned.** `canopyShadow`
  held a module-level `{seed, version}` cache — exactly what the note above
  `cacheFor` says is wrong, and for exactly the stated reason: two states of the
  same seed reach the same version numbers and were handed each other's shadow,
  so a tower fired at ground still under standing canopy on its own map. Moved
  onto `cacheFor` with the rest.
- **The reach walked over hives and through walls.** `walkableFromBase` flooded
  on terrain alone, and a spawner's mound is sand that reads as cleared — so
  work was offered on ground whose only join was across the enemy's own tiles,
  and behind a sealed palisade. `roadNetwork` had excluded spawner tiles all
  along; the exclusion had simply never reached the walk. Both now go through
  one predicate, `isCrewGround`, shared with the walk itself.
- **The panel promised a walk the sim did not honour.** When travel moved onto
  `crewRoute`, `walkFor` was left measuring `distance` — so the assign modal
  said "10 tiles away — 0 turns, work starts this turn" for a job round the far
  side of a wood that the resolve then billed a turn for. It now measures the
  route, and `nearestIdle` picks the body by route too: the straight line
  shortlists the five nearest and the route decides between them, which keeps
  the choice honest without running a hundred searches for one order.
- **An unbounded search behind a UI call.** `crewRoute` had no expansion cap, so
  a goal nothing joins drained the whole walkable island — 46% of the map, six
  milliseconds — in one frame before falling back. Bounded now, with a cheap
  no-way-in check first, and the fallback is pinned by a test of its own.
- **A cache key that could not see a swap.** The batch-glow key was
  `version|turn|orders.length|assignments.length`; revoking one order and
  queuing another leaves all four untouched, and the glow stayed on the
  abandoned tile. `state.ids` is in the key now — every enqueue draws a fresh
  one.
- **Two orders, one plot.** The same blindness on the other axis: placement read
  `state.buildings` and not the queue, so the ghost drew green over a queued
  footprint and two orders claimed one piece of ground. Everything that asks
  "may a structure stand here" now reads the queue too.
- **Two orders, one hand, two promises.** The assign panel picked the body from
  whoever was idle right then, ignoring what the queue had already spoken for,
  so every tile you opened in a phase was quoted the same nearest hand and the
  same walk — and the resolve, which allocates in queue order, sent somebody
  else. Fixed by making the allocation explicit and shared (`projectedCrew`);
  the queue now names the body on each row. The test for it stacks the crew on
  one tile so the old rule would name one man three times, and checks the names
  against what `applyQueue` actually does.
- **The castaway did not join where he was saved,** though this document had
  said so for a long time. `recruitPirate` called `landCrew` without a `from`,
  which defaults to the ship: the officer site could be 37 tiles away and the
  pirate appeared 1 tile from the hull. The doc was right and the code was
  wrong, so the code moved.

Five assertions in the acceptance suite were also found to be passing for the
wrong reason — two whose fixtures cut no ground at all (one of them trying to
clear open sea), two that asserted arithmetic identities rather than anything
the sim does, and one of mine that the straight-line fallback satisfied exactly.
Six recently added rules turned out to be pinned by nothing. All are fixed or
pinned now, and each new pin was checked by breaking the rule and watching it
fail.

### Rules the spec left ambiguous

- **Armour** subtracts per second, not per 30 Hz tick: `max(power - armour, 1)`,
  then divided by the tick rate. Read literally, a floor of 1 applied to a
  `power/30` tick would make armour *increase* damage taken.
- **A tier-1 tower carries no item.** Fitting the first item displaces nothing;
  otherwise a tower would be a 30-wood item printer.

## What the simulations found

Six full 300-turn runs with the AI player, on the current numbers:

| | |
|---|---|
| win rate | **2 / 6** — both spawners dead |
| winning turns | 178 and 256 |
| losing turns | 115–232, **all four `lost:hull`** — the ship is broken open, not out-waited |

That sits inside the design's stated 25–40% campaign band. It did not always:
the table here used to read 10 of 12 on turns 51–113, with both losses turtled
to turn 300 with the hull intact. That was measured before the island grew from
radius 32 to 36, before footprints doubled, before the crew had to walk their
own ground rather than the straight line, and before the labour officer's batch
was restricted to one kind of terrain. Every one of those changes cost the
reference policy seeds, and the losing mode changed with them: nothing turtles
now, because a policy that does not get out and kill something is broken open
long before turn 300.

The one number the sweep still cares about is **`maxTowers`**, now **5**, with
`mateShare: 2` — five towers of two kinds, the two of the minor kind fed to an
evolution. It was 2 when the gun line was cheaper and the waves were thinner;
act 3 cannot be held by two guns.

Three findings worth the designer's attention:

**1 · Hands never grow, and it does not matter.** A Forge ordered on turn 17
and manned all run produces **136 iron in 300 turns** — one flare, on turn 144.
Six flares want 240. So the crew goes 10 → 15 late, never 15 → 25 → 40, and the
act structure never happens. But cutting the flare's iron cost to 40, which
makes three flares reachable, changed the win rate **not at all** (5/12 either
way): the rush wins before the crew economy matters. The iron price does not
block winning — it blocks the game the acts describe. That cut is now the
shipped value; the bullet under "Known calibration problems" that still called
it 120 has been corrected.

**2 · A smaller island is harder, not easier.** Dropping `ISLAND_RADIUS` from 33
to 28 halved the win rate, 5/12 → 2/12 (measured when the radius was 33; it is
36 now, for this reason). The shorter road helps the enemy as
much as the player, and the smaller island earns less. Island size is not a
difficulty dial in the direction you would guess.

**3 · Sand and salt are permanent walls to a road, but not to a worker.**
Neither can ever be cleared, so neither can ever become road. Your crew walk
both freely — that is what `WORK_OPEN_TERRAIN` says — so a beach is a highway
for labour and a dead end for a supply line at the same time. A flat lying
across the approach to a spawner cannot be bridged or dug and forces a detour,
and since a sabotage mission needs a *continuous* road, it can rule out a whole
bearing. This is emergent rather than stated, and it is a good property, but
nothing in the UI tells the player why their road will not connect.

### Known calibration problems, not yet fixed

- **Flare iron is tight, and no longer unreachable.** This bullet used to say a
  flare cost 120 iron and a player could fire one. The experiment two sections
  up shipped: `FLARE_COST_IRON` is **40**, so the 136 iron a manned Forge makes
  by turn 300 buys three of the six the acts are built around — and the seam
  terrain (below) can be dug for more. The economy harness still grants the iron
  so the wood-and-stone calibration can be measured on its own.
- **The Forge and Trading Dock have no throttle.** Once manned they consume
  3 stone and 12 wood-or-stone every turn, for ever. Building a Dock early
  drains a run.

## Conventions

- ES modules, no bundler, no transpiler, no npm.
- `sim/` is pure: no DOM, no canvas, no `Math.random`, no `Date.now`. It is a
  deterministic function of `(state, seed, orders)`.
- `view/` reads sim state and draws. It never writes to it; it emits orders.
- All randomness goes through the seeded RNG in `sim/rng.js`. The seed is shown
  in the HUD and settable from the URL (`?seed=12345`).
- Units: distances in tiles, time in turns for the strategic clock and in
  seconds for the resolve clock. Never mix the two.
