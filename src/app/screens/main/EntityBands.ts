import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "./IsometricCoordinate";

/**
 * Cutting an entity's sprite into horizontal bands so that its depth order is
 * exact — inside a single chunk.
 *
 * An entity stands at fractional coordinates, so it straddles cells. A cell's
 * depth key orders cells that hide one another, and nothing else: two cells
 * that never overlap on screen are ranked arbitrarily. An entity bridging them
 * inherits that arbitrary rank, and no single key can then be right for its
 * whole sprite. Cutting it into bands, each with its own key, is what fixes it.
 *
 * The cut needs no search. Every screen point is a view ray, and along a ray
 * the depth key grows strictly, so exactly two cells constrain a pixel: the
 * last one before the entity and the first one after it. Both are a closed
 * form of the pixel's position — see `bindingPair`. The band is then whatever
 * run of rows those two cells stay the same over.
 *
 * Chunks are deliberately absent: this assumes everything that constrains the
 * entity is drawn in the same container, sorted by the same key. Map holds up
 * that end by merging the chunks around the entity into one — see
 * Map.syncBlock, and `constrainingCells` for how far that has to reach.
 */

/** One horizontal band of a sprite, and the depth key it must be drawn at. */
export type EntityBand = {
  /** first row of the band, in pixels from the top of the sprite */
  offsetY: number;
  height: number;
  zIndex: number;
};

export type EntitySlices = {
  /** top-left of the sprite, in map pixels */
  x: number;
  y: number;
  bands: EntityBand[];
};

export type EntityShape = {
  /** Position of the entity, in cells, fractional */
  iso: GlobalIsoCoordinates;
  /** Volume that blocks the entity's movement, in cells */
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
};

/**
 * Which side of the entity a cell is on, or nothing when their silhouettes
 * miss each other.
 *
 * The ray proposes a cell; this confirms it. Both are needed: the ray is what
 * makes the cell computable without scanning, and the check is what rejects
 * the ones it proposes for a ray that grazes past the hitbox instead of
 * crossing it. A cell straddling 0 is one the entity stands in, which
 * collision keeps empty.
 */
const sideOf = (
  s: number,
  e: number,
  u: number,
  box: IsoBox
): "behind" | "front" | undefined => {
  const from = Math.max(s - box.max.s, e - box.max.e, (u - box.max.u) / 2);
  const to = Math.min(
    s + 1 - box.min.s,
    e + 1 - box.min.e,
    (u + 1 - box.min.u) / 2
  );
  if (from >= to) return undefined;
  if (from >= 0) return "front";
  if (to <= 0) return "behind";
  return undefined;
};

/**
 * How far the walk below is allowed to go. The entity's cell range is what the
 * ray starts from, so a couple of steps always suffice; the cap only stops a
 * ray that grazes the range from walking off the map.
 */
const WALK_LIMIT = 6;

/**
 * How far apart, in screen pixels, two cells one step apart along the view ray
 * are drawn. It is the only place a band can start: between two of those rows
 * nothing about which cell is nearest can change.
 */
const LATTICE = 8;

/**
 * The two cells that constrain one screen point.
 *
 * A screen point (X, Y) is the set of world points that project onto it — a
 * ray, which with `a = (X − 16) / 16` and `b = (Y − 8) / 8` is
 *
 *     s = t,   e = t + a,   u = 2t + a − b
 *
 * Along it the depth key grows strictly, so of every cell the entity hides
 * only the nearest one constrains, and likewise of every cell that hides it.
 * The entity covers the whole cells [F, G): the ray enters that range at `tb`
 * and leaves it at `tf`, which is where those two cells sit. No neighbourhood
 * to scan, no sort, no nearest-of search — two extrema and a step or two.
 */
