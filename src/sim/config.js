// 00-constants.md as one frozen object.
// Nothing anywhere else may hard-code a number that appears here.
// Values tagged [cal] are calibration targets, not fixed rules.

const C = {
  // 2 · Run frame
  // A session is meant to be an hour at the table. A won run used to take 120
  // turns of a 300-turn frame and about ninety minutes, so the whole clock is
  // cut to a third: three acts of 33 turns, escalation every 11, and an island
  // a third of the width to walk across. Nothing about the shape of the run
  // changes — the same three acts, the same star curve, the same road out —
  // it is played at three times the pace.
  TURNS_PER_RUN: 99,
  TURNS_PER_ACT: 33,
  ACTS: 3,
  // The map is a round island ringed by open ocean. The grid is centred on the
  // island; the base is the ship, landed on the first tile of the south beach.
  //
  // ISLAND_RADIUS sets everything else. The hive sits just inside the opposite
  // shore, so a cohort crosses about 2 x ISLAND_RADIUS tiles to reach the ship —
  // at ~2.5 tiles a turn that is the ~17-27 turn approach the design runs on.
  // Raising it makes a bigger island and a proportionally longer approach.
  ISLAND_RADIUS: 12,
  OCEAN_MARGIN: 4,
  MAP_RADIUS: 19, // ISLAND_RADIUS + OCEAN_MARGIN + the coast's outward swing
  COAST_LOBES: 1.5,  // smooth bays and headlands
  COAST_JAG: 0.8,    // per-tile raggedness on top
  LANDING_BEARING: 90, // +y is south on screen; the ship lands on the south beach
  // The sea is allowed one or two proper intrusions into the island: a bay —
  // a wide mouth narrowing inland — or a strait, a long narrow channel that
  // runs deep and stops short of the far shore. Salt water cannot be bridged,
  // so what these place is a permanent detour: the cohort walks round it, and so
  // does your road. They keep clear of the landing bearing, because a ship put
  // ashore inside a bay is a ship with nowhere to go.
  // One water feature, not two: a bay and a strait on a 12-tile island are a
  // bay and a strait on top of each other. The dimensions are the old ones cut
  // by a third — a mouth wider than the island's radius is not a bay, it is a
  // channel that saws it in half.
  WATER_FEATURE_COUNT: [1, 1],
  WATER_FEATURE_OFF_LANDING: 55, // degrees clear of the landing, and of each other
  BAY_MOUTH: [2, 3],
  BAY_LENGTH: [3, 5],
  STRAIT_WIDTH: [1, 1],
  STRAIT_LENGTH: [5, 9],
  STRAIT_STOP_SHORT: 2, // land left standing between its head and the far shore
  SPAWNER_INSET: 1,    // how far inside the far shore a spawner stands
  SPAWNER_RING: 15,
  SPAWNER_RING_JITTER: 1,
  // The hive sits straight across the island from the landing. The shell
  // spawner flanks it, measured round the island's centre.
  HIVE_JITTER: 12,
  FLANK_OFFSET: [50, 72],
  BASE_FOOTPRINT: 7,
  ARMADA_TURN: 99,
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
    forest: { clearable: true, yield: { wood: 14 }, buildable: true, passable: true, assaultPassable: true, advance: 3.0, targetableVirgin: false, blocksSight: false },
    // Old timber: a tenth more wood than forest for the same three turns. The
    // margin is deliberately thin — felling a canopy stand is worth doing for
    // the shadow it lifts off everything behind it, and the extra wood is a
    // sweetener rather than the reason.
    canopy: { clearable: true, yield: { wood: 15 }, buildable: true, passable: true, assaultPassable: true, advance: 3.0, targetableVirgin: false, blocksSight: true },
    // Scrub is thin enough to march through on the way in, but a swarm at full
    // tilt will not push into it — the charge keeps to open ground.
    //
    // It is also a third of forest's wood, so it is cut in a third of the time:
    // one turn, not three. The wood per worker per turn comes out the same
    // either way — what it buys is tempo. A road driven through scrub reaches
    // three times as far for the same labour, which makes the thin ground worth
    // routing along instead of worth avoiding.
    scrub: { clearable: true, yield: { wood: 5 }, turns: 1, buildable: true, passable: true, assaultPassable: false, advance: 1.5, targetableVirgin: true, blocksSight: false },
    stone: { clearable: true, yield: { stone: 45 }, buildable: true, passable: false, assaultPassable: false, advance: 2.0, targetableVirgin: true, blocksSight: false },
    // Rare ore, worked like a boulder. The Forge still turns stone into iron;
    // this is the seam you can dig instead of smelting for it.
    iron: { clearable: true, yield: { iron: 45 }, buildable: true, passable: false, assaultPassable: false, advance: 2.0, targetableVirgin: true, blocksSight: false },
    road: { clearable: false, yield: {}, buildable: true, passable: true, assaultPassable: true, advance: 1.0, targetableVirgin: true, blocksSight: false },
    sand: { clearable: false, yield: {}, buildable: false, passable: true, assaultPassable: true, advance: 2.0, targetableVirgin: true, blocksSight: false },
    // Open grass. Nothing to cut and nothing under it, so it is walked rather
    // than worked — by the crew as well as by the enemy, which is what sets it
    // apart from scrub: a swarm at full tilt will cross a meadow and will not
    // push into thin wood. Easier going than sand, harder than a salt pan.
    //
    // It exists to break up open ground. Sand and salt were the whole of it and
    // both read as pale, so a coast-to-coast walk was one colour; the meadow's
    // share is taken out of theirs rather than off the clearable ground, which
    // leaves the wood and stone on the island exactly where they were.
    //
    // Buildable, and the only ground on the island that is buildable without
    // first being cut. That makes a meadow worth finding: a tower goes up on
    // one for nothing, and because it never becomes road, a tower standing in
    // one adds no entry for a cohort to arrive down either.
    meadow: { clearable: false, yield: {}, buildable: true, passable: true, assaultPassable: true, advance: 1.5, targetableVirgin: true, blocksSight: false },
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
    meadow: '#9aad5e',
    cliff: '#5a5048', saltwater: '#25506e', tar: '#241f1c',
  },
  // 02-map.md §3.5 — target mix in points, over land tiles
  // iron is carved out of forest and scrub: rare, and never near enough
  // The meadow's 2.5 points come out of sand's 6 and salt's 1 and nowhere else,
  // so the clearable share of the island — and with it every wood and stone
  // number in the economy — is exactly what it was. Salt halves rather than
  // vanishes: it is the one ground a cohort crosses at road speed, and that is
  // worth keeping rare rather than losing.
  TERRAIN_MIX: {
    forest: 40, canopy: 2, scrub: 23, stone: 10, iron: 2, road: 3,
    sand: 4, meadow: 2.5, salt: 0.5, freshwater: 8, cliff: 4,
  },
  // Three points, not two. The mix is measured over land tiles and the island
  // is a ninth of the area it was, so one tile is now a fifth of a point where
  // it used to be a twentieth: the same generator that hit +-2 comfortably at
  // radius 36 cannot always round its way inside it at radius 12.
  MIX_TOLERANCE: 4,
  // Generation lays no road at all: every road tile on a live map is ground the
  // player cleared. Road therefore leaves the natural mix and its 3 points are
  // shared out across what actually grows.
  CLEARABLE_FLOOR: 0.40,
  // The landing. The ship is run aground in a cove: a strip of beach under it,
  // ocean at its back, and a broken wall of cliff round the land side. Nothing
  // else there is opened for you — no corridor, no apron, and no road anywhere
  // on the island. Every road tile on the map is one the player cut, so the
  // shape of the supply line is a decision rather than a starting condition.
  LANDING_BEACH_SPAN: 2,   // how far along the shore the landing beach reaches
  LANDING_BEACH_DEPTH: 1,  // and how far back from the waterline it runs
  // ...and the wide cove beach stays on the ship's seaward side: it is the
  // ground between the ship and the water, and the way inland is ordinary
  // island the player has to cut. It used to have to stay seaward on pain of
  // walling the ship in, because sand can never be cut and the network was
  // road-only; the network is open ground now, so sand joins rather than
  // blocks, and the apron below rings the ship on every side.
  LANDING_BEACH_ARC: 90,
  // The apron: one tile of sand all the way round the ship's standing, so a
  // hand can walk out of the hull in any direction and nothing — cliff, wood,
  // rock or stream — is ever jammed against the hull itself. It sits outside
  // the terrain mix like every other beach.
  LANDING_APRON: 1,
  // Cuttable ground the apron must touch, or the island is rerolled. Measured
  // at the apron's edge rather than against the hull: the ship no longer needs
  // a face it can cut, only somewhere to cut once the crew are off the sand.
  LANDING_EXITS_MIN: 3,
  // Sand is where a boat can be run aground, not the whole shoreline. A few
  // more beaches sit round the rim; everywhere else the island grows down to
  // the water, so most of the coast is ground you have to cut.
  EDGE_BEACH_COUNT: [2, 3],
  EDGE_BEACH_SIZE: [3, 7],
  EDGE_BEACH_MIN_APART: 5,
  // The cove wall. It stands outside STRUCTURE_KEEPOUT so the ship keeps its
  // firing arcs, and it is broken: one gap always sits on the corridor bearing
  // so the way inland is never sealed, plus a couple more. A cohort cannot climb
  // cliff, so every approach funnels through a gap — which is what makes the
  // landing worth defending rather than merely surrounded.
  LANDING_CLIFF_RADIUS: 4,
  LANDING_CLIFF_COURSES: 1,     // how many rings deep the wall stands
  LANDING_CLIFF_ARC: 105,       // half-arc round the inland bearing; sea does the rest
  // Ways through the wall, counting the one always on the corridor bearing.
  // Cut as bearings before the ground is settled, then checked again once it is
  // and reopened if a stream or a boulder field has silted one up; an island
  // that still cannot offer LANDING_ENTRANCES[0] of them is rejected.
  LANDING_ENTRANCES: [2, 3],
  // Narrower than the 10-15 the big island used: a doorway is measured in
  // degrees and cut in tiles, and at radius 4 one tile of the ring is 15 deg —
  // so the old half-width was a gap three tiles wide, which is not a doorway,
  // it is the wall missing.
  LANDING_CLIFF_GAP_HALF: [5, 8], // half-width of a gap, degrees
  // The fresh-water spokes radiate from a hub just inland of the landing. Left alone
  // they seal the landing site off and leave the ship no arc to fire down, so
  // nothing impassable is generated inside this radius.
  STRUCTURE_KEEPOUT: 2,
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
  //
  // This list is also the enemy's road in. Open ground joined to the ship is
  // one network — see `shipNetwork` — so a run of beach or meadow is a supply
  // line the island handed you and a lane the cohorts march up, both at once.
  // No road ever runs *over* sand, but a walk along it counts.
  // The meadow is here for the same reason the beach is: there is nothing on it
  // to cut, so a chest lying in one has to be reachable without cutting.
  WORK_OPEN_TERRAIN: ['road', 'sand', 'salt', 'meadow'],
  BRIDGE_COST_WOOD: 65,
  CLEARED_BECOMES: 'road',

  // 4 · Labour
  HANDS_START: 3,
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
  // Cut from 5/25 with the rest of the clock, but not by a flat third: what the
  // first band has to buy is "work beside the ship costs no walk", and the
  // landing's own apron and cliff ring put the first frontier three or four
  // tiles out. At `within: 2` the crew spent their first turn walking to the
  // nearest face on the island, which is not a decision, only a delay.
  TRAVEL: [{ within: 4, turns: 0 }, { within: 12, turns: 1 }, { within: Infinity, turns: 2 }],
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
  // A quarter off both halves of the price: at 300 and 40 the boat was payable
  // on the schedule and never actually paid for, because everything else the
  // wood buys — a yard, a gun, a hull patched back up — buys it this turn where
  // a flare buys five hands in two.
  FLARE_COST_WOOD: 120,
  // [cal] — spec value 120. A Forge makes 1 iron a turn and is the only source,
  // so at 120 a run affords one flare on turn 144 against the six the acts are
  // built around: the crew could never grow. It matters now that it could not,
  // because the gun line act 3 demands is nine hands of the ten you land with.
  FLARE_COST_IRON: 30,
  FLARE_HANDS: 3,
  FLARE_DELAY_TURNS: 2,
  FLARE_DELAY_POWDER: 1,
  FLARE_POWDER_DISCOUNT: 0.25,
  FLARE_GATE: [1, 3, 6], // cumulative, by act
  // 04-economy.md makes the act gate the only limiter, so the moment an act
  // opens with a full purse two boats land on consecutive turns. A minimum
  // spacing keeps the six spread over the run they are meant to pace.
  FLARE_COOLDOWN: 4,

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
  // The ship's own shot, which is not a tower's and should not read as one.
  SHIP_SHOT_COLOUR: '#dfe6f2',
  REPAIR_WOOD_PER_HULL: 25,
  HOLD_SLOTS: 5,

  // 7 · Towers
  TIER_BASE: 2.5,
  EVOLVED_MULT: 2.5,
  TOWER_MANNING: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, evolved: 2 },
  // A tower's ground is a property of the gun, not of the tier: the yard a
  // Culverin Battery needs is the yard it needs on the day it is raised, and a
  // better fitting dropped in later is a better gun in the same emplacement.
  // Tiering used to grow the footprint, which meant a tower could be refused a
  // fitting it had the wood for because the ground beside it had since filled
  // in — a rule the player could neither see coming nor plan around. Each
  // tower's own `tiles` is now its shape for life, 1 to 3, laid out of
  // BUILDING_SHAPES exactly as a yard's is.
  TOWER_COST: { wood: 30, stone: 20 },
  // v6: "A tower needs an item to be built" — the emplacement is wood and
  // stone, but the gun itself is a tier-1 fitting out of the hold. Set false to
  // fall back to spec/04-economy.md, where the emplacement is the whole cost.
  TOWER_NEEDS_ITEM: true,
  // v7: the fitting in the gun can be merged with a matching one out of the
  // hold, which is the only way past the tier a tower was built at short of
  // taking it down. It is work in the yard rather than a swap: three turns, and
  // the gun goes on firing at the tier it has while they are done.
  TOWER_MERGE_TURNS: 3,
  DISASSEMBLE_REFUND: 0.80,
  CLIFF_RANGE_BONUS: 1,
  MAX_TIER: 5,

  // Ranges are deliberately short. A tower covers a corridor, so where the road
  // runs past it is a decision — and a Palisade is how you make the enemy take
  // the corridor you built.
  //
  // `source` is where the fitting comes from, and there is exactly one route to
  // each. Iron fittings are ironwork — a barrel, a bore, a length of chain —
  // and a Workshop makes them out of iron. Everything else is a living thing or
  // a keg of powder: nobody on the crew makes those, they are bought off the
  // Peculiar Merchant for gold and cannot be made at any price.
  TOWERS: [
    { i: 0, name: 'Swivel Gun Post', shelf: 'gunnery', range: 2, shape: 'single', tiles: 1, rate: 'fast', essence: 'Scatter', fire: 'fast single target', colour: '#c8b45a', item: 'Swivel Gun', itemShort: 'Swivel', source: 'iron' },
    { i: 1, shelved: true, name: 'Culverin Battery', shelf: 'gunnery', range: 4, shape: 'single', tiles: 2, rate: 'slow', essence: 'Bore', fire: 'slow single target', colour: '#b9743f', item: 'Culverin', itemShort: 'Culverin', source: 'iron' },
    { i: 2, shelved: true, name: 'Chain-Shot Gallery', shelf: 'gunnery', range: 3, shape: 'file', tiles: 2, rate: 'normal', essence: 'Rake', fire: 'pierces a file along the road', colour: '#a85c5c', item: 'Chain-Shot', itemShort: 'Chain-Shot', source: 'iron' },
    { i: 3, shelved: true, name: 'Dynamite Throwers', shelf: 'gunnery', range: 3, shape: 'blast', tiles: 2, rate: 'slow', essence: 'Blast', fire: 'slow blast, radius 1', colour: '#d0603a', item: 'Powder Charge', itemShort: 'Charge', source: 'gold' },
    { i: 4, name: 'Parrot Swarm Aviary', shelf: 'beasts', range: 3, shape: 'multi', tiles: 3, rate: 'fast', essence: 'Swarm', fire: 'many weak hits, up to 4 targets', colour: '#4fae7a', item: 'Parrot Cage', itemShort: 'Parrots', source: 'gold' },
    { i: 5, shelved: true, name: 'Alligator Guards', shelf: 'beasts', range: 1, shape: 'single', tiles: 2, rate: 'normal', essence: 'Snag', fire: 'holds what it hits in place', colour: '#5e8a3a', item: 'Alligator Egg', itemShort: 'Gator Egg', source: 'gold' },
    { i: 6, shelved: true, name: 'Krakenling Well', shelf: 'beasts', range: 1, shape: 'adjacent', tiles: 1, rate: 'normal', essence: 'Sweep', fire: 'hits every adjacent road tile', colour: '#5a7fae', item: 'Krakenling Spawn', itemShort: 'Krakenling', source: 'gold' },
    { i: 7, shelved: true, name: 'Monkey Riggers', shelf: 'beasts', range: 2, shape: 'single', tiles: 1, rate: 'normal', essence: 'Plunder', fire: 'yields 2 gold per kill', colour: '#b58b4a', item: 'Monkey Troop', itemShort: 'Monkeys', source: 'gold' },
  ],
  BLAST_RADIUS: 1,
  // Shot on the map. A gun's damage is a rate, applied every tick — what the
  // player sees has to be a discrete thing leaving the barrel or the fight
  // reads as eight towers pointing at the swarm. So the gun keeps its rate and
  // throws a round on its own cadence: the projectile is the telling, not the
  // arithmetic, and nothing about where it is changes what anything takes.
  SHOT_INTERVAL: { fast: 0.16, normal: 0.42, slow: 0.85 },
  PROJECTILE_SPEED: 11,   // tiles a second, so a 4-tile shot is in the air ~0.36 s
  PROJECTILE_MAX: 300,    // a ceiling for a fight run out with nobody watching
  IMPACT_SECONDS: 0.18,
  SHIP_SHOT_RATE: 'normal',
  FILE_LENGTH: 3, // target tile plus the two behind it
  MULTI_TARGETS: 4,
  PLUNDER_GOLD_PER_KILL: 2,
  EVOLUTION_OFFSETS: [1, 7],
  EVOLUTION_MOD: 20,

  // 8 · Items
  // Neither price is a shop you carry with you. A fitting is crafted at a
  // Workshop or bought off a Peculiar Merchant, and which of the two is a
  // property of the fitting (see `source` above), not a choice: the hold is
  // filled by putting up the house that fills it.
  ITEM_CRAFT_IRON: 6,
  ITEM_BUY_GOLD: 8,
  WEAPONS_MASTER_DISCOUNT: 0.25,

  // 8b · The Trading Dock's counter
  // The dock's standing trade turns the surplus into gold a lot at a time and
  // asks nobody. The counter is the other half of it: goods bought and sold to
  // order, in whatever quantity, struck on the spot. It is not labour, so it
  // does not go through the queue and does not wait for a turn to resolve.
  //
  // `per` is the lot the prices are quoted against, `sell` what the dock pays
  // for one and `buy` what it asks. The spread is 2x throughout, and the wood
  // and stone sell price is DOCK_INPUT for DOCK_GOLD_OUT — the counter pays
  // exactly what the dock's own trade does, so selling by hand is a matter of
  // timing rather than a better rate. Iron is dear on both sides: it is a turn
  // of the Forge's work, not a heap on the beach.
  TRADE_GOODS: ['wood', 'stone', 'iron'],
  TRADE: {
    wood: { per: 12, sell: 1, buy: 2 },
    stone: { per: 12, sell: 1, buy: 2 },
    iron: { per: 1, sell: 1, buy: 2 },
  },

  // 9 · Economic buildings
  BUILDING_COST: { wood: 120, stone: 80 },
  BUILDING_HANDS: 2,
  BUILDING_HANDS_BUNKHOUSE: 1,
  // Gold spent on a building's works so it runs with one hand fewer. It stacks
  // with a Bunkhouse: two hands, one inside a Bunkhouse's radius, none at all
  // for an upgraded building that also stands inside one. Bought once per
  // building — there is nothing below nobody.
  CREW_UPGRADE_GOLD: 50,
  // Pulling a yard down again. Higher than a tower's 80% on purpose: a gun is
  // an emplacement and a fitting, and the fitting comes back whole, where a yard
  // is nothing but the wood and stone that went into it. What is lost is the
  // turn it took to build and the turn it takes to build again somewhere else —
  // which is the right price for changing your mind about where a house goes.
  BUILDING_REFUND: 0.90,
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
    { type: 'forge', shelved: true, name: 'Forge', tiles: 4, cost: { wood: 110, stone: 70 }, owns: 'iron', effect: '3 stone -> 1 iron per turn', repeatable: false },
    { type: 'workshop', name: 'Workshop', tiles: 5, cost: { wood: 150, stone: 100 }, owns: 'ironwork', effect: 'iron fittings craftable at 6 iron', repeatable: false },
    { type: 'dock', shelved: true, name: 'Trading Dock', tiles: 5, cost: { wood: 140, stone: 90 }, owns: 'the surplus', effect: '12 wood or stone -> 1 gold per turn, and a counter to trade over', repeatable: false },
    // The other half of the hold. Five of the eight fittings are things no crew
    // makes — powder, birds, eggs, spawn, monkeys — and this is the only door
    // they come through. Cheap, small, and the one yard on the shelf that runs
    // on a single hand: it gates every gun of its shelf, and a gate that costs
    // a fifth of the company to open is a gate nobody opens in time. The
    // merchant keeps his own counter; the hand is there to carry.
    { type: 'merchant', name: 'Peculiar Merchant', tiles: 3, crew: 1, cost: { wood: 90, stone: 60 }, owns: 'oddities', effect: 'gold fittings can be bought at 8 gold; runs on one hand', repeatable: false },
    { type: 'tinker', shelved: true, name: "Tinker's Shed", tiles: 4, cost: { wood: 130, stone: 90 }, owns: 'evolution', effect: 'evolutions become possible', repeatable: false },
    { type: 'sappers', name: "Sappers' Camp", tiles: 6, cost: { wood: 380, stone: 260 }, owns: 'offence', effect: 'sabotage teams can be raised', repeatable: false },
    { type: 'hospital', shelved: true, name: 'Hospital', tiles: 3, cost: { wood: 90, stone: 60 }, owns: 'downtime', effect: 'sabotage downtime 3 -> 1 turn', repeatable: false },
    { type: 'powder', name: 'Powder Store', tiles: 3, cost: { wood: 75, stone: 53 }, owns: 'the flare', effect: 'flare cost -25%, lands in 1 turn', repeatable: false },
    { type: 'excavation', shelved: true, name: 'Excavation Camp', tiles: 4, cost: { wood: 100, stone: 60 }, owns: 'buried gold', effect: 'works one cache: 220 gold over 10 turns', repeatable: true },
    { type: 'bunkhouse', shelved: true, name: 'Bunkhouse', tiles: 3, cost: { wood: 50, stone: 40 }, owns: 'manning', effect: 'buildings within radius 3 cost 1 hand', repeatable: true },
    // Not an economy at all: one tile of ground the enemy will not cross. It is
    // exempt from both rules below — a palisade that needed a road beside it and
    // could not touch its neighbour would not be a wall.
    //
    // A tower's price for a tile of ground the enemy will not cross, and no gun
    // on it. It was 140 wood and 90 stone — dearer than a Bunkhouse for one hex,
    // which priced out the first wall rather than the tenth — then a third of
    // that, and now the same 30 and 20 an emplacement costs. What should stop a
    // player walling the island in is the labour and the ground it takes, not a
    // price that rules out trying it at all.
    //
    // `blocksCrew` is what makes it a wall and not a yard: the crew walk through
    // the ship and through their own workshops, and stop at this.
    { type: 'wall', name: 'Palisade', tiles: 1, cost: { wood: 30, stone: 20 }, crew: 0, economic: false, blocksCrew: true, owns: 'the ground', effect: 'the enemy will not cross it; needs no crew', repeatable: true },
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
  // The Trading Dock is the one building that stands in the water: three tiles
  // of salt water carrying the jetty, and two of shore behind them carrying the
  // counter. Its own shape, not one of the sizes below, because the two halves
  // are not interchangeable — the water tiles must be water and the land tiles
  // must be ground a building could stand on.
  //
  // Written as it reads on a south-facing shore: the anchor and its neighbour
  // on the land, the three water tiles in the row beneath. `dockPlans` turns
  // that into all six rotations, so a dock on the north coast is the same
  // building the other way up rather than a building that cannot be built.
  DOCK_SHAPE: { land: [[0, 0], [1, 0]], water: [[-1, 1], [0, 1], [1, 1]] },

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
  // Who is holding the charges. A unique lieutenant is a two-thirds job; the
  // Sapper Captain is the man whose trade this is and is nearly sure of it; a
  // pirate off the island, or a team with nobody over it, manages the generic
  // rate — which is the campaign's whole progression lever, so the gap between
  // the ends of it is deliberately wide.
  SUCCESS_NAMED: 0.65,
  SUCCESS_CAPTAIN: 0.90,
  SUCCESS_GENERIC: 0.40,
  // How far out from the spawner the team gathers before the charges go in.
  // Two tiles: close enough that the last dash is the mission itself, far
  // enough that the staging ground is somewhere you had to open a way to.
  STAGING_DISTANCE: 2,
  // ...and how long the mission itself takes once they are all in position.
  // The length of a mission is the length of your road; this is the fuse.
  STRIKE_TURNS: 1,
  DOWNTIME_TURNS: 3,
  DOWNTIME_HOSPITAL: 1,
  EXCLUSION_RADIUS: 3,

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
  ESCALATION_TURNS: 11,
  // What an act costs on top of the clock. The regular escalation is one star
  // on one spawner every 11 turns; the turn an act opens, two more land on top
  // of it. That is what makes an act a threshold rather than a label — act 2
  // and act 3 each arrive as a step, not as more of the same.
  ACT_ESCALATION: 2,
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

  // Speeds are close together on purpose, and closer than the spec's 1.2 / 0.6.
  //
  // What separates the two kinds is armour and hull damage, not pace. A Shell
  // at half a Grub's speed sorted every mixed cohort back into two waves
  // whatever order they set off in — over a nine-tile road the Grubs arrived at
  // 23-38 seconds and the Shells at 49-71, so the fast half was fought and dead
  // before the armoured half turned up, and a gun line only ever met one
  // problem at a time. At 80% they arrive inside the same window and a rank is
  // a rate-of-fire problem and a penetration problem at once, which is what a
  // cohort is supposed to be. The elite's own multiplier moved with them.
  UNITS: {
    grub: { name: 'Grub', share: 0.70, hp: 10, armour: 0, speed: 0.4, hullDamage: 4, colour: '#e0b0a0' },
    shell: { name: 'Shell', share: 0.30, hp: 30, armour: 3, speed: 0.32, hullDamage: 9, colour: '#8a4030' },
  },
  ELITE_HP_MULT: 10,
  ELITE_SPEED_MULT: 0.8,
  ELITE_HULL_DAMAGE: 30,
  // How a cohort comes on. `pos` is a unit's place along the path in tiles, and
  // a negative one is a unit that has not stepped onto it yet — so this is the
  // shape of the column at the moment of contact. It used to be one unit every
  // 0.45 tiles, single file, which turned a cohort of 72 into a queue 32 tiles
  // long trickling past the guns one at a time: the fight was long, thin and
  // never in doubt either way.
  //
  // Three abreast, and the rank behind close on its heels. What that buys is a
  // wave that arrives as a wave — the guns are overlapped rather than fed, and
  // whether the line holds is decided in seconds rather than by attrition.
  CONTACT_ABREAST: 2,
  CONTACT_RANK_GAP: 0.35,  // tiles between one rank and the next
  CONTACT_JITTER: 0.25,    // ...and the slop in it, so a rank is a crowd, not a row
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
  // tile and one to dig.
  //
  // The spring used to be the exception: held rather than worked, paying `+3` to
  // a cap for exactly as long as somebody stood on it. That was a rule from when
  // hands were a number. They are named bodies now, so a cap they count against
  // is bookkeeping about a thing that no longer exists — and standing a man on a
  // spring for the rest of the run to be allowed three more of him was a worse
  // trade than it looked. It pays what it always meant: three hands, ashore,
  // for good.
  FEATURES: {
    cache: { count: 12, gold: 100, action: 'dig up' },
    spring: { count: 1, hands: 3, action: 'draw from' },
    officer: { count: 1, action: 'save' },
    // A wreck is a ship, so she is carrying a ship's stores: her timbers, the
    // iron out of her fittings, and what little was in the strongbox. Written
    // as one line per resource and read out in that order everywhere.
    wreck: { count: 3, wood: 60, iron: 30, gold: 10, action: 'search' },
  },
  FEATURE_MIN_APART: 2,
  CACHE_DIST: [2, 20],   // from the base, across a 2 x ISLAND_RADIUS island
  CACHE_NEAR: [2, 4],    // the first few sit within reach of the landing
  CACHE_NEAR_COUNT: 3,   // ...and gold is spendable at a Merchant as it comes in

  // 13 · Officers
  // Four sail with the run. A fifth is found on the island: a random pirate,
  // weaker than a unique — a lesser version of one of these verbs, and only
  // the generic assault rate.
  OFFICERS: [
    { id: 'builder', name: 'Master Pioneer', verb: 'clears 3 tiles a turn by himself', role: 'clear' },
    { id: 'weapons', name: 'Weapons Master', verb: 'items cost 25% less', role: 'item' },
    { id: 'gunner', name: 'Master Gunner', verb: 'mans one tower alone, +50% power', role: 'man' },
    // Not a trade that works from the roster: the charges are his job, so he has
    // to be the one going. Leading, he is 90% where another lieutenant is 65%,
    // and the team he leads is two hands rather than four.
    { id: 'sapper', name: 'Sapper Captain', verb: 'leads a sabotage team: 90%, and 2 hands rather than 4', role: 'assault' },
  ],
  // One of the four works from the roster: the Weapons Master's discount applies
  // because the man is in the company, not because he was put on a job. The
  // other three are jobs — the Pioneer has to be sent to cut, the Gunner has to
  // be stood in a tower, the Sapper Captain has to go with the charges — and the
  // difference is worth saying on the line the player reads before deciding
  // where he goes.
  PASSIVE_ROLES: ['item'],
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
  // The backstop, and only that: a fight is over when everyone is dead or
  // everyone has arrived. It has to be long enough that no cohort ever runs out
  // of clock — a wave that evaporates is a wave the player never had to fight,
  // and it rewarded building the longest road you could. At a third of the old
  // unit speed a slow column crossing the island end to end is minutes of
  // resolve, so the cap is set well past anything a real fight takes.
  RESOLVE_CAP_SECONDS: 600,
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
/** How much ground a tower of this kind stands on — the same at every tier. */
C.footprintFor = (towerIndex) => (C.TOWERS[towerIndex] ? C.TOWERS[towerIndex].tiles : 1);
/** Its fixed shape laid on the map at (q, r), out of the same table a yard uses. */
C.towerTiles = (towerIndex, q, r) => C.buildingTiles(C.footprintFor(towerIndex), q, r);
/** Seconds between rounds leaving this gun. Visual cadence only. */
C.shotInterval = (rate) => C.SHOT_INTERVAL[rate] || C.SHOT_INTERVAL.normal;
C.actOf = (turn) => Math.min(C.ACTS, Math.floor((turn - 1) / C.TURNS_PER_ACT) + 1);
/** Turns of walking before work begins; the arrival turn is itself a work turn. */
C.travelTurns = (dist) => C.TRAVEL.find((t) => dist <= t.within).turns;
/** The drag as a speed, which is how it is always shown: road 1.00x, tar 0.20x. */
C.enemySpeed = (kind) => 1 / C.TERRAIN[kind].advance;
/** Turns of one worker's labour to cut this ground; per-terrain, else the default. */
C.turnsToClear = (terrain) => (C.TERRAIN[terrain] && C.TERRAIN[terrain].turns) || C.TURNS_PER_TILE;
/** Does this officer's trade work from the roster rather than from a job? */
C.isPassiveRole = (role) => C.PASSIVE_ROLES.includes(role);
/**
 * What an officer does, as it is shown.
 *
 * Read off the table by id rather than out of the run, and marked here rather
 * than in the verbs. A run stores its officers' verbs as they read on the day it
 * was started, so a run in progress would otherwise go on quoting whatever the
 * trade used to do long after it changed — which is exactly what happened when
 * the Sapper Captain stopped shrinking teams from the roster. The pirate is the
 * one who keeps his own: his verb is a sentence written when he joined, about a
 * lieutenant's trade and about his being a lesser copy of it.
 */
