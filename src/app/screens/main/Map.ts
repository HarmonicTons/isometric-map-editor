import { Container, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  isoDirections,
  LocalIsoCoordinates,
  VisibleIsoDirection,
} from "./IsometricCoordinate";
import { ChunkTileData, MapChunk } from "./MapChunk";
import { MapObject } from "./MapObject";
import { Tile } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

const MAX_CHUNK_ISO_U = 32;

export type MapData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
};

/**
 * The map, as a collection of chunks.
 *
 * Map is the single authority on global coordinates: every operation that can
 * cross a chunk boundary (lookups, edits, neighborhood invalidation) lives
 * here and is routed to the owning chunk in local coordinates. Chunks never
 * know about their neighbors.
 */
export class Map extends Container {
  public chunks: Record<string, MapChunk> = {};
  private chunksSize: number = 8;
  public hoveredEntity?: {
    entity: Tile | MapObject;
    side: VisibleIsoDirection;
  };

  constructor(
    mapData: MapData,
    public tileFragmentsTextures: TileFragmentsTextures
  ) {
    super();
    // Pointer events are handled by GameScreen
    this.eventMode = "none";
    this.sortableChildren = true;

    // Group the map data by chunk
    const chunksData: Record<string, ChunkTileData> = {};
    const chunkDataFor = (globalIso: GlobalIsoCoordinates): ChunkTileData => {
      const chunkKey = this.toChunkIso(globalIso).toString();
      return (chunksData[chunkKey] ??= {});
    };
    for (const key in mapData.tiles) {
      const type = mapData.tiles[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      chunkDataFor(globalIso)[this.toLocalIso(globalIso).toString()] = type;
    }

    for (const chunkKey in chunksData) {
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
      this.addMapObjectAt(globalIso, type);
    }
  }

  private toChunkIso(iso: GlobalIsoCoordinates): ChunkIsoCoordinates {
    const size = this.chunksSize;
    return new ChunkIsoCoordinates(
      Math.floor(iso.s / size),
      Math.floor(iso.e / size),
      Math.floor(iso.u / size)
    );
  }

  private toLocalIso(iso: GlobalIsoCoordinates): LocalIsoCoordinates {
    const size = this.chunksSize;
    // Euclidean modulo: also correct for negative global coordinates
    const mod = (v: number) => ((v % size) + size) % size;
    return new LocalIsoCoordinates(mod(iso.s), mod(iso.e), mod(iso.u));
  }

  public getChunkAt(iso: GlobalIsoCoordinates): MapChunk | undefined {
    return this.chunks[this.toChunkIso(iso).toString()];
  }

  private getOrCreateChunkAt(iso: GlobalIsoCoordinates): MapChunk {
    return this.getChunkAt(iso) ?? this.createChunk(this.toChunkIso(iso), {});
  }

  public getEntityAt(iso: GlobalIsoCoordinates): Tile | MapObject | undefined {
    return this.getChunkAt(iso)?.getEntityAt(this.toLocalIso(iso));
  }

  public addTileAt(iso: GlobalIsoCoordinates, type: string) {
    console.debug(`Adding tile at ${iso.toString()}`);
    if (this.getEntityAt(iso)) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }
    this.getOrCreateChunkAt(iso).createTile(this.toLocalIso(iso), type);
    this.updateTileNeighbors(iso);
  }

  public addMapObjectAt(iso: GlobalIsoCoordinates, type: string) {
    console.debug(`Adding map object at ${iso.toString()}`);
    const cells = MapObject.getOccupiedCells(type, iso);
    if (cells.some((cell) => this.getEntityAt(cell))) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }
    const mapObject = new MapObject({
      type,
      globalIsoCoordinates: iso,
      occupiedCells: cells,
    });
    for (const cell of cells) {
      this.getOrCreateChunkAt(cell).registerMapObjectAt(
        this.toLocalIso(cell),
        mapObject
      );
    }

