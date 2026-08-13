import { describe, expect, it } from "vitest";
import { constrainingCells, sliceEntity } from "./EntityBands";
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
  for (let s = originS - radius; s <= originS + radius; s++) {
    for (let e = originE - radius; e <= originE + radius; e++) {
      for (let u = originU - 2 * radius; u <= originU + 2 * radius; u++) {
        if (u < 0) continue;
        const from = Math.max(s - max.s, e - max.e, (u - max.u) / 2);
        const to = Math.min(s + 1 - min.s, e + 1 - min.e, (u + 1 - min.u) / 2);
        // their silhouettes miss each other, or the entity stands in the cell,
        // which is then empty: nothing has to be ordered
        if (from >= to || (from < 0 && to > 0)) continue;
        const isInFront = from >= 0;
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

  it("only ever cuts on the 8-pixel screen lattice", () => {
    // Cells are drawn 8 pixels apart in y, so that lattice is the only place
    // where which cell is nearest can change. This is what lets the cut be
    // deduced from the entity's position instead of searched for.
    for (const iso of sweep(0.02)) {
      const { y: top, bands } = slice(iso);
      for (const band of bands.slice(1)) {
        expect((top + band.offsetY) % 8).toBe(0);
      }
    }
  });

  it("cuts as little as the keys allow", () => {
    // The sprite is 32px tall and a level is 8px, so it crosses at most four
    // rows of the lattice and can never need more than four bands. In practice
    // it needs far fewer, because each band takes the highest key its window
    // allows and so survives into the bands below.
    const counts = sweep(0.02).map((iso) => slice(iso).bands.length);
    expect(Math.max(...counts)).toBeLessThanOrEqual(4);
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
