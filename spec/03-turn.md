# 03 · The turn

## §1 · Structure

| phase | what happens |
|---|---|
| **1 · Player** | untimed, any number of orders, all revocable until the turn ends |
| **2 · Resolve** | the order queue executes, then the world moves |
| **3 · Combat** | only if a cohort reached a road this turn — real time, no input |

There is no build/defend split. Something is always massing somewhere.

## §2 · Player phase

Orders available:

| order | cost |
|---|---|
| assign a hand or officer to **clear** from an anchor tile | — |
| assign a hand or officer to **man** a tower or building | — |
| **build a tower** (tier 1) | 30 wood + 20 stone |
| **fit an item** to a tower (upgrade in place) | the item |
| **disassemble a tower** | refunds 80% + the item |
| **evolve** two tier-5 towers | needs a manned Tinker's Shed |
| **buy an item** | 8 gold |
| **craft an item** | 6 iron, needs a Workshop |
| **merge two items** | free |
| **build an economic building** | 120 wood + 80 stone + 2 hands |
| **upgrade a building to unmanned** | 50 gold |
| **build a bridge** | 65 wood |
| **fire a flare** | 250 wood + 120 iron |
| **repair the hull** | 25 wood per point |
| **schedule an assault** | 4 hands + a Sappers' Camp + a clear road path |

Every order is appended to `state.orders` and **applied only during resolve**.
Until the turn ends, any order can be revoked at no cost. The queue is visible
as a list; ending the turn shows what is about to happen.

Two things the player can do are **not** orders, because there is nothing in
either for a resolve to carry out: a trade over the Trading Dock's counter, and
**standing a worker down**. Taking a worker off a job frees the body on the spot
and moves nobody — they go on standing where the job left them — so the body is
loose the instant the button is pressed and can be given something else to do in
that same phase.

There is no confirmation dialog on anything.

## §3 · Resolve order

Execute exactly this sequence.

```
1.  apply the order queue in the order given; refund anything now invalid
2.  labour: each clear assignment clears its tiles; credit yields
3.  construction: towers, buildings, bridges complete
4.  buildings produce: Forge, Trading Dock, Excavation Camp
5.  flares in flight land; hands added
6.  assaults: march ticks, arrivals resolve
7.  escalation: every 50th turn one random living spawner gains a star
8.  spawners: accumulate or advance (§4)
9.  contact: any cohort reaching a road triggers combat (§5)
10. end checks: hull <= 0 -> lost · all spawners dead -> won · turn 300 -> lost
```

## §4 · Spawners

A spawner is in one of two modes.

### Accumulate

- Lasts `ACCUMULATE_TURNS = 6`.
- At the end, it releases a **cohort** of `stars × 8` units, sitting on its own
  footprint.
- Visible from turn 1 as a red outline over the spawner's tiles, growing each
  turn of the window.

### Advance

A cohort moves **toward the base**, `6 tiles per turn ÷ the mean advance
multiplier of the tiles it crosses this turn`.

- Impassable tiles (`freshwater` without a bridge, `cliff`, `stone`, player
  buildings) are routed around by A* on passable tiles, cost = advance
  multiplier.
- A cohort is drawn as an outline over the tiles it currently occupies.
- On `forest` or `canopy`, unit count and composition are hidden.

### Entry into the road network

> **A cohort advances toward the base and enters the road network at the first
> road tile on its approach line.**

Concretely: each turn, walk the cohort's path toward the base; if any tile on that
path this turn is `road` or `bridge`, contact happens **at that tile**, and
combat starts. The cohort never diverts to a nearer road that is not on its line.

This is what makes the shape of cleared ground the entry-point decision, and it
is the rule the whole approach model rests on. Do not substitute "nearest road".

### Combination

Two cohorts that occupy overlapping tiles on the same turn **merge into one
cohort** and arrive together. This is the threat the player manages by shaping
where their road is.

### On a spawner's death

- It stops producing.
- Its currently accumulating cohort is **released and advances on that same turn**.
- Its stars transfer to the surviving spawners, respecting each cap.

## §5 · The real-time resolve

Triggered when a cohort reaches a road. Fixed timestep, `TICK_HZ = 30`.

### Setup

1. Units are placed at the entry tile, spread over its width.
2. Their path to the base is the shortest **road-and-bridge** path (BFS). If no
   road path exists from the entry to the base, they walk overland by the same
   A* used in the advance.
3. Every tower whose range covers a tile on that path is a participant.

### Per tick

```
for each unit:      move along path at speed × terrain modifier
for each tower:     if manned and a target is in range and on cleared ground,
                    deal power/30 damage in its shape
for each ship gun:  same, range 12 from base centre
apply healers, shields, salt-flat modifiers
units at the base:  deal hull damage, remove
```

### Firing rules

- **Towers fire only into cleared ground.** A unit on virgin `forest` or
  `canopy` cannot be shot. `scrub`, `sand`, `salt`, `road` and bridges are
  targetable while virgin.
- **`canopy` blocks line of sight over itself.** A tower cannot fire through a
  canopy tile — so a killzone must be a cleared bowl, not a cleared line.
- **Cliff** gives +1 range.
- Armour subtracts a flat amount **per damage application**, floored at 1.

### End

The resolve ends when every unit is dead or has reached the base, or at
`RESOLVE_CAP_SECONDS = 60`, after which the remainder is applied instantly:
surviving units deal their hull damage and are removed.

Control returns to the player phase and the turn counter advances.

## §6 · Acts

| act | turns | flares allowed (cumulative) |
|---:|---|---:|
| I | 1–100 | 1 |
| II | 101–200 | 3 |
| III | 201–300 | 6 |

Acts change nothing else. They gate flares and label the HUD.

## §7 · End of run

| outcome | condition |
|---|---|
| **won** | both spawners destroyed |
| **lost — hull** | hull reaches 0 |
| **lost — armada** | turn 300 passes with a spawner alive |

All three open the same end-of-run modal: outcome, turns taken, tiles cleared,
peak power, resources earned, and a **New run** button that regenerates from a
fresh seed. Nothing persists.