    // for (const span of this.splitCellsByChunk(cells)) {
    //   span.chunk.addObjectPiece(object, span);
    // }
  }

  public removeEntityAt(iso: GlobalIsoCoordinates) {
    console.debug(`Removing entity at ${iso.toString()}`);
    const chunk = this.getChunkAt(iso);
    if (!chunk) return;
    const entity = chunk.getEntityAt(this.toLocalIso(iso));
    if (!entity) return;
    if (this.hoveredEntity?.entity === entity) {
      this.hoveredEntity = undefined;
    }
    if (entity instanceof Tile) {
      chunk.removeTileAt(this.toLocalIso(iso));
      this.updateTileNeighbors(iso);
      this.destroyChunkIfEmpty(chunk);
      return;
    }
    if (entity instanceof MapObject) {
      const chunks = new Set<MapChunk>();
      for (const cell of entity.occupiedCells) {
        const cellChunk = this.getChunkAt(cell);
        if (!cellChunk) continue;
        chunks.add(cellChunk);
        cellChunk.unregisterMapObjectAt(this.toLocalIso(cell));
      }
      entity.destroy({ children: true });
      chunks.forEach((chunk) => this.destroyChunkIfEmpty(chunk));
    }
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
    const tile = this.getEntityAt(iso);
    if (tile instanceof Tile) {
      tile.chunk.refreshTile(tile);
    }
  }

  public updateAllTileNeighborhood() {
    for (const key in this.chunks) {
      this.chunks[key].updateAllTileNeighborhood();
    }
  }

  private createChunk(
    chunkIso: ChunkIsoCoordinates,
    chunkTileData: ChunkTileData
  ): MapChunk {
    console.debug(`Creating chunk at ${chunkIso.toString()}`);
    const getTileTypeAt = (iso: GlobalIsoCoordinates): string | undefined => {
      const entity = this.getEntityAt(iso);
      return entity instanceof Tile ? entity.type : undefined;
    };
    const chunk = new MapChunk(
      this.chunksSize,
      chunkTileData,
      this.tileFragmentsTextures,
      getTileTypeAt,
      chunkIso
    );
    const xy = chunkIso.toXY();
    chunk.x = xy.x * this.chunksSize;
    chunk.y = xy.y * this.chunksSize;
    chunk.zIndex = chunkIso.paintersOrderKey(MAX_CHUNK_ISO_U);
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
  ): { entity: Tile | MapObject; side: VisibleIsoDirection } | undefined {
    const w = (px - 16) / 16;
    const m = (py - 8) / 8;

    const U = MAX_CHUNK_ISO_U * this.chunksSize + 1;
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

      const entity = this.getEntityAt(new GlobalIsoCoordinates(si, ei, ui));
      if (entity) return { entity, side };
    }
    return undefined;
  }

  public updatePointerPosition(
    localPosition: { x: number; y: number } | undefined
  ) {
    if (!localPosition) return;
    // find first tile under the pointer
    const newHoveredEntity = this.getEntityAtPixelPosition(
      localPosition.x,
      localPosition.y
    );

    if (
      newHoveredEntity?.entity !== this.hoveredEntity?.entity ||
      newHoveredEntity?.side !== this.hoveredEntity?.side
    ) {
      if (this.hoveredEntity?.entity instanceof Tile) {
        this.hoveredEntity.entity.setHovered(false, undefined);
      }
      if (newHoveredEntity?.entity instanceof Tile) {
        newHoveredEntity.entity.setHovered(true, newHoveredEntity.side);
      }
    }
    this.hoveredEntity = newHoveredEntity;
  }

  public removeEntityAtPointerPosition(
    localPosition: { x: number; y: number } | undefined
  ) {
    if (!this.hoveredEntity) return;
    this.removeEntityAt(this.hoveredEntity.entity.globalIsoCoordinates);
    this.updatePointerPosition(localPosition);
  }

  public addEntityAtPointerPosition(
    localPosition: { x: number; y: number } | undefined,
    entityType: "tile" | "object",
    type: string
  ) {
    if (!this.hoveredEntity) return;
    const { entity, side } = this.hoveredEntity;
    if (entity instanceof MapObject) {
      // TODO add from an object is disabled because no UI element show that it's possible
      return;
    }
    const target = entity.globalIsoCoordinates.move(side);
    if (entityType === "tile") {
      this.addTileAt(target, type);
    } else if (entityType === "object") {
      this.addMapObjectAt(target, type);
    }
    this.updatePointerPosition(localPosition);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public update(_time: Ticker) {}
}
