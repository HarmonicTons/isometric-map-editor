import { Container } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import type { MapChunk } from "./MapChunk";
import { NoTextureFoundError } from "./NoTextureFoundError";
import { TileFragment, tileFragmentKeys } from "./TileFragment";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type GetTileTypeAt = (iso: GlobalIsoCoordinates) => string | undefined;

/**
 * An isometric tile
 */
export class Tile extends Container {
  public type: string;
  public localIsoCoordinates: LocalIsoCoordinates;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public tileFragmentsTextures: TileFragmentsTextures;
  public getTileTypeAt: GetTileTypeAt;
  public chunk: MapChunk;
  constructor({
    type,
    getTileTypeAt,
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
    getTileTypeAt: GetTileTypeAt;
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
    this.getTileTypeAt = getTileTypeAt;
    this.chunk = chunk;
    this.eventMode = "none";

    if (!skipFragmentsSetup) {
      this.setTileFragments();
    }
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
          getTileNeighbor: (relative: IsoCoordinates) =>
            this.getTileTypeAt(this.globalIsoCoordinates.add(relative)),
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
}
