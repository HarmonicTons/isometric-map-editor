/**
 * Maximum height of a map, in cells. Chunks are vertical columns: horizontal
 * coordinates are unbounded, but u must stay in [0, MAP_MAX_HEIGHT).
 */
export const MAP_MAX_HEIGHT = 256;

/**
 * Stringified iso coordinates.
 */
export type IsoString = `${number},${number},${number}`;

export const isoDirections = [
  "up",
  "north",
  "east",
  "south",
  "west",
  "down",
] as const;
export type IsoDirection = (typeof isoDirections)[number];
export const visibleIsoDirections = ["up", "east", "south"] as const;
export type VisibleIsoDirection = (typeof visibleIsoDirections)[number];

export const isoAxes = ["s", "e", "u"] as const;
export type IsoAxis = (typeof isoAxes)[number];

/** The direction one travels along an axis, by sign. */
export const isoDirectionByAxis: Record<
  IsoAxis,
  { positive: IsoDirection; negative: IsoDirection }
> = {
  s: { positive: "south", negative: "north" },
  e: { positive: "east", negative: "west" },
  u: { positive: "up", negative: "down" },
};

/**
 * Represents isometric coordinates in a 3D space.
 */
export class IsoCoordinates {
  constructor(
    public s: number,
    public e: number,
    public u: number
  ) {}

  /**
   * Brand-preserving: `LocalIsoCoordinates.fromString(...)` returns a
   * LocalIsoCoordinates, etc.
   */
  public static fromString<T extends IsoCoordinates>(
    this: new (s: number, e: number, u: number) => T,
    coordString: string
  ): T {
    const [s, e, u] = coordString.split(",").map(Number);
    return new this(s, e, u);
  }

  public static directionsOffsets: Record<IsoDirection, IsoCoordinates> = {
    up: new IsoCoordinates(0, 0, 1),
    north: new IsoCoordinates(-1, 0, 0),
    east: new IsoCoordinates(0, 1, 0),
    south: new IsoCoordinates(1, 0, 0),
    west: new IsoCoordinates(0, -1, 0),
    down: new IsoCoordinates(0, 0, -1),
  };

  public toString(): IsoString {
    return `${this.s},${this.e},${this.u}`;
  }

  /** Brand-preserving: adding an offset to a global coordinate stays global. */
  public add(offset: IsoCoordinates): this {
    const Ctor = this.constructor as new (
      s: number,
      e: number,
      u: number
    ) => this;
    return new Ctor(this.s + offset.s, this.e + offset.e, this.u + offset.u);
  }

  public multiply(factor: number): this {
    const Ctor = this.constructor as new (
      s: number,
      e: number,
      u: number
    ) => this;
    return new Ctor(this.s * factor, this.e * factor, this.u * factor);
  }

  public move(direction: IsoDirection): this {
    return this.add(IsoCoordinates.directionsOffsets[direction]);
  }

  public equals(other?: IsoCoordinates): boolean {
    return this.s === other?.s && this.e === other?.e && this.u === other?.u;
  }

  public toXY() {
    return {
      x: 16 * (this.e - this.s),
      y: 8 * (this.e + this.s) - 8 * this.u,
    };
  }
}

/**
 * How close to a whole number a box's face has to be to count as sitting on
 * it. Wide enough to swallow the error of adding a few fractions together,
 * far narrower than anything a position can meaningfully express.
 */
export const EDGE = 1e-9;

/**
 * An axis-aligned box in iso space, used as a hitbox.
 *
 * The box is half-open: it spans [min, max) on each axis.
 */
export class IsoBox {
  constructor(
    public readonly min: IsoCoordinates,
    public readonly max: IsoCoordinates
  ) {}

  /**
   * A box of `size` standing on the cell at `iso`: centred on it horizontally,
   * feet on its floor.
   *
   * An entity narrower than a cell shares the slack between its two sides, so
   * that walking into a wall behaves the same whichever direction it came
   * from. Hanging the box off the cell's minimum corner instead would put all
   * the slack on the south and east sides.
   *
   * Height is deliberately not centred: an entity stands on the cell, it does
   * not float in the middle of it.
   */
  public static standingOn(iso: IsoCoordinates, size: IsoCoordinates): IsoBox {
    const min = iso.add(
      new IsoCoordinates((1 - size.s) / 2, (1 - size.e) / 2, 0)
    );
    return new IsoBox(min, min.add(size));
  }