C.officerVerb = (o) => {
  if (!o) return '';
  const def = C.OFFICERS.find((d) => d.id === o.id);
  const verb = def ? def.verb : o.verb;
  return C.isPassiveRole(o.role) ? `${verb} (passive)` : verb;
};
C.buildingDef = (type) => C.BUILDINGS.find((b) => b.type === type);
/**
 * Content that exists in the design and is switched off in this build.
 *
 * A balance pass is a conversation about a small number of moving parts, and
 * this prototype has eight tower kinds, twelve yards and two shelves of
 * fittings — most of which were not in the run being tuned. They are shelved
 * rather than deleted: the tables, the art and the rules are all still here,
 * and turning one back on is deleting one word.
 *
 * Everything that offers a thing to build asks this, and everything that
 * refuses one says the same sentence, so a player never meets a button that
 * looks live and is not.
 */
C.SHELVED_WHY = 'unavailable in this version';
C.buildingShelved = (type) => !!(C.buildingDef(type) || {}).shelved;
C.towerShelved = (i) => !!(C.TOWERS[i] || {}).shelved;
/** The kinds a run can actually raise, which is what every list should draw. */
C.liveTowers = () => C.TOWERS.filter((x) => !x.shelved);
C.liveBuildings = () => C.BUILDINGS.filter((b) => !b.shelved);
/** The fixed shape of a building of n tiles: axial offsets from its anchor. */
C.buildingShape = (n) => C.BUILDING_SHAPES[n] || C.BUILDING_SHAPES[1];
/** One 60° turn of an axial offset, anticlockwise on screen. */
const turn60 = ([q, r]) => [-r, q + r];
const turned = (offs, n) => {
  let out = offs;
  for (let i = 0; i < n; i++) out = out.map(turn60);
  return out;
};
/**
 * The Trading Dock's six orientations, the written one first.
 *
 * A shore runs whichever way it runs, and a building with a fixed compass
 * direction would be unbuildable on most of the island. The shape is the rule —
 * three water, two land, the water in one row against the land — and the
 * rotation is whichever of the six the ground will take.
 */
