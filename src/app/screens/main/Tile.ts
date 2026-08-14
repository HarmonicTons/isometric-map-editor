import { Container, Graphics } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import type { MapChunk } from "./MapChunk";
import { NoTextureFoundError } from "./NoTextureFoundError";
import { paintRuns, TOP_FACE_RUNS } from "./Shadows";
import { TileFragment, tileFragmentKeys } from "./TileFragment";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

/**
 * The type of a tile (e.g. "dirt", "wall").
 */
export type TileType = string & { readonly __brand: "TileType" };

export type GetTileTypeAt = (iso: GlobalIsoCoordinates) => TileType | undefined;

/**
 * An isometric tile
 */
export class Tile extends Container {
  public type: TileType;
  public localIsoCoordinates: LocalIsoCoordinates;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public tileFragmentsTextures: TileFragmentsTextures;
  public getTileTypeAt: GetTileTypeAt;
  /** Whether something floating above darkens this tile's top face */
  public isOvershadowed: (iso: GlobalIsoCoordinates) => boolean;
  public chunk: MapChunk;
  /** How many of this tile's children are fragments rather than its shade */
  private fragments = 0;
  constructor({
    type,
    getTileTypeAt,
    isOvershadowed,
    localIsoCoordinates,
    globalIsoCoordinates,
    tileFragmentsTextures,
    chunk,
    skipFragmentsSetup,
  }: {
    /**
     * the type, ex: wall or stone
     */
    type: TileType;
    getTileTypeAt: GetTileTypeAt;
    isOvershadowed: (iso: GlobalIsoCoordinates) => boolean;
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
    this.isOvershadowed = isOvershadowed;
    this.chunk = chunk;
    this.eventMode = "none";

    if (!skipFragmentsSetup) {
      this.setTileFragments();
    }
  }

  public get hasVisibleFragments(): boolean {
    return this.fragments > 0;
  }

  public updateNeighborhood() {
    this.removeChildren().forEach((child) => {
      child.destroy();
    });
    this.fragments = 0;
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
        this.fragments++;
      } catch (e) {
        if (e instanceof NoTextureFoundError) {
          // can safely ignore, just means this fragment is empty
          return;
        }
        throw e;
      }
    });
    this.setShade();
  }

  /**
   * Darken the whole top face when something floats over this tile.
   *
   * A child of the tile rather than a display object of its own, which is the
   * whole reason this is cheap: it inherits the tile's place in the draw order
   * and is added last, so it lands on the tile's own art and on nothing else.
   * No key to invent, nothing to sort, nothing to keep in step.
   *
   * The pixels are the ones the top face owns — the same partition a
   * character's shadow is read through, seam bias included, so the two never
   * disagree about where a tile ends.
   */
  private setShade() {
    if (this.fragments === 0) return;
    if (!this.isOvershadowed(this.globalIsoCoordinates)) return;
    const shade = new Graphics({ eventMode: "none" });
    paintRuns(shade, TOP_FACE_RUNS);
    this.addChild(shade);
  }
}
