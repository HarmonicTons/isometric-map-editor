import { describe, expect, it } from "vitest";
import { constrainingCells, maxBands, sliceEntity } from "./EntityBands";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "./IsometricCoordinate";

const HITBOX = new IsoCoordinates(0.8, 0.8, 1.9);
const SPRITE_WIDTH = 23;
const SPRITE_HEIGHT = 32;
const CELL_WIDTH = 32;
const CELL_HEIGHT = 24;

const slice = (iso: GlobalIsoCoordinates) =>
  sliceEntity({
    iso,
    hitbox: HITBOX,
    spriteWidth: SPRITE_WIDTH,
    spriteHeight: SPRITE_HEIGHT,
  });

/**
 * Whether a cell's artwork paints the pixel at (column, row) of its 32×24
 * sprite: the hexagon inscribed in it, corners cut at the 2:1 slope. A pixel
 * counts as painted as soon as the hexagon covers part of it, which is how the
 * tile artwork rasterises — its bottom row is 4 pixels wide, not one.
 */
const cellPaints = (column: number, row: number) => {
  if (row < 0 || row >= CELL_HEIGHT) return false;
  const widest = Math.min(Math.max(CELL_HEIGHT / 3, row), row + 1);
  const from = Math.max(0, 16 - 2 * widest, 2 * widest - CELL_WIDTH);
  const to = Math.min(CELL_WIDTH, 2 * widest + 16, 64 - 2 * widest);
  return column >= from && column <= to - 1;
};

type Mistake = { iso: string; cell: string; pixel: string; expected: string };

/**
 * Which side of the entity a cell is on: slide the cell along the view ray
 * (1, 1, 2) and see over which range of t it overlaps the box. Reached only
 * after t = 0 and it is in front, only before and it is behind, across 0 and
 * they interpenetrate, never and they miss each other.
 *
 * The oracle below rests on this, so "the ground truth agrees with marching
 * the ray" is what says it is right — it is the same formula the code under
 * test uses, and a sign error in it would otherwise be mirrored in both.
 */
const sideOfCell = (s: number, e: number, u: number, { min, max }: IsoBox) => {
  const from = Math.max(s - max.s, e - max.e, (u - max.u) / 2);
  const to = Math.min(s + 1 - min.s, e + 1 - min.e, (u + 1 - min.u) / 2);
  if (from >= to) return "unrelated";
  if (from >= 0) return "front";
  if (to <= 0) return "behind";
  return "interpenetrating";
};

/**
 * Ground truth, derived from the geometry alone and never from the algorithm:
 * for every cell around the entity, which side of it the cell is on, and
 * whether the band covering each pixel that cell paints is drawn on that side.
 */
const orderMistakes = (iso: GlobalIsoCoordinates, radius = 6): Mistake[] => {
  const { x: left, y: top, bands } = slice(iso);
  const { min, max } = IsoBox.standingOn(iso, HITBOX);
  const keyOfRow = new Array<number>(SPRITE_HEIGHT);
  for (const band of bands) {
    for (let row = band.offsetY; row < band.offsetY + band.height; row++) {
      keyOfRow[row] = band.zIndex;
    }
  }

  const mistakes: Mistake[] = [];
  const originS = Math.floor(iso.s);
  const originE = Math.floor(iso.e);
  const originU = Math.floor(iso.u);
  const box = new IsoBox(min, max);
  for (let s = originS - radius; s <= originS + radius; s++) {
    for (let e = originE - radius; e <= originE + radius; e++) {
      for (let u = originU - 2 * radius; u <= originU + 2 * radius; u++) {
        if (u < 0) continue;
        const side = sideOfCell(s, e, u, box);
        // their silhouettes miss each other, or the entity stands in the cell,
        // which is then empty: nothing has to be ordered
        if (side === "unrelated" || side === "interpenetrating") continue;
        const isInFront = side === "front";
        const key = paintersOrderKey(s, e, u);
        const cellX = 16 * (e - s);
        const cellY = 8 * (e + s) - 8 * u;
        for (let row = 0; row < SPRITE_HEIGHT; row++) {
          for (let column = 0; column < SPRITE_WIDTH; column++) {
            if (!cellPaints(left + column - cellX, top + row - cellY)) continue;
            const drawnAfter = key > keyOfRow[row];
            if (drawnAfter === isInFront) continue;
            mistakes.push({
              iso: iso.toString(),
              cell: `${s},${e},${u}`,
              pixel: `${column},${row}`,
              expected: isInFront ? "after" : "before",
            });
          }
        }
      }
    }
  }
  return mistakes;
};

/** Positions well inside one chunk, so chunk order never enters the picture */
const sweep = (step: number, heights: number[] = [4]) => {
  const positions: GlobalIsoCoordinates[] = [];
  for (let s = 11; s < 13; s += step) {
    for (let e = 19; e < 21; e += step) {
      for (const u of heights) {
        positions.push(
          new GlobalIsoCoordinates(
            Math.round(s * 1000) / 1000,
            Math.round(e * 1000) / 1000,
            u
          )
        );
      }
    }
  }
  return positions;
};

