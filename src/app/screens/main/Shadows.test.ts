import { describe, expect, it } from "vitest";
import { shadowRuns, TOP_FACE_RUNS } from "./Shadows";

/** The shadow of a character 0.8 cells wide, in the middle of the cell (4, 4) */
const FOOTPRINT = 0.8 / 2;
const MIDDLE = { s: 4.5, e: 4.5 };

/** Every pixel of the shadow on one cell, in that cell's own sprite */
const shadowPixels = (
  cs: number,
  ce: number,
  centre = MIDDLE,
  radius = FOOTPRINT
) =>
  shadowRuns(cs, ce, centre, radius).flatMap((run) =>
    Array.from({ length: run.width }, (_unused, step) => ({
      x: run.x + step,
      y: run.y,
    }))
  );

/** How many pixels the whole shadow paints, over every cell it reaches */
const paintedBy = (centre: { s: number; e: number }, radius = FOOTPRINT) => {
  let total = 0;
  for (let cs = Math.floor(centre.s - radius); cs <= centre.s + radius; cs++) {
    for (
      let ce = Math.floor(centre.e - radius);
      ce <= centre.e + radius;
      ce++
    ) {
      total += shadowPixels(cs, ce, centre, radius).length;
    }
  }
  return total;
};

describe("shadowRuns", () => {
  it("paints whole pixels of the game's grid", () => {
    // The point of reading the ground pixel by pixel: at any zoom the shadow
    // has to be as chunky as the tile it lies on, which a smooth ellipse
    // never is.
    for (const run of shadowRuns(4, 4, MIDDLE, FOOTPRINT)) {
      expect(Number.isInteger(run.x)).toBe(true);
      expect(Number.isInteger(run.y)).toBe(true);
      expect(Number.isInteger(run.width)).toBe(true);
      expect(run.width).toBeGreaterThan(0);
    }
  });

  it("paints the projection of a disc on the ground", () => {
    // Judged against the geometry rather than against itself: a disc of radius
    // r cells projects to an ellipse of semi-axes 16√2 r and 8√2 r pixels, so
    // it spans 32√2 r across and covers 256 π r².
    const xs = shadowPixels(4, 4).map((pixel) => pixel.x);
    expect(Math.max(...xs) - Math.min(...xs) + 1).toBe(
      Math.round(32 * Math.SQRT2 * FOOTPRINT)
    );
    const area = 256 * Math.PI * FOOTPRINT * FOOTPRINT;
    expect(paintedBy(MIDDLE)).toBeGreaterThan(area * 0.9);
    expect(paintedBy(MIDDLE)).toBeLessThan(area * 1.1);
  });

  it("paints nothing on a cell the character is nowhere near", () => {
    expect(shadowRuns(9, 9, MIDDLE, FOOTPRINT)).toEqual([]);
  });

  it("stays on the top faces, never on the sides of a tile", () => {
    // A shadow falls on the ground, and the two faces the projection leaves
    // visible are both vertical. The sprite is 32 by 24; only its top sixteen
    // rows are ground, and the row above them is the seam bias.
    const onTheEdge = { s: 5, e: 4.5 };
    for (const pixel of shadowPixels(4, 4, onTheEdge)) {
      expect(pixel.y).toBeGreaterThanOrEqual(-1);
      expect(pixel.y).toBeLessThan(16);
    }
  });

  it("never paints the same pixel of the map twice", () => {
    // Two pieces overlapping would darken the seam between two tiles, which is
    // exactly where the eye is looking. The half-open cell test is what
    // prevents it, on a character standing right on a corner.
    const centre = { s: 5, e: 5 };
    const painted = new Set<string>();
    let total = 0;
    for (let cs = 3; cs <= 6; cs++) {
      for (let ce = 3; ce <= 6; ce++) {
        for (const pixel of shadowPixels(cs, ce, centre)) {
          // where that pixel lands on the map, all cells at the same height
          total++;
          painted.add(`${16 * (ce - cs) + pixel.x},${8 * (ce + cs) + pixel.y}`);
        }
      }
    }
    expect(total).toBeGreaterThan(100);
    expect(painted.size).toBe(total);
  });

  it("is split between the cells the character stands across", () => {
    // A character on a boundary drops shadow on both sides of it...
    const onTheEdge = { s: 5, e: 4.5 };
    expect(shadowPixels(4, 4, onTheEdge).length).toBeGreaterThan(0);
    expect(shadowPixels(5, 4, onTheEdge).length).toBeGreaterThan(0);
    // ...and the pieces still add up to one shadow, wherever it is cut. Not
    // to the pixel: a disc sampled at pixel centres gains and loses a few
    // along its rim as it slides.
    const whole = paintedBy(MIDDLE);
    expect(paintedBy(onTheEdge)).toBeGreaterThan(whole * 0.9);
    expect(paintedBy(onTheEdge)).toBeLessThan(whole * 1.1);
  });
});

describe("TOP_FACE_RUNS", () => {
  it("is every pixel of the face a shadow could ever reach", () => {
    // what a tile floating overhead drops: the same set as a disc wide enough
    // to swallow the whole cell
    expect(TOP_FACE_RUNS).toEqual(shadowRuns(0, 0, { s: 0, e: 0 }, 1000));
  });

  it("tiles the map, leaving no pixel out and none in twice", () => {
    // What every shadow in the game rests on. A floor darkened cell by cell
    // has to come out as one unbroken sheet: a pixel nobody claims is a bright
    // line down an edge, and one claimed twice is a dark one.
    const claims = new Map<string, number>();
    for (let cs = -6; cs <= 10; cs++) {
      for (let ce = -6; ce <= 10; ce++) {
        for (const run of TOP_FACE_RUNS) {
          for (let step = 0; step < run.width; step++) {
            const at = `${16 * (ce - cs) + run.x + step},${8 * (ce + cs) + run.y}`;
            claims.set(at, (claims.get(at) ?? 0) + 1);
          }
        }
      }
    }
    // well inside the patch, so that its border is not the answer
    let holes = 0;
    let twice = 0;
    for (let x = -20; x <= 60; x++) {
      for (let y = 40; y <= 90; y++) {
        const n = claims.get(`${x},${y}`) ?? 0;
        if (n === 0) holes++;
        if (n > 1) twice++;
      }
    }
    expect({ holes, twice }).toEqual({ holes: 0, twice: 0 });
  });
});
