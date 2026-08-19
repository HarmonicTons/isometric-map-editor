import { Container, Sprite, Texture, Ticker } from "pixi.js";
import {
  ChunkIsoCoordinates,
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  isoDirections,
  IsoString,
  LocalIsoCoordinates,
  MAP_MAX_HEIGHT,
  VisibleIsoDirection,
} from "../iso/IsometricCoordinate";
import { CellContent, ChunkTileData, MapChunk } from "./MapChunk";
import { MapObject, MapObjectType } from "./MapObject";
import { Tile, TileType } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import { Character, CharacterType, headingOf } from "../character/Character";
import { sliceEntityByColumn } from "../character/EntityColumns";
import {
  fallVelocity,
  freeDistance,
  isGrounded,
  jumpSpeedFor,
  slideAlong,
  walkVelocity,
} from "../character/Collision";
import { keyboardInput } from "../input/Keyboard";
import { sampleGamepad } from "../input/Gamepad";
import { DebugOverlay } from "../debug/DebugOverlay";

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

/** How far below its feet a character still casts a shadow, in cells */
const SHADOW_REACH = 16;

/** One empty level: a tile resting on another has nowhere to cast a shadow */
const OVERHANG_GAP = 2;

/**
 * The map, as a collection of chunks.
 *
 * Chunks are vertical columns (chunksSize × chunksSize × MAP_MAX_HEIGHT), so
 * there is no vertical boundary and anything tall lives in a single chunk.
 *
 * Map is the single authority on global coordinates: everything that can cross
 * a chunk boundary lives here and is routed to the owning chunk in local ones.
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

  /** DEBUG — the two F10 overlays, see DebugOverlay */
  private readonly debug = new DebugOverlay(this);

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

    if (Object.keys(mapData.characters ?? {}).length > 1) {
      console.warn(
        `Only one character is supported: all but the last of ${Object.keys(mapData.characters).join(", ")} are dropped`
      );
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
   * Outside the chunked area everything is solid, so the map is a walled box
   * and a character always stands over a column with a chunk to draw it (see
   * chunkOver). The wall is at the edge of the CHUNKS, so there is still room
   * to fall off a ledge.
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
  public isInShell(iso: GlobalIsoCoordinates): boolean {
    return shellTilesRelativeCoordinates.some(
      (relative) => this.getCellContentAt(iso.add(relative)) === undefined
    );
  }

  /**
   * Whether a cell holds a TILE — the only thing that casts a shade.
   *
   * Not `isSolidAt`: a tree blocks movement but darkens nothing. Objects are
   * left out because nothing refreshes the column under one when it is planted
   * or felled, so counting them would make the shade depend on the order the
   * edits happened in.
   */
  public isTileAt(iso: GlobalIsoCoordinates): boolean {
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
      | { entityType: "character"; type: CharacterType }
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
    } else if (action.entityType === "object") {
      this.addMapObjectAt(target, action.type);
    } else {
      // Nothing to make room for and nothing to refuse: a character is not a
      // cell. Dropped on the side of a tile it simply falls until it lands.
      this.addCharacterAt(target, action.type);
    }
  }

  /**
   * The HIGHEST ground under the cells the character's hitbox covers, or
   * nothing if there is none within reach.
   *
   * The HIGHEST of the hitbox's cells, not the one under its middle and not the
   * shadow's: a corner holds a character up as surely as its centre does, and
   * the shadow is a disc inside the square, so it can clear the lip of a cliff
   * while the character is plainly still standing on it.
   */
  private groundUnderCharacter(character: Character): number | undefined {
    const iso = character.globalIsoCoordinates;
    const cells = IsoBox.standingOn(iso, character.hitbox).cells();
    let highest: number | undefined;
    for (let cs = cells.min.s; cs < cells.max.s; cs++) {
      for (let ce = cells.min.e; ce < cells.max.e; ce++) {
        const ground = this.levelUnder(cs, ce, iso.u);
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
   * Where it STANDS, not where it is, so a jump does not drag the camera up and
   * back down with it — it is the ground going still that makes a jump
   * readable. Half its height above that ground, at 4 pixels per level, or a
   * tall character sits in the top half of the screen.
   *
   * The level comes out separately because it is the one part of `y` that
   * JUMPS, and a camera has to decide for itself what to do with it while the
   * character is off the ground. See Camera.groundToWatch.
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

  /**
   * Put a character on the map, MOVING the one already there if there is one.
   *
   * One character per map for now, so this is both how the editor places one
   * and how it moves it. Destroying the old one is what takes its meshes out of
   * the chunks they were drawn in; left alone they would stay there for ever,
   * still drawn and never updated again.
   */
  public addCharacterAt(globalIso: GlobalIsoCoordinates, type: CharacterType) {
    this.character?.destroy();
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
    // added rather than chosen between, so neither device has to be declared
    // the active one: whichever is at rest contributes nothing
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

    const isSolid = (iso: GlobalIsoCoordinates) => this.isSolidAt(iso);
    const walked = slideAlong(
      isSolid,
      character.globalIsoCoordinates,
      character.hitbox,
      deltaS,
      deltaE
    );

    // Rising and falling are one more sweep, on the u axis. Standing on
    // something is asking to go down and being refused, which is also what
    // tells a jump it is allowed.
    const fallBox = IsoBox.standingOn(walked, character.hitbox);
    const grounded = isGrounded(isSolid, fallBox);
    const jumped = input.jump && grounded;
    character.verticalSpeed = fallVelocity(character.verticalSpeed, {
      grounded,
      jump: input.jump,
      jumpSpeed: jumpSpeedFor(character.hitbox.u),
      seconds,
    });
    const wanted = character.verticalSpeed * seconds;
    const rise = freeDistance(isSolid, fallBox, "u", wanted);
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
      grounded: isGrounded(isSolid, IsoBox.standingOn(after, character.hitbox)),
      jumped,
      attack: input.attack,
    });
  }

  /**
   * The chunk that draws whatever stands over the column (s, e).
   *
   * Each piece of a character covers one column and a column belongs to one
   * chunk, so a piece has a chunk of its own to be drawn by — see
   * EntityColumns. Off the map is an error, not a case: isSolidAt walls the map
   * at the edge of its chunks, so this is the assertion, not the handling.
   */
  public hostOver(s: number, e: number): MapChunk {
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
  public levelUnder(s: number, e: number, u: number): number | undefined {
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

  /** Cut the character up and hand each piece to its own column's chunk. */
  private syncView() {
    const character = this.character;
    if (!character) return;
    const { globalIsoCoordinates: iso, hitbox } = character;
    character.shadow.sync(iso, hitbox, this);
    if (character.needsSlicing) {
      character.setSlices(sliceEntityByColumn(character.shape));
    }
    character.render((s, e) => this.hostOver(s, e));
  }

  private updateCosmetics(time: Ticker) {
    if (this.hoveredEntity) {
      const pulse = 0.5 + 0.5 * Math.sin((time.lastTime / 800) * Math.PI * 2);
      this.cursorSprites[this.hoveredEntity.side].alpha = 0.3 + 0.7 * pulse;
    }
  }

  public update(time: Ticker) {
    const input = this.sampleInput();
    // picks the animation frame too, which the view is then cut from
    this.simulate(time, input);
    this.updateCosmetics(time);
    this.syncView();
    this.debug.sync();
  }

  public destroy(options?: { children?: boolean; texture?: boolean }) {
    // it borrows chunks to be drawn in, so it goes before the chunks do
    this.character?.destroy();
    this.character = undefined;
    this.cursorSprites.up.destroy();
    this.cursorSprites.east.destroy();
    this.cursorSprites.south.destroy();
    super.destroy(options);
  }
}
