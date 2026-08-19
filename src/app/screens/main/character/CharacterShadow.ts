import { Container, Graphics } from "pixi.js";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "../iso/IsometricCoordinate";
import { paintRuns, ShadowRun, shadowRuns } from "../iso/Shadows";

/**
 * The dark disc a character drops on whatever is under it. One per character,
 * owned by it and destroyed with it; the map comes in as two callbacks.
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
   * The disc it is cast from, in cells: inside the footprint, and on whole
   * pixels like the sprite, so it does not shimmer under it.
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
   * keyed a quarter above the cell it lies on. One key for the whole shadow
   * would lift the pieces that fell into a hole over the tiles hiding them.
   */
  public sync(
    iso: GlobalIsoCoordinates,
    hitbox: IsoCoordinates,
    ground: Ground
  ) {
    const { radius, centre } = CharacterShadow.disc(iso, hitbox);
    // the cells of the HITBOX, which always have a chunk to be drawn in; the
    // disc lies inside them, and the ones it misses paint no run anyway
    const cells = IsoBox.standingOn(iso, hitbox).cells();

    let used = 0;
    for (let cs = cells.min.s; cs < cells.max.s; cs++) {
      for (let ce = cells.min.e; ce < cells.max.e; ce++) {
        const level = ground.levelUnder(cs, ce, iso.u);
        if (level === undefined) continue;
        const runs = shadowRuns(cs, ce, centre, radius);
        if (runs.length === 0) continue;
        // over the cell it lies on, under the character's own pieces
        this.paint(used++, ground.hostOver(cs, ce), runs, {
          at: new GlobalIsoCoordinates(cs, ce, level).toXY(),
          zIndex: paintersOrderKey(cs, ce, level) + 0.25,
        });
      }
    }
    this.putAwayFrom(used);
  }

  /**
   * Fill one pooled piece with `runs`, and only when they changed — Pixi
   * rebuilds a whole render group as soon as one Graphics in it reports one.
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

  /** Detach the pieces this frame had no use for, so their chunk can go */
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
