import type { ColorMatrix } from "pixi.js";
import {
  Color,
  ColorMatrixFilter,
  Container,
  Mesh,
  MeshGeometry,
  Texture,
} from "pixi.js";
import { GlobalIsoCoordinates, IsoCoordinates } from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";
import type {
  EntityColumnPiece,
  EntityColumnSlices,
  EntityShape,
} from "./EntityColumns";
import { debugViewEnabled } from "./DebugView";

/**
 * The type of a character (e.g. who).
 */
export type CharacterType = string & { readonly __brand: "CharacterType" };

export type CharacterState = "idle" | "walking";
const stateKey: Record<CharacterState, string> = {
  idle: "i",
  walking: "m",
};
export type CharacterDirection = "north" | "east" | "south" | "west";
const directionKey: Record<CharacterDirection, string> = {
  north: "n",
  east: "e",
  south: "s",
  west: "w",
};

/**
 * What a character occupies, in cells. Deliberately narrower than what it
 * looks like: it slips through a gap a little before its sprite stops
 * touching the walls, which is what makes moving along them feel right.
 *
 * It also decides which cells hide it, and that is not a free choice — it has
 * to be the volume collision keeps clear, or a wall the character is pressed
 * against would interpenetrate it and end up with no depth order at all.
 * Whatever the sprite draws outside its silhouette is ordered by
 * approximation; EntityColumns.test.ts counts how much that is, as offSprite.
 */
const CHARACTER_HITBOX: Record<string, IsoCoordinates> = {
  default: new IsoCoordinates(0.8, 0.8, 1.9),
  "cube-medium": new IsoCoordinates(0.99, 0.99, 2),
  "cube-large": new IsoCoordinates(1.99, 1.99, 4),
  "template-1x1x2": new IsoCoordinates(0.99, 0.99, 2),
  "template-2x2x4": new IsoCoordinates(1.99, 1.99, 4),
  "005-reptincel": new IsoCoordinates(0.6, 0.6, 1.9),
  "095-onix": new IsoCoordinates(1.9, 1.9, 3.9),
};

/**
 * The frames of the walk cycle, in the order they are shown: a step, legs
 * together, the other step, legs together.
 */
const WALK_CYCLE = [1, 2, 3, 2];

/** Legs together — what it stands on when it is not going anywhere. */
const NEUTRAL_FRAME = 2;

/**
 * How far the character walks between two frames of the cycle, in cells.
 *
 * Frames follow the distance covered rather than the clock, so the cadence is
 * whatever the speed is: half speed, half cadence, and the feet never slide
 * over the ground. Half a cell is what the old fixed 250 ms per frame came out
 * at when walking at full speed, so nothing changes at full stick.
 */
const CELLS_PER_FRAME = 0.4;

/**
 * DEBUG — one colour per column while the depth order overlay is on, so where
 * the sprite is cut is visible at a glance. Laid out as a checkerboard over
 * (s, e) rather than by the order the pieces come in, so that a piece keeps its
 * colour while the character walks and two neighbouring columns never share one.
 * See DebugView.
 */
const PIECE_TINTS = [0xff6b6b, 0x6bc8ff, 0xffd76b, 0x8cff8c];

/**
 * How much of the sprite's own shading survives, the rest being a flat floor of
 * the column's colour.
 *
 * At 1 the darkest pixels come out black and the columns under them are
 * indistinguishable; at 0 the sprite is four flat silhouettes and its shape is
 * gone. This reads the cut first and the art second.
 */
const SHADING = 0.55;

/** Rec. 709, so that the sprite's shading survives at the brightness it had */
const [LUMA_R, LUMA_G, LUMA_B] = [0.2126, 0.7152, 0.0722];

/**
 * The colour of a column as a filter: drop the sprite to its luminance, then
 * paint that luminance back in the column's colour.
 *
 * `mesh.tint` cannot do this on its own. A tint MULTIPLIES, so it can only ever
 * take colour away: an all-red character stays red under all four tints — the
 * blue and green ones simply turn it black — and the cut is invisible, which is
 * the whole point of the overlay. Throwing the sprite's own hue away FIRST is
 * what makes four columns four colours whatever the art.
 *
 * It has to be one matrix rather than a desaturation on top of a tint: a filter
 * runs on what the mesh already rendered, tint included, so desaturating after
 * would grey out the very colour it is meant to show.
 */
