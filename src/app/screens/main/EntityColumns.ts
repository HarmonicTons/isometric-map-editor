import {
  EDGE,
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "./IsometricCoordinate";

/**
 * Cutting an entity's sprite by the column of the map each of its pixels
 * stands over, so that its depth order is exact.
 *
 * An entity stands at fractional coordinates, so it straddles cells. A cell's
 * depth key orders cells that hide one another, and nothing else: two cells
 * that never overlap on screen are ranked arbitrarily. An entity bridging them
 * inherits that arbitrary rank, and no single key can then be right for its
 * whole sprite. Cutting it by column, each piece with its own key, is what
 * fixes it.
 *
 * Why one key per column is enough, in two steps:
 *
 * Along the view ray s, e and u all grow together, so a cell nearer the camera
 * than a point p of the entity has s' >= floor(ps) and e' >= floor(pe) — never a
 * smaller diagonal. The 256 (s + e) term therefore sorts by itself: everything
 * on a lower diagonal is behind, whatever its height.
 *
 * Equal diagonal then means the very same column, and there collision finishes
 * the argument: nothing solid overlaps the hitbox, so the cells of that column
 * are either at u <= floor(u) - 1, entirely below the entity, or at
 * u >= ceil(u + height), entirely above it. Any key strictly between the two
 * works, so floor(u) plus anything in [0, 1) does — which leaves a whole unit
 * free to say where in that cell the entity stands, and that is what tells two
 * of them sharing a column apart. See subCellKey. A jump or a fall needs no
 * special case: it is floor(u), and the window is more than two units wide.
 *
 * There is nothing else to it: no ray to march, no window to narrow, no key to
 * choose. Which column a pixel belongs to is one min of three terms, and the
 * key follows from it.
 *
 * Chunks are deliberately absent: this assumes everything that constrains the
 * entity is drawn in the same container, sorted by the same key. Map holds up
 * that end by merging the chunks around the entity into one — see
 * Map.syncBlock, and BLOCK_SIDE for how far that has to reach.
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
 * Centred on the middle of its footprint and standing on the front tip of it —
 * the bottom corner of the diamond it occupies, which is where the ground it
 * rests on is drawn. That tip is at 16 + 4 (footprint.s + footprint.e) below
 * the cell's own top left: 24 for one cell, 32 for a two by two entity, a whole
 * level lower. A 24 hard-coded here is the reason cube-large — the same art as
 * cube-medium at twice the size — hung a level above its own shadow.
 *
 * The footprint is counted in whole CELLS, not in hitbox: what a sprite is
 * drawn to stand on is the diamond of the tiles under it, and a hitbox is
 * deliberately a little narrower than that so an entity slips through a gap
 * before its sprite stops touching the walls. Reading the hitbox here would
 * lift every character already on the map by a pixel or two for nothing.
 *
 * Rounded to whole pixels: cells sit on integer pixels, so this keeps "does
 * that cell paint this pixel" an exact question at any zoom, and the pixel art
 * on its grid.
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
 * How many pieces the cut can produce: one per column the hitbox straddles,
 * known from the position alone and before cutting anything.
 *
 * A bound the cut cannot exceed rather than one anything has to check — every
 * piece is clamped into the box's own cell rectangle below, and this is that
 * rectangle's area. EntityColumns.test.ts is what holds it to that.
 */
export const maxPieces = (entity: EntityShape): number => {
  const cells = IsoBox.standingOn(entity.iso, entity.hitbox).cells();
  return (cells.max.s - cells.min.s) * (cells.max.e - cells.min.e);
};

const clamp = (value: number, low: number, high: number) =>
  value < low ? low : value > high ? high : value;

/**
 * Where the entity stands INSIDE the cell its key is counted from, as a
 * fraction of the gap to the next one.
 *
 * The whole part of a piece's key says which two cells of the column it belongs
 * between; this says where between them it is, and it is what tells two
 * entities sharing a column apart. Without it they take the same key and their
 * order is whatever the sort happens to do — two characters one hitbox apart
 * along s share a column and overlap on screen over some seventy pixels, so
 * that is reachable, not theoretical.
 *
 * The room is free: collision keeps the column empty from floor(u) to
 * ceil(u + height), so the cells around are at floor(u) - 1 and below or
 * floor(u) + 1 and above, and the whole unit in between belongs to whatever
 * stands there. A flat half wasted all of it, and 0.5 is what this still
 * returns for an entity standing exactly on the corner it is keyed from.
 *
 * What it reads is `paintersOrderKey` itself, at the box's far bottom corner,
 * counted from the corner of that cell — the same functional as a cell key, at
 * a point instead of a cell. That is not a coincidence: along a view ray it
 * grows strictly, so it IS a depth for points, and cell keys are only its
 * restriction to whole ones.
 *
 * Deliberately NOT clipped to the column. Which of two boxes is in front is a
 * fact about the boxes, not about their share of one column, and clipping
 * throws away exactly what separates them: a box reaching in from behind gets
 * the column's own corner, ties with anything else that does, and the pair
 * measured above ties on 151 pixels.
 *
 * Where it stops being exact: no single number can express the three-axis
 * separation that really decides which of two boxes is in front. The error term
 * is the height difference, at most one hitbox, against 256 per unit of
 * diagonal — so it can only bite where the two overlap by less than a
 * hundredth of a cell along the diagonal, which is a tenth of a pixel.
 * EntityColumns.test.ts slides two characters past each other at every offset
 * to check that nothing above that ever comes out wrong.
 */
const subCellKey = (
  box: IsoBox,
  base: IsoCoordinates,
  s: number,
  e: number
): number => {
  // In cells of diagonal rather than in key units. The order is the same either
  // way — it is one positive factor — but the squash below saturates fast, and
  // fed the raw key it would spend its whole range on the 1/256 of a cell
  // around zero and sit against 0 or 1 everywhere else. Still a correct order,
  // and a number worth nothing: unreadable in the debug overlay, and resolving
  // as 1/depth², so two entities a whisker apart two cells out from the column
  // separate by some five orders of magnitude less than they need to. The
  // double carrying the key holds that today. There is no reason to spend it.
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
 * A pixel does not contain a column: it contains a ray, which crosses the
 * hitbox and can leave it in a different column from the one it entered — and
 * the columns (s, e) and (s + 1, e + 1) project onto the very same 32 pixel
 * strip, so no reading of x alone could tell them apart. What is well defined is
 * the column of the point the sprite actually shows at that pixel: where the ray
 * leaves the box, nearest the camera.
 *
 * With a = (X - 16) / 16 and b = (Y - 8) / 8 the ray is s = t, e = t + a,
 * u = 2t + a - b, and it leaves the box at the first of its three far faces —
 * one min, no search. Pixels of the sprite that overhang the hitbox get the
 * point of that same plane, outside the box, which the clamp folds back onto the
 * column nearest to them: the partition simply continues past the silhouette,
 * which is the only part of this that is an approximation.
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
        // The same forgiveness cellRange grants, and for the same reason: a
        // point that should land exactly on a cell boundary lands a few 1e-16
        // short of it, and without this the pixel on the boundary would change
        // column depending on where on the map the entity stands.
        //
        // A box is half-open, so a face landing exactly on a boundary belongs to
        // the cell below it; the clamp says so, and says where the pixels that
        // overhang the sprite's silhouette go at the same time.
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
