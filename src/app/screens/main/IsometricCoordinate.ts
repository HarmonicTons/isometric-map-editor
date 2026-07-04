export const isoDirections = [
  "up",
  "north",
  "east",
  "south",
  "west",
  "down",
] as const;
export type IsoDirection = (typeof isoDirections)[number];

/**
 * Represents isometric coordinates in a 3D space.
 */
export class IsoCoordinates {
  constructor(
    public s: number,
    public e: number,
    public u: number
  ) {}

  public static fromString(coordString: string) {
    const [s, e, u] = coordString.split(",").map(Number);
    return new IsoCoordinates(s, e, u);
  }

  public static directionsOffsets: Record<IsoDirection, IsoCoordinates> = {
    up: new IsoCoordinates(0, 0, 1),
    north: new IsoCoordinates(-1, 0, 0),
    east: new IsoCoordinates(0, 1, 0),
    south: new IsoCoordinates(1, 0, 0),
    west: new IsoCoordinates(0, -1, 0),
    down: new IsoCoordinates(0, 0, -1),
  };

  public toString() {
    return `${this.s},${this.e},${this.u}`;
  }

  public add(offset: IsoCoordinates) {
    return new IsoCoordinates(
      this.s + offset.s,
      this.e + offset.e,
      this.u + offset.u
    );
  }
  public move(direction: IsoDirection) {
    return this.add(IsoCoordinates.directionsOffsets[direction]);
  }

  public paintersOrderKey(uMax: number) {
    return (this.s + this.e) * uMax + this.u;
  }
}
