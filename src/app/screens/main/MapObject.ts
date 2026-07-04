import { Sprite, Texture } from "pixi.js";
import { IsoCoordinates } from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";

/**
 * An object on the map
 */
export class MapObject extends Sprite {
  public isoCoordinates: IsoCoordinates;
  public type: string;
  constructor({
    type,
    isoCoordinates,
  }: {
    type: string;
    isoCoordinates: IsoCoordinates;
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
    this.isoCoordinates = isoCoordinates;
    this.interactive = true;
  }
}
