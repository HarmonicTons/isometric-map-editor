import { Container, Sprite, Texture, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  IsoCoordinates,
  isoDirections,
  IsoString,
  LocalIsoCoordinates,
  MAP_MAX_HEIGHT,
  VisibleIsoDirection,
} from "./IsometricCoordinate";
import { CellContent, ChunkTileData, MapChunk } from "./MapChunk";
import { MapObject, MapObjectType } from "./MapObject";
import { Tile, TileType } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type MapData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
};

/**
 * Relative coordinates of the tiles to check to know if a tile is in the visible shell or not
 */
const shellTilesRelativeCoordinates = [
  new IsoCoordinates(0, 0, 1),
  new IsoCoordinates(0, 1, 0),
  new IsoCoordinates(1, 0, 0),
  new IsoCoordinates(1, 0, 1),
  new IsoCoordinates(0, 1, 1),
  new IsoCoordinates(1, 1, 1),
];

/**
 * The map, as a collection of chunks.
 *
 * Chunks are vertical columns (chunksSize × chunksSize × MAP_MAX_HEIGHT):
 * there is no vertical chunk boundary, so a map object always lives in a
 * single chunk, whole sprite included.
 *
 * Map is the single authority on global coordinates: every operation that can
 * cross a chunk boundary (lookups, edits, neighborhood invalidation) lives
 * here and is routed to the owning chunk in local coordinates. Chunks never
 * know about their neighbors.
 */
export class Map extends Container {
  public chunks: Record<IsoString, MapChunk> = {};
  private chunksSize: number = 8;
  public hoveredEntity?: {
    entity: Tile | MapObject;
    side: VisibleIsoDirection;
    iso: GlobalIsoCoordinates;
  };
  private cursorSprites: Record<VisibleIsoDirection, Sprite> = {} as Record<
    VisibleIsoDirection,
    Sprite
  >;
  private cursorMode?: "add" | "remove";

