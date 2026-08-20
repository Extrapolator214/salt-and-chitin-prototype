// 00-constants.md as one frozen object.
// Nothing anywhere else may hard-code a number that appears here.
// Values tagged [cal] are calibration targets, not fixed rules.

const C = {
  // 2 · Run frame
  TURNS_PER_RUN: 300,
  TURNS_PER_ACT: 100,
  ACTS: 3,
  // The map is a round island ringed by open ocean. The grid is centred on the
  // island; the base is the ship, landed on the first tile of the south beach.
  //
  // ISLAND_RADIUS sets everything else. The hive sits just inside the opposite
  // shore, so a cohort crosses about 2 x ISLAND_RADIUS tiles to reach the ship —
  // at ~2.5 tiles a turn that is the ~17-27 turn approach the design runs on.
  // Raising it makes a bigger island and a proportionally longer approach.
  ISLAND_RADIUS: 36,
  OCEAN_MARGIN: 4,
  MAP_RADIUS: 45, // ISLAND_RADIUS + OCEAN_MARGIN + the coast's outward swing
  COAST_LOBES: 3.0,  // smooth bays and headlands
  COAST_JAG: 1.4,    // per-tile raggedness on top
  LANDING_BEARING: 90, // +y is south on screen; the ship lands on the south beach
  // The sea is allowed one or two proper intrusions into the island: a bay —
  // a wide mouth narrowing inland — or a strait, a long narrow channel that
  // runs deep and stops short of the far shore. Salt water cannot be bridged,
  // so what these place is a permanent detour: the cohort walks round it, and so
  // does your road. They keep clear of the landing bearing, because a ship put
  // ashore inside a bay is a ship with nowhere to go.
  WATER_FEATURE_COUNT: [1, 2],
  WATER_FEATURE_OFF_LANDING: 55, // degrees clear of the landing, and of each other
  BAY_MOUTH: [5, 8],
  BAY_LENGTH: [8, 16],
  STRAIT_WIDTH: [1, 2],
  STRAIT_LENGTH: [14, 26],
  STRAIT_STOP_SHORT: 3, // land left standing between its head and the far shore
  SPAWNER_INSET: 2,    // how far inside the far shore a spawner stands
  SPAWNER_RING: 44,
  SPAWNER_RING_JITTER: 3,
  // The hive sits straight across the island from the landing. The shell
  // spawner flanks it, measured round the island's centre.
  HIVE_JITTER: 12,
  FLANK_OFFSET: [50, 72],
  BASE_FOOTPRINT: 7,
  ARMADA_TURN: 300,
  DEFAULT_SEED: 20260816,

  // 3 · Terrain
  // `passable` is the turn-based advance: whether a cohort can cross this ground
  // on its march to the ship. `assaultPassable` is the real-time resolve:
  // whether a unit already in contact can cross it while it comes at the hull.
  // Separate questions, separate flags — tar refuses the first and allows the
  // second.
  //
  // `advance` is the ground's drag on the enemy and applies to both phases. It
  // is stored the way 00-constants.md §3 writes it — as a *cost*, so 5.0 means
  // five times the ground to cover. Everything the player sees is the speed it
  // implies, `C.enemySpeed`, so tar reads 0.20x: five times slower.
  TERRAIN: {
    forest: { clearable: true, yield: { wood: 9 }, buildable: true, passable: true, assaultPassable: true, advance: 3.0, targetableVirgin: false, blocksSight: false },
    // Old timber: a third more wood than forest for the same three turns, which is
    // what makes felling the canopy worth doing for its own sake and not only
    // to lift the shadow it casts over everything behind it.
    canopy: { clearable: true, yield: { wood: 12 }, buildable: true, passable: true, assaultPassable: true, advance: 3.0, targetableVirgin: false, blocksSight: true },
    // Scrub is thin enough to march through on the way in, but a swarm at full
    // tilt will not push into it — the charge keeps to open ground.
    //
    // It is also a third of forest's wood, so it is cut in a third of the time:
    // one turn, not three. The wood per worker per turn comes out the same
    // either way — what it buys is tempo. A road driven through scrub reaches
    // three times as far for the same labour, which makes the thin ground worth
    // routing along instead of worth avoiding.
    scrub: { clearable: true, yield: { wood: 3 }, turns: 1, buildable: true, passable: true, assaultPassable: false, advance: 1.5, targetableVirgin: true, blocksSight: false },
    stone: { clearable: true, yield: { stone: 15 }, buildable: true, passable: false, assaultPassable: false, advance: 2.0, targetableVirgin: true, blocksSight: false },
    // Rare ore, worked like a boulder. The Forge still turns stone into iron;
    // this is the seam you can dig instead of smelting for it.
    iron: { clearable: true, yield: { iron: 10 }, buildable: true, passable: false, assaultPassable: false, advance: 2.0, targetableVirgin: true, blocksSight: false },
    road: { clearable: false, yield: {}, buildable: true, passable: true, assaultPassable: true, advance: 1.0, targetableVirgin: true, blocksSight: false },
    sand: { clearable: false, yield: {}, buildable: false, passable: true, assaultPassable: true, advance: 2.0, targetableVirgin: true, blocksSight: false },
    salt: { clearable: false, yield: {}, buildable: false, passable: true, assaultPassable: true, advance: 1.0, targetableVirgin: true, blocksSight: false },
    freshwater: { clearable: false, yield: {}, buildable: false, passable: false, assaultPassable: false, advance: 6.0, targetableVirgin: true, blocksSight: false },
    cliff: { clearable: false, yield: {}, buildable: 'towers', passable: false, assaultPassable: false, advance: 6.0, targetableVirgin: true, blocksSight: false },
    saltwater: { clearable: false, yield: {}, buildable: false, passable: false, assaultPassable: false, advance: 6.0, targetableVirgin: true, blocksSight: false },
    // A cohort will not march through tar on its way in, but a swarm already in
    // contact will wade across it — at a fifth of the pace.
    tar: { clearable: false, yield: {}, buildable: false, passable: false, assaultPassable: true, advance: 5.0, targetableVirgin: true, blocksSight: false },
  },
  // What a terrain is called where the player reads it. Only the ones whose key
  // is not already the word for the thing need an entry.
  TERRAIN_NAME: {
    freshwater: 'fresh water',
    saltwater: 'salt water',
    salt: 'salt flat',
  },
  TERRAIN_COLOUR: {
    forest: '#2f5d3a', canopy: '#1e4029', scrub: '#6d7a48', stone: '#7a7a72',
    road: '#b9a582', sand: '#d9c48f', salt: '#e8e6dd', freshwater: '#3c6d8f', iron: '#8c6a55',
    cliff: '#5a5048', saltwater: '#25506e', tar: '#241f1c',
  },
  // 02-map.md §3.5 — target mix in points, over land tiles
  // iron is carved out of forest and scrub: rare, and never near enough
  TERRAIN_MIX: {
    forest: 40, canopy: 2, scrub: 23, stone: 10, iron: 2, road: 3,
    sand: 6, salt: 1, freshwater: 8, cliff: 4,
  },
  MIX_TOLERANCE: 2,
  // Generation lays no road at all: every road tile on a live map is ground the
  // player cleared. Road therefore leaves the natural mix and its 3 points are
  // shared out across what actually grows.
  CLEARABLE_FLOOR: 0.40,
  // The landing. The ship is run aground in a cove: a strip of beach under it,
  // ocean at its back, and a broken wall of cliff round the land side. Nothing
  // else there is opened for you — no corridor, no apron, and no road anywhere
  // on the island. Every road tile on the map is one the player cut, so the
  // shape of the supply line is a decision rather than a starting condition.
  LANDING_BEACH_SPAN: 5,   // how far along the shore the landing beach reaches
  LANDING_BEACH_DEPTH: 2,  // and how far back from the waterline it runs
  // ...and it stays on the ship's seaward side. Sand can never be cut, so sand
  // laid across the landward face would wall the ship in against its own road
  // for good — the beach is the ground between the ship and the water, and the
  // way inland is ordinary island the player has to cut.
  LANDING_BEACH_ARC: 90,
  LANDING_EXITS_MIN: 3,    // clearable faces the ship must have, or reroll
  // Sand is where a boat can be run aground, not the whole shoreline. A few
  // more beaches sit round the rim; everywhere else the island grows down to
  // the water, so most of the coast is ground you have to cut.
  EDGE_BEACH_COUNT: [3, 5],
  EDGE_BEACH_SIZE: [8, 20],
  EDGE_BEACH_MIN_APART: 14,
  // The cove wall. It stands outside STRUCTURE_KEEPOUT so the ship keeps its
  // firing arcs, and it is broken: one gap always sits on the corridor bearing
  // so the way inland is never sealed, plus a couple more. A cohort cannot climb
  // cliff, so every approach funnels through a gap — which is what makes the
  // landing worth defending rather than merely surrounded.
  LANDING_CLIFF_RADIUS: 8,
  LANDING_CLIFF_COURSES: 2,     // how many rings deep the wall stands
  LANDING_CLIFF_ARC: 105,       // half-arc round the inland bearing; sea does the rest
  // Ways through the wall, counting the one always on the corridor bearing.
  // Cut as bearings before the ground is settled, then checked again once it is
  // and reopened if a stream or a boulder field has silted one up; an island
  // that still cannot offer LANDING_ENTRANCES[0] of them is rejected.
  LANDING_ENTRANCES: [2, 3],
  LANDING_CLIFF_GAP_HALF: [10, 15], // half-width of a gap, degrees
  // The fresh-water spokes radiate from a hub just inland of the landing. Left alone
  // they seal the landing site off and leave the ship no arc to fire down, so
  // nothing impassable is generated inside this radius.
  STRUCTURE_KEEPOUT: 6,
  // Ground a worker can cross without cutting it first: your own cleared
  // ground, your bridges, the beach and the salt flats. Forest and scrub are
  // passable — that is a rule about enemy units — but a hand cuts its way in,
  // so work inland can only start on the fringe of what you have opened.
  //
  // The beach is open ground because it plainly is: you landed on it, you can
  // walk along it, and a wreck sitting on sand has to be reachable without
  // cutting anything, because sand can never be cut. Sand no longer rings the
  // island, so this buys you the landing cove and the few beaches on the rim
  // and nothing else — the rest of the coast is ground you cut your way into.
  // No road will ever run over sand either, so a beach walk never becomes a
  // supply line, and an assault still needs a real road.
  WORK_OPEN_TERRAIN: ['road', 'sand', 'salt'],
  BRIDGE_COST_WOOD: 65,
  CLEARED_BECOMES: 'road',

  // 4 · Labour
  HANDS_START: 10,
  HANDS_CAP: 40,
  TILES_PER_HAND_PER_TURN: 1,
  // Cutting a tile is three turns of one worker's labour, and the tile pays
  // three times as much for it. The island's total wealth is unchanged and so
  // is the wood per worker per turn — what changes is that the map is no longer
  // something you flatten. Partial work stays on the tile, so a worker stood
  // down does not throw away what they have already cut.
  TURNS_PER_TILE: 3,
  // 04-economy.md §3 — crew redeployment, priced by how far the worker has to
  // walk from where they are actually standing. Stepping onto the next tile is
  // not a redeployment: a crew chewing along a frontier would otherwise spend
  // every other turn walking one hex.
  //
  // These are the turns spent walking *before* any work: the last leg of the
  // walk is folded into the turn the job starts, because a worker who can be
  // there this turn gets to work this turn. So a job close enough to reach
  // costs nothing but the turn it is worked — a scrub tile the next hex over is
  // one turn from order to road, not two.
  //
  // The free band is half a turn's walk, not a whole one. `04-economy.md` §3
  // puts it at 10 — the whole of a turn's march — and that is too generous once
  // the route is measured properly: it quoted a hand ten tiles out as "0 turns,
  // work starts this turn", which is a full turn's walking and a full turn's
  // cutting in the same turn. Anything more than half a turn still standing
  // between a worker and the job is a leg of its own, and the work starts next
  // turn. CREW_TILES_PER_TURN is the whole; the first band is half of it.
  CREW_TILES_PER_TURN: 10,
  TRAVEL: [{ within: 5, turns: 0 }, { within: 25, turns: 1 }, { within: Infinity, turns: 2 }],
  CREW_PER_TILE: 5, // how many bodies stand on one hex before the next fills

  // What the walk is measured over. The crew keep to their own ground — cleared
  // tiles, road, bridges, beach and salt flat — at a step apiece, and the number
  // fed to TRAVEL is that walk, not the straight line. Standing wood and rock,
  // fresh water, cliff and the sea are not walked at all; the one thing crossed
  // that the terrain would refuse is a tile one of the crew is standing on.
  // Nobody is sealed in by that, because the tile a worker stands on is reach
  // and the ground at his elbow can always be queued: he cuts his own way out.

  // 5 · Flares
  // The six flares the acts are built around should land at roughly turn 50,
  // 100 and 120, then 200, 210 and 215 — so the price has to be payable on
  // that schedule out of a crew of ten, not merely payable in principle.
  FLARE_COST_WOOD: 300,
  // [cal] — spec value 120. A Forge makes 1 iron a turn and is the only source,
  // so at 120 a run affords one flare on turn 144 against the six the acts are
  // built around: the crew could never grow. It matters now that it could not,
  // because the gun line act 3 demands is nine hands of the ten you land with.
  FLARE_COST_IRON: 40,
  FLARE_HANDS: 5,
  FLARE_DELAY_TURNS: 2,
  FLARE_DELAY_POWDER: 1,
  FLARE_POWDER_DISCOUNT: 0.25,
  FLARE_GATE: [1, 3, 6], // cumulative, by act
  // 04-economy.md makes the act gate the only limiter, so the moment an act
  // opens with a full purse two boats land on consecutive turns. A minimum
  // spacing keeps the six spread over the run they are meant to pace.
  FLARE_COOLDOWN: 10,

  // 6 · Ship
  HULL_MAX: 100,
  // [cal] — spec value 14.
  // 06-acceptance.md marks this [cal] and says to move it first, which is what
  // has happened. It was 21 when the landing came with an apron cut round it: a
  // cohort entered the player's road five to eleven tiles out and the guns had the
  // walk in to work with. Nothing is cleared for you now, so until the player
  // cuts a road the cohort arrives *on* the ship and the whole fight happens at
  // point-blank. That costs the guns most of their firing time — at 21, wave 1
  // was clean on 2 seeds in 10 and the ship was dead by turn 49. At 25 wave 1 is
  // clean on all 10 and the median death is turn 77, back inside the 60-90
  // target. It falls off a cliff below that rather than sloping (24 gives 5 clean
  // and a median of 62): at this range the wave is either broken before it lands
  // or it is not.
  SHIP_DPS: 25,
  // [cal] — the ship used to cover a twelve-tile bubble, which made the guns
  // decoration. It holds its own landing and no more.
  SHIP_RANGE: 6,
  REPAIR_WOOD_PER_HULL: 25,
  HOLD_SLOTS: 5,

  // 7 · Towers
  TIER_BASE: 2.5,
  EVOLVED_MULT: 2.5,
  TOWER_MANNING: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, evolved: 3 },
  TOWER_FOOTPRINT: { 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, evolved: 3 },
  TOWER_COST: { wood: 30, stone: 20 },
  // v6: "A tower needs an item to be built" — the emplacement is wood and
  // stone, but the gun itself is a tier-1 fitting out of the hold. Set false to
  // fall back to spec/04-economy.md, where the emplacement is the whole cost.
  TOWER_NEEDS_ITEM: true,
  DISASSEMBLE_REFUND: 0.80,
  CLIFF_RANGE_BONUS: 1,
  MAX_TIER: 5,

  // Ranges are deliberately short. A tower covers a corridor, so where the road
  // runs past it is a decision — and a Palisade is how you make the enemy take
  // the corridor you built.
  TOWERS: [
    { i: 0, name: 'Swivel Gun Post', shelf: 'gunnery', range: 2, shape: 'single', essence: 'Scatter', fire: 'fast single target', colour: '#c8b45a', item: 'Swivel Gun', itemShort: 'Swivel' },
    { i: 1, name: 'Culverin Battery', shelf: 'gunnery', range: 4, shape: 'single', essence: 'Bore', fire: 'slow single target', colour: '#b9743f', item: 'Culverin', itemShort: 'Culverin' },
    { i: 2, name: 'Chain-Shot Gallery', shelf: 'gunnery', range: 3, shape: 'file', essence: 'Rake', fire: 'pierces a file along the road', colour: '#a85c5c', item: 'Chain-Shot', itemShort: 'Chain-Shot' },
    { i: 3, name: 'Dynamite Throwers', shelf: 'gunnery', range: 3, shape: 'blast', essence: 'Blast', fire: 'slow blast, radius 1', colour: '#d0603a', item: 'Powder Charge', itemShort: 'Charge' },
    { i: 4, name: 'Parrot Swarm Aviary', shelf: 'beasts', range: 3, shape: 'multi', essence: 'Swarm', fire: 'many weak hits, up to 4 targets', colour: '#4fae7a', item: 'Parrot Cage', itemShort: 'Parrots' },
    { i: 5, name: 'Alligator Guards', shelf: 'beasts', range: 1, shape: 'single', essence: 'Snag', fire: 'holds what it hits in place', colour: '#5e8a3a', item: 'Alligator Egg', itemShort: 'Gator Egg' },
    { i: 6, name: 'Krakenling Well', shelf: 'beasts', range: 1, shape: 'adjacent', essence: 'Sweep', fire: 'hits every adjacent road tile', colour: '#5a7fae', item: 'Krakenling Spawn', itemShort: 'Krakenling' },
    { i: 7, name: 'Monkey Riggers', shelf: 'beasts', range: 2, shape: 'single', essence: 'Plunder', fire: 'yields 2 gold per kill', colour: '#b58b4a', item: 'Monkey Troop', itemShort: 'Monkeys' },
  ],
  BLAST_RADIUS: 1,
  FILE_LENGTH: 3, // target tile plus the two behind it
  MULTI_TARGETS: 4,
  PLUNDER_GOLD_PER_KILL: 2,
  EVOLUTION_OFFSETS: [1, 7],
  EVOLUTION_MOD: 20,

  // 8 · Items
  ITEM_CRAFT_IRON: 6,
  ITEM_BUY_GOLD: 8,
  WEAPONS_MASTER_DISCOUNT: 0.25,

  // 9 · Economic buildings
  BUILDING_COST: { wood: 120, stone: 80 },
  BUILDING_HANDS: 2,
  BUILDING_HANDS_BUNKHOUSE: 1,
  // Gold spent on a building's works so it runs with one hand fewer. It stacks
  // with a Bunkhouse: two hands, one inside a Bunkhouse's radius, none at all
  // for an upgraded building that also stands inside one. Bought once per
  // building — there is nothing below nobody.
  CREW_UPGRADE_GOLD: 50,
  BUNKHOUSE_RADIUS: 3,
  // 00-constants.md §9 prices every building at 120 wood + 80 stone. This build
  // charges each one for what it is worth: the Sappers' Camp is the only route
  // to a win, a Bunkhouse is an enabler nobody wants to ration. The ten sum to
  // 1400 wood and 940 stone against the flat price's 1200 and 800, which moves
  // 06-acceptance.md §3.3's build-out bill from 4825 to 5465 — inside the
  // harness's 15% band, not identical to it.
  // Footprints are roughly double the spec's. A yard, not a hut: the whole
  // economy no longer fits inside the landing's cliff wall, so the second half
  // of it has to be built out through a gap and defended where it stands. With
  // BUILDING_GAP and the road rule below, ten buildings want something like
  // three times their own tile count in ground, and the cove holds well under
  // that.
  BUILDINGS: [
    { type: 'warehouse', name: 'Warehouse', tiles: 5, cost: { wood: 150, stone: 100 }, owns: 'inventory', effect: 'the hold becomes unlimited', repeatable: false },
    { type: 'forge', name: 'Forge', tiles: 4, cost: { wood: 110, stone: 70 }, owns: 'iron', effect: '3 stone -> 1 iron per turn', repeatable: false },
    { type: 'workshop', name: 'Workshop', tiles: 5, cost: { wood: 150, stone: 100 }, owns: 'crafting', effect: 'items craftable at 6 iron', repeatable: false },
    { type: 'dock', name: 'Trading Dock', tiles: 5, cost: { wood: 140, stone: 90 }, owns: 'the surplus', effect: '12 wood or stone -> 1 gold per turn', repeatable: false },
    { type: 'tinker', name: "Tinker's Shed", tiles: 4, cost: { wood: 130, stone: 90 }, owns: 'evolution', effect: 'evolutions become possible', repeatable: false },
    { type: 'sappers', name: "Sappers' Camp", tiles: 6, cost: { wood: 380, stone: 260 }, owns: 'offence', effect: 'sabotage teams can be raised', repeatable: false },
    { type: 'hospital', name: 'Hospital', tiles: 3, cost: { wood: 90, stone: 60 }, owns: 'downtime', effect: 'sabotage downtime 3 -> 1 turn', repeatable: false },
    { type: 'powder', name: 'Powder Store', tiles: 3, cost: { wood: 100, stone: 70 }, owns: 'the flare', effect: 'flare cost -25%, lands in 1 turn', repeatable: false },
    { type: 'excavation', name: 'Excavation Camp', tiles: 4, cost: { wood: 100, stone: 60 }, owns: 'buried gold', effect: 'works one cache: 220 gold over 10 turns', repeatable: true },
    { type: 'bunkhouse', name: 'Bunkhouse', tiles: 3, cost: { wood: 50, stone: 40 }, owns: 'manning', effect: 'buildings within radius 3 cost 1 hand', repeatable: true },
    // Not an economy at all: one tile of ground the enemy will not cross, dear
    // enough that a line of them is a plan rather than a habit. It is exempt
    // from both rules below — a palisade that needed a road beside it and could
    // not touch its neighbour would not be a wall.
    // `blocksCrew` is what makes it a wall and not a yard: the crew walk through
    // the ship and through their own workshops, and stop at this.
    { type: 'wall', name: 'Palisade', tiles: 1, cost: { wood: 140, stone: 90 }, crew: 0, economic: false, blocksCrew: true, owns: 'the ground', effect: 'the enemy will not cross it; needs no crew', repeatable: true },
  ],
  // An economic building is a yard on your supply line, not a shed in the
  // woods: it must have road joined to the ship beside it, and it must stand
  // clear of the next one by at least this many tiles. The gap is what stops
  // the economy being poured into one blob in the corner of the landing.
  BUILDING_GAP: 1,
  // Every building has ONE shape, the same at every site on every map: the
  // anchor tile plus these offsets, in this order. Nothing is grown to fit the
  // ground — a site takes the whole shape or it is refused — so a Forge is
  // always the same four hexes around its anchor and can be given one picture
  // later instead of a different silhouette per plot.
  //
  // The shapes are the anchor and its neighbours taken in ring order, which
  // keeps every one of them compact and centred on the tile you clicked.
  // Offsets are axial [dq, dr]; the ring order is (+1,0) (+1,-1) (0,-1) (-1,0)
  // (-1,+1) (0,+1), so consecutive petals always touch.
  BUILDING_SHAPES: {
    1: [[0, 0]],
    2: [[0, 0], [1, 0]],
    3: [[0, 0], [1, 0], [1, -1]],
    4: [[0, 0], [1, 0], [1, -1], [0, -1]],
    5: [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0]],
    6: [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1]],
    7: [[0, 0], [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]],
  },
  // What happens when the wave washes over a yard.
  //
  // A tower is a fortification: the swarm will not close with one, it goes
  // round — nothing in the resolve ever attacks a tower. A building is a shed
  // with a roof on it, and what stands within reach of the lane gets pulled
  // down. It is never destroyed outright, only **ruined**: the walls stay where
  // they are, the work stops, and putting it back costs a fraction of building
  // it new. Ruins keep their ground, so nothing else can be raised on top of one.
  // Toughness is set so that a yard outlasts a wave the guns are working on and
  // does not outlast one they are not: a 4-tile Forge is 600, and nine shells
  // with hold of it take about twenty seconds. At 60 and 0.5 it fell in six,
  // which made anything beside a lane a certainty rather than a risk.
  BUILDING_HP_PER_TILE: 150,
  BUILDING_DAMAGE_MULT: 0.35,   // of a unit's hull damage, per second
  RUIN_REBUILD_FRACTION: 0.4,
  // A hex has six sides, and three of them can get at a side at once. A face
  // shared with another tile of the same building is inside the building and
  // takes nobody, so a free-standing single-tile yard can be worked on by
  // eighteen at most, and a bigger one by three times its exposed faces.
  ATTACK_SLOTS_PER_SIDE: 3,
  FORGE_STONE_IN: 3,
  FORGE_IRON_OUT: 1,
  DOCK_INPUT: 12,
  DOCK_GOLD_OUT: 1,
  EXCAVATION_TURNS: 10,
  EXCAVATION_GOLD: 220,

  // 10 · Assaults
  ASSAULT_HANDS: 4,
  SUCCESS_NAMED: 0.80,
  SUCCESS_GENERIC: 0.40,
  MARCH_TURNS: 32,
  DOWNTIME_TURNS: 3,
  DOWNTIME_HOSPITAL: 1,
  EXCLUSION_RADIUS: 7,

  // 11 · Spawners and the enemy
  // The two fronts push differently. The hive is the column: grubs, fast and
  // numerous, a problem of rate of fire. The shell spawner is the opposite —
  // mostly Shells, slow and armoured, a problem of penetration. `grubShare` is
  // that split; weighted by each cap it still averages the 70/30 the design
  // asks of the island as a whole.
  SPAWNERS: [
    { kind: 'hive', name: 'hive', stars: 1, cap: 10, footprint: 8, grubShare: 0.90 },
    { kind: 'shell', name: 'shell spawner', stars: 1, cap: 8, footprint: 4, grubShare: 0.45 },
  ],
  ESCALATION_TURNS: 30,
  ACCUMULATE_TURNS: 5,
  ADVANCE_TILES_PER_TURN: 6,
  UNITS_PER_STAR: 12,
  // Escalation makes the enemy bigger, not just more numerous, and it does so
  // on a curve rather than a slope: a unit's hp and armour carry a factor of
  //     1 + SCALE * (stars - 1) ** EXP
  // so the first stars are almost free and the last ones are brutal. Numbers
  // grow linearly (UNITS_PER_STAR) and toughness quadratically, which leaves
  // acts 1 and 2 a game about numbers and makes act 3 a game about power.
  UNIT_DANGER_EXP: 2,
  UNIT_DANGER_SCALE: 0.078,
  SPAWNER_MIN_SEPARATION_DEG: 25,

  UNITS: {
    grub: { name: 'Grub', share: 0.70, hp: 10, armour: 0, speed: 1.2, hullDamage: 4, colour: '#e0b0a0' },
    shell: { name: 'Shell', share: 0.30, hp: 30, armour: 3, speed: 0.6, hullDamage: 9, colour: '#8a4030' },
  },
  ELITE_HP_MULT: 10,
  ELITE_SPEED_MULT: 0.5,
  ELITE_HULL_DAMAGE: 30,
  SHIELD_STARS: 3,
  SHIELD_HP: 60,
  SHIELD_RADIUS: 2,
  HEALER_STARS: 3,
  HEAL_PER_SECOND: 3,
  HEAL_RADIUS: 2,
  SALT_DAMAGE_MULT: 1.25,
  ARMOUR_FLOOR: 1,

  // 12 · Treasure and features
  // Each point of interest is worked by a crew member standing on it, and only
  // once the ground is open — a chest under forest is two turns, one to cut the
  // tile and one to dig. The spring is the exception: it is held, not worked.
  FEATURES: {
    cache: { count: 12, gold: 220, action: 'dig up' },
    spring: { count: 1, handsCap: 3 },
    officer: { count: 1, action: 'save' },
    wreck: { count: 3, wood: 40, action: 'search' },
  },
  FEATURE_MIN_APART: 6,
  CACHE_DIST: [6, 58],   // from the base, across a 2 x ISLAND_RADIUS island
  CACHE_NEAR: [5, 11],   // the first few sit within reach of the landing
  CACHE_NEAR_COUNT: 3,   // ...and gold is the only thing that buys a gun

  // 13 · Officers
  // Four sail with the run. A fifth is found on the island: a random pirate,
  // weaker than a unique — a lesser version of one of these verbs, and only
  // the generic assault rate.
  OFFICERS: [
    { id: 'builder', name: 'Master Pioneer', verb: 'clears 3 tiles a turn by himself', role: 'clear' },
    { id: 'weapons', name: 'Weapons Master', verb: 'items cost 25% less', role: 'item' },
    { id: 'gunner', name: 'Master Gunner', verb: 'mans one tower alone, +50% power', role: 'man' },
    { id: 'sapper', name: 'Sapper Captain', verb: 'sabotage teams need 2 hands, not 4', role: 'assault' },
  ],
  PIRATE_QUALITY: 0.55, // a random officer is worth this much of a unique
  PIRATE_NAMES: ['Rattlejack', 'Sil the Quiet', 'Bosun Crane', 'Mad Perrott', 'One-Eye Tace', 'Gallows Ryn'],
  // The hands. Nobody signs the articles under their own name, and most of
  // these were earned rather than chosen.
  HAND_NAMES: [
    'Nine-Finger Ned', 'Lucky Tom', 'Wet Bill', 'Stump', 'Cheerful Meg', 'Half-Ear Otto',
    'Widow Cray', 'Dry Jonah', 'Toothless Ann', 'Second-Best Sam', 'Quiet Solly', 'Bucket',
    'Cinders Fay', 'Left Hand Lem', 'Barnacle Rose', 'Patient Dob', 'Gutless Gil', 'Bones Tavey',
    'Sober Pell', 'Squint Marlow', 'Fever Nan', 'Sad Isaac', 'Tallow Kit', 'Two-Coffin Joe',
    'Whistling Vane', 'Lamprey', 'Rat-Catcher Pye', 'Mourning Bess', 'Splinter Cole', 'Chum',
    'Scurvy Doll', 'Spare Parts Finn', 'Grave-Digger Ruth', 'Last-Week Wick', 'Ballast Hobb',
    'Weeping Ash', 'Fingers Delaney', 'Mouldy Pat', 'Salt Lick Ivo', 'Hopeful Grum',
    'Unlucky Prue', 'Boiled Corrin', 'Deadweight Shaw', 'Kindling Nell', 'Knuckles Marsh',
  ],
  BUILDER_TILES_PER_TURN: 3,
  GUNNER_POWER_BONUS: 0.50,
  ASSAULT_HANDS_CAPTAIN: 2,

  // 14 · Real-time resolve
  TICK_HZ: 30,
  RESOLVE_CAP_SECONDS: 60,
  SPEED_OPTIONS: [1, 3, 'skip'],

  EPSILON: 1e-6,
};

