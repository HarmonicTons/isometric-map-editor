import { Sprite, Texture } from "pixi.js";
import { GlobalIsoCoordinates, IsoCoordinates } from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";

/**
 * An object on the map
 */
export class MapObject extends Sprite {
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public type: string;
  public objectHeight: number;
  public occupiedCells: GlobalIsoCoordinates[] = [];

  constructor({
    type,
    globalIsoCoordinates,
    occupiedCells,
  }: {
    type: string;
    globalIsoCoordinates: GlobalIsoCoordinates;
    occupiedCells: GlobalIsoCoordinates[];
  }) {
    const texture = Texture.from(type + ".png");
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for object of type ${type}`
      );
    }
    // keep pixel art style

    super({ texture });
    this.type = type;
    this.anchor.set(0, 1);
    this.globalIsoCoordinates = globalIsoCoordinates;

    this.objectHeight = MapObject.getHeight(type);
    this.occupiedCells = occupiedCells;
  }

  public static getHeight(type: string): number {
    const texture = Texture.from(type + ".png");
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for object of type ${type}`
      );
    }
    const isValid = (texture.height - 16) % 8 === 0;
    if (!isValid) {
      console.warn(
        `Invalid texture height for object of type ${type}. Height must be 16 + 8 * n`
      );
    }
    return Math.max(Math.floor((texture.height - 16) / 8), 1);
  }

  public static getOccupiedCells(
    type: string,
    isoCoordinates: GlobalIsoCoordinates
  ): GlobalIsoCoordinates[] {
    const height = MapObject.getHeight(type);
    const occupiedCells: GlobalIsoCoordinates[] = [];
    for (let u = 0; u < height; u++) {
      occupiedCells.push(isoCoordinates.add(new IsoCoordinates(0, 0, u)));
    }
    return occupiedCells;
  }
}
