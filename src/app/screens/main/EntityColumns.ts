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
 * An entity stands at fractional coordinates and straddles cells. A cell key
 * only orders cells that hide one another, so an entity bridging two unrelated
 * ones inherits an arbitrary rank. One piece per column fixes it.
 *
 * Why one key per column suffices, in two steps. Along the view ray s, e and u
 * grow together, so a cell nearer the camera than a point p has s' >= floor(ps)
 * and e' >= floor(pe) — never a smaller diagonal, and the 256 (s + e) term
 * sorts by itself. Equal diagonal then means the very same column, where
 * collision keeps everything at u <= floor(u) - 1 or u >= ceil(u + height): any
 * key in floor(u) + [0, 1) works, and the free unit is what tells two entities
 * sharing a column apart (see subCellKey).
 *
 * Assumes everything constraining the entity is drawn in the same container,
 * sorted by the same key — Map.syncBlock and BLOCK_SIDE.
 */

/** Everything the cut is decided from. */
export type EntityShape = {
  /** Position of the entity, in cells, fractional */
  iso: GlobalIsoCoordinates;
  /** Volume that blocks the entity's movement, in cells */
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
};

/**
 * Where an entity's sprite is drawn, and the volume its depth order is decided
 * against.
 *
 * Centred on its footprint and standing on the front tip of it, at
 * 16 + 4 (footprint.s + footprint.e) below the cell's top left: 24 for one cell
 * but 32 for a two by two entity, a whole level lower.
 *
 * The footprint is in whole CELLS, not in hitbox — a sprite stands on the
 * diamond of the tiles under it, and a hitbox is deliberately narrower.
 *
 * Rounded to whole pixels, so "does that cell paint this pixel" stays exact.
 */
const placeSprite = ({
  iso,
  hitbox,
  spriteWidth,
  spriteHeight,
}: EntityShape) => {
  const xy = iso.toXY();
  const footprint = Math.ceil(hitbox.s) + Math.ceil(hitbox.e);
  return {
    left: Math.round(xy.x + 16 - spriteWidth / 2),
    top: Math.round(xy.y + 16 + 4 * footprint - spriteHeight),
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

/**
 * How many pieces the cut can produce, from the position alone: the area of the
 * box's cell rectangle, which every piece below is clamped into.
 */
export const maxPieces = (entity: EntityShape): number => {
  const cells = IsoBox.standingOn(entity.iso, entity.hitbox).cells();
  return (cells.max.s - cells.min.s) * (cells.max.e - cells.min.e);
};

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

/**
 * Where the entity stands INSIDE the cell its key is counted from, as a fraction
 * of the gap to the next one. This is what tells two entities sharing a column
 * apart; without it they take the same key and sort arbitrarily. It returns 0.5
 * for an entity exactly on the corner it is keyed from.
 *
 * What it reads is `paintersOrderKey` itself, at the box's far bottom corner:
 * that functional grows strictly along a view ray, so it is a depth for points
 * and cell keys are its restriction to whole ones. Deliberately NOT clipped to
 * the column, or anything reaching in from behind ties on the column's corner.
 *
 * Not exact — no single number expresses the three-axis separation that decides
 * it — but the error is the height difference, at most one hitbox, against 256
 * per diagonal, so it only bites under a hundredth of a cell of overlap.
 */
const subCellKey = (
  box: IsoBox,
  base: IsoCoordinates,
  s: number,
  e: number
): number => {
  // In cells of diagonal rather than in key units: same order either way (one
  // positive factor), but the squash below saturates fast, and fed the raw key
  // it would spend its whole range on the 1/256 of a cell around zero — correct,
  // unreadable in the overlay, and resolving as 1/depth².
  const depth =
    paintersOrderKey(box.min.s - s, box.min.e - e, box.min.u - base.u) /
    paintersOrderKey(1, 0, 0);
  // any strictly increasing map onto (0, 1) does; this is the cheapest one that
  // needs no bound on how big a hitbox is allowed to be
  return 0.5 + depth / (2 * (1 + Math.abs(depth)));
};

/**
 * Cut an entity's sprite into one piece per column of the map it stands over,
 * each with the key it must be drawn at.
 *
 * A pixel does not contain a column but a ray, which can leave the hitbox in a
 * different column from the one it entered — and (s, e) and (s + 1, e + 1)
 * project onto the same 32 pixel strip, so x alone cannot tell them apart. What
 * is well defined is where that ray leaves the box, nearest the camera.
 *
 * With a = (X - 16) / 16 and b = (Y - 8) / 8 the ray is s = t, e = t + a,
 * u = 2t + a - b, and it leaves at the first of the three far faces — one min,
 * no search. Pixels overhanging the hitbox get a point on that plane outside the
 * box, which the clamp folds onto the nearest column: the partition continues
 * past the silhouette, the only approximation here.
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
