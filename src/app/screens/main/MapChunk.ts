import { Container, DestroyOptions, Sprite, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  IsoString,
  LocalIsoCoordinates,
  MAP_MAX_HEIGHT,
} from "./IsometricCoordinate";
import { MapObject, MapObjectType } from "./MapObject";
import { Tile, TileType } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type ChunkTileData = Record<IsoString, TileType>;

/**
 * What a cell can hold. The value type encodes the cell's state:
 * - string: a buried tile, kept as pure data (its type), no display object
 * - Tile: a shell tile, materialized (attached while it has fragments)
 * - MapObject: shared reference, present on every cell the object occupies
 */
export type CellContent = TileType | Tile | MapObject;

/**
 * A fixed-size column section of the map.
 *
 * A chunk only knows its own local domain.
 * Anything that may cross a chunk boundary must go through Map
 */
export class MapChunk extends Container {
  public cells: Record<IsoString, CellContent> = {};

  constructor(
    public size: number,
    chunkTileData: ChunkTileData,
    public tileFragmentsTextures: TileFragmentsTextures,
    private getTileTypeByGlobalCoordinates: (
      iso: GlobalIsoCoordinates
    ) => TileType | undefined,
    public readonly chunkIsoCoordinates: ChunkIsoCoordinates
  ) {
    super();
    this.eventMode = "none";
    this.sortableChildren = true;
    // Tiles are loaded as bare data: materialization of the shell happens in
    // the map-wide pass, once every chunk's data is available
    for (const key of Object.keys(chunkTileData) as IsoString[]) {
      const type = chunkTileData[key];
      if (!type) continue;
      try {
        this.assertInside(LocalIsoCoordinates.fromString(key));
      } catch (e) {
        console.warn(
          `Ignoring tile at ${key} in chunk ${this.chunkIsoCoordinates.toString()}: ${e}`
        );
        continue;
      }
      this.cells[key] = type;
    }
  }

  public get isEmpty(): boolean {
    return Object.keys(this.cells).length === 0;
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

  public getCellAt(iso: LocalIsoCoordinates): CellContent | undefined {
    this.assertInside(iso);
    return this.cells[iso.toString()];
  }

  public isCellOccupied(iso: LocalIsoCoordinates): boolean {
    return this.getCellAt(iso) !== undefined;
  }

  public getTileTypeAt(iso: LocalIsoCoordinates): TileType | undefined {
    const cell = this.getCellAt(iso);
    if (typeof cell === "string") return cell;
    return cell instanceof Tile ? cell.type : undefined;
  }

  public getDisplayedEntityAt(
    iso: LocalIsoCoordinates
  ): Tile | MapObject | undefined {
    const cell = this.getCellAt(iso);
    return typeof cell === "string" ? undefined : cell;
  }

  public createTile(
    iso: LocalIsoCoordinates,
    type: TileType,
    skipFragmentsSetup = false
  ): Tile {
    this.assertInside(iso);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const tile = new Tile({
      type,
      getTileTypeAt: this.getTileTypeByGlobalCoordinates,
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
    this.cells[iso.toString()] = tile;
    if (!skipFragmentsSetup) {
      this.syncTileAttachment(tile);
    }
    return tile;
  }

  /**
   * string → Tile: give a buried cell its display object.
   */
  public materializeTile(iso: LocalIsoCoordinates): Tile {
    const cell = this.getCellAt(iso);
    if (typeof cell !== "string") {
      throw new Error(
        `Cannot materialize cell ${iso.toString()}: it holds no bare tile data`
      );
    }
    return this.createTile(iso, cell, true);
  }

  /** Tile → string: drop the display object of a buried tile, keep the data */
  public dematerializeTile(tile: Tile) {
    const key = tile.localIsoCoordinates.toString();
    if (this.cells[key] !== tile) {
      throw new Error(
        `Cannot dematerialize ${key}: it is not the registered tile`
      );
    }
    this.cells[key] = tile.type;
    tile.destroy({ children: true });
  }

  public createMapObject(
    iso: LocalIsoCoordinates,
    type: MapObjectType
  ): MapObject {
    this.assertInside(iso);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const mapObject = new MapObject({
      type,
      localIsoCoordinates: iso,
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
      this.cells[cellIso.toString()] = mapObject;
    }
    return mapObject;
  }

  public removeEntityAt(iso: LocalIsoCoordinates) {
    const cell = this.getCellAt(iso);
    if (cell === undefined) return;
    if (typeof cell === "string") {
      delete this.cells[iso.toString()];
      return;
    }
    if (cell instanceof MapObject) {
      const anchorU = cell.globalIsoCoordinates.u;
      for (let i = 0; i < cell.objectHeight; i++) {
        const cellIso = new LocalIsoCoordinates(iso.s, iso.e, anchorU + i);
        delete this.cells[cellIso.toString()];
      }
    } else {
      delete this.cells[iso.toString()];
    }
    cell.destroy({ children: true });
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

  public updateAllTileNeighborhood(
    isInShell: (iso: GlobalIsoCoordinates) => boolean
  ) {
    for (const key of Object.keys(this.cells) as IsoString[]) {
      const cell = this.cells[key];
      if (cell instanceof MapObject) continue;
      const iso = LocalIsoCoordinates.fromString(key);
      if (typeof cell === "string") {
        if (!isInShell(this.toGlobalIsoCoordinates(iso))) continue;
        this.refreshTile(this.materializeTile(iso));
      } else {
        this.refreshTile(cell);
      }
    }
  }

  public override destroy(options?: DestroyOptions) {
    for (const key of Object.keys(this.cells) as IsoString[]) {
      const cell = this.cells[key];
      if (cell instanceof Tile && !cell.parent) {
        cell.destroy({ children: true });
      }
    }
    this.cells = {};
    super.destroy(options);
  }

  public addCursorSpriteAt(iso: LocalIsoCoordinates, sprite: Sprite) {
    const xy = iso.toXY();
    sprite.x = xy.x;
    sprite.y = xy.y;
    sprite.zIndex = iso.paintersOrderKey(MAP_MAX_HEIGHT);
    this.addChild(sprite);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public update(_time: Ticker) {}
}
