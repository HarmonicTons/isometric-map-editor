import { Container, Sprite, Text, Texture, Ticker } from "pixi.js";
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
import { sliceEntity } from "./EntityBands";
import { debugViewEnabled } from "./DebugView";

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

/** Character walking speed, in cells per second */
const CHARACTER_SPEED = 2;
/** Fall speed, in cells per second */
const GRAVITY = 5;

/**
 * Side of the live block, in chunks — the square of chunks around the
 * character that is drawn as a single container. See Map.syncBlock.
 *
 * Merging chunks means giving the whole set ONE rank where each of them had
 * its own, and that is not always possible: a chunk left outside has to sort
 * the same way against every block chunk it is ordered against, and the rank
 * has to sit between the two. Written out over the block's corners, a rank
 * exists exactly when the block's two sides differ by at most one, and it is
 * the block's middle diagonal, s0 + e1. Being square is what makes that middle
 * a whole number rather than a half — a 2 × 3 block would work too, at a rank
 * of x.5. characterChunks.test.ts checks the rank against every occluding pair
 * of cells that crosses the block's edge, rather than trusting this paragraph:
 * an earlier version of it was wrong in both directions and the code was right
 * anyway.
 *
 * Two chunks of side means the character is never closer than half a chunk to
 * the block's edge, against the two cells a constraining cell is ever away
 * from it (EntityBands.test.ts, "is never constrained by a cell more than two
 * cells away").
 */
