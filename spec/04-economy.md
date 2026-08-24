# 04 · Economy, towers and crew

## §1 · The four resources

| resource | earned by | spent on |
|---|---|---|
| **wood** | clearing forest, canopy, scrub | tower structures, bridges, buildings, flares, hull repair |
| **stone** | clearing stone tiles | tower structures, buildings, Forge input |
| **iron** | the Forge (3 stone → 1 iron per turn), iron seams | crafting items at a Workshop, flares |
| **gold** | treasure caches (100 each), the Trading Dock, Monkey Riggers kills | buying items at a Peculiar Merchant, unmanning buildings |

**Wood and stone build the emplacement. Iron and gold buy the gun.** A player can
be rich in one and starving in the other; that is intended.

There is no chitin in this build.

## §2 · Hands

- Start at 10, cap 40, +5 per flare (up to 6 flares).
- One hand clears one tile per turn.
- A hand can be: clearing, manning a tower, manning a building, on an assault,
  or idle.
- **Officers are hands with a specialisation.** An officer fills any manning slot
  one-for-one and gives their bonus only in their own role.

The HUD shows **hands on shovels** as a first-class readout, as a fraction and as
a bar. It updates live as the player reassigns.

## §3 · Towers

### Building

A tower is **built at the tier of the fitting it takes**: 30 wood + 20 stone for
the emplacement, plus one fitting of its own kind out of the hold. **Which tier
to spend is the player's choice** — the Towers panel offers a Build button per
tier held, up to the highest. The **lowest** is the default and usually the right
one, since a standing tower rises by having a better fitting put in and so
reaches the same place for less; but a high fitting with nothing pressing to fit
it to is worth more in the ground today than a turn later. Tier decides the
manning; the **footprint belongs to the gun** and is the same at every tier.

A gun is picked off the **Towers** panel in the bar and then placed on the map:
its silhouette follows the cursor, green where the ground will take it, with its
range ring drawn around it. It cannot be built:

- on `sand`, `salt`, `freshwater` (unbridged), `saltwater`, or an occupied tile
- where any tile of its shape is not free, cleared and buildable
- within `EXCLUSION_RADIUS = 7` of a living spawner
- where no tile beside the yard is ground the crew can walk to

`cliff` accepts towers and nothing else, and gives +1 range.

### Rising

A tower rises two ways.

- A **higher-tier item fitted in place**. The displaced item returns to
  inventory. Instant, on the turn the order resolves.
- A **matching item merged into the one already in the gun**: the same rule the
  hold plays by — two of a kind at the same tier make one of the next — with the
  fitted item as one of the two. This is work in the yard rather than a swap: it
  takes `TOWER_MERGE_TURNS` (3) turns, the item leaves the hold when the work
  starts, and **the gun goes on firing at the tier it has** until the last turn,
  when the tier changes. A tower taken down mid-merge gives both fittings back.

Merging is the route that matters in practice: above tier 1 no item exists
except by merging, so a gun built at tier 3 will rarely meet a tier-4 fitting to
be handed — but it will often be standing beside its own twin.

| tier | power | manning |
|---:|---:|---:|
| 1 | 1.00 | 1 |
| 2 | 2.50 | 1 |
| 3 | 6.25 | 1 |
| 4 | 15.63 | 2 |
| 5 | 39.06 | 2 |
| evolved | 97.66 | 3 |

A tower's ground never changes. The fit is about the gun, not about the plot:
the emplacement is already standing, and nothing beside it can be built over in
the meantime to make a fitting the player has paid for illegal. An **evolution**
consumes the partner and its ground; the survivor keeps its own shape.

### Manning

- An **unmanned tower stands and does not fire.** It holds a position: build on
  every approach, man the one under attack.
- Crew redeployment costs **no turn of its own** if the destination is within
  10 tiles — the worker walks there and starts the job in the same turn. It
  costs 1 turn of walking to 25 tiles, 2 turns beyond. The arrival turn is
  always a working turn: the end of the walk and the start of the work are the
  same turn.
- **Crew cannot be redeployed during a real-time resolve.** Sequential arrivals
  can be covered by one crew shuffling between them; simultaneous ones cannot.

### Evolution

Requires: both towers at tier 5, a built and manned **Tinker's Shed**, and a
legal recipe. Tower *i* evolves with *i+1* or *i+7*; within the starting eight
the live recipes are (0,1) (1,2) (2,3) (3,4) (4,5) (5,6) (6,7) (0,7).

The partner tower is consumed. The result sits on the base tower's tile, needs 3
tiles and 3 hands, and has `power(5) × 2.5 = 97.66`, plus the partner's essence
effect layered on its own firing shape.

## §4 · Items

- Each fitting has **one house and one only**. The ironwork — Swivel Gun,
  Culverin, Chain-Shot — is crafted at a **Workshop** for **6 iron**; the other
  five are bought off a **Peculiar Merchant** for **8 gold**. What is crafted
  cannot be bought and what is bought cannot be crafted, and neither can be had
  before its house is built and manned. The Weapons Master makes both 25%
  cheaper.
