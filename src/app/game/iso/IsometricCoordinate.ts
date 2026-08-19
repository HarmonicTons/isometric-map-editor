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

/** How close to a whole number a box's face has to be to count as sitting on it */
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
   * Half-open, so a box flush against a cell boundary does NOT overlap the cell
   * beyond it — and a bound within EDGE of a whole number counts as being on
   * it, since a box is built by adding fractions.
   */
  public cellRange(axis: IsoAxis): [number, number] {
    const min = Math.floor(this.min[axis] + EDGE);
    // a zero-width box still covers the cell it sits in
    return [min, Math.max(min, Math.ceil(this.max[axis] - EDGE) - 1)];
  }

  /** The whole cells the box covers, as a half-open range [min, max) */
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
 * What a cell's depth key gains per diagonal (s + e); a level is worth 1, so a
 * whole column fits between two diagonals.
 */
const DIAGONAL_WEIGHT = MAP_MAX_HEIGHT;

/**
 * Depth key of a cell: an exact linear extension of "this cell hides that one".
 * @see GlobalIsoCoordinates.paintersOrderKey
 */
export const paintersOrderKey = (s: number, e: number, u: number): number =>
  DIAGONAL_WEIGHT * (s + e) + u;

/**
 * Global map isometric coordinates.
 */
export class GlobalIsoCoordinates extends IsoCoordinates {
  public readonly type = "global";

  /**
   * Depth key of this cell, for the zIndex of whatever displays it. Global
   * only: everything that meets in a container shares one origin.
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
