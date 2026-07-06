import { Container, DestroyOptions, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";
import { MapObject } from "./MapObject";
import { Tile } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type MapChunkData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
};

/**
 * A fixed-size cubic section of the map.
 *
 * A chunk only knows its own local domain: every coordinate it receives is a
 * LocalIsoCoordinates that must be inside its bounds (asserted). Anything
 * that may cross a chunk boundary — neighbor lookups, edits, invalidation —
 * must go through Map, the single authority on global coordinates.
 */
export class MapChunk extends Container {
  public tiles: Record<string, Tile> = {};
  public objects: Record<string, MapObject> = {};

  constructor(
    public size: number,
    chunkData: MapChunkData,
    public tileFragmentsTextures: TileFragmentsTextures,
    private getTileByGlobalCoordinates: (
      iso: GlobalIsoCoordinates
    ) => Tile | undefined,
    public readonly chunkIsoCoordinates: ChunkIsoCoordinates
  ) {
    super();
    this.eventMode = "none";
    this.sortableChildren = true;
    const { tiles, objects } = chunkData;
    for (const key in tiles) {
      const type = tiles[key];
      if (!type) continue;
      this.createTile(LocalIsoCoordinates.fromString(key), type);
    }
    for (const key in objects) {
      const type = objects[key];
      if (!type) continue;
      this.createObject(LocalIsoCoordinates.fromString(key), type);
    }
  }

  public get isEmpty(): boolean {
    return (
      Object.keys(this.tiles).length === 0 &&
      Object.keys(this.objects).length === 0
    );
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

  public getTileAt(iso: LocalIsoCoordinates): Tile | undefined {
    this.assertInside(iso);
    return this.tiles[iso.toString()];
  }

  public getMapObjectAt(iso: LocalIsoCoordinates): MapObject | undefined {
    this.assertInside(iso);
    return this.objects[iso.toString()];
  }

  public getEntityAt(iso: LocalIsoCoordinates): Tile | MapObject | undefined {
    return this.getTileAt(iso) || this.getMapObjectAt(iso);
  }

  public createTile(iso: LocalIsoCoordinates, type: string): Tile {
    this.assertInside(iso);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const tile = new Tile({
      type,
      getTileNeighbor: (relativeCoordinates) =>
        this.getTileByGlobalCoordinates(globalIso.add(relativeCoordinates))
          ?.type,
      localIsoCoordinates: iso,
      globalIsoCoordinates: globalIso,
      tileFragmentsTextures: this.tileFragmentsTextures,
      chunk: this,
    });
    const xy = iso.toXY();
    tile.x = xy.x;
    tile.y = xy.y;
    tile.zIndex = iso.paintersOrderKey(this.size);
    this.tiles[iso.toString()] = tile;
    this.syncTileAttachment(tile);
    return tile;
  }

  public createObject(iso: LocalIsoCoordinates, type: string): MapObject {
    this.assertInside(iso);
    const mapObject = new MapObject({ type, isoCoordinates: iso });
    const xy = iso.toXY();
    mapObject.x = xy.x;
    mapObject.y = xy.y + 24;
    mapObject.zIndex = iso.paintersOrderKey(this.size);
    this.objects[iso.toString()] = mapObject;
    this.addChild(mapObject);
    return mapObject;
  }

  public removeTileAt(iso: LocalIsoCoordinates) {
    const existingTile = this.getTileAt(iso);
    if (!existingTile) return;
    delete this.tiles[iso.toString()];
    existingTile.destroy({ children: true });
  }

  public removeMapObjectAt(iso: LocalIsoCoordinates) {
    const existingObject = this.getMapObjectAt(iso);
    if (!existingObject) return;
    delete this.objects[iso.toString()];
    existingObject.destroy({ children: true });
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
    for (const key in this.tiles) {
      this.refreshTile(this.tiles[key]);
    }
  }

  /** Buried tiles are detached from the scene graph: destroy them explicitly. */
  public override destroy(options?: DestroyOptions) {
    for (const key in this.tiles) {
      const tile = this.tiles[key];
      if (!tile.parent) tile.destroy({ children: true });
    }
    this.tiles = {};
    this.objects = {};
    super.destroy(options);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public update(_time: Ticker) {}
}
