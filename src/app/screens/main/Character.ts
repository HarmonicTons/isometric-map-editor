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
import {
  DIRECTIONS,
  animationOf,
  characterSprites,
  directionRow,
} from "./characterSprites";
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
 * The walking speed the sheets are drawn for, in cells per second.
 *
 * A sheet says how long it holds each of its frames, and those durations are
 * the rhythm the walk cycle was drawn at. Tying the two together here is what
 * lets the cadence follow the ground covered — half speed, half cadence, feet
 * that never slide — and still come out at the drawn rhythm at full stick.
 * Map walks the character at exactly this.
 */
export const NOMINAL_WALK_SPEED = 3;

/** A tick of the durations in the sheets, in seconds */
const TICK = 1 / 60;

/**
 * How long a character stands doing nothing before it plays its idle animation,
 * in seconds.
 *
 * The idle sheet is a stretch and a yawn, not a way of standing: looped it
 * would be a character fidgeting without pause. Played once now and then it is
 * what it was drawn for, a break in the stillness. Between two of them the
 * character holds the first frame of its walk cycle, which IS its way of
 * standing.
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
 * The sheet's rows are 45° apart on SCREEN, and our axes are not: `e` alone is
 * down and to the right, `s` and `e` together are straight down. Projecting the
 * movement and taking the angle there is what puts a heading in the row that
 * actually faces that way — comparing s against e instead would hand the four
 * diagonals of the screen to the four axes and turn the character 22.5° wrong.
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
 * paint that luminance back in the column's colour.
 *
 * `mesh.tint` cannot — it MULTIPLIES, so an all-red character stays red under
 * all four colours and black under three — and it has to be ONE matrix rather
 * than a desaturation over a tint, since a filter runs on what the mesh already
 * rendered, tint included.
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

const filterOf = (piece: EntityColumnPiece): ColorMatrixFilter | undefined => {
  // Building one compiles a shader, and that wants a canvas. There is none in
  // node, where a test may still turn the overlay on to look at the rest of
  // what it draws — the colours are the one part of it a headless run cannot
  // see anyway.
  if (typeof document === "undefined") return undefined;
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
 * one mesh per column it stands over, drawn in the live block. See
 * EntityColumns.
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
    const animation = this.playing;
    const key = `${this.type}_${animation.key}-${this.direction}${this.frame + 1}.png`;
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
    const row = directionRow(this.sprites, this.direction);
    return (
      animation.anchors[row * animation.frames + this.frame] ??
      animation.anchors[0]
    );
  }

  /** How many pieces it is currently cut into */
  public get pieceCount(): number {
    return this.slices?.pieces.length ?? 0;
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
   * Three clocks, because the three animations are paced by different things.
   * An attack and a stand run on the wall clock, at the rhythm their sheet was
   * drawn at. A walk runs on the ground it covers, so that half speed is half
   * cadence and the feet never slide — NOMINAL_WALK_SPEED is what turns the
   * sheet's durations into a distance. A hop runs on the physics: the sheet
   * draws its own rise and fall, and the engine's are the ones that count, so
   * each of its four poses is held for as long as the engine is in it.
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
      this.frame = this.hopFrame(step, airborne, landing);
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
   *
   * Takeoff and landing are one frame each, as they are the instants they
   * describe. What is left of the sheet's ten frames is two poses, which is all
   * it ever drew: the rest of the difference between them was height, and the
   * engine owns that.
   */
  private hopFrame(step: CharacterStep, airborne: boolean, landing: boolean) {
    const animation = this.playing;
    const [takeoff, rising, falling, touchdown] = animation.phases ?? [
      0, 0, 0, 0,
    ];
    if (step.jumped) return takeoff;
    if (landing) return touchdown;
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
    // takes a draw call and splits the live block's tile batch on its way past.
    // Asking also puts MeshPipe.validateRenderable back on the branch that
    // compares buffer sizes, which is what makes fillGeometry's fixed sizing
    // worth anything.
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
   * Sized once for the worst case and never resized: a piece holds at most one
   * run per row of the sprite, since along a row the column it stands over only
   * moves one way. That matters because Pixi rebuilds a render group's whole
   * instruction set when a batched mesh's vertex count changes, and the count
   * would otherwise follow the character around pixel by pixel. Spare quads
   * collapse to a point and rasterize nothing.
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