const columnFilter = (tint: number): ColorMatrixFilter => {
  const filter = new ColorMatrixFilter();
  const [r, g, b] = new Color(tint).toArray();
  // out.channel = channel * (SHADING * luma + (1 - SHADING)) — the last term of
  // a row is a constant the shader adds, which is what makes the floor affine
  // rather than a second pass
  const row = (channel: number) =>
    [
      LUMA_R * SHADING * channel,
      LUMA_G * SHADING * channel,
      LUMA_B * SHADING * channel,
      0,
      (1 - SHADING) * channel,
    ] as const;
  // alpha carried through untouched, so the silhouette is unchanged
  filter.matrix = [
    ...row(r),
    ...row(g),
    ...row(b),
    0,
    0,
    0,
    1,
    0,
  ] as ColorMatrix;
  return filter;
};

/**
 * Shared, and built on first use: a filter holds no per-object state, so four
 * are enough for any number of characters — and building one compiles a shader,
 * which the headless tests have no context for and no reason to want, the
 * overlay being off there.
 */
const PIECE_FILTERS: ColorMatrixFilter[] = [];

const filterOf = (piece: EntityColumnPiece) => {
  const index = (((piece.s % 2) + 2) % 2) * 2 + (((piece.e % 2) + 2) % 2);
  return (PIECE_FILTERS[index] ??= columnFilter(PIECE_TINTS[index]));
};

/**
 * One piece of the character's sprite: what it shows over a single column of
 * the map, drawn at that column's depth key.
 *
 * A mesh rather than a sprite because a piece is not a rectangle — it is a run
 * of pixels per row of the sprite, one quad each, cut along the boundary
 * between two columns. They are pooled, buffers included, and sized for the
 * worst case once: only their contents, position and depth ever change.
 */
type CharacterPiece = {
  mesh: Mesh<MeshGeometry>;
  /** the slice its buffers currently hold, so that a still frame refills none */
  filledFrom?: EntityColumnPiece;
};

/**
 * A character on the map.
 *
 * Unlike tiles and objects, a character stands at fractional coordinates and
 * straddles cells, so no single depth key is right for its whole sprite. It is
 * therefore not a display object itself: it owns a handful of meshes, one per
 * column of the map it stands over, all drawn in the live block around it.
 * See EntityColumns.
 */
export class Character {
  public readonly type: CharacterType;
  /** What it occupies, for collision and for depth order alike */
  public hitbox = CHARACTER_HITBOX.default;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  /** How fast it is rising, in cells per second. Negative while falling. */
  public verticalSpeed = 0;
  public state: CharacterState;
  public direction: CharacterDirection;

  /** Animation frame currently displayed, as found in the atlas */
  private animationTexture: Texture;
  /** Ground covered since it last stood still, in cells. See update. */
  private walked = 0;
  private walkedFrom?: { s: number; e: number };
  private pieces: CharacterPiece[] = [];
  private slices?: EntityColumnSlices;
  private slicedAt?: {
    s: number;
    e: number;
    u: number;
    width: number;
    height: number;
  };

  constructor({
    type,
    state = "walking",
    direction = "south",
    globalIsoCoordinates,
  }: {
    type: CharacterType;
    state?: CharacterState;
    direction?: CharacterDirection;
    globalIsoCoordinates: GlobalIsoCoordinates;
  }) {
    this.type = type;
    this.hitbox = CHARACTER_HITBOX[type] ?? CHARACTER_HITBOX.default;
    this.state = state;
    this.direction = direction;
    this.globalIsoCoordinates = globalIsoCoordinates;
    this.animationTexture = Character.getTexture(type, state, direction);
  }

