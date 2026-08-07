import { Container, Sprite, Texture, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  IsoAxis,
  isoAxes,
  IsoBox,
  IsoCoordinates,
  IsoDirection,
  isoDirectionByAxis,
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
import { Character, CharacterType } from "./Character";

export type MapData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
  characters: Record<string, string>;
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

/** Character hitbox, in cells */
const CHARACTER_SIZE = new IsoCoordinates(0.9, 0.9, 1.9);
/** Character walking speed, in cells per second */
const CHARACTER_SPEED = 2;
/** Fall speed, in cells per second */
const GRAVITY = 5;

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

  public character: Character | undefined;
  public gamepadIndex: number | undefined;

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

    for (const key in mapData.characters) {
      const type = mapData.characters[key];
      if (!type) continue;
      const globalIso = GlobalIsoCoordinates.fromString(key);
      this.addCharacterAt(globalIso, type as CharacterType);
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
      Math.floor(Math.ceil(iso.s) / size),
      Math.floor(Math.ceil(iso.e) / size),
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

  /**
   * Whether a cell blocks movement. The single seam where "solid" is defined:
   * for now anything in a cell blocks, tiles and objects alike.
   */
  private isSolidAt(iso: GlobalIsoCoordinates): boolean {
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

    return this.getOrCreateChunkAt(iso).createMapObject(
      this.toLocalIso(iso),
      type
    );
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

  /**
   * First solid cell met by marching a box along a direction, or undefined if
   * there is none within `searchDepth` cells.
   *
   * The scan starts at the box's leading face, so a cell the box already
   * overlaps is never returned.
   */
  private firstSolidCellTowards(
    box: IsoBox,
    direction: IsoDirection,
    searchDepth: number
  ): GlobalIsoCoordinates | undefined {
    const offset = IsoCoordinates.directionsOffsets[direction];
    const axis: IsoAxis = offset.s !== 0 ? "s" : offset.e !== 0 ? "e" : "u";
    const step = offset[axis];
    const [crossA, crossB] = isoAxes.filter((candidate) => candidate !== axis);
    const [aMin, aMax] = box.cellRange(crossA);
    const [bMin, bMax] = box.cellRange(crossB);
    const [lo, hi] = box.cellRange(axis);

    let v = step > 0 ? hi : lo;
    for (let depth = 0; depth < searchDepth; depth++) {
      v += step;
      for (let a = aMin; a <= aMax; a++) {
        for (let b = bMin; b <= bMax; b++) {
          const iso = new GlobalIsoCoordinates(0, 0, 0);
          iso[axis] = v;
          iso[crossA] = a;
          iso[crossB] = b;
          if (this.isSolidAt(iso)) return iso;
        }
      }
    }
    return undefined;
  }

  /**
   * How far the box may actually travel along one axis, given the intended
   * `delta`: the delta itself when nothing is in the way, or the exact
   * distance to the obstacle. Never changes sign, so a box can never be
   * pushed backwards.
   */
  private freeDistance(box: IsoBox, axis: IsoAxis, delta: number): number {
    if (delta === 0) return 0;
    const direction =
      isoDirectionByAxis[axis][delta > 0 ? "positive" : "negative"];
    // nothing beyond the reach of this move can block it
    const searchDepth = Math.ceil(Math.abs(delta)) + 1;
    const obstacle = this.firstSolidCellTowards(box, direction, searchDepth);
    if (!obstacle) return delta;
    return delta > 0
      ? Math.min(delta, obstacle[axis] - box.max[axis])
      : Math.max(delta, obstacle[axis] + 1 - box.min[axis]);
  }

  public addCharacterAt(globalIso: GlobalIsoCoordinates, type: CharacterType) {
    this.character = new Character({
      type,
      globalIsoCoordinates: globalIso,
      localIsoCoordinates: this.toLocalIso(globalIso),
      chunk: this.getOrCreateChunkAt(globalIso),
      direction: "south",
    });
    this.character.chunk.addCharacterAt(
      this.character.localIsoCoordinates,
      this.character
    );
  }

  private sampleInput() {
    if (this.gamepadIndex === undefined) {
      return {
        leftStickX: 0,
        leftStickY: 0,
      };
    }
    const gamepad = navigator.getGamepads()[this.gamepadIndex]!;
    const [leftStickX, leftStickY] = gamepad.axes;
    const deadzone = 0.15;

    return {
      leftStickX: Math.abs(leftStickX) > deadzone ? leftStickX : 0,
      leftStickY: Math.abs(leftStickY) > deadzone ? leftStickY : 0,
    };
  }

  private simulate(
    time: Ticker,
    input: { leftStickX: number; leftStickY: number }
  ) {
    if (!this.character) {
      return;
    }
    const seconds = time.deltaMS / 1000;

    // The stick is read in screen space: un-squash y by the 2:1 iso ratio so
    // that the resulting speed is uniform in screen pixels in any direction.
    const deltaX = input.leftStickX * seconds;
    const deltaY = input.leftStickY * seconds * 2;
    const magnitude = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const angle = Math.atan2(deltaY, deltaX);
    const deltaS = magnitude * Math.sin(angle - Math.PI / 4) * CHARACTER_SPEED;
    const deltaE = magnitude * Math.cos(angle - Math.PI / 4) * CHARACTER_SPEED;

    if (deltaS !== 0 || deltaE !== 0) {
      this.character.direction =
        Math.abs(deltaS) > Math.abs(deltaE)
          ? deltaS > 0
            ? "south"
            : "north"
          : deltaE > 0
            ? "east"
            : "west";
    }

    // Both axes are swept against the same starting box: this is what makes
    // the character slide along a wall instead of sticking to it.
    const walkBox = IsoBox.fromOriginAndSize(
      this.character.globalIsoCoordinates,
      CHARACTER_SIZE
    );
    const walked = this.character.globalIsoCoordinates.add(
      new IsoCoordinates(
        this.freeDistance(walkBox, "s", deltaS),
        this.freeDistance(walkBox, "e", deltaE),
        0
      )
    );

    // Gravity is just one more sweep, on the u axis
    const fallBox = IsoBox.fromOriginAndSize(walked, CHARACTER_SIZE);
    this.character.globalIsoCoordinates = walked.add(
      new IsoCoordinates(
        0,
        0,
        this.freeDistance(fallBox, "u", -GRAVITY * seconds)
      )
    );
  }

  private syncView() {
    if (!this.character) {
      return;
    }

    const newChunk = this.getOrCreateChunkAt(
      this.character.globalIsoCoordinates
    );
    if (newChunk !== this.character.chunk) {
      this.character.chunk.removeChild(this.character);
      newChunk.addChild(this.character);
      this.character.chunk = newChunk;
    }
    this.character.localIsoCoordinates = new LocalIsoCoordinates(
      this.character.globalIsoCoordinates.s -
        this.character.chunk.chunkIsoCoordinates.s * this.chunksSize,
      this.character.globalIsoCoordinates.e -
        this.character.chunk.chunkIsoCoordinates.e * this.chunksSize,
      this.character.globalIsoCoordinates.u
    );
    this.character.chunk.positionCharacterAt(
      this.character.localIsoCoordinates,
      this.character
    );
  }

  private updateCosmetics(time: Ticker) {
    if (this.hoveredEntity) {
      const pulse = 0.5 + 0.5 * Math.sin((time.lastTime / 800) * Math.PI * 2);
      this.cursorSprites[this.hoveredEntity.side].alpha = 0.3 + 0.7 * pulse;
    }

    if (this.character) {
      this.character.update(time);
    }
  }

  public update(time: Ticker) {
    const input = this.sampleInput();
    this.simulate(time, input);
    this.syncView();
    this.updateCosmetics(time);
  }

  public destroy(options?: { children?: boolean; texture?: boolean }) {
    this.cursorSprites.up.destroy();
    this.cursorSprites.east.destroy();
    this.cursorSprites.south.destroy();
    super.destroy(options);
  }
}
