import { Container, DestroyOptions, Sprite } from "pixi.js";
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
 *
 * It is also the container its cells are drawn in, which makes a chunk atomic
 * in the draw order — except while it is part of the live block around a
 * character, where it lends its views out so they can interleave with the
 * character's own. See Map.syncBlock.
 */
export class MapChunk extends Container {
  public cells: Record<IsoString, CellContent> = {};

  /**
   * The highest level this chunk has ever held a cell at.
   *
   * A high-water mark, never lowered: it only ever bounds a search upward
   * through a column (Map.isOvershadowed), so an emptied tower costs a few
   * wasted lookups and never a wrong answer.
   */
  public highestLevel = -1;

  /**
   * Bumped whenever `cells` changes, so that anything derived from the whole
   * chunk can tell in one comparison whether it is still current. Only the
   * debug chunk-boundary overlay reads it (Map.syncChunkBounds), which is why
   * it is a counter and not an event: it is asked, never announced.
   */
  public revision = 0;

  /** Container the views below are drawn in: this chunk, or the live block. */
  private viewHost: Container = this;
  /**
   * Every view this chunk put in its host. Not `children`, because the host is
   * not always this chunk: this is what it can hand over and take back.
   */
  private readonly views = new Set<Container>();

  constructor(
    public size: number,
    chunkTileData: ChunkTileData,
    public tileFragmentsTextures: TileFragmentsTextures,
    private getTileTypeByGlobalCoordinates: (
      iso: GlobalIsoCoordinates
    ) => TileType | undefined,
    private isOvershadowed: (iso: GlobalIsoCoordinates) => boolean,
    public readonly chunkIsoCoordinates: ChunkIsoCoordinates
  ) {
    super();
    this.eventMode = "none";
    this.sortableChildren = true;
    // Pixi rebuilds a render group's draw instructions when its structure
    // changes. Without a boundary the whole map is one group, so moving the
    // character one pixel rebuilds every cell of it — 170 000 display objects
    // on a 128×128×16 map, a 140 → 30 fps drop. A chunk is already atomic in
    // the draw order, so its own pass costs nothing and contains the rebuild.
    this.isRenderGroup = true;
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
      this.highestLevel = Math.max(
        this.highestLevel,
        LocalIsoCoordinates.fromString(key).u
      );
    }
  }

  public get isEmpty(): boolean {
    return Object.keys(this.cells).length === 0;
  }

  /** Whether it still draws anything, wherever its views currently live. */
  public get hasViews(): boolean {
    return this.views.size > 0;
  }

  private attach(view: Container) {
    this.views.add(view);
    this.viewHost.addChild(view);
  }

  private release(view: Container) {
    this.views.delete(view);
    view.parent?.removeChild(view);
  }

  /**
   * Draw this chunk's cells inside `host` instead of inside itself, so that
   * they take their place in a wider draw order. Pixi reparents on addChild,
   * so this is the whole of it.
   */
  public lendViewsTo(host: Container) {
    if (host === this.viewHost) return;
    this.viewHost = host;
    for (const view of this.views) host.addChild(view);
  }

  public takeViewsBack() {
    this.lendViewsTo(this);
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

  public createTile(
    iso: LocalIsoCoordinates,
    type: TileType,
    skipFragmentsSetup = false
  ): Tile {
    this.assertInside(iso);
    this.highestLevel = Math.max(this.highestLevel, iso.u);
    const globalIso = this.toGlobalIsoCoordinates(iso);
    const tile = new Tile({
      type,
      getTileTypeAt: this.getTileTypeByGlobalCoordinates,
      isOvershadowed: this.isOvershadowed,
      localIsoCoordinates: iso,
      globalIsoCoordinates: globalIso,
      tileFragmentsTextures: this.tileFragmentsTextures,
      chunk: this,
      skipFragmentsSetup,
    });
    // Views are placed in map pixels, never relative to the chunk: a chunk is
    // a grouping in the draw order, not a coordinate frame, and its views move
    // between it and the live block without ever changing position.
    const xy = globalIso.toXY();
    tile.x = xy.x;
    tile.y = xy.y;
    tile.zIndex = globalIso.paintersOrderKey();
    this.cells[iso.toString()] = tile;
    this.revision++;
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
    this.revision++;
    this.release(tile);
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
    const xy = globalIso.toXY();
    mapObject.x = xy.x + 16;
    mapObject.y = xy.y + 24;
    mapObject.zIndex = globalIso.paintersOrderKey();
    this.attach(mapObject);
    // every level it occupies, so highestLevel is only right once they are
    // known: a large_pine is eleven cells tall, not one
    for (let i = 0; i < mapObject.objectHeight; i++) {
      const cellIso = new LocalIsoCoordinates(iso.s, iso.e, iso.u + i);
      this.assertInside(cellIso);
      this.cells[cellIso.toString()] = mapObject;
    }
    this.highestLevel = Math.max(
      this.highestLevel,
      iso.u + mapObject.objectHeight - 1
    );
    this.revision++;
    return mapObject;
  }

  public removeEntityAt(iso: LocalIsoCoordinates) {
    const cell = this.getCellAt(iso);
    if (cell === undefined) return;
    this.revision++;
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
    this.release(cell);
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
      this.attach(tile);
    } else if (!tile.hasVisibleFragments && tile.parent) {
      this.release(tile);
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
    // Views lent to the live block would outlive it otherwise
    this.takeViewsBack();
    this.views.clear();
    for (const key of Object.keys(this.cells) as IsoString[]) {
      const cell = this.cells[key];
      if (cell instanceof Tile && !cell.parent) {
        cell.destroy({ children: true });
      }
    }
    this.cells = {};
    super.destroy(options);
  }

  public addCursorSpriteAt(globalIso: GlobalIsoCoordinates, sprite: Sprite) {
    const xy = globalIso.toXY();
    sprite.x = xy.x;
    sprite.y = xy.y;
    sprite.zIndex = globalIso.paintersOrderKey();
    this.attach(sprite);
  }

  public removeCursorSprite(sprite: Sprite) {
    this.release(sprite);
  }
}
