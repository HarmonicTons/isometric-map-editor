import {
  EDGE,
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "../iso/IsometricCoordinate";

/**
 * Cutting a sprite by the column of the map each of its pixels stands over, so
 * that its depth order is exact.
 *
 * A sprite straddles cells, and a cell key only orders cells that hide one
 * another, so no single key is right for the whole of it. Each column takes the
 * key of its own map column plus a fraction of the unit left free above it.
 *
 * A column belongs to one chunk: Map draws it there, alongside that chunk's
 * cells and on the same key — see Map.hostOver.
 */

/** Everything the cut is decided from. */
export type SpriteShape = {
  /** Position of the sprite, in cells, fractional */
  iso: GlobalIsoCoordinates;
  /** Volume that blocks its movement, in cells */
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
  /**
   * The pixel of the sprite that stands on the ground under it, from its top
   * left. Whatever the art is, this is the one thing it has to say.
   */
  anchorX: number;
  anchorY: number;
};

/**
 * Where the sprite is drawn, and the volume its depth order is decided against:
 * its anchor goes on the ground under it, which projects 16 right and 16 below
 * the cell's top left. Rounded to whole pixels.
 */
const placeSprite = ({ iso, hitbox, anchorX, anchorY }: SpriteShape) => {
  const xy = iso.toXY();
  return {
    left: Math.round(xy.x + 16 - anchorX),
    top: Math.round(xy.y + 16 - anchorY),
    box: IsoBox.standingOn(iso, hitbox),
  };
};

/** One horizontal run of pixels, from the sprite's top left. */
export type PixelRun = { x: number; y: number; width: number };

/** What the sprite shows over a single column of the map. */
export type SpriteColumn = {
  /** the column of the map it stands over */
  s: number;
  e: number;
  runs: PixelRun[];
  zIndex: number;
};

export type SpriteCut = {
  /** top-left of the sprite, in map pixels */
  x: number;
  y: number;
  /** by depth, so walking them is drawing them */
  columns: SpriteColumn[];
};

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

/**
 * Where the sprite stands INSIDE the cell its key is counted from, in (0, 1) —
 * what tells two sprites sharing a column apart. Read as `paintersOrderKey` at
 * the box's far bottom corner, and NOT clipped to the column, or anything
 * reaching in from behind ties on its corner.
 */
const subCellKey = (
  box: IsoBox,
  base: IsoCoordinates,
  s: number,
  e: number
): number => {
  // in cells of diagonal rather than key units, or the squash below would
  // spend its whole range on 1/256 of a cell
  const depth =
    paintersOrderKey(box.min.s - s, box.min.e - e, box.min.u - base.u) /
    paintersOrderKey(1, 0, 0);
  // any strictly increasing map onto (0, 1) does
  return 0.5 + depth / (2 * (1 + Math.abs(depth)));
};

/**
 * Cut a sprite into one piece per column of the map it stands over, each with
 * the key it must be drawn at.
 *
 * What a pixel stands for is where its ray LEAVES the box, nearest the camera.
 * With a = (X - 16) / 16 and b = (Y - 8) / 8 the ray is s = t, e = t + a,
 * u = 2t + a - b, and it leaves at the first of the three far faces: one min,
 * no search. Pixels overhanging the hitbox are clamped onto the nearest column.
 */
export const sliceSpriteByColumn = (sprite: SpriteShape): SpriteCut => {
  const { left, top, box } = placeSprite(sprite);
  const cells = box.cells();

  const columns = new globalThis.Map<string, SpriteColumn>();
  const run = (s: number, e: number, x: number, y: number, width: number) => {
    const key = `${s},${e}`;
    let column = columns.get(key);
    if (!column) {
      column = {
        s,
        e,
        runs: [],
        // the whole part places it between two cells of the column, the
        // fraction places it inside the cell it stands in
        zIndex:
          paintersOrderKey(s, e, cells.min.u) +
          subCellKey(box, cells.min, s, e),
      };
      columns.set(key, column);
    }
    column.runs.push({ x, y, width });
  };

  for (let row = 0; row < sprite.spriteHeight; row++) {
    const b = (top + row + 0.5 - 8) / 8;
    let open: { s: number; e: number } | undefined;
    let from = 0;
    // one past the edge, so that a run touching it is closed like any other
    for (let x = 0; x <= sprite.spriteWidth; x++) {
      let here: { s: number; e: number } | undefined;
      if (x < sprite.spriteWidth) {
        const a = (left + x + 0.5 - 16) / 16;
        const leaves = Math.min(
          box.max.s,
          box.max.e - a,
          (box.max.u - a + b) / 2
        );
        // EDGE for the reason cellRange grants it: a point that should land
        // on a cell boundary lands a few 1e-16 short
        here = {
          s: clamp(Math.floor(leaves + EDGE), cells.min.s, cells.max.s - 1),
          e: clamp(Math.floor(leaves + a + EDGE), cells.min.e, cells.max.e - 1),
        };
      }
      if (open && (!here || here.s !== open.s || here.e !== open.e)) {
        run(open.s, open.e, from, row, x - from);
        open = undefined;
      }
      if (here && !open) {
        open = here;
        from = x;
      }
    }
  }

  return {
    x: left,
    y: top,
    columns: [...columns.values()].sort((a, b) => a.zIndex - b.zIndex),
  };
};
