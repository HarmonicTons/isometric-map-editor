import { Graphics } from "pixi.js";

/**
 * Which pixels of the map a shadow darkens, and how they are painted.
 *
 * Everything here works in the sprite of one cell and answers one question:
 * given a whole pixel, which point of the ground does it stand for?
 */

/** Size of a cell's top face on screen, in pixels */
const FACE_WIDTH = 32;
const FACE_HEIGHT = 16;

/** How dark a shadow is, over whatever it lands on */
const SHADOW_ALPHA = 0.5;

/**
 * How far down the boundary between two cells is read, in pixels. It hands each
 * seam to the cell in front, which covers it with its own art; without it a
 * bright line follows every edge on the map.
 */
const SEAM = 1;

/**
 * One horizontal run of shadow pixels, in pixels from the top left of a cell's
 * sprite.
 */
export type ShadowRun = { x: number; y: number; width: number };

/**
 * The point of the ground a pixel of a cell's top face stands for, in cell
 * fractions, or nothing when the pixel belongs to another cell. Half-open, so
 * every pixel of the map belongs to exactly one cell.
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

/** The whole of a cell's top face — what a tile floating over it drops on it */
export const TOP_FACE_RUNS: ShadowRun[] = runsWhere(() => true);

/** How wide the edge lines below are, as a fraction of a cell */
const EDGE_THICKNESS = 1 / 32;

/**
 * The pixels along a cell's two MIN edges, for drawing a line on the boundary
 * between two cells. The max sides belong to the cell in front (see SEAM).
 */
export const NORTH_EDGE_RUNS: ShadowRun[] = runsWhere(
  ({ ds }) => ds < EDGE_THICKNESS
);
export const WEST_EDGE_RUNS: ShadowRun[] = runsWhere(
  ({ de }) => de < EDGE_THICKNESS
);

/** Fill a Graphics with `runs`, replacing whatever it held. */
export const paintRuns = (shadow: Graphics, runs: ShadowRun[]) => {
  shadow.clear();
  for (const run of runs) shadow.rect(run.x, run.y, run.width, 1);
  if (runs.length > 0) {
    shadow.fill({ color: 0x000000, alpha: SHADOW_ALPHA });
  }
};
