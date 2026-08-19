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
  CharacterAnimationName,
  CharacterDirection,
  CharacterSprites,
  SpriteAnimation,
} from "./characterSprites";
import { DIRECTIONS, animationOf, characterSprites } from "./characterSprites";
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

export type { CharacterAnimationName, CharacterDirection };

/**
 * The walking speed the sheets are drawn for, in cells per second — Map walks
 * the character at exactly this, so the cadence follows the ground covered and
 * still comes out at the drawn rhythm at full stick.
 */
export const NOMINAL_WALK_SPEED = 3;

/** A tick of the durations in the sheets, in seconds */
const TICK = 1 / 60;

/**
 * How long a character stands doing nothing before it plays its idle animation.
 *
 * The idle sheet is a stretch and a yawn, not a way of standing: looped it
 * would be a character fidgeting without pause. Between two of them it holds
 * the first frame of its walk cycle, which IS its way of standing.
 */
export const IDLE_EVERY = 5;

/** The frame of the walk cycle a character rests on */
const RESTING_FRAME = 0;

/**
 * The frame a run of durations is on after `ticks`, looping.
 *
 * Takes a fractional number of ticks, which is what lets one function serve
 * both the animations played by the clock and the one played by the ground the
 * character has covered.
 */
export const frameAtTicks = (durations: number[], ticks: number): number => {
  const cycle = durations.reduce((total, held) => total + held, 0);
  let left = ((ticks % cycle) + cycle) % cycle;
  for (let frame = 0; frame < durations.length; frame++) {
    left -= durations[frame];
    if (left < 0) return frame;
  }
  return durations.length - 1;
};

/**
 * The eight-way heading a movement asks for, or undefined if it asks for none.
 *
 * The sheet's rows are 45° apart on SCREEN and our axes are not, so the
 * movement is projected before its angle is taken: comparing s against e
 * instead would turn the character 22.5° wrong.
 */
export const headingOf = (
  deltaS: number,
  deltaE: number
): CharacterDirection | undefined => {
  if (deltaS === 0 && deltaE === 0) return undefined;
  const x = 16 * (deltaE - deltaS);
  const y = 8 * (deltaE + deltaS);
  // DIRECTIONS is in the order the rows are stacked: `se` is straight down the
  // screen, and each next one is 45 degrees counter-clockwise from it
  const turns = 2 - Math.atan2(y, x) / (Math.PI / 4);
  return DIRECTIONS[
    ((Math.round(turns) % DIRECTIONS.length) + DIRECTIONS.length) %
      DIRECTIONS.length
  ];
};

/** How one frame of one animation is named in the atlas */
const frameName = (
  type: string,
  animation: CharacterAnimationName,
  direction: CharacterDirection,
  frame: number
) => `${type}_${animation}-${direction}${frame + 1}.png`;

/**
 * How a character is shown on the control bar: the resting frame of its walk
 * cycle seen from `se`, which points straight down the screen. Its own sheets,
 * so adding a character to the palette is a line in a list and nothing else.
 */
export const characterPortrait = (type: CharacterType): Texture => {
  const key = frameName(type, "walk", "se", RESTING_FRAME);
  const texture = Texture.from(key);
  if (!texture) {
    throw new NoTextureFoundError(
      `No texture found for character ${type}: ${key}`
    );
  }
  return texture;
};

/** What the simulation tells a character every frame */
export type CharacterStep = {
  seconds: number;
  /** whether something under its feet refused to let it down */
  grounded: boolean;
  /** the jump that just took off, not the button being held */
  jumped: boolean;
  /** the press that starts an attack */
  attack: boolean;
};

/**
 * DEBUG — one colour per column while the depth order overlay is on (DebugView).
 * A checkerboard over (s, e) rather than the order the pieces come in, so a
 * piece keeps its colour while the character walks and neighbours never match.
 */
const PIECE_TINTS = [0xff6b6b, 0x6bc8ff, 0xffd76b, 0x8cff8c];

/**
 * How much of the sprite's shading survives, the rest a flat floor of colour.
 * At 1 the darkest pixels come out black and hide their column; at 0 the sprite
 * is four flat silhouettes.
 */
