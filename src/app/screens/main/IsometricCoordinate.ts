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
   * Centred so that an entity narrower than a cell shares the slack between its
   * two sides, and walking into a wall behaves the same from either direction.
   * Height is not centred: an entity stands on the cell.
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
   * boundary does NOT overlap the cell beyond it: this is what lets a character
   * standing flush against a wall still move along it.
   *
   * A bound within EDGE of a whole number counts as being on it. A box is built
   * by adding fractions, so a face that should land exactly on a boundary lands
   * a few 1e-16 past it; without this the same entity would occupy a different
   * number of cells depending on where it stood, changing both its collisions
   * and the way its sprite is cut.
   */
  public cellRange(axis: IsoAxis): [number, number] {
    const min = Math.floor(this.min[axis] + EDGE);
    // a zero-width box still covers the cell it sits in
    return [min, Math.max(min, Math.ceil(this.max[axis] - EDGE) - 1)];
  }

  /**
   * The whole cells the box covers, as a half-open range [min, max): the
   * corners of `cellRange` on all three axes at once. Kept here so a box and its
   * cells can never disagree about the EDGE forgiveness above.
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
 * The ratio is free for correctness: whenever a cell hides another it has at
 * least as high a diagonal AND as high a u, so every positive pair is an exact
 * painter's order (IsometricCoordinate.test.ts enumerates it).
 *
 * What it decides is the room left BETWEEN two cells, which anything standing
 * across them needs: height weighted as low as it can be leaves a whole unit
 * between one cell of a column and the next (EntityColumns.subCellKey). Do not
 * tune it — a MapObject taller than one cell carries the key of its base cell
 * (MapChunk.createMapObject) and only survives that because a whole column fits
 * between two diagonals here.
 *
 * Whole numbers, so that a fractional key inserted between two cells never ties.
 */
const DIAGONAL_WEIGHT = MAP_MAX_HEIGHT;
const HEIGHT_WEIGHT = 1;

/**
 * Depth key of a cell: an exact linear extension of "this cell hides that one".
 *
 * @see GlobalIsoCoordinates.paintersOrderKey, the way to call it unless
 * allocating a coordinate would be too costly.
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
   * Defined on global coordinates only: the live block draws the cells of four
   * chunks and the pieces of a character in one container, so every key meeting
   * there has to be counted from the same origin.
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
