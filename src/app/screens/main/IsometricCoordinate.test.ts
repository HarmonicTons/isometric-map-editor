import { describe, expect, it } from "vitest";
import {
  GlobalIsoCoordinates,
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
