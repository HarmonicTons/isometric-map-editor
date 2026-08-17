import { Graphics } from "pixi.js";

/**
 * Which pixels of the map a shadow darkens, and how they are painted.
 *
 * Everything here works in the sprite of one cell and answers one question:
 * given a whole pixel, which point of the ground does it stand for? Reading a
 * shadow off the ground keeps it on the game's grid at any zoom and cuts it at
 * the edge of a tile for free.
 */

/** Size of a cell's top face on screen, in pixels */
const FACE_WIDTH = 32;
const FACE_HEIGHT = 16;

/** How dark a shadow is, over whatever it lands on */
const SHADOW_ALPHA = 0.5;

/**
 * How far down the boundaries between cells are read, in pixels, when deciding
 * which cell owns a pixel of shadow.
 *
 * Tile art overflows its own faces — a grass top face is fatter than its
 * rhombus — so the tile in front repaints a pixel or two of the one behind,
 * which is what makes them interlock. A shadow laid down right after its own
 * tile loses that pixel, and a bright line follows every edge on the map.
 *
 * Reading the boundary one row lower shifts the whole partition up by a pixel.
 * Still a partition, but the strip along each seam now belongs to the cell in
 * front, which is drawn last and covers it with its own art.
 */
const SEAM = 1;

/**
 * One horizontal run of shadow pixels, in pixels from the top left of a cell's
 * sprite.
 */
export type ShadowRun = { x: number; y: number; width: number };

/**
 * The point of the ground a pixel of a cell's top face stands for, in cell
 * fractions, or nothing when the pixel belongs to another cell.
 *
 * The projection makes the face an affine map from whole pixels to the cell —
 * x = 16 (de − ds) + 16 and y = 8 (de + ds) — and this is its inverse. Top face
 * only: the other two visible faces are vertical.
 *
 * The test is half-open, so every pixel of the map belongs to exactly one cell.
 * Which cell owns a pixel is read SEAM rows below it; where the ground it stands
 * for is, at the pixel itself.
 */
const groundUnderPixel = (
  x: number,
  y: number
): { ds: number; de: number } | undefined => {
  const across = (x + 0.5 - FACE_WIDTH / 2) / FACE_WIDTH;
  const owner = (y + SEAM + 0.5) / FACE_HEIGHT;
  if (
    owner - across < 0 ||
    owner - across >= 1 ||
    owner + across < 0 ||
    owner + across >= 1
  ) {
    return undefined;
  }
  const here = (y + 0.5) / FACE_HEIGHT;
  return { ds: here - across, de: here + across };
};

/** The pixels of a cell's top face whose ground point `keep` accepts. */
const runsWhere = (
  keep: (point: { ds: number; de: number }) => boolean
): ShadowRun[] => {
  const runs: ShadowRun[] = [];
  // the face, and one row above it that the seam bias hands to this cell
  for (let y = -SEAM; y < FACE_HEIGHT; y++) {
    let from = -1;
    // one past the edge, so that a run touching it is closed like any other
    for (let x = 0; x <= FACE_WIDTH; x++) {
      const point = x < FACE_WIDTH ? groundUnderPixel(x, y) : undefined;
      const shadowed = point !== undefined && keep(point);
      if (shadowed && from < 0) from = x;
      if (!shadowed && from >= 0) {
        runs.push({ x: from, y, width: x - from });
        from = -1;
      }
    }
  }
  return runs;
};

/**
 * The pixels a round shadow of `radius` cells centred on `centre` paints on the
 * top face of the cell (cs, ce). What a character drops on the ground.
 */
export const shadowRuns = (
  cs: number,
  ce: number,
  centre: { s: number; e: number },
  radius: number
): ShadowRun[] =>
  runsWhere(({ ds, de }) => {
    const offS = cs + ds - centre.s;
    const offE = ce + de - centre.e;
    return offS * offS + offE * offE <= radius * radius;
  });

/**
 * The whole of a cell's top face — what a tile floating over it drops on it.
 *
 * The same set for every cell of the map, since which pixel a face owns depends
 * only on where the pixel sits in the sprite.
 */
export const TOP_FACE_RUNS: ShadowRun[] = runsWhere(() => true);

/** Fill a Graphics with `runs`, replacing whatever it held. */
export const paintRuns = (shadow: Graphics, runs: ShadowRun[]) => {
  shadow.clear();
  for (const run of runs) shadow.rect(run.x, run.y, run.width, 1);
  if (runs.length > 0) {
    shadow.fill({ color: 0x000000, alpha: SHADOW_ALPHA });
  }
};
