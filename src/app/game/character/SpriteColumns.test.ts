import { describe, expect, it } from "vitest";
import { SpriteShape, sliceSpriteByColumn } from "./SpriteColumns";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "../iso/IsometricCoordinate";

/**
 * The cut, against the geometry it stands for.
 *
 * Everything below leans on one oracle: for a given pixel and a given cell,
 * which surface is really nearer the camera. The cut's keys are then asked to
 * agree with it, over a sweep of positions.
 */

const CELL_WIDTH = 32;
const CELL_HEIGHT = 24;

/** What is being cut. Two sizes, since size is what the cut has to survive. */
type Subject = {
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
};

const CHARACTER: Subject = {
  hitbox: new IsoCoordinates(0.8, 0.8, 1.9),
  spriteWidth: 23,
  spriteHeight: 32,
};

/** The largest thing the map has to place: four columns across, nine straddled */
const GIANT: Subject = {
  hitbox: new IsoCoordinates(1.8, 1.8, 3.9),
  spriteWidth: 64,
  spriteHeight: 96,
};

// Art drawn as the projection of the subject's own box: centred on it, its
// bottom edge the box's lowest corner. Real characters carry an anchor per
// frame; the partition only needs the sprite to be somewhere exact.
const shape = (subject: Subject, iso: GlobalIsoCoordinates): SpriteShape => ({
  iso,
  hitbox: subject.hitbox,
  spriteWidth: subject.spriteWidth,
  spriteHeight: subject.spriteHeight,
  anchorX: subject.spriteWidth / 2,
  anchorY:
    subject.spriteHeight -
    4 * (Math.ceil(subject.hitbox.s) + Math.ceil(subject.hitbox.e)),
});

const byColumn = (subject: Subject, iso: GlobalIsoCoordinates) =>
  sliceSpriteByColumn(shape(subject, iso));

/** Which key the cut gives each pixel of the sprite */
const keysOfPixels = (subject: Subject, iso: GlobalIsoCoordinates) => {
  const keys = new Float64Array(
    subject.spriteWidth * subject.spriteHeight
  ).fill(NaN);
  for (const column of byColumn(subject, iso).columns) {
    for (const run of column.runs) {
      for (let x = run.x; x < run.x + run.width; x++) {
        keys[run.y * subject.spriteWidth + x] = column.zIndex;
      }
    }
  }
  return (column: number, row: number) =>
    keys[row * subject.spriteWidth + column];
};

/**
 * Whether a cell's artwork paints the pixel at (column, row) of its 32×24
 * sprite: the hexagon inscribed in it, corners cut at the 2:1 slope.
 */
const cellPaints = (column: number, row: number) => {
  if (row < 0 || row >= CELL_HEIGHT) return false;
  const widest = Math.min(Math.max(CELL_HEIGHT / 3, row), row + 1);
  const from = Math.max(0, 16 - 2 * widest, 2 * widest - CELL_WIDTH);
  const to = Math.min(CELL_WIDTH, 2 * widest + 16, 64 - 2 * widest);
  return column >= from && column <= to - 1;
};

/**
 * Which side of the box a cell is on, as a whole: slide it along the view ray
 * (1, 1, 2) and see over which range it overlaps.
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
 * Where the ray through the screen point (a, b) leaves a box, nearest the
 * camera — the depth of the surface that point shows — or nothing when it
 * misses the box. Along the ray t grows towards the camera.
 */
const frontOf = (
  a: number,
  b: number,
  min: IsoCoordinates,
  max: IsoCoordinates
): number | undefined => {
  const enters = Math.max(min.s, min.e - a, (min.u - a + b) / 2);
  const leaves = Math.min(max.s, max.e - a, (max.u - a + b) / 2);
  return enters < leaves ? leaves : undefined;
};

/** Whether two boxes overlap along the view ray, which collision prevents */
const interpenetrating = (them: IsoBox, us: IsoBox) => {
  const from = Math.max(
    them.min.s - us.max.s,
    them.min.e - us.max.e,
    (them.min.u - us.max.u) / 2
  );
  const to = Math.min(
    them.max.s - us.min.s,
    them.max.e - us.min.e,
    (them.max.u - us.min.u) / 2
  );
  return from < to && from < 0 && to > 0;
};

const CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

/**
 * Ground truth for one pixel and one cell: is the cell's surface nearer to the
 * camera than the sprite's, right here?
 *
 * A pixel is a square, so the question is asked at its four corners and only
 * answered when all four agree — undefined covers the ray missing the hitbox
 * (a sprite is bigger than what it collides with), the pixel straddling the
 * cell's edge, and the two surfaces crossing inside the pixel.
 */
