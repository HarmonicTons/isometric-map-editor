import { Container, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  isoDirections,
  LocalIsoCoordinates,
  VisibleIsoDirection,
} from "./IsometricCoordinate";
import { MapChunk, MapChunkData } from "./MapChunk";
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
  public hoveredTile?: { tile: Tile; side: VisibleIsoDirection };

  constructor(
    mapData: MapData,
    public tileFragmentsTextures: TileFragmentsTextures
  ) {
    super();
    // Pointer events are handled by GameScreen
    this.eventMode = "none";
    this.sortableChildren = true;

    // Group the map data by chunk
    const chunksData: Record<string, MapChunkData> = {};
    const chunkDataFor = (globalIso: GlobalIsoCoordinates): MapChunkData => {
      const chunkKey = this.toChunkIso(globalIso).toString();
      return (chunksData[chunkKey] ??= { tiles: {}, objects: {} });
    };
    for (const key in mapData.tiles) {
      const type = mapData.tiles[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      chunkDataFor(globalIso).tiles[this.toLocalIso(globalIso).toString()] =
        type;
    }
    for (const key in mapData.objects) {
      const type = mapData.objects[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      chunkDataFor(globalIso).objects[this.toLocalIso(globalIso).toString()] =
        type;
    }

    for (const chunkKey in chunksData) {
      this.createChunk(
        ChunkIsoCoordinates.fromString(chunkKey),
        chunksData[chunkKey]
      );
    }

    this.updateAllTileNeighborhood();
  }

  public toJson(): string {
    const result: MapData = { objects: {}, tiles: {} };
    for (const chunkKey in this.chunks) {
      const chunk = this.chunks[chunkKey];
      for (const key in chunk.tiles) {
        const tile = chunk.tiles[key];
        result.tiles[tile.globalIsoCoordinates.toString()] = tile.type;
      }
      for (const key in chunk.objects) {
        const globalIso = chunk.toGlobalIsoCoordinates(
          LocalIsoCoordinates.fromString(key)
        );
        result.objects[globalIso.toString()] = chunk.objects[key].type;
      }
    }
    return JSON.stringify(result);
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
    return (
      this.getChunkAt(iso) ??
      this.createChunk(this.toChunkIso(iso), { tiles: {}, objects: {} })
    );
  }

  public getTileAt(iso: GlobalIsoCoordinates): Tile | undefined {
    return this.getChunkAt(iso)?.getTileAt(this.toLocalIso(iso));
  }

  public getMapObjectAt(iso: GlobalIsoCoordinates): MapObject | undefined {
    return this.getChunkAt(iso)?.getMapObjectAt(this.toLocalIso(iso));
  }

  public getEntityAt(iso: GlobalIsoCoordinates): Tile | MapObject | undefined {
    return this.getTileAt(iso) || this.getMapObjectAt(iso);
  }

  public addTileAt(iso: GlobalIsoCoordinates, type: string) {
    if (this.getEntityAt(iso)) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }
    this.getOrCreateChunkAt(iso).createTile(this.toLocalIso(iso), type);
    this.updateTileNeighbors(iso);
  }

  public addMapObjectAt(iso: GlobalIsoCoordinates, type: string) {
    if (this.getEntityAt(iso)) {
      console.warn("Entity already exists at", iso.toString());
      return;
    }
    this.getOrCreateChunkAt(iso).createObject(this.toLocalIso(iso), type);
  }

  public removeTileAt(iso: GlobalIsoCoordinates) {
    const chunk = this.getChunkAt(iso);
    if (!chunk) return;
    const tile = chunk.getTileAt(this.toLocalIso(iso));
    if (!tile) return;
    if (this.hoveredTile?.tile === tile) {
      this.hoveredTile = undefined;
    }
    chunk.removeTileAt(this.toLocalIso(iso));
    this.updateTileNeighbors(iso);
    this.destroyChunkIfEmpty(chunk);
  }

  public removeMapObjectAt(iso: GlobalIsoCoordinates) {
    const chunk = this.getChunkAt(iso);
    if (!chunk) return;
    chunk.removeMapObjectAt(this.toLocalIso(iso));
    this.destroyChunkIfEmpty(chunk);
  }

  private destroyChunkIfEmpty(chunk: MapChunk) {
    if (!chunk.isEmpty) return;
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
    const tile = this.getTileAt(iso);
    if (tile) {
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
    chunkData: MapChunkData
  ): MapChunk {
    const chunk = new MapChunk(
      this.chunksSize,
      chunkData,
      this.tileFragmentsTextures,
      (globalIso) => this.getTileAt(globalIso),
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
   * Amanatides-Woo algorithm to find the first tile under the pointer
   */
  public getTileAtPixelPosition(
    px: number,
    py: number
  ): { tile: Tile; side: VisibleIsoDirection } | undefined {
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

      const tile = this.getTileAt(new GlobalIsoCoordinates(si, ei, ui));
      if (tile) return { tile, side };
    }
    return undefined;
  }

  public updatePointerPosition(
    localPosition: { x: number; y: number } | undefined
  ) {
    if (!localPosition) return;
    // find first tile under the pointer
    const newHoveredTile = this.getTileAtPixelPosition(
      localPosition.x,
      localPosition.y
    );

    if (
      newHoveredTile?.tile !== this.hoveredTile?.tile ||
      newHoveredTile?.side !== this.hoveredTile?.side
    ) {
      if (this.hoveredTile) {
        this.hoveredTile.tile.setHovered(false, undefined);
      }
      if (newHoveredTile) {
        newHoveredTile.tile.setHovered(true, newHoveredTile.side);
      }
    }

    this.hoveredTile = newHoveredTile;
  }

  public removeEntityAtPointerPosition(
    localPosition: { x: number; y: number } | undefined
  ) {
    if (!this.hoveredTile) return;
    this.removeTileAt(this.hoveredTile.tile.globalIsoCoordinates);
    this.updatePointerPosition(localPosition);
  }

  public addEntityAtPointerPosition(
    localPosition: { x: number; y: number } | undefined,
    entityType: "tile" | "object",
    type: string
  ) {
    if (!this.hoveredTile) return;
    const { tile, side } = this.hoveredTile;
    const target = tile.globalIsoCoordinates.move(side);
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
