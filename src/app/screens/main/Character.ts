import { Sprite, Texture, Ticker } from "pixi.js";
import {
  GlobalIsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import type { MapChunk } from "./MapChunk";
import { NoTextureFoundError } from "./NoTextureFoundError";

/**
 * The type of a character (e.g. who).
 */
export type CharacterType = string & { readonly __brand: "CharacterType" };

export type CharacterState = "idle" | "walking";
const stateKey: Record<CharacterState, string> = {
  idle: "i",
  walking: "m",
};
export type CharacterDirection = "north" | "east" | "south" | "west";
const directionKey: Record<CharacterDirection, string> = {
  north: "n",
  east: "e",
  south: "s",
  west: "w",
};

/**
 * A character on the map.
 */
export class Character extends Sprite {
  public type: CharacterType;
  public localIsoCoordinates: LocalIsoCoordinates;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public characterHeight: number = 2;
  public chunk: MapChunk;
  public state: CharacterState;
  public direction: CharacterDirection = "south";

  constructor({
    type,
    state = "walking",
    direction = "south",
    localIsoCoordinates,
    globalIsoCoordinates,
    chunk,
  }: {
    type: CharacterType;
    state?: CharacterState;
    direction?: CharacterDirection;
    localIsoCoordinates: LocalIsoCoordinates;
    globalIsoCoordinates: GlobalIsoCoordinates;
    chunk: MapChunk;
  }) {
    const texture = Character.getTexture(type, state, direction);
    super({ texture });
    this.type = type;
    this.state = state;
    this.direction = direction;
    this.anchor.set(0.5, 1);
    this.localIsoCoordinates = localIsoCoordinates;
    this.globalIsoCoordinates = globalIsoCoordinates;
    this.chunk = chunk;
  }

  public static getTexture(
    type: CharacterType,
    state: CharacterState,
    direction: CharacterDirection = "south",
    animationFrame: number = 1
  ): Texture {
    const texture = Texture.from(
      `${type}_${stateKey[state]}-${directionKey[direction]}${animationFrame}.png`
    );
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for character ${type}_${stateKey[state]}-${directionKey[direction]}${animationFrame}.png`
      );
    }
    return texture;
  }

  public update(time: Ticker) {
    const animationFrameIndex = Math.floor(time.lastTime / 250) % 4;
    const animationFrame = [1, 2, 3, 2][animationFrameIndex];
    this.texture = Character.getTexture(
      this.type,
      this.state,
      this.direction,
      animationFrame
    );
  }
}