const cellIsInFront = (
  left: number,
  top: number,
  column: number,
  row: number,
  cell: { min: IsoCoordinates; max: IsoCoordinates },
  box: IsoBox
): boolean | undefined => {
  let after = 0;
  let before = 0;
  for (const [dx, dy] of CORNERS) {
    const a = (left + column + dx - 16) / 16;
    const b = (top + row + dy - 8) / 8;
    const onSprite = frontOf(a, b, box.min, box.max);
    const onCell = frontOf(a, b, cell.min, cell.max);
    if (onSprite === undefined || onCell === undefined) return undefined;
    if (onCell > onSprite) after++;
    else if (onCell < onSprite) before++;
  }
  if (after === CORNERS.length) return true;
  if (before === CORNERS.length) return false;
  return undefined;
};

type Tally = { checked: number; mistakes: string[] };

/**
 * Every (pixel, cell) pair around the sprite, weighed against the truth above.
 *
 * Ground truth per PIXEL, not per cell: a ledge can be in front of the far
 * corner of a hitbox and behind the near one.
 */
const weigh = (
  subject: Subject,
  iso: GlobalIsoCoordinates,
  into: Tally,
  radius = 6
) => {
  const { x: left, y: top } = byColumn(subject, iso);
  const keyOf = keysOfPixels(subject, iso);
  const box = IsoBox.standingOn(iso, subject.hitbox);
  const originS = Math.floor(iso.s);
  const originE = Math.floor(iso.e);
  const originU = Math.floor(iso.u);

  for (let s = originS - radius; s <= originS + radius; s++) {
    for (let e = originE - radius; e <= originE + radius; e++) {
      for (let u = originU - 2 * radius; u <= originU + 2 * radius; u++) {
        if (u < 0) continue;
        const side = sideOfCell(s, e, u, box);
        // their silhouettes miss each other, or the sprite stands in the cell,
        // which is then empty: nothing has to be ordered
        if (side === "unrelated" || side === "interpenetrating") continue;
        const cell = {
          min: new IsoCoordinates(s, e, u),
          max: new IsoCoordinates(s + 1, e + 1, u + 1),
        };
        const key = paintersOrderKey(s, e, u);
        const cellX = 16 * (e - s);
        const cellY = 8 * (e + s) - 8 * u;
        const fromRow = Math.max(0, cellY - top);
        const toRow = Math.min(subject.spriteHeight, cellY - top + CELL_HEIGHT);
        const fromColumn = Math.max(0, cellX - left);
        const toColumn = Math.min(
          subject.spriteWidth,
          cellX - left + CELL_WIDTH
        );
        for (let row = fromRow; row < toRow; row++) {
          for (let column = fromColumn; column < toColumn; column++) {
            if (!cellPaints(left + column - cellX, top + row - cellY)) continue;
            const inFront = cellIsInFront(left, top, column, row, cell, box);
            if (inFront === undefined) continue;
            into.checked++;
            if (key > keyOf(column, row) === inFront) continue;
            into.mistakes.push(
              `${iso.toString()}: cell ${s},${e},${u} at pixel ${column},${row} is drawn wrong`
            );
          }
        }
      }
    }
  }
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

describe("sliceSpriteByColumn", () => {
  it("covers the sprite exactly once, pixel by pixel", () => {
    for (const iso of sweep(0.1)) {
      const seen = new Uint8Array(
        CHARACTER.spriteWidth * CHARACTER.spriteHeight
      );
      for (const column of byColumn(CHARACTER, iso).columns) {
        for (const run of column.runs) {
          expect(run.width).toBeGreaterThan(0);
          for (let x = run.x; x < run.x + run.width; x++) {
            seen[run.y * CHARACTER.spriteWidth + x]++;
          }
        }
      }
      expect(seen.filter((count) => count !== 1).length).toBe(0);
    }
  });

  it("keys every column between the cell it stands in and the next one up", () => {
    for (const iso of sweep(0.05)) {
      for (const column of byColumn(CHARACTER, iso).columns) {
        const cell = paintersOrderKey(column.s, column.e, Math.floor(iso.u));
        expect(column.zIndex).toBeGreaterThanOrEqual(cell);
        expect(column.zIndex).toBeLessThan(cell + 1);
      }
    }
  });

  it("gives each column at most one run per row of the sprite", () => {
    // What lets a renderer size a mesh's buffers once and never resize them
    // (Pixi rebuilds a render group when a mesh's vertex count changes).
    for (const subject of [CHARACTER, GIANT]) {
      for (const iso of sweep(0.1)) {
        for (const column of byColumn(subject, iso).columns) {
          const rows = new Set(column.runs.map((run) => run.y));
          expect(rows.size).toBe(column.runs.length);
        }
      }
    }
  });

  it("puts every pixel in the right place in the draw order", () => {
    const tally: Tally = { checked: 0, mistakes: [] };
    for (const iso of sweep(0.1, [4, 4.5, 4.75])) weigh(CHARACTER, iso, tally);
    expect(tally.mistakes.slice(0, 5)).toEqual([]);
    // an oracle that settled nothing would pass the line above in silence
    expect(tally.checked).toBeGreaterThan(100000);
  });

  it("holds on something several cells wide", () => {
    // A giant is four cells across the diagonal, so a whole column of cell keys
    // fits inside its sprite. Nothing about the cut notices: it never cuts in u.
    const tally: Tally = { checked: 0, mistakes: [] };
    for (const iso of sweep(0.25)) weigh(GIANT, iso, tally, 8);
    expect(tally.mistakes.slice(0, 5)).toEqual([]);
    expect(tally.checked).toBeGreaterThan(100000);
  });
});

describe("where the sprite is placed", () => {
  /** The projection of a world POINT, 16 right and 8 below a cell's top left */
  const project = (s: number, e: number, u: number) => ({
    x: 16 * (e - s) + 16,
    y: 8 * (e + s) - 8 * u + 8,
  });

  /** Whole cells, so the tip lands on a whole pixel and compares exactly */
  const iso = new GlobalIsoCoordinates(10, 20, 5);

  it("stands the sprite on the front tip of the cells it occupies", () => {
    for (const subject of [CHARACTER, GIANT]) {
      const cut = byColumn(subject, iso);
      const cells = IsoBox.standingOn(
        iso,
        new IsoCoordinates(
          Math.ceil(subject.hitbox.s),
          Math.ceil(subject.hitbox.e),
          1
        )
      );
      const tip = project(cells.max.s, cells.max.e, cells.min.u);
      expect(cut.y + subject.spriteHeight).toBe(tip.y);
      // and centred on it, to the half pixel an odd sprite width costs
      expect(
        Math.abs(cut.x + subject.spriteWidth / 2 - tip.x)
      ).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("two entities sharing a column", () => {
  /**
   * One character slid past another at every offset a tenth of a cell apart.
   * Whenever their hitboxes stay clear of each other there is a right answer,
   * and the sub-cell fraction of the key has to give it — a flat half ties.
   */
  it("orders them the way the geometry does", () => {
    const here = new GlobalIsoCoordinates(11.3, 19.4, 4);
    let judged = 0;
    let wrong = 0;
    let tied = 0;

    for (let ds = -2; ds <= 2.0001; ds += 0.1) {
      for (let de = -2; de <= 2.0001; de += 0.1) {
        for (const du of [0, 2]) {
          const there = new GlobalIsoCoordinates(
            Math.round((here.s + ds) * 100) / 100,
            Math.round((here.e + de) * 100) / 100,
            here.u + du
          );
          const boxes = [here, there].map((iso) =>
            IsoBox.standingOn(iso, CHARACTER.hitbox)
          );
          if (interpenetrating(boxes[1], boxes[0])) continue;
          const cuts = [here, there].map((iso) => byColumn(CHARACTER, iso));
          const keys = [here, there].map((iso) => keysOfPixels(CHARACTER, iso));

          // every map pixel both sprites cover
          const fromX = Math.max(cuts[0].x, cuts[1].x);
          const toX = Math.min(cuts[0].x, cuts[1].x) + CHARACTER.spriteWidth;
          const fromY = Math.max(cuts[0].y, cuts[1].y);
          const toY = Math.min(cuts[0].y, cuts[1].y) + CHARACTER.spriteHeight;
          for (let mapY = fromY; mapY < toY; mapY++) {
            for (let mapX = fromX; mapX < toX; mapX++) {
              let ahead = 0;
              let behind = 0;
              let blind = false;
              for (const [dx, dy] of CORNERS) {
                const a = (mapX + dx - 16) / 16;
                const b = (mapY + dy - 8) / 8;
                const depths = boxes.map((box) =>
                  frontOf(a, b, box.min, box.max)
                );
                if (depths[0] === undefined || depths[1] === undefined) {
                  blind = true;
                  break;
                }
                if (depths[1] > depths[0]) ahead++;
                else if (depths[1] < depths[0]) behind++;
              }
              if (blind || (ahead !== 4 && behind !== 4)) continue;
              judged++;
              const drawn = keys.map((keyOf, index) =>
                keyOf(mapX - cuts[index].x, mapY - cuts[index].y)
              );
              if (drawn[0] === drawn[1]) tied++;
              else if (drawn[1] > drawn[0] !== (ahead === 4)) wrong++;
            }
          }
        }
      }
    }

    expect({ wrong, tied }).toEqual({ wrong: 0, tied: 0 });
    expect(judged).toBeGreaterThan(10000);
  });
});
