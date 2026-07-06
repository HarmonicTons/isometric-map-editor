import { Container, Sprite, Texture } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoCoordinates,
  LocalIsoCoordinates,
  VisibleIsoDirection,
} from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";
import { TileFragment, tileFragmentKeys } from "./TileFragment";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import type { MapChunk } from "./MapChunk";

export type GetTileNeighbor = (
  relativeCoordinates: IsoCoordinates
) => string | undefined;

/**
 * An isometric tile
 */
export class Tile extends Container {
  public type: string;
  public localIsoCoordinates: LocalIsoCoordinates;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public tileFragmentsTextures: TileFragmentsTextures;
  public getTileNeighbor: GetTileNeighbor;
  public cursorSprites: Record<VisibleIsoDirection, Sprite> = {} as Record<
    VisibleIsoDirection,
    Sprite
  >;
  public chunk: MapChunk;
  constructor({
    type,
    getTileNeighbor,
    localIsoCoordinates,
    globalIsoCoordinates,
    tileFragmentsTextures,
    chunk,
    skipFragmentsSetup,
  }: {
    /**
     * the type, ex: wall or stone
     */
    type: string;
    getTileNeighbor: GetTileNeighbor;
    localIsoCoordinates: LocalIsoCoordinates;
    globalIsoCoordinates: GlobalIsoCoordinates;
    tileFragmentsTextures: TileFragmentsTextures;
    chunk: MapChunk;
    skipFragmentsSetup?: boolean;
  }) {
    super();
    this.type = type;
    this.localIsoCoordinates = localIsoCoordinates;
    this.globalIsoCoordinates = globalIsoCoordinates;
    this.tileFragmentsTextures = tileFragmentsTextures;
    this.getTileNeighbor = getTileNeighbor;
    this.chunk = chunk;
    this.eventMode = "none";

    if (!skipFragmentsSetup) {
      this.setTileFragments();
    }

    const cursorUTexture = Texture.from("cursor-u.png");
    const cursorUSprite = new Sprite(cursorUTexture);

    const cursorETexture = Texture.from("cursor-e.png");
    const cursorESprite = new Sprite(cursorETexture);
    cursorESprite.anchor.set(-1, -0.5);

    const cursorSTexture = Texture.from("cursor-s.png");
    const cursorSSprite = new Sprite(cursorSTexture);
    cursorSSprite.anchor.set(0, -0.5);

    this.cursorSprites = {
      up: cursorUSprite,
      east: cursorESprite,
      south: cursorSSprite,
    };
  }

  public get hasVisibleFragments(): boolean {
    return this.children.length > 0;
  }

  public updateNeighborhood() {
    this.removeChildren();
    this.setTileFragments();
  }

  private setTileFragments() {
    tileFragmentKeys.forEach((key) => {
      try {
        const fragment = new TileFragment({
          type: this.type,
          key,
          getTileNeighbor: this.getTileNeighbor,
          height: this.globalIsoCoordinates.u,
          tileFragmentsTextures: this.tileFragmentsTextures,
        });
        this.addChild(fragment);
      } catch (e) {
        if (e instanceof NoTextureFoundError) {
          // can safely ignore, just means this fragment is empty
          return;
        }
        throw e;
      }
    });
  }

  public setHovered(isHovered: boolean, side?: VisibleIsoDirection) {
    this.removeChild(this.cursorSprites.up);
    this.removeChild(this.cursorSprites.east);
    this.removeChild(this.cursorSprites.south);

    if (isHovered && side) {
      this.addChild(this.cursorSprites[side]);
    }
  }
}
