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

  public paintersOrderKey(uMax: number) {
    return (this.s + this.e) * uMax + this.u;
  }
 
  /**
   * Painter's order key for mobile entities (character). 
   * - drawn after the ground of the row in front;
   * - drawn before everything else in that row above.
   */
  public billboardPaintersOrderKey(uMax: number) {
    return (Math.floor(this.s + this.e) + 1) * uMax + this.u - 0.5;
  }

  public toXY() {
    return {
      x: 16 * (this.e - this.s),
      y: 8 * (this.e + this.s) - 8 * this.u,
    };
  }
}

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

  public static fromOriginAndSize(
    origin: IsoCoordinates,
    size: IsoCoordinates
  ): IsoBox {
    return new IsoBox(origin, origin.add(size));
  }

  /**
   * Range of integer cells the box overlaps on one axis, both bounds included.
   *
   * Because the box is half-open, a box whose max falls exactly on a cell
   * boundary does NOT overlap the cell beyond it: this is what lets a
   * character standing flush against a wall still move along it.
   */
  public cellRange(axis: IsoAxis): [number, number] {
    const min = Math.floor(this.min[axis]);
    // a zero-width box still covers the cell it sits in
    return [min, Math.max(min, Math.ceil(this.max[axis]) - 1)];
  }
}

/**
 * Global map isometric coordinates.
 */
export class GlobalIsoCoordinates extends IsoCoordinates {
  public readonly type = "global";
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
