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
    const uMax = 256;

    it("orders by diagonal (s+e) first", () => {
      const back = new IsoCoordinates(0, 0, 255);
      const front = new IsoCoordinates(1, 0, 0);
      expect(front.paintersOrderKey(uMax)).toBeGreaterThan(
        back.paintersOrderKey(uMax)
      );
    });

    it("orders by height within the same diagonal", () => {
      const low = new IsoCoordinates(2, 3, 1);
      const high = new IsoCoordinates(3, 2, 2);
      expect(high.paintersOrderKey(uMax)).toBeGreaterThan(
        low.paintersOrderKey(uMax)
      );
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

describe("billboardPaintersOrderKey", () => {
  const uMax = 256;
  // a character standing at u=1 on flat ground, straddling cells 4 and 5
  const character = new IsoCoordinates(4.1, 3.4, 1);
  const key = character.billboardPaintersOrderKey(uMax);
  const tile = (s: number, e: number, u: number) =>
    new IsoCoordinates(s, e, u).paintersOrderKey(uMax);

  it("draws after the ground of the row in front, which would clip its legs", () => {
    expect(key).toBeGreaterThan(tile(5, 3, 0));
    expect(key).toBeGreaterThan(tile(4, 4, 0));
  });

  it("draws after the ground it stands on", () => {
    expect(key).toBeGreaterThan(tile(4, 3, 0));
  });

  it("draws before what stands in the row in front at its own height", () => {
    expect(key).toBeLessThan(tile(5, 3, 1));
    expect(key).toBeLessThan(tile(4, 4, 1));
  });

  it("never ties with a tile", () => {
    for (let s = 4; s < 5; s += 0.1) {
      for (let u = 0; u <= 3; u++) {
        const billboard = new IsoCoordinates(s, 3, 1).billboardPaintersOrderKey(
          uMax
        );
        expect(billboard).not.toBe(tile(Math.round(s), 3, u));
      }
    }
  });
});

describe("IsoBox", () => {
  const boxAt = (s: number) =>
    IsoBox.fromOriginAndSize(
      new IsoCoordinates(s, 0, 0),
      new IsoCoordinates(0.9, 0.9, 1.9)
    );

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
