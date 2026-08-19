import { describe, expect, it } from "vitest";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  LocalIsoCoordinates,
} from "./IsometricCoordinate";

describe("IsoCoordinates", () => {
  describe("toXY (isometric projection)", () => {
    it("projects the origin to 0,0", () => {
      expect(new IsoCoordinates(0, 0, 0).toXY()).toEqual({ x: 0, y: 0 });
    });

    it("moves east down-right and south down-left", () => {
      expect(new IsoCoordinates(0, 1, 0).toXY()).toEqual({ x: 16, y: 8 });
      expect(new IsoCoordinates(1, 0, 0).toXY()).toEqual({ x: -16, y: 8 });
    });

    it("moves up 8px toward the top of the screen", () => {
      expect(new IsoCoordinates(0, 0, 1).toXY()).toEqual({ x: 0, y: -8 });
    });

    it("projects cells along the view ray (1,1,2) to the same point", () => {
      const cell = new IsoCoordinates(3, 5, 2);
      const behind = new IsoCoordinates(4, 6, 4);
      expect(cell.toXY()).toEqual(behind.toXY());
    });
  });

  describe("paintersOrderKey", () => {
    /**
     * Which of two cells hides the other, by the interval test along the view
     * ray (1, 1, 2): the second is reached from the first for t in [from, to).
     * Distinct unit cells are disjoint, so this is never ambiguous.
     */
    const occlusion = (ds: number, de: number, du: number) => {
      const from = Math.max(ds - 1, de - 1, (du - 1) / 2);
      const to = Math.min(ds + 1, de + 1, (du + 1) / 2);
      if (from >= to) return "unrelated";
      return from >= 0 ? "front" : "behind";
    };

    it("gives the higher key to whichever cell hides the other", () => {
      for (let ds = -6; ds <= 6; ds++) {
        for (let de = -6; de <= 6; de++) {
          for (let du = -12; du <= 12; du++) {
            if (occlusion(ds, de, du) !== "front") continue;
            const behind = new GlobalIsoCoordinates(8, 8, 8);
            const front = behind.add(new IsoCoordinates(ds, de, du));
            expect(front.paintersOrderKey()).toBeGreaterThan(
              behind.paintersOrderKey()
            );
          }
        }
      }
    });

    it("orders by height within the same diagonal", () => {
      const low = new GlobalIsoCoordinates(2, 3, 1);
      const high = new GlobalIsoCoordinates(3, 2, 2);
      expect(high.paintersOrderKey()).toBeGreaterThan(low.paintersOrderKey());
    });

    it("is counted from the map origin, not from any chunk", () => {
      // keying a cell on its chunk-local coordinates once made characters draw
      // over the tiles in front of them
      const here = new GlobalIsoCoordinates(3, 15, 9);
      const shifted = new GlobalIsoCoordinates(3 + 8, 15 + 8, 9);
      expect(shifted.paintersOrderKey()).not.toBe(here.paintersOrderKey());
    });
  });

  describe("move / add", () => {
    it("applies direction offsets", () => {
      const iso = new IsoCoordinates(1, 2, 3);
      expect(iso.move("up")).toEqual(new IsoCoordinates(1, 2, 4));
      expect(iso.move("south")).toEqual(new IsoCoordinates(2, 2, 3));
      expect(iso.move("east")).toEqual(new IsoCoordinates(1, 3, 3));
      expect(iso.move("north").move("west").move("down")).toEqual(
        new IsoCoordinates(0, 1, 2)
      );
    });

    it("preserves the coordinate brand (class)", () => {
      const global = new GlobalIsoCoordinates(0, 0, 0);
      const local = new LocalIsoCoordinates(0, 0, 0);
      expect(global.move("up")).toBeInstanceOf(GlobalIsoCoordinates);
      expect(local.add(new IsoCoordinates(1, 1, 1))).toBeInstanceOf(
        LocalIsoCoordinates
      );
    });
  });

  describe("toString / fromString", () => {
    it("round-trips, including negative coordinates", () => {
      const iso = new GlobalIsoCoordinates(-3, 12, 0);
      const back = GlobalIsoCoordinates.fromString(iso.toString());
      expect(back.equals(iso)).toBe(true);
      expect(back).toBeInstanceOf(GlobalIsoCoordinates);
    });
  });

  describe("equals", () => {
    it("compares by value and tolerates undefined", () => {
      const iso = new IsoCoordinates(1, 2, 3);
      expect(iso.equals(new IsoCoordinates(1, 2, 3))).toBe(true);
      expect(iso.equals(new IsoCoordinates(1, 2, 4))).toBe(false);
      expect(iso.equals(undefined)).toBe(false);
    });
  });
});