- **Two items of the same tier merge into one of the next.** Merging is free and
  happens only in inventory.
- A tier-*n* item is worth `2^(n-1)` tier-1 items: 1 · 2 · 4 · 8 · 16.
- The ship holds **5 items**. A Warehouse makes it unlimited.
- **An item fitted to a tower is not in the hold** — building is how you make
  room.

Items are generic: an item has a tier and nothing else. Which of the eight towers
it becomes is chosen at build time.

## §5 · Economic buildings

Every building: **120 wood + 80 stone**, **2 hands** (1 within radius 3 of a
Bunkhouse), one turn to build. Upgrading to run unmanned costs **50 gold**.

| building | tiles | owns | effect |
|---|---:|---|---|
| Warehouse | 3 | inventory | the hold becomes unlimited |
| Forge | 2 | iron | 3 stone → 1 iron per turn |
| Workshop | 3 | ironwork | the iron fittings craftable at 6 iron |
| Trading Dock | 3 | the surplus | 12 wood or stone → 1 gold per turn, and a counter to trade over |
| Peculiar Merchant | 3 | oddities | the gold fittings buyable at 8 gold; runs on 1 hand |
| Tinker's Shed | 3 | evolution | evolutions become possible |
| Sappers' Camp | 3 | offence | assault teams can be raised |
| Hospital | 2 | downtime | assault downtime 3 → 1 turn |
| Powder Store | 2 | the flare | flare cost −25%, lands in 1 turn |
| Excavation Camp | 3 | buried gold | works one cache: 100 gold over 10 turns |
| Bunkhouse | 2 | manning | buildings within radius 3 cost 1 hand |

Excavation Camp and Bunkhouse may be built repeatedly; the rest are one each.

**A yard can be pulled down again.** `BUILDING_REFUND` (90%) of what was paid
comes back — the crew upgrade included, if one was bought — the ground comes
free, and whoever was manning it walks out. A ruin refunds the same: the player
paid the same for it, and clearing rubble should not be dearer than clearing a
working house. An Excavation Camp pulled down before it pays gives its cache
back undug rather than burying it for the rest of the run. The Palisade is not
offered it: it is not one of the eleven. What is lost is the turn it took to
build and the turn it takes to build again somewhere else, which is the right
price for changing your mind about where a house goes.

**A requirement that falls sends the surplus home.** A Bunkhouse finished within
reach, or a crew upgrade paid for, drops what a house wants by a hand — and the
hand already standing in it is stood down that same turn (step 3) rather than
left manning a job that no longer exists. Whoever is still walking to the house
goes first, then the last one put on.

**The dock counter.** Beside its standing trade, a manned Trading Dock buys and
sells wood, stone and iron to order in whatever amount. It is instant — no turn,
no hand, nothing queued — and it deals in whole gold: it pays 1 gold for 12 wood
or 12 stone and asks 2 for the same, and pays 1 for an iron and asks 2. What the
order queue has already spent is not on the counter.

Buildings occupy multiple contiguous tiles, all of which must be cleared,
buildable and free.

## §6 · Flares

- **250 wood + 120 iron** (−25% with a Powder Store). The price never escalates.
- Brings **5 hands**, landing **2 turns** later (1 with a Powder Store) on the
  beach beside the base. The boat stays there permanently.
- Gated by act: 1 in act I, 3 cumulative by act II, 6 by act III.

## §7 · Assaults

**Spawners can only be destroyed by an assault team.**

Requirements:

1. A built and manned **Sappers' Camp**.
2. **A continuous road or bridge path** from the base to a tile adjacent to the
   target spawner.
3. **4 hands**, optionally led by an officer — **2 hands** under the Sapper
   Captain, whose trade this is, and only when he is the one going.

Scheduling is a player-phase order; resolution happens in the resolve phase and
opens a modal.

| leader | success | team |
|---|---:|---:|
| the Sapper Captain | **90%** | 2 hands |
| any other unique lieutenant | **65%** | 4 hands |
| nobody, or a pirate off the island | **40%** | 4 hands |

- March: **10 turns** out. The team is unavailable for the whole march.
- Success: the spawner dies. Its accumulating cohort is released and advances that
  turn. Its stars transfer to the survivor.
- Failure: nobody dies; the team is disabled for **3 turns** (1 with a Hospital),
  then returns.

The road you cut to reach a spawner is also a road that spawner's cohorts walk
down. That is the cost, and it is not mitigated anywhere.

**No tower may be built within 7 tiles of a living spawner.**

## §8 · The ship

- Hull 100. Every unit that reaches the base deals its hull damage and is removed.
- The ship's guns fire at **14 dps** into cleared ground within **12 tiles** of
  the base centre — the landing corridor and nothing else, until the player
  clears more.
- **Repair costs 25 wood per hull point** and is a player-phase order with a
  visible cost. It is never automatic.

Calibration target: with no player action the ship clears wave 1 untouched, ends
wave 2 at 40–60% hull, and dies during wave 3, around turn 60–90.