  constructor(
    mapData: MapData,
    public tileFragmentsTextures: TileFragmentsTextures
  ) {
    super();
    // Pointer events are handled by GameScreen
    this.eventMode = "none";
    this.sortableChildren = true;

    // Group the map data by chunk
    const chunksData: Record<IsoString, ChunkTileData> = {};
    const chunkDataFor = (globalIso: GlobalIsoCoordinates): ChunkTileData => {
      const chunkKey = this.toChunkIso(globalIso).toString();
      return (chunksData[chunkKey] ??= {});
    };
    for (const key in mapData.tiles) {
      const type = mapData.tiles[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      chunkDataFor(globalIso)[this.toLocalIso(globalIso).toString()] =
        type as TileType;
    }

    for (const chunkKey of Object.keys(chunksData) as IsoString[]) {
      this.createChunk(
        ChunkIsoCoordinates.fromString(chunkKey),
        chunksData[chunkKey]
      );
    }

    this.updateAllTileNeighborhood();

    for (const key in mapData.objects) {
      const type = mapData.objects[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      this.addMapObjectAt(globalIso, type as MapObjectType);
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

  /** Chunks are columns: their iso coordinates have no u component. */
  private toChunkIso(iso: GlobalIsoCoordinates): ChunkIsoCoordinates {
    const size = this.chunksSize;
    return new ChunkIsoCoordinates(
      Math.floor(iso.s / size),
      Math.floor(iso.e / size),
      0
    );
  }

  private toLocalIso(iso: GlobalIsoCoordinates): LocalIsoCoordinates {
    const size = this.chunksSize;
    // Euclidean modulo: also correct for negative global coordinates
    const mod = (v: number) => ((v % size) + size) % size;
    // u is not chunked: local u === global u
    return new LocalIsoCoordinates(mod(iso.s), mod(iso.e), iso.u);
  }

  private isInsideHeightBounds(iso: GlobalIsoCoordinates): boolean {
    return iso.u >= 0 && iso.u < MAP_MAX_HEIGHT;
  }

  public getChunkAt(iso: GlobalIsoCoordinates): MapChunk | undefined {
    return this.chunks[this.toChunkIso(iso).toString()];
  }

  private getOrCreateChunkAt(iso: GlobalIsoCoordinates): MapChunk {
    return this.getChunkAt(iso) ?? this.createChunk(this.toChunkIso(iso), {});
  }

  private getCellContentAt(iso: GlobalIsoCoordinates): CellContent | undefined {
    if (!this.isInsideHeightBounds(iso)) return undefined;
    return this.getChunkAt(iso)?.getCellAt(this.toLocalIso(iso));
  }

  public isCellOccupied(iso: GlobalIsoCoordinates): boolean {
    return this.getCellContentAt(iso) !== undefined;
  }

  public getTileTypeAt(iso: GlobalIsoCoordinates): TileType | undefined {
    const cell = this.getCellContentAt(iso);
    if (typeof cell === "string") return cell;
    return cell instanceof Tile ? cell.type : undefined;
  }

  public getEntityAt(iso: GlobalIsoCoordinates): Tile | MapObject | undefined {
    const cell = this.getCellContentAt(iso);
    return typeof cell === "string" ? undefined : cell;
  }

  /**
   * A tile cell deserves a display object iff at least one of its direct
   * neighbors is not a tile
   */
  private isInShell(iso: GlobalIsoCoordinates): boolean {
    return shellTilesRelativeCoordinates.some(
      (relative) => this.getCellContentAt(iso.add(relative)) === undefined
    );
  }

  public addTileAt(iso: GlobalIsoCoordinates, type: TileType) {
    console.debug(`Adding tile at ${iso.toString()}`);
    if (!this.isInsideHeightBounds(iso)) {
      console.warn("Tile exceeds map height bounds at", iso.toString());
      return;
    }
    if (this.isCellOccupied(iso)) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }
    this.getOrCreateChunkAt(iso).createTile(this.toLocalIso(iso), type);
    this.updateTileNeighbors(iso);
  }

  public addMapObjectAt(iso: GlobalIsoCoordinates, type: MapObjectType) {
    console.debug(`Adding map object at ${iso.toString()}`);
    const cells = MapObject.getOccupiedCells(type, iso);
    if (cells.some((cell) => !this.isInsideHeightBounds(cell))) {
      console.warn("Object exceeds map height bounds at", iso.toString());
      return;
    }
    if (cells.some((cell) => this.isCellOccupied(cell))) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }

    this.getOrCreateChunkAt(iso).createMapObject(this.toLocalIso(iso), type);
  }

  public removeEntityAt(iso: GlobalIsoCoordinates) {
    console.debug(`Removing entity at ${iso.toString()}`);
    const chunk = this.getChunkAt(iso);
    if (!chunk) return;
    const cell = chunk.getCellAt(this.toLocalIso(iso));
    if (cell === undefined) return;
    if (typeof cell !== "string") {
      this.clearHoveredEntity(cell);
    }
    chunk.removeEntityAt(this.toLocalIso(iso));
    this.destroyChunkIfEmpty(chunk);

    if (!(cell instanceof MapObject)) {
      this.updateTileNeighbors(iso);
    }
  }

  private clearHoveredEntity(entity: Tile | MapObject) {
    if (this.hoveredEntity?.entity !== entity) return;
    entity.chunk.removeChild(this.cursorSprites[this.hoveredEntity.side]);
    this.hoveredEntity = undefined;
  }

  private destroyChunkIfEmpty(chunk: MapChunk) {
    if (!chunk.isEmpty) return;
    console.debug(
      `Destroying empty chunk at ${chunk.chunkIsoCoordinates.toString()}`
    );
    delete this.chunks[chunk.chunkIsoCoordinates.toString()];
    chunk.destroy({ children: true });
  }

  /**
   * This won't work with tiles that are not UNESWD
   * TODO note which tile depends on which tile in a linked list
   */
  public updateTileNeighbors(iso: GlobalIsoCoordinates) {
    for (const direction of isoDirections) {
      this.refreshTileAt(iso.move(direction));
    }
    // HACK: hard code tiles to update
    this.refreshTileAt(iso.move("up").move("up").move("up"));
    this.refreshTileAt(iso.move("up").move("up"));
    this.refreshTileAt(iso.move("up").move("north"));
    this.refreshTileAt(iso.move("up").move("west"));
    this.refreshTileAt(iso.move("down").move("down"));
    this.refreshTileAt(iso.move("down").move("south"));
    this.refreshTileAt(iso.move("down").move("east"));
  }

  private refreshTileAt(iso: GlobalIsoCoordinates) {
    if (!this.isInsideHeightBounds(iso)) return;
    const chunk = this.getChunkAt(iso);
    if (!chunk) return;
    const localIso = this.toLocalIso(iso);
    const cell = chunk.getCellAt(localIso);
    if (cell === undefined || cell instanceof MapObject) return;

    if (typeof cell === "string") {
      if (!this.isInShell(iso)) return;
      chunk.refreshTile(chunk.materializeTile(localIso));
      return;
    }

    chunk.refreshTile(cell);
    if (!cell.hasVisibleFragments) {
      this.clearHoveredEntity(cell);
      chunk.dematerializeTile(cell);
    }
  }

  public updateAllTileNeighborhood() {
    for (const key of Object.keys(this.chunks) as IsoString[]) {
      this.chunks[key].updateAllTileNeighborhood((iso) => this.isInShell(iso));
    }
  }

  private createChunk(
    chunkIso: ChunkIsoCoordinates,
    chunkTileData: ChunkTileData
  ): MapChunk {
    console.debug(`Creating chunk at ${chunkIso.toString()}`);
    const chunk = new MapChunk(
      this.chunksSize,
      chunkTileData,
      this.tileFragmentsTextures,
      (iso) => this.getTileTypeAt(iso),
      chunkIso
    );
    const xy = chunkIso.toXY();
    chunk.x = xy.x * this.chunksSize;
    chunk.y = xy.y * this.chunksSize;
    // Columns have no u dimension: depth order between chunks is their diagonal
    chunk.zIndex = chunkIso.s + chunkIso.e;
    this.chunks[chunkIso.toString()] = chunk;
    this.addChild(chunk);
    return chunk;
  }

  /**
   * Amanatides-Woo algorithm to find the first occupied cell under the pointer
   */
  public getEntityAtPixelPosition(
    px: number,
    py: number
  ):
    | {
        entity: Tile | MapObject;
        side: VisibleIsoDirection;
        iso: GlobalIsoCoordinates;
      }
    | undefined {
    const w = (px - 16) / 16;
    const m = (py - 8) / 8;

    const U = MAP_MAX_HEIGHT + 1;
    const S = (U + m - w) / 2;
    const E = (U + m + w) / 2;

    let si = Math.floor(S);
    let ei = Math.floor(E);
    let ui = Math.floor(U);

    const frac = (v: number) => v - Math.floor(v);
    let tMaxU = 0;
    let tMaxS = 2 * frac(S);
    let tMaxE = 2 * frac(E);

    while (ui >= 0) {
      let side: VisibleIsoDirection;
      if (tMaxU <= tMaxS && tMaxU <= tMaxE) {
        ui -= 1;
        tMaxU += 1;
        side = "up";
      } else if (tMaxS <= tMaxE) {
        si -= 1;
        tMaxS += 2;
        side = "south";
      } else {
        ei -= 1;
        tMaxE += 2;
        side = "east";
      }

      const iso = new GlobalIsoCoordinates(si, ei, ui);
      const cell = this.getCellContentAt(iso);
      if (cell === undefined) continue;
      if (typeof cell !== "string") return { entity: cell, side, iso };
      console.warn(`Picking hit an unmaterialized cell at ${iso.toString()}`);
      const chunk = this.getChunkAt(iso)!;
      const tile = chunk.materializeTile(this.toLocalIso(iso));
      chunk.refreshTile(tile);
      return { entity: tile, side, iso };
    }
    return undefined;
  }

  public setCursorMode(mode: "add" | "remove") {
    if (this.cursorMode === mode) return;
    this.cursorMode = mode;
    if (mode === "add") {
      const blue = 0x0000ff;
      this.cursorSprites.up.tint = blue;
      this.cursorSprites.east.tint = blue;
      this.cursorSprites.south.tint = blue;
    } else if (mode === "remove") {
      const red = 0xff0000;
      this.cursorSprites.up.tint = red;
      this.cursorSprites.east.tint = red;
      this.cursorSprites.south.tint = red;
    }
  }

  public updatePointerPosition(
    localPosition: { x: number; y: number } | undefined,
    mode?: "add" | "remove"
  ) {
    if (!localPosition) return;
    if (mode) {
      this.setCursorMode(mode);
    }
    // find first tile under the pointer
    const newHoveredEntity = this.getEntityAtPixelPosition(
      localPosition.x,
      localPosition.y
    );

    if (
      newHoveredEntity?.entity !== this.hoveredEntity?.entity ||
      newHoveredEntity?.side !== this.hoveredEntity?.side ||
      !newHoveredEntity?.iso.equals(this.hoveredEntity?.iso)
    ) {
      if (this.hoveredEntity?.entity && !this.hoveredEntity.entity.destroyed) {
        this.hoveredEntity.entity.chunk.removeChild(
          this.cursorSprites[this.hoveredEntity.side]
        );
      }
      if (newHoveredEntity?.entity) {
        newHoveredEntity.entity.chunk.addCursorSpriteAt(
          this.toLocalIso(newHoveredEntity.iso),
          this.cursorSprites[newHoveredEntity.side]
        );
      }
    }
    this.hoveredEntity = newHoveredEntity;
  }

  public removeEntityAtPointerPosition(localPosition: {
    x: number;
    y: number;
  }) {
    const hoveredEntity = this.getEntityAtPixelPosition(
      localPosition.x,
      localPosition.y
    );
    if (!hoveredEntity) return;
    this.removeEntityAt(hoveredEntity.entity.globalIsoCoordinates);
  }

  public addEntityAtPointerPosition(
    localPosition: { x: number; y: number },
    action:
      | { entityType: "tile"; type: TileType }
      | { entityType: "object"; type: MapObjectType }
  ) {
    const hoveredEntity = this.getEntityAtPixelPosition(
      localPosition.x,
      localPosition.y
    );
    if (!hoveredEntity) return;
    const { side, iso } = hoveredEntity;
    const target = iso.move(side);
    if (action.entityType === "tile") {
      this.addTileAt(target, action.type);
    } else {
      this.addMapObjectAt(target, action.type);
    }
  }

  public update(time: Ticker) {
    if (!this.hoveredEntity) return;
    const pulse = 0.5 + 0.5 * Math.sin((time.lastTime / 800) * Math.PI * 2);
    this.cursorSprites[this.hoveredEntity.side].alpha = 0.3 + 0.7 * pulse;
  }

  public destroy(options?: { children?: boolean; texture?: boolean }) {
    this.cursorSprites.up.destroy();
    this.cursorSprites.east.destroy();
    this.cursorSprites.south.destroy();
    super.destroy(options);
  }
}