  public static getTexture(
    type: CharacterType,
    state: CharacterState,
    direction: CharacterDirection = "south",
    animationFrame: number = 1
  ): Texture {
    const texture = Texture.from(
      `${type}_${stateKey[state]}-${directionKey[direction]}${animationFrame}.png`
    );
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for character ${type}_${stateKey[state]}-${directionKey[direction]}${animationFrame}.png`
      );
    }
    return texture;
  }

  /** How many pieces it is currently cut into */
  public get pieceCount(): number {
    return this.slices?.pieces.length ?? 0;
  }

  /** The cut as it currently stands. Read by the depth-key debug overlay. */
  public get slicing(): EntityColumnSlices | undefined {
    return this.slices;
  }

  /** What the cut is decided from: where it stands and how big it is. */
  public get shape(): EntityShape {
    return {
      iso: this.globalIsoCoordinates,
      hitbox: this.hitbox,
      spriteWidth: this.spriteWidth,
      spriteHeight: this.spriteHeight,
    };
  }

  public get spriteWidth(): number {
    return this.animationTexture.frame.width;
  }

  public get spriteHeight(): number {
    return this.animationTexture.frame.height;
  }

  /**
   * Pick the animation frame the character's ground travel has earned.
   *
   * Only s and e count: falling is not walking, and a character pressed into a
   * wall covers no ground and so stands still rather than walking on the spot.
   */
  public update() {
    const previous = this.walkedFrom;
    const { s, e } = this.globalIsoCoordinates;
    this.walkedFrom = { s, e };
    const step = previous ? Math.hypot(s - previous.s, e - previous.e) : 0;
    if (step === 0) {
      // start the next departure on a step rather than mid-stride
      this.walked = 0;
    }
    this.walked += step;

    const animationFrame =
      step === 0
        ? NEUTRAL_FRAME
        : WALK_CYCLE[
            Math.floor(this.walked / CELLS_PER_FRAME) % WALK_CYCLE.length
          ];
    this.animationTexture = Character.getTexture(
      this.type,
      this.state,
      this.direction,
      animationFrame
    );
  }

  /**
   * Whether the cut is out of date. It depends only on where the character
   * stands and how big its sprite is, so it survives every frame it does not
   * move, animation included.
   */
  public get needsSlicing(): boolean {
    const { s, e, u } = this.globalIsoCoordinates;
    const at = this.slicedAt;
    return (
      at === undefined ||
      at.s !== s ||
      at.e !== e ||
      at.u !== u ||
      at.width !== this.spriteWidth ||
      at.height !== this.spriteHeight
    );
  }

  public setSlices(slices: EntityColumnSlices) {
    const { s, e, u } = this.globalIsoCoordinates;
    this.slicedAt = {
      s,
      e,
      u,
      width: this.spriteWidth,
      height: this.spriteHeight,
    };
    this.slices = slices;
  }

  /**
   * Draw the character as its current pieces, all in `host`, reusing the pooled
   * meshes. Pieces beyond what is needed are detached rather than hidden, so
   * that nothing is kept alive by an invisible mesh.
   */
  public render(host: Container) {
    const slices = this.slices;
    if (!slices) return;
    while (this.pieces.length < slices.pieces.length) {
      this.pieces.push(this.createPiece());
    }
    this.pieces.forEach((mesh, index) => {
      const piece = slices.pieces[index];
      if (piece) {
        this.showPiece(mesh, slices, piece, host);
      } else {
        this.detach(mesh);
      }
    });
  }

  public destroy() {
    for (const piece of this.pieces) {
      this.detach(piece);
      const { geometry } = piece.mesh;
      // the texture is the shared animation frame from the atlas: not ours.
      // The geometry is, and Mesh.destroy only drops its reference to it —
      // buffers and the GPU allocations behind them would outlive the mesh.
      piece.mesh.destroy();
      geometry.destroy();
    }
    this.pieces = [];
  }

  private createPiece(): CharacterPiece {
    const geometry = new MeshGeometry({ shrinkBuffersToFit: false });
    // Left to decide for itself Pixi batches a mesh of at most 100 vertices,
    // and a piece is one quad per row of the sprite: 128 vertices for a 32
    // pixel character. Every piece would take a draw call of its own and cut
    // the live block's tile batch in two on its way past, every frame.
    //
    // Asking for it also puts MeshPipe.validateRenderable back on the branch
    // that compares buffer sizes — for an unbatched mesh it returns early —
    // which is what makes the fixed sizing in fillGeometry worth anything.
    geometry.batchMode = "batch";
    return { mesh: new Mesh({ geometry, texture: this.animationTexture }) };
  }

  /**
   * Fill a mesh with the runs of one piece, one quad per run.
   *
   * Positions are pixels from the sprite's top-left, UVs the same points in
   * [0, 1] over the animation frame — the texture's own matrix takes care of
   * where that frame sits in the atlas, so a frame change is one assignment
   * and never touches the buffers.
   *
   * The buffers are sized once for the worst case and never resized: a piece
   * can hold at most one run per row of the sprite, because along a row the
   * column it stands over only ever moves one way. That is not a detail. Pixi
   * rebuilds a render group's whole instruction set when a BATCHED mesh's
   * vertex count changes, and the count would otherwise follow the character
   * around, pixel by pixel — the very thing that made moving cost 170 000
   * objects a frame. The spare quads collapse to a point instead, and
   * rasterize nothing. See createPiece for why the mesh is batched at all: at
   * this size it is not by default, and this paragraph would then be describing
   * a branch Pixi never reaches.
   */
  private fillGeometry(piece: CharacterPiece, cut: EntityColumnPiece) {
    const { geometry } = piece.mesh;
    const quads = this.spriteHeight;
    if (geometry.indices.length !== 6 * quads) {
      geometry.positions = new Float32Array(8 * quads);
      geometry.uvs = new Float32Array(8 * quads);
      const indices = new Uint32Array(6 * quads);
      for (let quad = 0; quad < quads; quad++) {
        const corner = quad * 4;
        indices.set(
          [corner, corner + 1, corner + 2, corner, corner + 2, corner + 3],
          quad * 6
        );
      }
      geometry.indices = indices;
      geometry.indexBuffer.update();
    }
    const { positions, uvs } = geometry;
    const width = this.spriteWidth;
    const height = this.spriteHeight;
    cut.runs.forEach((run, quad) => {
      const left = run.x;
      const right = run.x + run.width;
      const top = run.y;
      const bottom = run.y + 1;
      // top-left, top-right, bottom-right, bottom-left
      positions.set(
        [left, top, right, top, right, bottom, left, bottom],
        quad * 8
      );
      uvs.set(
        [
          left / width,
          top / height,
          right / width,
          top / height,
          right / width,
          bottom / height,
          left / width,
          bottom / height,
        ],
        quad * 8
      );
    });
    positions.fill(0, cut.runs.length * 8);
    uvs.fill(0, cut.runs.length * 8);
    geometry.getBuffer("aPosition").update();
    geometry.getBuffer("aUV").update();
  }

  private showPiece(
    piece: CharacterPiece,
    slices: EntityColumnSlices,
    cut: EntityColumnPiece,
    host: Container
  ) {
    if (piece.mesh.texture !== this.animationTexture) {
      piece.mesh.texture = this.animationTexture;
    }
    const filter = debugViewEnabled() ? filterOf(cut) : undefined;
    // assigning rebuilds the effect list, so only when it actually changed
    if (piece.mesh.filters?.[0] !== filter) {
      piece.mesh.filters = filter ? [filter] : [];
    }
    // a cut only changes when the character moves, and the buffers are the
    // costly part of a piece: a still frame refills nothing
    if (piece.filledFrom !== cut) {
      this.fillGeometry(piece, cut);
      piece.filledFrom = cut;
    }

    // re-adding an existing child moves it to the end of the list every frame
    if (piece.mesh.parent !== host) host.addChild(piece.mesh);
    piece.mesh.x = slices.x;
    piece.mesh.y = slices.y;
    piece.mesh.zIndex = cut.zIndex;
  }

  private detach(piece: CharacterPiece) {
    piece.mesh.parent?.removeChild(piece.mesh);
  }
}