describe("sliceEntity", () => {
  it("covers the sprite exactly once, top to bottom", () => {
    for (const iso of sweep(0.05)) {
      const { bands } = slice(iso);
      let row = 0;
      for (const band of bands) {
        expect(band.offsetY).toBe(row);
        expect(band.height).toBeGreaterThan(0);
        row += band.height;
      }
      expect(row).toBe(SPRITE_HEIGHT);
    }
  });

  it("puts every pixel in the right place in the draw order", () => {
    const mistakes = sweep(0.05).flatMap((iso) => orderMistakes(iso));
    expect(mistakes.slice(0, 5)).toEqual([]);
  });

  it("holds at fractional heights, mid-jump", () => {
    const mistakes = sweep(0.1, [4.3, 4.5, 4.75]).flatMap((iso) =>
      orderMistakes(iso)
    );
    expect(mistakes.slice(0, 5)).toEqual([]);
  });

  it("holds at positions that fall between pixels", () => {
    const positions = Array.from(
      { length: 400 },
      (_, index) =>
        new GlobalIsoCoordinates(
          11 + (index * 0.0137) ** 1.3,
          19.4813 + index * 0.00791,
          4
        )
    );
    const mistakes = positions.flatMap((iso) => orderMistakes(iso));
    expect(mistakes.slice(0, 5)).toEqual([]);
  });

  it("looks no further than it has to", () => {
    // the ground truth above uses radius 6; a much larger one must agree
    for (const iso of sweep(0.25)) {
      expect(orderMistakes(iso, 14).slice(0, 5)).toEqual([]);
    }
  });

  it("agrees with marching the view ray", () => {
    // What makes the oracle above worth anything. It shares its occlusion
    // formula with the code under test, so a sign error in it would be
    // mirrored in both and every other test here would still pass. This one
    // answers the same question by brute force: slide the cell along the ray
    // in small steps and record where it actually meets the box.
    const box = IsoBox.standingOn(
      new GlobalIsoCoordinates(11.3, 19.7, 4),
      HITBOX
    );
    const STEP = 1 / 512;
    let checked = 0;
    for (let s = 8; s <= 14; s++) {
      for (let e = 17; e <= 23; e++) {
        for (let u = 0; u <= 10; u++) {
          let first: number | undefined;
          let last = 0;
          for (let t = -12; t <= 12; t += STEP) {
            // the box slides, the cell stays: t is how far along the ray the
            // entity has to travel to reach it, so a positive t means the cell
            // is ahead of it
            const meets =
              box.min.s + t < s + 1 &&
              box.max.s + t > s &&
              box.min.e + t < e + 1 &&
              box.max.e + t > e &&
              box.min.u + 2 * t < u + 1 &&
              box.max.u + 2 * t > u;
            if (!meets) continue;
            if (first === undefined) first = t;
            last = t;
          }
          const marched =
            first === undefined
              ? "unrelated"
              : first > 0
                ? "front"
                : last < 0
                  ? "behind"
                  : "interpenetrating";
          // a cell whose range starts or ends within one step of zero is the
          // sampling's own ambiguity, not a disagreement
          if (
            first !== undefined &&
            (Math.abs(first) < STEP || Math.abs(last) < STEP)
          ) {
            continue;
          }
          checked++;
          expect({
            cell: `${s},${e},${u}`,
            side: sideOfCell(s, e, u, box),
          }).toEqual({
            cell: `${s},${e},${u}`,
            side: marched,
          });
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it("cuts as little as the keys allow", () => {
    // A band starts at the top of the sprite or on a row of the lattice, so a
    // 32px sprite can never need more than maxBands of them. In practice it
    // needs far fewer, because each band takes the highest key its window
    // allows and so survives into the bands below.
    const counts = sweep(0.02).map((iso) => slice(iso).bands.length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(maxBands(SPRITE_HEIGHT));
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    // measured 1.93 here, 1.68 over a sweep that also varies the height
    expect(mean).toBeLessThan(2);
  });

  it("depends on where the entity stands inside its cell, not on which cell", () => {
    // Moving by whole cells shifts every key by that move's own key and leaves
    // the bands where they are. The cut is a function of the fractional part
    // of the position alone — which is why sweeping two cells' worth of
    // positions covers every case there is.
    let checked = 0;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        for (const fu of [0, 0.4]) {
          const here = slice(
            new GlobalIsoCoordinates(11 + a / 12, 19 + b / 12, 4 + fu)
          );
          for (const [ds, de, du] of [
            [1, 0, 0],
            [0, 1, 0],
            [5, -4, 0],
            [0, 0, 3],
            [-3, 7, -2],
            [40, 40, 10],
          ]) {
            const there = slice(
              new GlobalIsoCoordinates(
                11 + ds + a / 12,
                19 + de + b / 12,
                4 + du + fu
              )
            );
            const offset = paintersOrderKey(ds, de, du);
            expect(
              there.bands.map((band) => ({
                ...band,
                zIndex: band.zIndex - offset,
              }))
            ).toEqual(here.bands);
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(1728);
  });

  it("is never constrained by a cell more than two cells away", () => {
    // What decides how wide the container that keeps the order exact has to
    // be: everything in here is drawn alongside the entity, so it can never be
    // left in a chunk of its own. Map.BLOCK_SIDE is sized against this.
    let furthest = 0;
    for (const iso of sweep(1 / 12)) {
      for (const cell of constrainingCells({
        iso,
        hitbox: HITBOX,
        spriteWidth: SPRITE_WIDTH,
        spriteHeight: SPRITE_HEIGHT,
      })) {
        furthest = Math.max(
          furthest,
          Math.abs(cell.s - Math.floor(iso.s)),
          Math.abs(cell.e - Math.floor(iso.e))
        );
      }
    }
    expect(furthest).toBe(2);
  });
});