describe("IsoBox", () => {
  const boxAt = (s: number) =>
    new IsoBox(
      new IsoCoordinates(s, 0, 0),
      new IsoCoordinates(s + 0.9, 0.9, 1.9)
    );

  describe("standingOn", () => {
    const size = (v: number) => new IsoCoordinates(v, v, 1);
    const cell = new GlobalIsoCoordinates(3, 5, 2);

    it("shares the slack between both sides of the cell", () => {
      // otherwise an entity narrower than a cell walks into a wall coming
      // from the north but pushes into it coming from the south
      for (const width of [0.1, 0.5, 0.8, 1]) {
        const box = IsoBox.standingOn(cell, size(width));
        expect(box.min.s - cell.s).toBeCloseTo(cell.s + 1 - box.max.s);
        expect(box.min.e - cell.e).toBeCloseTo(cell.e + 1 - box.max.e);
      }
    });

    it("keeps its feet on the floor of the cell", () => {
      const box = IsoBox.standingOn(cell, size(0.1));
      expect(box.min.u).toBe(cell.u);
      expect(box.max.u).toBe(cell.u + 1);
    });

    it("fills the cell exactly at full size", () => {
      const box = IsoBox.standingOn(cell, new IsoCoordinates(1, 1, 1));
      expect(box.min).toEqual(cell);
      expect(box.max).toEqual(new GlobalIsoCoordinates(4, 6, 3));
    });

    it("preserves the coordinate brand", () => {
      const box = IsoBox.standingOn(cell, size(0.5));
      expect(box.min).toBeInstanceOf(GlobalIsoCoordinates);
    });
  });

  describe("cellRange", () => {
    it("covers the single cell a box sits inside", () => {
      expect(boxAt(3).cellRange("s")).toEqual([3, 3]);
    });

    it("covers both cells a box straddles", () => {
      expect(boxAt(3.4).cellRange("s")).toEqual([3, 4]);
      expect(boxAt(3.9).cellRange("s")).toEqual([3, 4]);
    });

    it("excludes the cell beyond a max landing exactly on a boundary", () => {
      // a character flush against a wall at s=5 must not overlap the wall,
      // otherwise it cannot move along it
      expect(boxAt(4.1).cellRange("s")).toEqual([4, 4]);
    });

    it("ignores the error of adding fractions together", () => {
      // standingOn adds the slack then the size, so a face that should land on
      // a whole number lands a few 1e-16 past it. Without a tolerance the same
      // entity occupies a different number of cells depending on where it
      // stands, which changes its collisions and the way its sprite is cut.
      const hitbox = new IsoCoordinates(0.8, 0.8, 1.9);
      for (const cell of [11, 12, 16, 40, 137, -9]) {
        const box = IsoBox.standingOn(
          new GlobalIsoCoordinates(cell + 0.1, cell + 0.2, 4),
          hitbox
        );
        expect(box.cellRange("s")).toEqual([cell, cell]);
      }
    });

    it("handles negative coordinates", () => {
      expect(boxAt(-0.5).cellRange("s")).toEqual([-1, 0]);
      expect(boxAt(-0.9).cellRange("s")).toEqual([-1, -1]);
    });

    it("keeps the cell of a zero-width box", () => {
      const point = new IsoCoordinates(4, 4, 4);
      expect(new IsoBox(point, point).cellRange("u")).toEqual([4, 4]);
    });

    it("spans several cells on the tall axis", () => {
      expect(boxAt(0).cellRange("u")).toEqual([0, 1]);
    });
  });
});
