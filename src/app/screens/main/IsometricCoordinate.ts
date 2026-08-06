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

  public toXY() {
    return {
      x: 16 * (this.e - this.s),
      y: 8 * (this.e + this.s) - 8 * this.u,
    };
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
