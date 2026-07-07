import { Container, DestroyOptions, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  LocalIsoCoordinates,
  MAP_MAX_HEIGHT,
} from "./IsometricCoordinate";
import { MapObject } from "./MapObject";
import { Tile } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type ChunkTileData = Record<string, string>;

/**
 * A fixed-size column section of the map.
 *
 * A chunk only knows its own local domain.
 * Anything that may cross a chunk boundary must go through Map
 */
export class MapChunk extends Container {
  public entities: Record<string, Tile | MapObject> = {};

  constructor(
    public size: number,
    chunkTileData: ChunkTileData,
    public tileFragmentsTextures: TileFragmentsTextures,
    private getTileTypeAt: (iso: GlobalIsoCoordinates) => string | undefined,
    public readonly chunkIsoCoordinates: ChunkIsoCoordinates
  ) {
    super();
    this.eventMode = "none";
    this.sortableChildren = true;
    for (const key in chunkTileData) {
      const type = chunkTileData[key];
      if (!type) continue;
      this.createTile(LocalIsoCoordinates.fromString(key), type, true);
    }
  }

  public get isEmpty(): boolean {
    return Object.keys(this.entities).length === 0;
  }

  private assertInside(iso: LocalIsoCoordinates) {
    // Chunks are vertical columns: s/e are chunk-local, u is global
    const inside =
      iso.s >= 0 &&
      iso.e >= 0 &&
      iso.u >= 0 &&
      iso.s < this.size &&
      iso.e < this.size &&
      iso.u < MAP_MAX_HEIGHT;
    if (!inside) {
      throw new Error(
        `Local coordinates ${iso.toString()} are outside chunk ${this.chunkIsoCoordinates.toString()}`
      );
    }
  }

  public toGlobalIsoCoordinates(
    localIso: LocalIsoCoordinates
  ): GlobalIsoCoordinates {
    return new GlobalIsoCoordinates(
      localIso.s + this.chunkIsoCoordinates.s * this.size,
      localIso.e + this.chunkIsoCoordinates.e * this.size,
      localIso.u + this.chunkIsoCoordinates.u * this.size
    );
  }

  public getEntityAt(iso: LocalIsoCoordinates): Tile | MapObject | undefined {
    this.assertInside(iso);
    return this.entities[iso.toString()];
  }

  public createTile(
    iso: LocalIsoCoordinates,
    type: string,
    skipFragmentsSetup = false
  ): Tile {
    this.assertInside(iso);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const tile = new Tile({
      type,
      getTileTypeAt: this.getTileTypeAt,
      localIsoCoordinates: iso,
      globalIsoCoordinates: globalIso,
      tileFragmentsTextures: this.tileFragmentsTextures,
      chunk: this,
      skipFragmentsSetup,
    });
    const xy = iso.toXY();
    tile.x = xy.x;
    tile.y = xy.y;
    tile.zIndex = iso.paintersOrderKey(MAP_MAX_HEIGHT);
    this.entities[iso.toString()] = tile;
    if (!skipFragmentsSetup) {
      this.syncTileAttachment(tile);
    }
    return tile;
  }

  public createMapObject(iso: LocalIsoCoordinates, type: string): MapObject {
    this.assertInside(iso);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const mapObject = new MapObject({
      type,
      globalIsoCoordinates: globalIso,
      chunk: this,
    });
    const xy = iso.toXY();
    mapObject.x = xy.x;
    mapObject.y = xy.y + 24;
    mapObject.zIndex = iso.paintersOrderKey(MAP_MAX_HEIGHT);
    this.addChild(mapObject);
    for (let i = 0; i < mapObject.objectHeight; i++) {
      const cellIso = new LocalIsoCoordinates(iso.s, iso.e, iso.u + i);
      this.assertInside(cellIso);
      this.entities[cellIso.toString()] = mapObject;
    }
    return mapObject;
  }

  public removeEntityAt(iso: LocalIsoCoordinates) {
    const existingEntity = this.getEntityAt(iso);
    if (!existingEntity) return;
    if (existingEntity instanceof MapObject) {
      const anchorU = existingEntity.globalIsoCoordinates.u;
      for (let i = 0; i < existingEntity.objectHeight; i++) {
        const cellIso = new LocalIsoCoordinates(iso.s, iso.e, anchorU + i);
        delete this.entities[cellIso.toString()];
      }
    } else {
      delete this.entities[iso.toString()];
    }
    existingEntity.destroy({ children: true });
  }

  /**
   * Rebuild a tile's fragments and keep it in the scene graph only while it
   * has something visible to render.
   */
  public refreshTile(tile: Tile) {
    tile.updateNeighborhood();
    this.syncTileAttachment(tile);
  }

  private syncTileAttachment(tile: Tile) {
    if (tile.hasVisibleFragments && !tile.parent) {
      this.addChild(tile);
    } else if (!tile.hasVisibleFragments && tile.parent) {
      this.removeChild(tile);
    }
  }

  public updateAllTileNeighborhood() {
    for (const key in this.entities) {
      const entity = this.entities[key];
      if (entity instanceof Tile) {
        this.refreshTile(entity);
      }
    }
  }

  /** Buried tiles are detached from the scene graph: destroy them explicitly. */
  public override destroy(options?: DestroyOptions) {
    for (const key in this.entities) {
      const entity = this.entities[key];
      if (entity instanceof Tile && !entity.parent) {
        entity.destroy({ children: true });
      }
    }
    this.entities = {};
    super.destroy(options);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public update(_time: Ticker) {}
}