const bindingPair = (
  a: number,
  b: number,
  box: IsoBox
): { behind?: IsoCoordinates; front?: IsoCoordinates } => {
  const { min: F, max: G } = box.cells();
  // ceil(t) − 1 is "the cell the ray is in just before t": it steps back a
  // whole cell when t lands exactly on a boundary, which is what the threshold
  // does whenever the s axis is the binding one.
  const tb = Math.max(F.s, F.e - a, (F.u - a + b) / 2);
  let bs = Math.ceil(tb) - 1;
  let be = Math.ceil(tb + a) - 1;
  let bu = Math.ceil(2 * tb + a - b) - 1;
  let behind: IsoCoordinates | undefined;
  for (let step = 0; step < WALK_LIMIT; step++) {
    if (sideOf(bs, be, bu, box) === "behind") {
      behind = new IsoCoordinates(bs, be, bu);
      break;
    }
    // The entity's cell range is rounded outward, so the cell the ray leaves it
    // through can still be one the entity does not hide — above its head, say.
    // Walk back along the ray until one it does hide: the axis whose boundary
    // comes last is the one to step over.
    const ts = bs;
    const te = be - a;
    const tu = (bu - a + b) / 2;
    const previous = Math.max(ts, te, tu);
    if (ts === previous) bs--;
    if (te === previous) be--;
    if (tu === previous) bu--;
  }

  const tf = Math.min(G.s, G.e - a, (G.u - a + b) / 2);
  let fs = Math.floor(tf);
  let fe = Math.floor(tf + a);
  let fu = Math.floor(2 * tf + a - b);
  let front: IsoCoordinates | undefined;
  for (let step = 0; step < WALK_LIMIT; step++) {
    if (sideOf(fs, fe, fu, box) === "front") {
      front = new IsoCoordinates(fs, fe, fu);
      break;
    }
    const ts = fs + 1;
    const te = fe + 1 - a;
    const tu = (fu + 1 - a + b) / 2;
    const next = Math.min(ts, te, tu);
    if (ts === next) fs++;
    if (te === next) fe++;
    if (tu === next) fu++;
  }

  return { behind, front };
};

/**
 * The tightest constraint over one row of the sprite.
 *
 * A pixel is a square, not a point: a cell paints it as soon as it covers any
 * part of it, so the row is constrained by every corner of every pixel in it,
 * not by its centre.
 *
 * Every corner, and not just the ends of the row: which face of the entity's
 * cell range the ray enters through changes along the row, and with it whether
 * the key grows or shrinks, so the tightest constraint regularly sits in the
 * middle. Measured on a 23-pixel sprite, sampling only the two ends gets 26 %
 * of the rows wrong, ends plus middle 9 %, one column in eight 5 %. There are
 * up to eleven distinct constraining pairs across a single row.
 */
const rowConstraint = (
  row: number,
  left: number,
  top: number,
  width: number,
  box: IsoBox
) => {
  let after = -Infinity;
  let before = Infinity;
  for (let column = 0; column <= width; column++) {
    for (let corner = 0; corner <= 1; corner++) {
      const { behind, front } = bindingPair(
        (left + column - 16) / 16,
        (top + row + corner - 8) / 8,
        box
      );
      if (behind) {
        const key = paintersOrderKey(behind.s, behind.e, behind.u);
        if (key > after) after = key;
      }
      if (front) {
        const key = paintersOrderKey(front.s, front.e, front.u);
        if (key < before) before = key;
      }
    }
  }
  return { after, before };
};

/**
 * Where an entity's sprite is drawn, and the volume its depth order is decided
 * against.
 *
 * The sprite stands on the middle of the cell floor, rounded to whole pixels:
 * cells sit on integer pixels, so this keeps "does that cell paint this pixel"
 * an exact question at any zoom, and the pixel art on its grid.
 */
const placeSprite = ({
  iso,
  hitbox,
  spriteWidth,
  spriteHeight,
}: EntityShape) => {
  const xy = iso.toXY();
  return {
    left: Math.round(xy.x + 16 - spriteWidth / 2),
    top: Math.round(xy.y + 24 - spriteHeight),
    box: IsoBox.standingOn(iso, hitbox),
  };
};

/**
 * Every cell the cut is decided against, for one position — the union over the
 * sprite of the pair `bindingPair` returns.
 *
 * Map needs this to know how wide the container that keeps the draw order
 * exact has to be: whatever is in here must be drawn alongside the entity, so
 * it can never be in a chunk of its own. Nothing else calls it; it is the
 * subject of "no cell further than two cells away constrains it".
 */
