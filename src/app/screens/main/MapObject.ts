import { Sprite, Texture } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";
import type { MapChunk } from "./MapChunk";

/**
 * The type of a map object (e.g. "large_pine").
 */
export type MapObjectType = string & { readonly __brand: "MapObjectType" };

/**
 * An object on the map (tree, rock...).
 */
export class MapObject extends Sprite {
  public readonly type: MapObjectType;
  public readonly localIsoCoordinates: LocalIsoCoordinates;
  public readonly globalIsoCoordinates: GlobalIsoCoordinates;
  public readonly objectHeight: number;
  public readonly occupiedCells: GlobalIsoCoordinates[];
  public chunk: MapChunk;

  constructor({
    type,
    localIsoCoordinates,
    globalIsoCoordinates,
    chunk,
  }: {
    type: MapObjectType;
    localIsoCoordinates: LocalIsoCoordinates;
    globalIsoCoordinates: GlobalIsoCoordinates;
    chunk: MapChunk;
  }) {
    const texture = MapObject.getTexture(type);
    super({ texture });
    this.type = type;
    this.anchor.set(0.5, 1);
    this.localIsoCoordinates = localIsoCoordinates;
    this.globalIsoCoordinates = globalIsoCoordinates;

    this.objectHeight = MapObject.getHeight(type);
    this.occupiedCells = MapObject.getOccupiedCells(type, globalIsoCoordinates);
    this.chunk = chunk;
  }

  public static getTexture(type: MapObjectType): Texture {
    const texture = Texture.from(type + ".png");
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for object of type ${type}`
      );
    }
    return texture;
  }

  /**
   * Height in cells, derived from the sprite size
   */
  public static getHeight(type: MapObjectType): number {
    const texture = MapObject.getTexture(type);
    const isValid = (texture.height - 16) % 8 === 0;
    if (!isValid) {
      console.warn(
        `Invalid texture height for object of type ${type}. Height must be 16 + 8 * n`
      );
    }
    return Math.max(Math.floor((texture.height - 16) / 8), 1);
  }

  public static getOccupiedCells(
    type: MapObjectType,
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