C.TERRAIN_KEYS = Object.keys(C.TERRAIN);

// The mix as measured over natural ground: ocean, beach and works excluded,
// road dropped, the rest renormalised to 100.
C.MIX_NATURAL = (() => {
  const src = { ...C.TERRAIN_MIX };
  delete src.road;
  const total = Object.values(src).reduce((a, b) => a + b, 0);
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = (v / total) * 100;
  return out;
})();

// power(tier) = TIER_BASE ^ (tier - 1)
C.power = (tier, evolved) => {
  const base = Math.pow(C.TIER_BASE, (evolved ? C.MAX_TIER : tier) - 1);
  return evolved ? base * C.EVOLVED_MULT : base;
};
C.manningFor = (tier, evolved) => (evolved ? C.TOWER_MANNING.evolved : C.TOWER_MANNING[tier]);
C.footprintFor = (tier, evolved) => (evolved ? C.TOWER_FOOTPRINT.evolved : C.TOWER_FOOTPRINT[tier]);
C.actOf = (turn) => Math.min(C.ACTS, Math.floor((turn - 1) / C.TURNS_PER_ACT) + 1);
/** Turns of walking before work begins; the arrival turn is itself a work turn. */
C.travelTurns = (dist) => C.TRAVEL.find((t) => dist <= t.within).turns;
/** The drag as a speed, which is how it is always shown: road 1.00x, tar 0.20x. */
C.enemySpeed = (kind) => 1 / C.TERRAIN[kind].advance;
/** Turns of one worker's labour to cut this ground; per-terrain, else the default. */
C.turnsToClear = (terrain) => (C.TERRAIN[terrain] && C.TERRAIN[terrain].turns) || C.TURNS_PER_TILE;
C.buildingDef = (type) => C.BUILDINGS.find((b) => b.type === type);
/** The fixed shape of a building of n tiles: axial offsets from its anchor. */
C.buildingShape = (n) => C.BUILDING_SHAPES[n] || C.BUILDING_SHAPES[1];
/** That shape laid on the map at (q, r). */
C.buildingTiles = (n, q, r) => C.buildingShape(n).map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
/** What this building costs, falling back to the spec's flat price. */
C.buildingCost = (type) => (C.buildingDef(type) || {}).cost || C.BUILDING_COST;
/** The verb for working a point of interest, or null if it is not worked at all. */
C.featureAction = (kind) => (C.FEATURES[kind] ? C.FEATURES[kind].action || null : null);
// Each tower takes its own fitting; they are not interchangeable.
C.itemName = (i) => (C.TOWERS[i] ? (C.TOWERS[i].item || `${C.TOWERS[i].name} fitting`) : 'fitting');
C.itemShort = (i) => (C.TOWERS[i] ? (C.TOWERS[i].itemShort || C.itemName(i)) : 'fitting');

export default Object.freeze(C);
