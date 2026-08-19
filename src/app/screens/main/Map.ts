import { Container, Graphics, Sprite, Text, Texture, Ticker } from "pixi.js";
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
  paintersOrderKey,
  VisibleIsoDirection,
} from "./IsometricCoordinate";
import { CellContent, ChunkTileData, MapChunk } from "./MapChunk";
import { MapObject, MapObjectType } from "./MapObject";
import { Tile, TileType } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import {
  Character,
  CharacterType,
  NOMINAL_WALK_SPEED,
  headingOf,
} from "./Character";
import { sliceEntityByColumn } from "./EntityColumns";
import { debugViewEnabled } from "./DebugView";
import { keyboardInput } from "./Keyboard";
import { sampleGamepad } from "./Gamepad";
import {
  NORTH_EDGE_RUNS,
  paintRuns,
  ShadowRun,
  shadowRuns,
  WEST_EDGE_RUNS,
} from "./Shadows";

export type MapData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
  characters: Record<string, string>;
};

/** What a camera watching the character needs from the map */
export type CharacterAnchor = {
  /** where to centre, in map pixels, taken at `standing` */
  x: number;
  y: number;
  /** the level it stands on, or would stand on if it were not in the air */
  standing: number;
  /** the level its feet are actually at */
  feet: number;
  grounded: boolean;
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
 * Character walking speed, in cells per second.
 *
 * Taken from Character rather than set here: the walk sheets are drawn at a
 * rhythm, and the cadence only comes out right if the character walks at the
 * speed those durations assume.
 */
const CHARACTER_SPEED = NOMINAL_WALK_SPEED;
/** Fall acceleration, in cells per second squared */
const GRAVITY = 40;
/**
 * Fastest it can fall, in cells per second. A feel knob, not a safety net: Pixi
 * clamps a hitching frame to 100 ms, so a long drop still crosses two cells
 * between two frames. What keeps it out of the floor is the sweep in
 * `freeDistance`, which marches the box however far the move reaches.
 */
const TERMINAL_SPEED = 20;

/** How far below its feet the ground is looked for: only a floor it rests on */
const GROUND_PROBE = 1e-6;

/**
 * How fast a body `height` cells tall leaves the ground, in cells per second.
 *
 * A character jumps its own height: Bulbasaur clears a cell and a half,
 * Rayquaza five. Which is the same jump seen from inside — the world a
 * character steps over is measured in its own size — and it is the one number
 * that needs no tuning, since a body already has a height.
 *
 * A jump reaches v² / 2g, so the speed is the square root of the height rather
 * than a multiple of it. The floor is there so that whatever gets imported can
 * always climb the one-cell steps the scenery is built out of; nothing
 * imported so far comes close to it, the shortest being Bulbasaur at 1.53.
 */
export const jumpSpeedFor = (height: number): number =>
  Math.sqrt(2 * GRAVITY * Math.max(1, height));

/**
 * The character's vertical speed after one frame, in cells per second.
 */
export const fallVelocity = (
  verticalSpeed: number,
  {
    grounded,
    jump,
    jumpSpeed,
    seconds,
  }: {
    grounded: boolean;
    jump: boolean;
    /** what this body leaves the ground at: see jumpSpeedFor */
    jumpSpeed: number;
    seconds: number;
  }
): number => {
  if (jump && grounded) return jumpSpeed;
  // standing on the floor: whatever speed it fell in with is spent
  const carried = grounded && verticalSpeed <= 0 ? 0 : verticalSpeed;
  return Math.max(-TERMINAL_SPEED, carried - GRAVITY * seconds);
};

/**
 * Where the stick asks the character to walk, in cells per second.
 *
 * The stick points on the screen; the character walks in the grid. Undoing the
 * projection — x = 16(e − s), y = 8(e + s) — makes a screen direction (x, y)
 * into (y/8 − x/16) along s and (y/8 + x/16) along e.
 *
 * Normalising THAT is what keeps the speed constant in cells. Normalising the
 * screen direction keeps it constant in pixels instead, and since the
 * projection squashes y by two, walking up the screen would cover twice the
 * ground of walking across it.
 */
export const walkVelocity = (
  leftStickX: number,
  leftStickY: number
): { s: number; e: number } => {
  const towardS = leftStickY / 8 - leftStickX / 16;
  const towardE = leftStickY / 8 + leftStickX / 16;
  const length = Math.hypot(towardS, towardE);
  if (length === 0) return { s: 0, e: 0 };
  // a stick pushed into a corner is longer than one pushed straight
  const push = Math.min(1, Math.hypot(leftStickX, leftStickY));
  const pace = (push * CHARACTER_SPEED) / length;
  return { s: towardS * pace, e: towardE * pace };
};

/** How far below its feet a character still casts a shadow, in cells */
const SHADOW_REACH = 16;

/** One empty level: a tile resting on another has nowhere to cast a shadow */
const OVERHANG_GAP = 2;

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

  /** The shadow under the character, one piece per ground cell. syncShadow. */
  private shadowPieces: Graphics[] = [];
  /** What each piece above holds, so that it is drawn only when it moves */
  private shadowShapes: string[] = [];

  private velocity = new IsoCoordinates(0, 0, 0);
  /** Whether A was already down last frame, so a hold is not a second jump */
  private jumpHeld = false;
  /** Same, for the attack button: one attack per press */
  private attackHeld = false;

  /**
   * How fast the character actually moved last frame — what it did, not what
   * the stick asked for.
   */
  public get characterVelocity(): IsoCoordinates {
    return this.velocity;
  }

  /** DEBUG overlay, see syncDepthKeys */
  private depthKeyOverlay?: Container;
  private depthKeyLabels: Text[] = [];

  /** DEBUG overlay, see syncChunkBounds. One line per chunk, drawn on demand. */
  private chunkBoundsOverlay?: Container;
  private chunkBounds: Record<
    IsoString,
    { line: Graphics; signature: string }
  > = {};

  constructor(
    mapData: MapData,
    public tileFragmentsTextures: TileFragmentsTextures,
    /**
     * Side of a chunk, in cells. Only tests change it, to put a boundary
     * everywhere or nowhere: nothing about a character depends on it, since
     * each of its pieces is drawn by the chunk owning that piece's column.
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
   *
   * Outside the chunked area everything is solid, so the map is a walled box.
   * That is what keeps a character over columns that have a chunk to draw it —
   * see chunkOver — rather than making walking off the edge a case to handle
   * everywhere. A chunk exists as soon as a single cell of it does, so the wall
   * stands at the edge of the chunks and not at the edge of the terrain: there
   * is room to fall off a ledge, none to leave the map.
   */
  private isSolidAt(iso: GlobalIsoCoordinates): boolean {
    if (!this.getChunkAt(iso)) return true;
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

  /**
   * Whether a cell holds a TILE — the only thing that casts a shade.
   *
   * Deliberately not `isSolidAt`, which also counts map objects: a tree blocks
   * movement but darkens nothing. Objects are left out because nothing
   * refreshes the column under one when it appears or goes away —
   * `addMapObjectAt` and the object branch of `removeEntityAt` leave the
   * neighbourhood alone, and the constructor loads objects after the map-wide
   * shading pass. Counting them here would make the shade depend on the order
   * the edits happened in: a tree planted over a clearing would cast nothing
   * until something else touched that column, and a felled one would leave its
   * shade behind.
   */
  private isTileAt(iso: GlobalIsoCoordinates): boolean {
    const cell = this.getCellContentAt(iso);
    return typeof cell === "string" || cell instanceof Tile;
  }

  /**
   * Whether a tile floating in this column darkens the top face of `iso`.
   *
   * The light comes straight down, so what casts is any tile in the same column
   * with at least one empty level in between, at any height at all. The search
   * stops at the highest cell the chunk has ever held, which keeps this from
   * walking to MAP_MAX_HEIGHT over every tile of a flat map.
   */
  public isOvershadowed(iso: GlobalIsoCoordinates): boolean {
    // a face with something resting on it is not a face at all
    if (this.isTileAt(iso.move("up"))) return false;
    const ceiling = this.getChunkAt(iso)?.highestLevel ?? -1;
    for (let u = iso.u + OVERHANG_GAP; u <= ceiling; u++) {
      if (this.isTileAt(new GlobalIsoCoordinates(iso.s, iso.e, u))) return true;
    }
    return false;
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
    // A chunk with no cell left may still draw something it does not own: the
    // cursor, or a piece of a character standing over one of its columns.
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
    this.refreshColumnBelow(iso);
  }

  /**
   * Refresh every cell of the column below `iso`.
   *
   * What floats over a cell can be at any height (see isOvershadowed), so
   * putting a tile down changes what is shaded all the way to the floor, far
   * past any neighbourhood. Only an edit pays for this walk.
   */
  private refreshColumnBelow(iso: GlobalIsoCoordinates) {
    for (let u = iso.u - 1; u >= 0; u--) {
      this.refreshTileAt(new GlobalIsoCoordinates(iso.s, iso.e, u));
    }
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
      (iso) => this.isOvershadowed(iso),
      chunkIso
    );
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
   * Scanning from the box's leading face, so a cell it already overlaps is
   * never returned.
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
   * Where a hitbox standing at `from` ends up after asking to move by
   * (deltaS, deltaE), stopped by whatever is in the way and sliding along it.
   *
   * One axis at a time, the second swept from where the first left the box.
   * Sweeping both against the SAME starting box lets a diagonal step walk
   * through a solid corner: each sweep only scans the cells the box already
   * spans on the other axis, so neither ever sees the cell diagonally ahead,
   * and a 1×1 pillar approached corner-on is simply passable. Advancing between
   * the two is what brings that cell into range — whichever axis crosses the
   * boundary last is swept against a box that already spans the other one.
   *
   * The larger component goes first, so the outcome does not depend on which
   * axis happens to be called s.
   */
  private slideAlong(
    from: GlobalIsoCoordinates,
    hitbox: IsoCoordinates,
    deltaS: number,
    deltaE: number
  ): GlobalIsoCoordinates {
    const delta: Record<"s" | "e", number> = { s: deltaS, e: deltaE };
    const order: ("s" | "e")[] =
      Math.abs(deltaS) >= Math.abs(deltaE) ? ["s", "e"] : ["e", "s"];
    let at = from;
    for (const axis of order) {
      const box = IsoBox.standingOn(at, hitbox);
      const step = this.freeDistance(box, axis, delta[axis]);
      const move = new IsoCoordinates(0, 0, 0);
      move[axis] = step;
      at = at.add(move);
    }
    return at;
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

  /**
   * The HIGHEST ground under the cells the character's hitbox covers, or
   * nothing if there is none within reach.
   *
   * The cells of the HITBOX, not of the shadow: the shadow is a disc drawn
   * INSIDE that square, so a character can be standing squarely on the lip of a
   * cliff while its disc has already cleared the edge entirely. A camera going
   * by the shadow would then sit at the bottom of the cliff while the character
   * is plainly on top of it.
   *
   * The highest of them and not the one under its middle, for the same reason:
   * a corner holds a character up as surely as its centre does.
   */
  private groundUnderCharacter(character: Character): number | undefined {
    const iso = character.globalIsoCoordinates;
    const cells = IsoBox.standingOn(iso, character.hitbox).cells();
    let highest: number | undefined;
    for (let cs = cells.min.s; cs < cells.max.s; cs++) {
      for (let ce = cells.min.e; ce < cells.max.e; ce++) {
        const ground = this.groundUnder(cs, ce, iso.u);
        if (ground === undefined) continue;
        if (highest === undefined || ground > highest) highest = ground;
      }
    }
    return highest;
  }

  /**
   * What a camera asked to look at the character should centre on, in map
   * pixels.
   *
   * Where it STANDS, not where it is: the level comes from the ground under it
   * rather than from the character itself, so that a jump does not drag the
   * camera up and back down with it. Everything else about a jump is visible
   * anyway — it is the ground going still that makes it readable.
   *
   * Half its height above that ground, at 4 pixels per level, the projection
   * being 8 to a level: on its feet, a tall character would sit in the top half
   * of the screen, and the taller it is the worse.
   *
   * The height comes out separately because it is the one part of `y` that
   * JUMPS — walking slides the rest a few pixels a frame — and because a camera
   * has to decide for itself what to do with it while the character is off the
   * ground. See Camera.groundToWatch.
   */
  public get characterCentre(): CharacterAnchor | undefined {
    const character = this.character;
    if (!character) return undefined;
    const iso = character.globalIsoCoordinates;
    // nothing underneath it: nothing better to go by than where it is
    const ground = this.groundUnderCharacter(character) ?? iso.u - 1;
    const standing = ground + 1;
    const xy = new GlobalIsoCoordinates(iso.s, iso.e, standing).toXY();
    return {
      x: xy.x + 16,
      y: xy.y + 16 - 4 * character.hitbox.u,
      standing,
      feet: iso.u,
      grounded: character.grounded,
    };
  }

  public addCharacterAt(globalIso: GlobalIsoCoordinates, type: CharacterType) {
    if (this.character) {
      // One character per map for now. Without this the previous one would
      // leave its meshes in the chunks forever, still drawn and never updated
      // again.
      console.warn(
        `Replacing the character of the map: only one is supported, ${type} evicts ${this.character.type}`
      );
      this.character.destroy();
    }
    this.character = new Character({
      type,
      globalIsoCoordinates: globalIso,
      direction: "s",
    });
    this.syncView();
  }

  /**
   * What the player is asking for this frame, from either device.
   *
   * `jump` and `attack` are the press, not the hold: a button held down is one
   * jump, not one per frame.
   */
  private sampleInput() {
    const pad = sampleGamepad();
    const keys = keyboardInput();
    // Added rather than chosen between, so that neither device has to be
    // declared the active one: whichever is at rest contributes nothing, and
    // holding both only ever asks for a longer deflection, which walkVelocity
    // clamps the same way it clamps a stick pushed into a corner.
    const held = pad.jumpHeld || keys.jumpHeld;
    const jump = held && !this.jumpHeld;
    this.jumpHeld = held;
    const attackHeld = pad.attackHeld || keys.attackHeld;
    const attack = attackHeld && !this.attackHeld;
    this.attackHeld = attackHeld;

    return {
      leftStickX: pad.left.x + keys.x,
      leftStickY: pad.left.y + keys.y,
      jump,
      attack,
    };
  }

  private simulate(
    time: Ticker,
    input: {
      leftStickX: number;
      leftStickY: number;
      jump: boolean;
      attack: boolean;
    }
  ) {
    const character = this.character;
    if (!character) {
      return;
    }
    const seconds = time.deltaMS / 1000;
    const before = character.globalIsoCoordinates;

    const velocity = walkVelocity(input.leftStickX, input.leftStickY);
    const deltaS = velocity.s * seconds;
    const deltaE = velocity.e * seconds;

    character.direction = headingOf(deltaS, deltaE) ?? character.direction;

    const walked = this.slideAlong(
      character.globalIsoCoordinates,
      character.hitbox,
      deltaS,
      deltaE
    );

    // Rising and falling are one more sweep, on the u axis. Standing on
    // something is asking to go down and being refused, which is also what
    // tells a jump it is allowed.
    const fallBox = IsoBox.standingOn(walked, character.hitbox);
    const grounded = this.freeDistance(fallBox, "u", -GROUND_PROBE) === 0;
    const jumped = input.jump && grounded;
    character.verticalSpeed = fallVelocity(character.verticalSpeed, {
      grounded,
      jump: input.jump,
      jumpSpeed: jumpSpeedFor(character.hitbox.u),
      seconds,
    });
    const wanted = character.verticalSpeed * seconds;
    const rise = this.freeDistance(fallBox, "u", wanted);
    // a floor caught it, or its head hit a ceiling: the speed is spent
    if (rise !== wanted) character.verticalSpeed = 0;
    const after = walked.add(new IsoCoordinates(0, 0, rise));
    character.globalIsoCoordinates = after;

    // What it actually did, not what the stick asked for: a wall it is pressed
    // against and the ground under its feet both show up here as a zero.
    if (seconds > 0) {
      this.velocity = new IsoCoordinates(
        (after.s - before.s) / seconds,
        (after.e - before.e) / seconds,
        (after.u - before.u) / seconds
      );
    }

    // Last, so that the frame is picked from where the character ended up and
    // from what the ground let it do — a jump refused by a ceiling is not a
    // jump, and the animation has to agree.
    character.update({
      seconds,
      grounded:
        this.freeDistance(
          IsoBox.standingOn(after, character.hitbox),
          "u",
          -GROUND_PROBE
        ) === 0,
      jumped,
      attack: input.attack,
    });
  }

  /**
   * The chunk that draws whatever stands over the column (s, e).
   *
   * A character straddles cells but each of its pieces covers exactly one
   * column, and a column belongs to exactly one chunk — chunks have no u
   * dimension. So a piece has a chunk of its own to be drawn by, where it
   * sorts against that chunk's cells on the same global depth key, and the
   * chunks themselves keep the diagonal order that is already right for the
   * cells of that column (see createChunk). Nothing has to be merged.
   *
   * Out of the map is an error, not a case: there is nowhere to draw a column
   * no chunk covers, and nothing should ever be over one — isSolidAt walls the
   * map at the edge of its chunks. This is the assertion, not the handling.
   */
  private chunkOver(s: number, e: number): MapChunk {
    const chunkIso = this.toChunkIso(new GlobalIsoCoordinates(s, e, 0));
    const chunk = this.chunks[chunkIso.toString()];
    if (!chunk) {
      throw new Error(
        `Nothing to draw the column ${s},${e} in: chunk ${chunkIso.toString()} is outside the map`
      );
    }
    return chunk;
  }

  /**
   * The highest solid cell strictly below the level `u` in the column (s, e),
   * or nothing within SHADOW_REACH.
   *
   * One column, not the whole footprint: the shadow needs the ground under each
   * cell it covers separately, since two of them can be at different heights.
   */
  private groundUnder(s: number, e: number, u: number): number | undefined {
    const below = Math.floor(u) - 1;
    for (
      let level = below;
      level > below - SHADOW_REACH && level >= 0;
      level--
    ) {
      if (this.isSolidAt(new GlobalIsoCoordinates(s, e, level))) return level;
    }
    return undefined;
  }

  /**
   * Keep the character's shadow on the ground below it.
   *
   * Painted one ground cell at a time, each piece a quarter above the cell it
   * lies on. One key for the whole shadow does not work: it lifts the pieces
   * lying on cells behind — the ones a character standing on an edge drops into
   * the hole beside it — over the tile and the character that ought to hide
   * them. The seams between pieces are closed by the SEAM bias instead.
   */
  /**
   * The disc the shadow is cast from, in cells.
   *
   * INSIDE the footprint: it keeps the shadow within the cells the hitbox
   * covers, which can never be in front of the character. A wider one reaches
   * the cell in front, drawn after the character, and dark pixels land on its
   * feet.
   *
   * On whole pixels, like the sprite (EntityColumns.placeSprite rounds too), or
   * it shimmers under it and is rasterized again every frame. What is rounded
   * is the projection — a pixel per 1/16 of a cell of (e − s), per 1/8 of
   * (e + s) — then inverted back.
   */
  private shadowDisc(character: Character) {
    const iso = character.globalIsoCoordinates;
    const across = Math.round(16 * (iso.e - iso.s)) / 16;
    const along = Math.round(8 * (iso.e + iso.s)) / 8;
    return {
      radius: Math.min(character.hitbox.s, character.hitbox.e) / 2,
      centre: {
        s: (along - across) / 2 + 0.5,
        e: (along + across) / 2 + 0.5,
      },
    };
  }

  private syncShadow(character: Character) {
    const iso = character.globalIsoCoordinates;
    const { radius, centre } = this.shadowDisc(character);
    // Over the cells of the HITBOX, not those of the disc: the disc lies
    // inside the footprint, so nothing is lost, and this is the range that is
    // certainly inside the map — floor(centre + radius) picks up the cell past
    // a box standing flush against a boundary, which has no chunk to be drawn
    // in when that boundary is the edge of the map. Cells the disc misses drop
    // out on their own, with no run to paint.
    const cells = IsoBox.standingOn(iso, character.hitbox).cells();

    let used = 0;
    for (let cs = cells.min.s; cs < cells.max.s; cs++) {
      for (let ce = cells.min.e; ce < cells.max.e; ce++) {
        const ground = this.groundUnder(cs, ce, iso.u);
        if (ground === undefined) continue;
        const runs = shadowRuns(cs, ce, centre, radius);
        if (runs.length === 0) continue;
        // Over the cell it lies on, under the character: the ground is a level
        // below the cell the character's pieces are keyed from, and those take
        // a fraction above it (EntityColumns.subCellKey), so the quarter only
        // ever has to clear the cell the shadow lies on.
        this.paintShadow(used++, this.chunkOver(cs, ce), runs, {
          at: new GlobalIsoCoordinates(cs, ce, ground).toXY(),
          zIndex: paintersOrderKey(cs, ce, ground) + 0.25,
        });
      }
    }
    this.clearShadowPiecesFrom(used);
  }

  /**
   * Fill one pooled piece of shadow with `runs`, and only when they changed.
   *
   * The guard is not an optimisation: Pixi rebuilds the draw instructions of a
   * whole render group as soon as one Graphics in it reports a change, and
   * GraphicsPipe.validateRenderable reports one for anything batchable without
   * looking at what changed. Redrawing an unmoved shadow would cost its chunk's
   * entire instruction set, every frame, standing still included.
   */
  private paintShadow(
    index: number,
    host: MapChunk,
    runs: ShadowRun[],
    where: { at: { x: number; y: number }; zIndex: number }
  ) {
    const piece = (this.shadowPieces[index] ??= new Graphics({
      eventMode: "none",
    }));
    if (piece.parent !== host) host.addChild(piece);
    piece.x = where.at.x;
    piece.y = where.at.y;
    piece.zIndex = where.zIndex;
    const shape = runs.map((run) => `${run.x},${run.y},${run.width}`).join(";");
    if (this.shadowShapes[index] === shape) return;
    this.shadowShapes[index] = shape;
    paintRuns(piece, runs);
  }

  /**
   * Put away the pieces this frame had no use for.
   *
   * Detached and not merely cleared: a piece left in the last chunk it was
   * drawn in would keep that chunk from ever being destroyed once emptied, and
   * a chunk holding an invisible Graphics is exactly the kind of thing that is
   * never noticed until it is a bug.
   */
  private clearShadowPiecesFrom(index: number) {
    for (let spare = index; spare < this.shadowPieces.length; spare++) {
      const piece = this.shadowPieces[spare];
      piece.parent?.removeChild(piece);
      if (this.shadowShapes[spare] === "") continue;
      this.shadowShapes[spare] = "";
      piece.clear();
    }
  }

  /**
   * A character straddles cells, so it cannot be a single sprite with a single
   * depth key: it is cut into one piece per column of the map it stands over,
   * each drawn at that column's key, by the chunk that owns that column — where
   * it sorts against the cells on the very same key. See chunkOver.
   */
  private syncView() {
    const character = this.character;
    if (!character) {
      this.clearShadowPiecesFrom(0);
      return;
    }
    this.syncShadow(character);
    if (character.needsSlicing) {
      character.setSlices(sliceEntityByColumn(character.shape));
    }
    character.render((s, e) => this.chunkOver(s, e));
  }

  private updateCosmetics(time: Ticker) {
    if (this.hoveredEntity) {
      const pulse = 0.5 + 0.5 * Math.sin((time.lastTime / 800) * Math.PI * 2);
      this.cursorSprites[this.hoveredEntity.side].alpha = 0.3 + 0.7 * pulse;
    }
  }

  /**
   * DEBUG — a red line along every chunk boundary, laid on the top face of the
   * tiles that sit on it, so the chunking can be read off the terrain it
   * follows. Toggled with F10, see DebugView.
   *
   * A boundary is exactly where a local coordinate is 0, so a tile knows it
   * stands on one without looking at a single neighbour, and the line it draws
   * is the NORTH and WEST edges of its own top face. Those are the edges a cell
   * owns — see Shadows.NORTH_EDGE_RUNS for why the other two are not usable —
   * and drawing only the min sides also means one line per boundary rather than
   * two abutting ones.
   *
   * Every boundary is drawn, always: chunks are never merged, so what the
   * overlay shows is what the draw order actually does.
   *
   * One Graphics per chunk, rebuilt only when the chunk's own cells changed.
   * All of them in an overlay above the map rather than inside the chunks,
   * where they would be hidden by the terrain in front of them — for finding a
   * boundary, showing through is worth more than looking solid.
   */
  private syncChunkBounds() {
    if (!debugViewEnabled()) {
      if (this.chunkBoundsOverlay) this.chunkBoundsOverlay.visible = false;
      return;
    }
    if (!this.chunkBoundsOverlay) {
      this.chunkBoundsOverlay = new Container();
      // above every chunk, and just under the depth key labels
      this.chunkBoundsOverlay.zIndex = Number.MAX_SAFE_INTEGER - 1;
      this.addChild(this.chunkBoundsOverlay);
    }
    this.chunkBoundsOverlay.visible = true;

    for (const key of Object.keys(this.chunkBounds) as IsoString[]) {
      if (this.chunks[key]) continue;
      this.chunkBounds[key].line.destroy();
      delete this.chunkBounds[key];
    }

    for (const key of Object.keys(this.chunks) as IsoString[]) {
      const chunk = this.chunks[key];
      const drawn = (this.chunkBounds[key] ??= {
        line: this.chunkBoundsOverlay.addChild(
          new Graphics({ eventMode: "none" })
        ),
        signature: "",
      });
      const signature = `${chunk.revision}`;
      if (drawn.signature === signature) continue;
      drawn.signature = signature;
      drawn.line.clear();
      for (const cellKey of Object.keys(chunk.cells) as IsoString[]) {
        const local = LocalIsoCoordinates.fromString(cellKey);
        if (local.s !== 0 && local.e !== 0) continue;
        const iso = chunk.toGlobalIsoCoordinates(local);
        // only a top face that is actually drawn: a buried tile has none, and
        // a map object is not a face at all
        if (!this.isTileAt(iso) || this.isTileAt(iso.move("up"))) continue;
        if (!this.isInShell(iso)) continue;
        const xy = iso.toXY();
        const runs = [
          ...(local.s === 0 ? NORTH_EDGE_RUNS : []),
          ...(local.e === 0 ? WEST_EDGE_RUNS : []),
        ];
        for (const run of runs) {
          drawn.line.rect(xy.x + run.x, xy.y + run.y, run.width, 1);
        }
      }
      drawn.line.fill({ color: 0xff0000, alpha: 1 });
    }
  }

  /**
   * DEBUG — writes the depth key on every cell around the character and on
   * every piece of its sprite, so the draw order can be read off the screen.
   * Toggled with F10, see DebugView. Only the cells the character can reach are
   * labelled; a whole map's worth of text would be unreadable.
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
    /** Two lines, the pair centred on (x, y). */
    const write = (
      top: string,
      bottom: string,
      x: number,
      y: number,
      fill: number
    ) => {
      const label = (this.depthKeyLabels[used] ??=
        this.depthKeyOverlay!.addChild(
          new Text({
            text: "",
            // thirteen characters have to fit in a 32 px cell, so the type is
            // tiny; the resolution is what keeps it readable once zoomed in
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
      const text = `${top}\n${bottom}`;
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
    const pieces = slicing?.pieces ?? [];
    pieces.forEach((piece, index) => {
      // A piece is a run of pixels per row, not a rectangle, so the label goes
      // at the centroid of the pixels it covers: the centre of the bounding box
      // of a piece cut along a diagonal falls inside the neighbouring one.
      let covered = 0;
      let x = 0;
      let y = 0;
      for (const run of piece.runs) {
        covered += run.width;
        x += (run.x + run.width / 2) * run.width;
        y += (run.y + 0.5) * run.width;
      }
      // Which column the piece stands over — except on the nearest piece, which
      // comes last, where the character's own position is worth more.
      const where =
        index === pieces.length - 1
          ? `${s.toFixed(1)},${e.toFixed(1)},${u.toFixed(1)}`
          : `${piece.s},${piece.e}`;
      write(
        // one decimal of the fraction is enough to separate two characters
        // sharing a column, where a double prints sixteen
        where,
        piece.zIndex.toFixed(1),
        slicing!.x + x / covered,
        slicing!.y + y / covered,
        0xffe066
      );
    });
    for (let index = used; index < this.depthKeyLabels.length; index++) {
      this.depthKeyLabels[index].visible = false;
    }
  }

  public update(time: Ticker) {
    const input = this.sampleInput();
    // picks the animation frame too, which the view is then cut from
    this.simulate(time, input);
    this.updateCosmetics(time);
    this.syncView();
    this.syncChunkBounds();
    this.syncDepthKeys();
  }

  public destroy(options?: { children?: boolean; texture?: boolean }) {
    // both borrow a chunk to be drawn in, so both go before the chunks do
    this.character?.destroy();
    this.character = undefined;
    for (const piece of this.shadowPieces) piece.destroy();
    this.cursorSprites.up.destroy();
    this.cursorSprites.east.destroy();
    this.cursorSprites.south.destroy();
    super.destroy(options);
  }
}
