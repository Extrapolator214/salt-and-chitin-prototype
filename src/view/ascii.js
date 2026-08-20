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

const POI = { wreck: WRECK, cache: CACHE, officer: CASTAWAY };

/** The picture for a worked site, or the chest as a stand-in for a new kind. */
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
