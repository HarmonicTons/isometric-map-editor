import { Container, Graphics } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "../iso/IsometricCoordinate";
import { paintRuns, ShadowRun, shadowRuns } from "../iso/Shadows";

/**
 * The dark disc a character drops on whatever is under it.
 *
 * One of these per character, owned by it and destroyed with it: the pool below
 * is indexed by that character's own ground cells, so sharing one between two
 * of them would mean juggling offsets into it.
 *
 * What it needs of the map it takes as two callbacks, so it knows nothing of
 * chunks or tiles.
 */
export type Ground = {
  /** The highest solid level strictly below `u` in the column, if any */
  levelUnder(s: number, e: number, u: number): number | undefined;
  /** Where anything standing over the column (s, e) is drawn */
  hostOver(s: number, e: number): Container;
};

export class CharacterShadow {
  private pieces: Graphics[] = [];
  /** What each piece above holds, so that it is drawn only when it moves */
  private shapes: string[] = [];

  /**
   * The disc it is cast from, in cells.
   *
   * INSIDE the footprint, so the shadow stays on cells that can never be drawn
   * in front of the character — a wider one puts dark pixels on its feet. On
   * whole pixels, like the sprite, or it shimmers under it: what is rounded is
   * the projection, then inverted back.
   */
  private static disc(iso: GlobalIsoCoordinates, hitbox: IsoCoordinates) {
    const across = Math.round(16 * (iso.e - iso.s)) / 16;
    const along = Math.round(8 * (iso.e + iso.s)) / 8;
    return {
      radius: Math.min(hitbox.s, hitbox.e) / 2,
      centre: {
        s: (along - across) / 2 + 0.5,
        e: (along + across) / 2 + 0.5,
      },
    };
  }

  /**
   * Lay it on the ground below the character, one piece per ground cell, each
   * a quarter above the cell it lies on.
   *
   * One key for the whole shadow lifts the pieces lying on cells behind — the
   * ones a character standing on an edge drops into the hole beside it — over
   * the tile and the character that ought to hide them.
   */
  public sync(
    iso: GlobalIsoCoordinates,
    hitbox: IsoCoordinates,
    ground: Ground
  ) {
    const { radius, centre } = CharacterShadow.disc(iso, hitbox);
    // Over the cells of the HITBOX, not those of the disc: the disc lies
    // inside the footprint, so nothing is lost, and this is the range that is
    // certainly inside the map — floor(centre + radius) picks up the cell past
    // a box standing flush against a boundary. Cells the disc misses drop out
    // on their own, with no run to paint.
    const cells = IsoBox.standingOn(iso, hitbox).cells();

    let used = 0;
    for (let cs = cells.min.s; cs < cells.max.s; cs++) {
      for (let ce = cells.min.e; ce < cells.max.e; ce++) {
        const level = ground.levelUnder(cs, ce, iso.u);
        if (level === undefined) continue;
        const runs = shadowRuns(cs, ce, centre, radius);
        if (runs.length === 0) continue;
        // over the cell it lies on and under the character, whose pieces are
        // keyed a level higher plus a fraction (EntityColumns.subCellKey)
        this.paint(used++, ground.hostOver(cs, ce), runs, {
          at: new GlobalIsoCoordinates(cs, ce, level).toXY(),
          zIndex: paintersOrderKey(cs, ce, level) + 0.25,
        });
      }
    }
    this.putAwayFrom(used);
  }

  /**
   * Fill one pooled piece with `runs`, and only when they changed.
   *
   * The guard is not an optimisation: Pixi rebuilds a whole render group's draw
   * instructions as soon as one Graphics in it reports a change, so redrawing
   * an unmoved shadow costs its chunk's entire instruction set every frame.
   */
  private paint(
    index: number,
    host: Container,
    runs: ShadowRun[],
    where: { at: { x: number; y: number }; zIndex: number }
  ) {
    const piece = (this.pieces[index] ??= new Graphics({ eventMode: "none" }));
    if (piece.parent !== host) host.addChild(piece);
    piece.x = where.at.x;
    piece.y = where.at.y;
    piece.zIndex = where.zIndex;
    const shape = runs.map((run) => `${run.x},${run.y},${run.width}`).join(";");
    if (this.shapes[index] === shape) return;
    this.shapes[index] = shape;
    paintRuns(piece, runs);
  }

  /**
   * Put away the pieces this frame had no use for. Detached and not merely
   * cleared: one left behind would keep its chunk from ever being destroyed.
   */
  private putAwayFrom(index: number) {
    for (let spare = index; spare < this.pieces.length; spare++) {
      const piece = this.pieces[spare];
      piece.parent?.removeChild(piece);
      if (this.shapes[spare] === "") continue;
      this.shapes[spare] = "";
      piece.clear();
    }
  }

  public destroy() {
    for (const piece of this.pieces) piece.destroy();
    this.pieces = [];
    this.shapes = [];
  }
}
