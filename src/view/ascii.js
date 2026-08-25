// The reel's pictures. Plain text, drawn in the page's own monospace face.
//
// Each one is a template literal that opens on its own line, so the art reads
// in the source the way it reads on the screen. `trim` on the way out drops the
// leading newline without touching the internal indentation, which is load
// bearing — every one of these is a grid, not a paragraph.

const art = (s) => s.replace(/^\n/, '').replace(/\s+$/, '');

// ---- points of interest ----------------------------------------------------

export const WRECK = art(`
             \\
          \\   \\
           \\   \\__
      ______\\_______\\____
     /   o     o     o    \\
~~~~/~~~~~~~~~~~~~~~~~~~~~~\\~~~~
  ~~~~~~~    ~~~~~~~~    ~~~~~~
`);

export const CACHE = art(`
       ___________________
      /                   \\
     /_____________________\\
     |    ___              |
     |   | o |    *   *    |
     |___|___|_____________|
      \\___________________/
`);

export const CASTAWAY = art(`
            \\  o  /
              \\|/
               |
              / \\
        _____/___\\_____
    ~~~~~~~~~~~~~~~~~~~~~~~
`);

export const SPRING = art(`
              ,
             /|\\
            ( o )
       .-~~~~~~~~~-.
      (  ~   ~   ~  )
       '-.._______..-'
`);

const POI = { wreck: WRECK, cache: CACHE, officer: CASTAWAY, spring: SPRING };

/** The picture for a site, or the chest as a stand-in for a kind with no art. */
export const forFeature = (kind) => POI[kind] || CACHE;

// ---- the two fronts --------------------------------------------------------
//
// They are drawn as different silhouettes rather than the same shape recoloured,
// because the two spawners are the two halves of the difficulty — the hive is a
// rate-of-fire problem and the shell spawner a penetration one — and the reel is
// the one place both are on the screen side by side.

export const HIVE = art(`
        .-~~~~~-.
      .'  o   o  '.
     /   .-----.   \\
    ;   /  ***  \\   ;
     \\  '.-----.'  /
      './  | |  \\.'
   ~~~~^^^^^^^^^^^~~~~
`);

export const SHELL = art(`
      _.-"""""""-._
    .'  /\\  /\\  /\\  '.
   /   /  \\/  \\/  \\   \\
  ;   |   .-----.   |   ;
   \\   \\  '-----'  /   /
    '._  '-------'  _.'
   ~~~~^^^^^^^^^^^~~~~
`);

const SPAWNER = { hive: HIVE, shell: SHELL };

export const forSpawner = (kind) => SPAWNER[kind] || HIVE;

// ---- what they let go ------------------------------------------------------

export const COLUMN = art(`
   vVv   vVv   vVv   vVv
  (o o) (o o) (o o) (o o)
  /|X|\\ /|X|\\ /|X|\\ /|X|\\
   ^ ^   ^ ^   ^ ^   ^ ^
`);

/**
 * A cohort at the size it actually is: four abreast is the picture above, and a
 * smaller cohort gets fewer files rather than the same block with a lower number
 * printed under it. Capped at four, because the splash is a glance and a column
 * of forty grubs drawn to scale is a wall.
 */
export function column(units) {
  const files = Math.max(1, Math.min(4, Math.ceil(units / 6)));
  const rows = [' vVv ', '(o o)', '/|X|\\', ' ^ ^ '];
  return rows.map((r) => '  ' + Array(files).fill(r).join(' ')).join('\n');
}

// ---- the sabotage mission --------------------------------------------------
//
// The one picture in the game that is a diagram rather than a portrait, because
// what the mission needs explaining is its *shape*: the team walks out of the
// ship, gathers on open ground two tiles short of the spawner, and only then
// goes in. Every part a player can act on is on the line — the road they cut,
// the ground they gather on, the gap they cross.

export const SABOTAGE = art(`
    ship            your road          staging        the last dash
     ___                                  __
    |o o|  >>>  = = = = = = = = = = >    /  \    ...>     ((( X )))
    |___|        cut ground, walked      \__/             the charges
                                       2 tiles out
`);

// ---- how a mission ends ------------------------------------------------------
//
// The one moment in a run that is worth a picture rather than a line: a spawner
// stops existing, or a team walks home with the charges still in the bag. Two
// silhouettes rather than one recoloured, for the same reason the two spawners
// are drawn differently — what happened is legible before the words are read.

export const SABOTAGE_DONE = art(`
            \\   |   /
         \\    .---.    /
       --    .' *** '.    --
            /  *****  \\
       /   |  ** ! **  |   \\
      /     \\  *****  /     \\
             '. *** .'
       ~~~~^^^^^-----^^^^^~~~~
         the mound comes apart
`);

export const SABOTAGE_FAILED = art(`
           .-~~~~~-.
         .'  o   o  '.          \\ o /
        /   .-----.   \\          \\|/
       ;   /  ***  \\   ;          |
        \\  '.-----.'  /          / \\
         './  | |  \\.'        __/   \\__
      ~~~~^^^^^^^^^^^~~~~
          awake, and waiting
`);