const SHADING = 0.55;

/** Rec. 709, so that the sprite's shading survives at the brightness it had */
const [LUMA_R, LUMA_G, LUMA_B] = [0.2126, 0.7152, 0.0722];

/**
 * The colour of a column as a filter: drop the sprite to its luminance, then
 * paint that luminance back in the column's colour. `mesh.tint` MULTIPLIES, so
 * an all-red character would stay red under all four colours.
 */
const columnFilter = (tint: number): ColorMatrixFilter => {
  const filter = new ColorMatrixFilter();
  const [r, g, b] = new Color(tint).toArray();
  // out.channel = channel * (SHADING * luma + (1 - SHADING)); a row's last term
  // is the constant the shader adds, which is what makes the floor affine
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

/** Shared, and built on first use: a filter holds no per-object state */
const PIECE_FILTERS: ColorMatrixFilter[] = [];

const filterOf = (piece: EntityColumnPiece): ColorMatrixFilter => {
  const index = (((piece.s % 2) + 2) % 2) * 2 + (((piece.e % 2) + 2) % 2);
  return (PIECE_FILTERS[index] ??= columnFilter(PIECE_TINTS[index]));
};

/**
 * One piece of the character's sprite: what it shows over a single column of the
 * map, drawn at that column's depth key. A mesh rather than a sprite because a
 * piece is not a rectangle but a run of pixels per row, one quad each.
 */
type CharacterPiece = {
  mesh: Mesh<MeshGeometry>;
  /** the slice its buffers currently hold, so that a still frame refills none */
  filledFrom?: EntityColumnPiece;
};

/**
 * A character on the map.
 *
 * It stands at fractional coordinates and straddles cells, so no single depth
 * key is right for its whole sprite: it is not a display object itself but owns
 * one mesh per column it stands over, each drawn by the chunk that owns that
 * column. See EntityColumns.
 */
export class Character {
  public readonly type: CharacterType;
  /** What it occupies, for collision and for depth order alike */
  public readonly hitbox: IsoCoordinates;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  /** How fast it is rising, in cells per second. Negative while falling. */
  public verticalSpeed = 0;
  /** Whether something under its feet is holding it up */
  public grounded = true;
  public direction: CharacterDirection;

  /** How it is drawn, all of it: sheets, anchors, hitbox */
  private readonly sprites: CharacterSprites;
  /** What it is playing, and where in it */
  private animation: CharacterAnimationName = "idle";
  private frame = 0;
  /** Animation frame currently displayed, as found in the atlas */
  private animationTexture: Texture;
  /** Ground covered since it last stood still, in cells. See update. */
  private walked = 0;
  private walkedFrom?: { s: number; e: number };
  /** What is left of the attack under way, in seconds */
  private attacking = 0;
  /** How long it has been standing there, in seconds. Reset by a break. */
  private stillFor = 0;
  /** How far into an idle break it is, in seconds, or none if it is not on one */
  private breaking?: number;
  private wasGrounded = true;
  private pieces: CharacterPiece[] = [];
  private slices?: EntityColumnSlices;
  private slicedAt?: {
    s: number;
    e: number;
    u: number;
    width: number;
    height: number;
    anchorX: number;
    anchorY: number;
  };

  constructor({
    type,
    direction = "s",
    globalIsoCoordinates,
  }: {
    type: CharacterType;
    direction?: CharacterDirection;
    globalIsoCoordinates: GlobalIsoCoordinates;
  }) {
    this.type = type;
    this.sprites = characterSprites(type);
    const [s, e, u] = this.sprites.hitbox;
    this.hitbox = new IsoCoordinates(s, e, u);
    this.direction = direction;
    this.globalIsoCoordinates = globalIsoCoordinates;
    this.animationTexture = this.textureOf();
  }

  /** The animation being played */
  private get playing(): SpriteAnimation {
    return animationOf(this.sprites, this.animation);
  }

  private textureOf(): Texture {
    const key = frameName(
      this.type,
      this.animation,
      this.direction,
      this.frame
    );
    const texture = Texture.from(key);
    if (!texture) {
      throw new NoTextureFoundError(
        `No texture found for character ${this.type} playing ${this.animation}: ${key}`
      );
    }
    return texture;
  }

  /**
   * Where the sprite's ground point is, in pixels from its top left.
   *
   * A frame carries its own, which is what places art of any size or shape
   * without a word of configuration — and what pins an animation that travels
   * inside its own frame back onto the spot the engine puts the character on.
   */
  private get anchor(): [number, number] {
    const animation = this.playing;
    const row = DIRECTIONS.indexOf(this.direction);
    return (
      animation.anchors[row * animation.frames + this.frame] ??
      animation.anchors[0]
    );
  }

  /** What it is showing right now: which animation, and which of its frames */
  public get showing(): { animation: CharacterAnimationName; frame: number } {
    return { animation: this.animation, frame: this.frame };
  }

  /** The cut as it currently stands. Read by the depth-key debug overlay. */
  public get slicing(): EntityColumnSlices | undefined {
    return this.slices;
  }

  /** What the cut is decided from: where it stands, how big, drawn where */
  public get shape(): EntityShape {
    const [anchorX, anchorY] = this.anchor;
    return {
      iso: this.globalIsoCoordinates,
      hitbox: this.hitbox,
      spriteWidth: this.spriteWidth,
      spriteHeight: this.spriteHeight,
      anchorX,
      anchorY,
    };
  }

  public get spriteWidth(): number {
    return this.animationTexture.frame.width;
  }

  public get spriteHeight(): number {
    return this.animationTexture.frame.height;
  }

  /**
   * Pick what to show: which animation the character is in, and which of its
   * frames.
   *
   * Three clocks: an attack and a stand run on the wall clock at the rhythm
   * their sheet was drawn at, a walk runs on the ground it covers so the feet
   * never slide, and a hop runs on the physics — each of its four poses held
   * for as long as the engine is in it.
   */
  public update(step: CharacterStep) {
    const previous = this.walkedFrom;
    const { s, e } = this.globalIsoCoordinates;
    this.walkedFrom = { s, e };
    const covered = previous ? Math.hypot(s - previous.s, e - previous.e) : 0;
    if (covered === 0) {
      // start the next departure on a step rather than mid-stride
      this.walked = 0;
    }
    this.walked += covered;
    if (covered > 0) {
      this.stillFor = 0;
      this.breaking = undefined;
    }

    this.attacking = step.attack
      ? this.lengthOf("attack")
      : Math.max(0, this.attacking - step.seconds);

    const airborne = !step.grounded;
    const landing = step.grounded && !this.wasGrounded;

    if (this.attacking > 0) {
      this.animation = "attack";
      this.frame = frameAtTicks(
        this.playing.durations,
        (this.lengthOf("attack") - this.attacking) / TICK
      );
    } else if (step.jumped || airborne || landing) {
      this.animation = "hop";
      this.frame = this.hopFrame(step, airborne);
    } else if (covered > 0) {
      this.animation = "walk";
      this.frame = frameAtTicks(
        this.playing.durations,
        this.walked / (NOMINAL_WALK_SPEED * TICK)
      );
    } else {
      this.standStill(step.seconds);
    }

    this.wasGrounded = step.grounded;
    this.grounded = step.grounded;
    this.animationTexture = this.textureOf();
  }

  /** How long an animation lasts played once: exactly as long as its sheet says */
  private lengthOf(name: CharacterAnimationName): number {
    const { durations } = animationOf(this.sprites, name);
    return durations.reduce((total, held) => total + held, 0) * TICK;
  }

  /**
   * Doing nothing: the resting frame of the walk cycle, and every IDLE_EVERY
   * seconds one run of the idle animation to break it.
   *
   * The counter only advances while the character is standing there, so walking
   * off and coming back postpones the next break rather than banking it, and a
   * character that never stops never plays one.
   */
  private standStill(seconds: number) {
    const idle = this.sprites.animations.idle;
    if (this.breaking !== undefined) {
      this.breaking += seconds;
      if (this.breaking >= this.lengthOf("idle")) this.breaking = undefined;
    } else {
      this.stillFor += seconds;
      if (idle && this.stillFor >= IDLE_EVERY) {
        this.breaking = 0;
        this.stillFor = 0;
      }
    }

    if (idle && this.breaking !== undefined) {
      this.animation = "idle";
      this.frame = frameAtTicks(idle.durations, this.breaking / TICK);
    } else {
      this.animation = "walk";
      this.frame = RESTING_FRAME;
    }
  }

  /**
   * Leaving the ground, rising, falling, landing — whichever the engine is in.
   * The sheet's ten frames are really four poses; the rest of the difference
   * between them was height, and the engine owns that.
   */
  private hopFrame(step: CharacterStep, airborne: boolean) {
    const [takeoff, rising, falling, touchdown] = this.playing.phases ?? [
      0, 0, 0, 0,
    ];
    if (step.jumped) return takeoff;
    if (!airborne) return touchdown;
    return this.verticalSpeed > 0 ? rising : falling;
  }

  /**
   * Whether the cut is out of date. It depends on where the character stands
   * and on where its sprite is put, which a change of frame can move on its
   * own: an attack travels inside its frame, and the anchor travels with it.
   */
  public get needsSlicing(): boolean {
    const { s, e, u } = this.globalIsoCoordinates;
    const [anchorX, anchorY] = this.anchor;
    const at = this.slicedAt;
    return (
      at === undefined ||
      at.s !== s ||
      at.e !== e ||
      at.u !== u ||
      at.width !== this.spriteWidth ||
      at.height !== this.spriteHeight ||
      at.anchorX !== anchorX ||
      at.anchorY !== anchorY
    );
  }

  public setSlices(slices: EntityColumnSlices) {
    const { s, e, u } = this.globalIsoCoordinates;
    const [anchorX, anchorY] = this.anchor;
    this.slicedAt = {
      s,
      e,
      u,
      width: this.spriteWidth,
      height: this.spriteHeight,
      anchorX,
      anchorY,
    };
    this.slices = slices;
  }

  /**
   * Draw the character as its current pieces, reusing the pooled meshes.
   *
   * Each piece asks `hostOf` where its own column is drawn: a character
   * straddling a chunk boundary has pieces on both sides of it, and each
   * belongs with the cells it has to sort against. Spare pieces are detached
   * rather than hidden, so nothing is kept alive by an invisible mesh.
   */
  public render(hostOf: (s: number, e: number) => Container) {
    const slices = this.slices;
    if (!slices) return;
    while (this.pieces.length < slices.pieces.length) {
      this.pieces.push(this.createPiece());
    }
    this.pieces.forEach((mesh, index) => {
      const piece = slices.pieces[index];
      if (piece) {
        this.showPiece(mesh, slices, piece, hostOf(piece.s, piece.e));
      } else {
        this.detach(mesh);
      }
    });
  }

  public destroy() {
    for (const piece of this.pieces) {
      this.detach(piece);
      const { geometry } = piece.mesh;
      // the texture is the atlas frame, not ours. The geometry is, and
      // Mesh.destroy only drops its reference to it: buffers and the GPU
      // allocations behind them would outlive the mesh.
      piece.mesh.destroy();
      geometry.destroy();
    }
    this.pieces = [];
  }

  private createPiece(): CharacterPiece {
    const geometry = new MeshGeometry({ shrinkBuffersToFit: false });
    // Left to itself Pixi batches a mesh of at most 100 vertices, and a piece is
    // one quad per row: 128 for a 32 pixel character. Unbatched, each piece
    // takes a draw call and splits its chunk's tile batch on its way past.
    geometry.batchMode = "batch";
    return { mesh: new Mesh({ geometry, texture: this.animationTexture }) };
  }

  /**
   * Fill a mesh with the runs of one piece, one quad per run.
   *
   * Positions are pixels from the sprite's top-left, UVs the same points in
   * [0, 1] over the animation frame — the texture's own matrix places that
   * frame in the atlas, so a frame change never touches the buffers.
   *
   * Sized once for the worst case — one run per row — and never resized: Pixi
   * rebuilds a render group's whole instruction set when a batched mesh's
   * vertex count changes. Spare quads collapse to a point.
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