C.dockPlans = () => [0, 1, 2, 3, 4, 5].map((n) => ({
  land: turned(C.DOCK_SHAPE.land, n),
  water: turned(C.DOCK_SHAPE.water, n),
}));
/** That shape laid on the map at (q, r). */
C.buildingTiles = (n, q, r) => C.buildingShape(n).map(([dq, dr]) => ({ q: q + dq, r: r + dr }));
/**
 * How far a building's effect reaches from the ground it stands on, or 0 for
 * one that only works where it is. Only the Bunkhouse has a reach, and the
 * radius lives in one place — here it is read back by name rather than copied
 * into the definition, which cannot refer to the table it sits in.
 */
C.buildingRadius = (type) => (type === 'bunkhouse' ? C.BUNKHOUSE_RADIUS : 0);
/** What this building costs, falling back to the spec's flat price. */
C.buildingCost = (type) => (C.buildingDef(type) || {}).cost || C.BUILDING_COST;
/** The verb for working a point of interest, or null if it is not worked at all. */
C.featureAction = (kind) => (C.FEATURES[kind] ? C.FEATURES[kind].action || null : null);
// Each tower takes its own fitting; they are not interchangeable.
/** 'iron' — crafted at a Workshop. 'gold' — bought off a Peculiar Merchant. */
C.itemSource = (i) => (C.TOWERS[i] ? C.TOWERS[i].source : 'gold');
/** The building that is the only route to this fitting. */
C.itemHouse = (i) => (C.itemSource(i) === 'iron' ? 'workshop' : 'merchant');
/** Gold the dock pays for `n` of a good, and gold it asks for the same. Whole gold both ways. */
C.tradeSell = (res, n) => (C.TRADE[res] ? Math.floor((n * C.TRADE[res].sell) / C.TRADE[res].per) : 0);
C.tradeBuy = (res, n) => (C.TRADE[res] ? Math.ceil((n * C.TRADE[res].buy) / C.TRADE[res].per) : Infinity);
C.itemName = (i) => (C.TOWERS[i] ? (C.TOWERS[i].item || `${C.TOWERS[i].name} fitting`) : 'fitting');
C.itemShort = (i) => (C.TOWERS[i] ? (C.TOWERS[i].itemShort || C.itemName(i)) : 'fitting');

export default Object.freeze(C);