  /**
   * Range of integer cells the box overlaps on one axis, both bounds included.
   *
   * Because the box is half-open, a box whose max falls exactly on a cell
   * boundary does NOT overlap the cell beyond it: this is what lets a
   * character standing flush against a wall still move along it.
   *
   * A bound within EDGE of a whole number counts as being on it. A box is
   * built by adding fractions — `standingOn` adds the slack, then the size —
   * so a face that should land exactly on a boundary lands a few 1e-16 past
   * it, and without this an entity would claim a cell it does not touch. That
   * is not cosmetic: it made the same entity occupy a different number of
   * cells depending on where it stood on the map, which changes both its
   * collisions and the way its sprite is cut.
   */
  public cellRange(axis: IsoAxis): [number, number] {
    const min = Math.floor(this.min[axis] + EDGE);
    // a zero-width box still covers the cell it sits in
    return [min, Math.max(min, Math.ceil(this.max[axis] - EDGE) - 1)];
  }

  /**
   * The whole cells the box covers, as a half-open range [min, max) — the
   * corners of `cellRange` on all three axes at once.
   *
   * Kept here rather than derived by callers so that a box and the cells it
   * covers can never disagree: it is the same fact, and turning a fractional
   * coordinate into a cell index is a question only this class knows how to
   * answer (see the EDGE forgiveness above).
   */
  public cells(): { min: IsoCoordinates; max: IsoCoordinates } {
    const [minS, maxS] = this.cellRange("s");
    const [minE, maxE] = this.cellRange("e");
    const [minU, maxU] = this.cellRange("u");
    return {
      min: new IsoCoordinates(minS, minE, minU),
      max: new IsoCoordinates(maxS + 1, maxE + 1, maxU + 1),
    };
  }
}

/**
 * What a cell's depth key gains per diagonal (s + e) and per level (u).
 *
 * The ratio is free: whenever a cell hides another it has at least as high a
 * diagonal AND at least as high a u, so every positive pair is an exact
 * painter's order. IsometricCoordinate.test.ts proves it by enumerating the
 * offsets at which one cell hides another.
 *
 * What the ratio does decide is how much room is left BETWEEN two cells, and
 * that is what anything standing across cells needs. Height weighted as low as
 * it can be leaves a whole unit between one cell of a column and the next,
 * which is what a character's pieces are keyed inside of — see
 * EntityColumns.subCellKey.
 *
 * It also moves that room away from somewhere else, which is what stops it
 * being tuned: a MapObject taller than one cell carries the key of its base
 * cell while its sprite covers its whole height (MapChunk.createMapObject), and
 * only survives that because a whole column of cells fits between two diagonals
 * here. At a ratio of 10 / 7 it no longer does, and the trees of koring-wood
 * and deti-plains change where they sort against the cliffs behind them.
 * Cutting tall objects by column the way characters are cut is what would
 * unlock this.
 *
 * Whole numbers, because anything standing across cells takes a key strictly
 * between two of them by adding a fraction, which only never ties if cell keys
 * are integers.
 */
const DIAGONAL_WEIGHT = MAP_MAX_HEIGHT;
const HEIGHT_WEIGHT = 1;

/**
 * Depth key of a cell: an exact linear extension of "this cell hides that
 * one" for integer cells.
 *
 * @see GlobalIsoCoordinates.paintersOrderKey, which is the way to call it
 * unless allocating a coordinate would be too costly.
 */
export const paintersOrderKey = (s: number, e: number, u: number): number =>
  DIAGONAL_WEIGHT * (s + e) + HEIGHT_WEIGHT * u;

/**
 * Global map isometric coordinates.
 */
export class GlobalIsoCoordinates extends IsoCoordinates {
  public readonly type = "global";

  /**
   * Depth key of this cell, for the zIndex of whatever displays it.
   *
   * Deliberately defined on global coordinates only: the live block draws the
   * cells of four chunks and the pieces of a character in one container, so
   * every key that meets there has to be counted from the same origin. Keying
   * a tile on its chunk-local coordinates instead would make those families
   * incomparable.
   */
  public paintersOrderKey(): number {
    return paintersOrderKey(this.s, this.e, this.u);
  }
}

/**
 * Chunk isometric coordinates.
 */
export class ChunkIsoCoordinates extends IsoCoordinates {
  public readonly type = "chunk";
}

/**
 * Local isometric coordinates in a chunk.
 */
export class LocalIsoCoordinates extends IsoCoordinates {
  public readonly type = "local";
}
