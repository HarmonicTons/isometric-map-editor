import { Container, Mesh, MeshGeometry, Texture, Ticker } from "pixi.js";
import { GlobalIsoCoordinates, IsoCoordinates } from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";
import type { EntityBand, EntitySlices } from "./EntityBands";
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
 * approximation; EntityBands.test.ts measures how much that is.
 */
const CHARACTER_HITBOX = new IsoCoordinates(0.8, 0.8, 1.9);

/**
 * Most pieces a character can be cut into: a band boundary only ever falls on
 * the 8-pixel screen lattice, so a 32-pixel sprite crosses four of them and can
 * never need a fifth band. Nothing breaks past it — the pool just grows — but a
 * taller sprite is worth knowing about, because every piece is a mesh kept for
 * the lifetime of the character.
 */
const EXPECTED_MAX_PIECES = 4;

/**
 * DEBUG — one tint per band while the depth order overlay is on, so where and
 * when the sprite is cut is visible at a glance. See DebugView.
 */
const PIECE_TINTS = [0xff6b6b, 0x6bc8ff, 0xffd76b, 0x8cff8c];

/**
 * One piece of the character's sprite: one horizontal band of it, drawn at its
 * own depth key.
 *
 * A mesh rather than a sprite so that the band can be a sub-rectangle of the
 * animation frame without allocating a texture for it. They are pooled, buffers
 * included: only their contents, position and depth ever change.
 */
type CharacterPiece = {
  mesh: Mesh<MeshGeometry>;
};

/**
 * A character on the map.
 *
 * Unlike tiles and objects, a character stands at fractional coordinates and
 * straddles cells, so no single depth key is right for its whole sprite. It is
 * therefore not a display object itself: it owns a handful of meshes, one per
 * band of the cut, all drawn in the live block around it. See EntityBands.
 */
export class Character {
  public readonly type: CharacterType;
  /** What it occupies, for collision and for depth order alike */
  public readonly hitbox = CHARACTER_HITBOX;
  public globalIsoCoordinates: GlobalIsoCoordinates;
  public state: CharacterState;
  public direction: CharacterDirection;

  /** Animation frame currently displayed, as found in the atlas */
  private animationTexture: Texture;
  private pieces: CharacterPiece[] = [];
  private slices?: EntitySlices;
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

  /** How many bands it is currently cut into */
  public get bandCount(): number {
    return this.slices?.bands.length ?? 0;
  }

  /** The cut as it currently stands. Read by the depth-key debug overlay. */
  public get slicing(): EntitySlices | undefined {
    return this.slices;
  }

  public get spriteWidth(): number {
    return this.animationTexture.frame.width;
  }

  public get spriteHeight(): number {
    return this.animationTexture.frame.height;
  }

  public update(time: Ticker) {
    const animationFrameIndex = Math.floor(time.lastTime / 250) % 4;
    const animationFrame = [1, 2, 3, 2][animationFrameIndex];
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

  public setSlices(slices: EntitySlices) {
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
   * Draw the character as its current bands, all in `host`, reusing the pooled
   * meshes. Bands beyond what is needed are detached rather than hidden, so
   * that nothing is kept alive by an invisible mesh.
   */
  public render(host: Container) {
    const slices = this.slices;
    if (!slices) return;
    while (this.pieces.length < slices.bands.length) {
      if (this.pieces.length === EXPECTED_MAX_PIECES) {
        console.warn(
          `Character ${this.type} needs more than ${EXPECTED_MAX_PIECES} bands at ${this.globalIsoCoordinates.toString()}`
        );
      }
      this.pieces.push(this.createPiece());
    }
    this.pieces.forEach((piece, index) => {
      const band = slices.bands[index];
      if (band) {
        this.showPiece(piece, slices, band, host, index);
      } else {
        this.detach(piece);
      }
    });
  }

  public destroy() {
    for (const piece of this.pieces) {
      this.detach(piece);
      // the texture is the shared animation frame from the atlas: not ours
      piece.mesh.destroy();
    }
    this.pieces = [];
  }

  private createPiece(): CharacterPiece {
    return {
      mesh: new Mesh({
        geometry: new MeshGeometry({ shrinkBuffersToFit: false }),
        texture: this.animationTexture,
      }),
    };
  }

  /**
   * Fill a piece's mesh with the quad of its band.
   *
   * Positions are pixels from the sprite's top-left, UVs the same points in
   * [0, 1] over the animation frame — the texture's own matrix takes care of
   * where that frame sits in the atlas, so a frame change is one assignment
   * and never touches the buffers.
   */
  private fillGeometry(piece: CharacterPiece, band: EntityBand) {
    const { geometry } = piece.mesh;
    if (geometry.indices.length !== 6) {
      geometry.positions = new Float32Array(8);
      geometry.uvs = new Float32Array(8);
      geometry.indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    }
    const top = band.offsetY;
    const bottom = top + band.height;
    const right = this.spriteWidth;
    const height = this.spriteHeight;
    // top-left, top-right, bottom-right, bottom-left
    geometry.positions.set([0, top, right, top, right, bottom, 0, bottom]);
    geometry.uvs.set([
      0,
      top / height,
      1,
      top / height,
      1,
      bottom / height,
      0,
      bottom / height,
    ]);
    geometry.getBuffer("aPosition").update();
    geometry.getBuffer("aUV").update();
    geometry.indexBuffer.update();
  }

  private showPiece(
    piece: CharacterPiece,
    slices: EntitySlices,
    band: EntityBand,
    host: Container,
    index: number
  ) {
    if (piece.mesh.texture !== this.animationTexture) {
      piece.mesh.texture = this.animationTexture;
    }
    piece.mesh.tint = debugViewEnabled()
      ? PIECE_TINTS[index % PIECE_TINTS.length]
      : 0xffffff;
    this.fillGeometry(piece, band);

    // re-adding an existing child moves it to the end of the list every frame
    if (piece.mesh.parent !== host) host.addChild(piece.mesh);
    piece.mesh.x = slices.x;
    piece.mesh.y = slices.y;
    piece.mesh.zIndex = band.zIndex;
  }

  private detach(piece: CharacterPiece) {
    piece.mesh.parent?.removeChild(piece.mesh);
  }
}
