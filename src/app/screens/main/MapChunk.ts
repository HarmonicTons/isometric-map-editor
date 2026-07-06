import { Container, DestroyOptions, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import { MapObject } from "./MapObject";
import { Tile } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type ChunkTileData = Record<string, string>;

/**
 * A fixed-size cubic section of the map.
 *
 * A chunk only knows its own local domain: every coordinate it receives is a
 * LocalIsoCoordinates that must be inside its bounds (asserted). Anything
 * that may cross a chunk boundary — neighbor lookups, edits, invalidation —
 * must go through Map, the single authority on global coordinates.
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
    const inside =
      iso.s >= 0 &&
      iso.e >= 0 &&
      iso.u >= 0 &&
      iso.s < this.size &&
      iso.e < this.size &&
      iso.u < this.size;
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
    tile.zIndex = iso.paintersOrderKey(this.size);
    this.entities[iso.toString()] = tile;
    if (!skipFragmentsSetup) {
      this.syncTileAttachment(tile);
    }
    return tile;
  }

  public registerMapObjectAt(
    iso: LocalIsoCoordinates,
    entity: MapObject
  ) {
    this.assertInside(iso);
    this.entities[iso.toString()] = entity;
  }

  public unregisterMapObjectAt(iso: LocalIsoCoordinates) {
    this.assertInside(iso);
    delete this.entities[iso.toString()];
  }

  // public createObject(iso: LocalIsoCoordinates, type: string): MapObject {
  // const mapObject = new MapObject({ type, isoCoordinates: iso });
  // const xy = iso.toXY();
  // mapObject.x = xy.x;
  // mapObject.y = xy.y + 24;
  // mapObject.zIndex = iso.paintersOrderKey(this.size);
  // this.objects[iso.toString()] = mapObject;
  // this.addChild(mapObject);
  // return mapObject;
  // }

  public removeTileAt(iso: LocalIsoCoordinates) {
    const existingEntity = this.getEntityAt(iso);
    if (!existingEntity) return;
    delete this.entities[iso.toString()];
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
