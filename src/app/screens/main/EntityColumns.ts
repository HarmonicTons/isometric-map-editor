import {
  EDGE,
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "./IsometricCoordinate";

/**
 * Cutting an entity's sprite by the column of the map each of its pixels stands
 * over, so that its depth order is exact.
 *
 * An entity straddles cells, and a cell key only orders cells that hide one
 * another — so an entity bridging two unrelated ones inherits an arbitrary
 * rank. One piece per column fixes it: along the view ray s, e and u grow
 * together, so anything nearer the camera than a point has at least its
 * diagonal, and an equal diagonal means the very same column, where collision
 * keeps every cell clear of the entity's own levels. Any key in floor(u) +
 * [0, 1) therefore works, and the free unit tells two entities sharing a
 * column apart (see subCellKey).
 *
 * A piece belongs to one column, which belongs to one chunk: Map draws it
 * there, alongside that chunk's cells and on the same key — see Map.chunkOver.
 */

/** Everything the cut is decided from. */
export type EntityShape = {
  /** Position of the entity, in cells, fractional */
  iso: GlobalIsoCoordinates;
  /** Volume that blocks the entity's movement, in cells */
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
  /**
   * The pixel of the sprite that stands on the ground under the entity, from
   * its top left. Whatever the art is, this is the one thing it has to say.
   */
  anchorX: number;
  anchorY: number;
};

/**
 * Where an entity's sprite is drawn, and the volume its depth order is decided
 * against.
 *
 * The box is centred in its cell, so the ground under it projects to exactly 16
 * right and 16 below the cell's top left; putting the sprite's own anchor there
 * is the whole of the placement. Rounded to whole pixels, this being pixel art.
 */
const placeSprite = ({ iso, hitbox, anchorX, anchorY }: EntityShape) => {
  const xy = iso.toXY();
  return {
    left: Math.round(xy.x + 16 - anchorX),
    top: Math.round(xy.y + 16 - anchorY),
    box: IsoBox.standingOn(iso, hitbox),
  };
};

/** One horizontal run of a piece, in pixels from the sprite's top left. */
export type PixelRun = { x: number; y: number; width: number };

/** One piece of an entity's sprite: what it shows over a single column. */
export type EntityColumnPiece = {
  /** the column of the map this piece stands over */
  s: number;
  e: number;
  runs: PixelRun[];
  zIndex: number;
};

export type EntityColumnSlices = {
  /** top-left of the sprite, in map pixels */
  x: number;
  y: number;
  pieces: EntityColumnPiece[];
};

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

/**
 * Where the entity stands INSIDE the cell its key is counted from, as a
 * fraction of the gap to the next one — what tells two entities sharing a
 * column apart.
 *
 * It reads `paintersOrderKey` at the box's far bottom corner, which is a depth
 * for points since the key grows strictly along a view ray. Deliberately NOT
 * clipped to the column, or anything reaching in from behind ties on its
 * corner.
 */
const subCellKey = (
  box: IsoBox,
  base: IsoCoordinates,
  s: number,
  e: number
): number => {
  // in cells of diagonal rather than key units: same order, but the squash
  // below would otherwise spend its whole range on 1/256 of a cell
  const depth =
    paintersOrderKey(box.min.s - s, box.min.e - e, box.min.u - base.u) /
    paintersOrderKey(1, 0, 0);
  // any strictly increasing map onto (0, 1) does, and this one needs no bound
  // on how big a hitbox may be
  return 0.5 + depth / (2 * (1 + Math.abs(depth)));
};

/**
 * Cut an entity's sprite into one piece per column of the map it stands over,
 * each with the key it must be drawn at.
 *
 * A pixel holds a ray, not a column, and (s, e) and (s + 1, e + 1) project onto
 * the same 32 pixel strip — so what a pixel means is where its ray LEAVES the
 * box, nearest the camera. With a = (X - 16) / 16 and b = (Y - 8) / 8 the ray
 * is s = t, e = t + a, u = 2t + a - b, and it leaves at the first of the three
 * far faces: one min, no search. Pixels overhanging the hitbox land outside the
 * box and are clamped onto the nearest column.
 */
export const sliceEntityByColumn = (
  entity: EntityShape
): EntityColumnSlices => {
  const { left, top, box } = placeSprite(entity);
  const cells = box.cells();

  const pieces = new globalThis.Map<string, EntityColumnPiece>();
  const run = (s: number, e: number, x: number, y: number, width: number) => {
    const key = `${s},${e}`;
    let piece = pieces.get(key);
    if (!piece) {
      piece = {
        s,
        e,
        runs: [],
        // the whole part places it between two cells of the column, the
        // fraction places it inside the cell it stands in
        zIndex:
          paintersOrderKey(s, e, cells.min.u) +
          subCellKey(box, cells.min, s, e),
      };
      pieces.set(key, piece);
    }
    piece.runs.push({ x, y, width });
  };

  for (let row = 0; row < entity.spriteHeight; row++) {
    const b = (top + row + 0.5 - 8) / 8;
    let open: { s: number; e: number } | undefined;
    let from = 0;
    // one past the edge, so that a run touching it is closed like any other
    for (let column = 0; column <= entity.spriteWidth; column++) {
      let here: { s: number; e: number } | undefined;
      if (column < entity.spriteWidth) {
        const a = (left + column + 0.5 - 16) / 16;
        const leaves = Math.min(
          box.max.s,
          box.max.e - a,
          (box.max.u - a + b) / 2
        );
        // EDGE for the reason cellRange grants it: a point that should land on
        // a cell boundary lands a few 1e-16 short, and the pixel there would
        // change column with the entity's position on the map. The clamp folds
        // the pixels overhanging the silhouette onto the nearest column.
        here = {
          s: clamp(Math.floor(leaves + EDGE), cells.min.s, cells.max.s - 1),
          e: clamp(Math.floor(leaves + a + EDGE), cells.min.e, cells.max.e - 1),
        };
      }
      if (open && (!here || here.s !== open.s || here.e !== open.e)) {
        run(open.s, open.e, from, row, column - from);
        open = undefined;
      }
      if (here && !open) {
        open = here;
        from = column;
      }
    }
  }

  return {
    x: left,
    y: top,
    // by depth, so that the order a renderer walks them in is the order they
    // are drawn in whatever it does with them
    pieces: [...pieces.values()].sort((a, b) => a.zIndex - b.zIndex),
  };
};