const BLOCK_SIDE = 2;

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

  /** The square of chunks around the character, drawn as one. See syncBlock. */
  private block?: { container: Container; origin: ChunkIsoCoordinates };

  /** DEBUG overlay, see syncDepthKeys */
  private depthKeyOverlay?: Container;
  private depthKeyLabels: Text[] = [];

  constructor(
    mapData: MapData,
    public tileFragmentsTextures: TileFragmentsTextures,
    /**
     * Side of a chunk, in cells. Only tests ever change it: a single huge
     * chunk is the exact draw order the chunked one has to reproduce, and a
     * small one puts a boundary everywhere. Half of it is how far the
     * character is from the edge of its block, so it may not go below twice
     * the reach of a constraining cell.
     */
    chunksSize = 8
  ) {
    super();
    this.chunksSize = chunksSize;
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
    return this.getOrCreateChunk(this.toChunkIso(iso));
  }

  private getOrCreateChunk(chunkIso: ChunkIsoCoordinates): MapChunk {
    return this.chunks[chunkIso.toString()] ?? this.createChunk(chunkIso, {});
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
    entity.chunk.removeCursorSprite(
      this.cursorSprites[this.hoveredEntity.side]
    );
    this.hoveredEntity = undefined;
  }

  private destroyChunkIfEmpty(chunk: MapChunk) {
    if (!chunk.isEmpty) return;
    // A chunk with no cell left may still draw a sprite it does not own: the
    // cursor. Its views may be lent to the live block, so `children` is not
    // the question to ask.
    if (chunk.hasViews) return;
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
    // Columns have no u dimension: depth order between chunks is their diagonal
    chunk.zIndex = chunkIso.s + chunkIso.e;
    this.chunks[chunkIso.toString()] = chunk;
    this.addChild(chunk);
    // Editing the map can create a chunk under the character's feet
    if (this.block && this.isInBlock(chunkIso)) {
      chunk.lendViewsTo(this.block.container);
    }
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
        this.hoveredEntity.entity.chunk.removeCursorSprite(
          this.cursorSprites[this.hoveredEntity.side]
        );
      }
      if (newHoveredEntity?.entity) {
        newHoveredEntity.entity.chunk.addCursorSpriteAt(
          newHoveredEntity.iso,
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
    if (this.character) {
      // One character per map for now. Without this the previous one would
      // leave its meshes in the live block forever, still drawn and never
      // updated again.
      console.warn(
        `Replacing the character of the map: only one is supported, ${type} evicts ${this.character.type}`
      );
      this.character.destroy();
    }
    this.character = new Character({
      type,
      globalIsoCoordinates: globalIso,
      direction: "south",
    });
    this.syncView();
  }

  /**
   * The left stick of the first gamepad that is there, or nothing.
   *
   * Asked afresh every frame rather than remembered from `gamepadconnected`:
   * the browser leaves a null in the slot once a pad is unplugged and fires no
   * event this side can act on, so a remembered index turns into a crash on
   * every frame of the ticker. Polling also means a pad plugged in halfway
   * through, or a map loaded after it, just works.
   */
  private sampleInput() {
    // node has a navigator, but no gamepads on it
    const gamepad = globalThis.navigator
      ?.getGamepads?.()
      .find((pad) => pad !== null);
    if (!gamepad) {
      return {
        leftStickX: 0,
        leftStickY: 0,
      };
    }
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
    const walkBox = IsoBox.standingOn(
      this.character.globalIsoCoordinates,
      this.character.hitbox
    );
    const walked = this.character.globalIsoCoordinates.add(
      new IsoCoordinates(
        this.freeDistance(walkBox, "s", deltaS),
        this.freeDistance(walkBox, "e", deltaE),
        0
      )
    );

    // Gravity is just one more sweep, on the u axis
    const fallBox = IsoBox.standingOn(walked, this.character.hitbox);
    this.character.globalIsoCoordinates = walked.add(
      new IsoCoordinates(
        0,
        0,
        this.freeDistance(fallBox, "u", -GRAVITY * seconds)
      )
    );
  }

  /** The chunks of the block at `origin` that exist, in no particular order. */
  private blockChunks(origin: ChunkIsoCoordinates): MapChunk[] {
    const found: MapChunk[] = [];
    for (let s = origin.s; s < origin.s + BLOCK_SIDE; s++) {
      for (let e = origin.e; e < origin.e + BLOCK_SIDE; e++) {
        const chunk = this.chunks[new ChunkIsoCoordinates(s, e, 0).toString()];
        if (chunk) found.push(chunk);
      }
    }
    return found;
  }

  private isInBlock(chunkIso: ChunkIsoCoordinates): boolean {
    const origin = this.block?.origin;
    return (
      origin !== undefined &&
      chunkIso.s >= origin.s &&
      chunkIso.s < origin.s + BLOCK_SIDE &&
      chunkIso.e >= origin.e &&
      chunkIso.e < origin.e + BLOCK_SIDE
    );
  }

  /**
   * Keep the square of chunks around the character drawn as a single
   * container, and return it.
   *
   * A chunk is a container, so it is drawn atomically: everything in it goes
   * before everything in the next one. That is what a character standing
   * across two of them cannot express — it needs to come after a cell of one
   * and before a cell of the other. So while it is there, those chunks stop
   * being separate containers: they lend their cells to one block, which sorts
   * cells and character bands alike by the global depth key. That is exactly
   * the order sliceEntity assumes, which is why it needs to know nothing about
   * chunks.
   *
   * The chunks outside the block keep being drawn atomically, which is what
   * leaves the door open to baking them into a single texture one day.
   */
  private syncBlock(iso: GlobalIsoCoordinates): Container {
    const size = this.chunksSize;
    // the block whose centre is nearest, so that the character is never within
    // half a chunk of its edge
    const origin = new ChunkIsoCoordinates(
      Math.round(iso.s / size - BLOCK_SIDE / 2),
      Math.round(iso.e / size - BLOCK_SIDE / 2),
      0
    );
    if (this.block?.origin.equals(origin)) return this.block.container;

    let container = this.block?.container;
    if (!container) {
      container = new Container();
      container.eventMode = "none";
      container.sortableChildren = true;
      this.addChild(container);
    }
    this.releaseBlockChunks();
    this.block = { container, origin };
    container.zIndex = origin.s + origin.e + BLOCK_SIDE - 1;
    for (const chunk of this.blockChunks(origin)) {
      chunk.lendViewsTo(container);
    }
    return container;
  }

  private releaseBlockChunks() {
    if (!this.block) return;
    for (const chunk of this.blockChunks(this.block.origin)) {
      chunk.takeViewsBack();
    }
  }

  private dissolveBlock() {
    if (!this.block) return;
    this.releaseBlockChunks();
    this.removeChild(this.block.container);
    this.block.container.destroy({ children: false });
    this.block = undefined;
  }

  /**
   * A character straddles cells, so it cannot be a single sprite with a single
   * depth key: it is cut into horizontal bands, each drawn at the key its rows
   * need. They all go into the live block, whose cells are sorted by that same
   * key — see syncBlock.
   */
  private syncView() {
    const character = this.character;
    if (!character) {
      this.dissolveBlock();
      return;
    }
    const block = this.syncBlock(character.globalIsoCoordinates);
    if (character.needsSlicing) {
      character.setSlices(
        sliceEntity({
          iso: character.globalIsoCoordinates,
          hitbox: character.hitbox,
          spriteWidth: character.spriteWidth,
          spriteHeight: character.spriteHeight,
        })
      );
    }
    character.render(block);
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

  /**
   * DEBUG — writes the depth key on every cell around the character and on
   * every band of its sprite, so the order they are drawn in can be read off
   * the screen. Toggled with F10, see DebugView.
   *
   * Only the cells the character can reach are labelled: a whole map's worth of
   * text would be unreadable, and unrelated to what the cut depends on.
   */
  private syncDepthKeys() {
    const character = this.character;
    if (!debugViewEnabled() || !character) {
      this.depthKeyLabels.forEach((label) => (label.visible = false));
      return;
    }
    if (!this.depthKeyOverlay) {
      this.depthKeyOverlay = new Container();
      // above every chunk, whatever their diagonal
      this.depthKeyOverlay.zIndex = Number.MAX_SAFE_INTEGER;
      this.addChild(this.depthKeyOverlay);
    }

    let used = 0;
    /** `where` above `key`, the pair centred on (x, y). */
    const write = (
      where: string,
      key: string,
      x: number,
      y: number,
      fill: number
    ) => {
      const label = (this.depthKeyLabels[used] ??=
        this.depthKeyOverlay!.addChild(
          new Text({
            text: "",
            // A cell is 32 px wide and holds two lines of up to thirteen
            // characters, so the type has to be tiny not to collide with the
            // neighbours'. Rendering it at eight times the size keeps it
            // readable once the viewport zooms in.
            resolution: 8,
            anchor: 0.5,
            style: {
              fontFamily: "monospace",
              fontSize: 2,
              align: "center",
              fill: 0xffffff,
              // in style pixels, so it has to shrink with the type
              stroke: { color: 0x000000, width: 0.5 },
            },
          })
        ));
      used++;
      label.visible = true;
      const text = `${where}\n${key}`;
      // both of these rebuild the text's texture, so only when they change
      if (label.text !== text) label.text = text;
      if (label.style.fill !== fill) label.style.fill = fill;
      label.x = x;
      label.y = y;
    };

    const { s, e, u } = character.globalIsoCoordinates;
    const radius = 3;
    for (let cs = Math.floor(s) - radius; cs <= Math.floor(s) + radius; cs++) {
      for (
        let ce = Math.floor(e) - radius;
        ce <= Math.floor(e) + radius;
        ce++
      ) {
        for (let cu = Math.floor(u) - 2; cu <= Math.floor(u) + 3; cu++) {
          const iso = new GlobalIsoCoordinates(cs, ce, cu);
          // only what is actually drawn: a buried cell's label would float over
          // the tiles hiding it
          if (!this.isCellOccupied(iso) || !this.isInShell(iso)) continue;
          const xy = iso.toXY();
          // the middle of the cell's top face, which is the top half of its
          // 32×24 sprite
          write(
            iso.toString(),
            `${iso.paintersOrderKey()}`,
            xy.x + 16,
            xy.y + 8,
            0xffffff
          );
        }
      }
    }
    const slicing = character.slicing;
    const bands = slicing?.bands ?? [];
    bands.forEach((band, index) => {
      // A band belongs to no cell, so what places it is the rows it covers —
      // except the bottom one, where reading the character's own position
      // right next to the cell it stands on is worth more.
      const where =
        index === bands.length - 1
          ? `${s.toFixed(1)},${e.toFixed(1)},${u.toFixed(1)}`
          : `${band.offsetY}-${band.offsetY + band.height - 1}`;
      write(
        where,
        `${band.zIndex}`,
        slicing!.x + character.spriteWidth / 2,
        slicing!.y + band.offsetY + band.height / 2,
        0xffe066
      );
    });
    for (let index = used; index < this.depthKeyLabels.length; index++) {
      this.depthKeyLabels[index].visible = false;
    }
  }

  public update(time: Ticker) {
    const input = this.sampleInput();
    this.simulate(time, input);
    // cosmetics first: it picks the animation frame the view is cut from
    this.updateCosmetics(time);
    this.syncView();
    this.syncDepthKeys();
  }

  public destroy(options?: { children?: boolean; texture?: boolean }) {
    this.character?.destroy();
    // before the chunks: they take their views back from it
    this.dissolveBlock();
    this.cursorSprites.up.destroy();
    this.cursorSprites.east.destroy();
    this.cursorSprites.south.destroy();
    super.destroy(options);
  }
}