export const constrainingCells = (entity: EntityShape): IsoCoordinates[] => {
  const { left, top, box } = placeSprite(entity);
  const cells = new globalThis.Map<string, IsoCoordinates>();
  for (let row = 0; row <= entity.spriteHeight; row++) {
    for (let column = 0; column <= entity.spriteWidth; column++) {
      const { behind, front } = bindingPair(
        (left + column - 16) / 16,
        (top + row - 8) / 8,
        box
      );
      for (const cell of [behind, front]) {
        if (cell) cells.set(cell.toString(), cell);
      }
    }
  }
  return [...cells.values()];
};

/**
 * Cut an entity's sprite into the fewest horizontal bands whose depth order is
 * exact, each with the key it must be drawn at.
 *
 * Bands are horizontal only. A vertical cut would mean two pixels of the same
 * row need incompatible keys, which cannot happen while every constraining
 * cell shares one container: the constraint moves with the ray, and along a
 * row the ray only slides sideways within the same pair of cells.
 */
export const sliceEntity = (entity: EntityShape): EntitySlices => {
  const { iso, spriteWidth, spriteHeight } = entity;
  const { left, top, box } = placeSprite(entity);

  // Where a band may start is not searched for: cells project 8 pixels apart
  // in y, so the rows where the cell in front or behind can change are the
  // rows of that lattice, and nothing else. Cutting on all of them is always
  // enough — EntityBands.test.ts checks it — and the ones that turn out
  // unnecessary cost nothing, since neighbours sharing a key merge back.
  const cuts: number[] = [0];
  for (
    let row = (((-top % LATTICE) + LATTICE) % LATTICE) % LATTICE;
    row < spriteHeight;
    row += LATTICE
  ) {
    if (row > 0) cuts.push(row);
  }

  const bands: EntityBand[] = [];
  let running: number | undefined;
  cuts.forEach((offsetY, index) => {
    const height = (cuts[index + 1] ?? spriteHeight) - offsetY;
    let after = -Infinity;
    let before = Infinity;
    for (let row = offsetY; row < offsetY + height; row++) {
      const constraint = rowConstraint(row, left, top, spriteWidth, box);
      if (constraint.after > after) after = constraint.after;
      if (constraint.before < before) before = constraint.before;
    }

    // Staying on the key the band above settled for whenever it still holds is
    // what keeps the pieces few: a band that merely has a different nearest
    // cell does not need a different key, only one that has an incompatible
    // cell. A band the hitbox does not reach at all — the sprite overflows it
    // at the top and at the bottom — has no constraint and simply follows.
    if (
      running === undefined ||
      after >= running ||
      running >= before ||
      (after === -Infinity && before === Infinity)
    ) {
      if (after > -Infinity || before < Infinity) {
        // As HIGH as the band allows, not as low. Going down the sprite the
        // cell behind only ever moves forward, so the floor of the window rises
        // band after band: a key taken at the floor dies at the very next one,
        // a key taken at the ceiling survives as long as it possibly can. This
        // is worth more than everything else here — 1.68 bands on average
        // against 2.80, and 36 % of the positions not cut at all against 1 %.
        //
        // Cell keys are whole numbers, so a half can never tie with one.
        running = before < Infinity ? before - 0.5 : after + 0.5;
        if (running <= after) {
          // Would mean one band needs two keys, which a horizontal cut cannot
          // express. Keep drawing rather than crash the frame.
          console.warn(
            `No single key orders rows ${offsetY}..${offsetY + height} of the entity at ${iso.toString()}`
          );
        }
      }
    }
    const zIndex = running ?? iso.paintersOrderKey();
    const open = bands[bands.length - 1];
    if (open && open.zIndex === zIndex) open.height += height;
    else bands.push({ offsetY, height, zIndex });
  });
  // The first bands can precede any constraint at all, when the sprite starts
  // above everything the hitbox reaches. They take the first real key.
  const settled = bands.find((band) => band.zIndex !== bands[0].zIndex);
  if (settled && bands[0].zIndex === iso.paintersOrderKey()) {
    bands[0].zIndex = settled.zIndex;
  }
  return { x: left, y: top, bands };
};
