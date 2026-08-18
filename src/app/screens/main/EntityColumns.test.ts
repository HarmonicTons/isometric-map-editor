import { describe, expect, it } from "vitest";
import { EntityShape, maxPieces, sliceEntityByColumn } from "./EntityColumns";
import {
  GlobalIsoCoordinates,
  IsoBox,
  IsoCoordinates,
  paintersOrderKey,
} from "./IsometricCoordinate";

/**
 * Print numbers the tests below deliberately do NOT assert on, with MEASURE=1.
 *
 * They are descriptive rather than contractual — how many pairs the geometry
 * had no opinion about, how many pieces and runs a cut comes out at, what it
 * costs per call — and pinning any of them in an `expect` would fail on a
 * faster machine or on a redrawn sprite. They are what one implementation is
 * compared against another with, so they live beside the oracle that judges
 * both rather than in a script of their own.
 */
const report = (data: unknown) => {
  if (process.env.MEASURE) console.log(JSON.stringify(data, null, 2));
};

const CELL_WIDTH = 32;
const CELL_HEIGHT = 24;

/**
 * What is being cut. Two of them, because size is what the cut has to survive:
 * a character straddles four columns at most, something a few cells wide nine.
 */
type Subject = {
  name: string;
  hitbox: IsoCoordinates;
  spriteWidth: number;
  spriteHeight: number;
};

const CHARACTER: Subject = {
  name: "character",
  hitbox: new IsoCoordinates(0.8, 0.8, 1.9),
  spriteWidth: 23,
  spriteHeight: 32,
};

/** The size of onix, the largest thing on the map */
const GIANT: Subject = {
  name: "giant",
  hitbox: new IsoCoordinates(1.8, 1.8, 3.9),
  spriteWidth: 64,
  spriteHeight: 96,
};

/**
 * The pair that caught the anchoring bug: the same art, one cell and two cells
 * across, drawn at exactly twice the size.
 */
const CUBE_MEDIUM: Subject = {
  name: "cube-medium",
  hitbox: new IsoCoordinates(0.99, 0.99, 2),
  spriteWidth: 32,
  spriteHeight: 32,
};

const CUBE_LARGE: Subject = {
  name: "cube-large",
  hitbox: new IsoCoordinates(1.99, 1.99, 4),
  spriteWidth: 64,
  spriteHeight: 64,
};

const shape = (subject: Subject, iso: GlobalIsoCoordinates): EntityShape => ({
  iso,
  hitbox: subject.hitbox,
  spriteWidth: subject.spriteWidth,
  spriteHeight: subject.spriteHeight,
});

const byColumn = (subject: Subject, iso: GlobalIsoCoordinates) =>
  sliceEntityByColumn(shape(subject, iso));

/**
 * Which key a cut gives each pixel of the sprite. Pieces are runs, the oracle
 * below asks about pixels, and this is where the two meet — it also lets a
 * variant of the key be weighed against the real one on the same ground.
 */
type KeyOfPixel = (column: number, row: number) => number;

const columnKeys = (
  subject: Subject,
  iso: GlobalIsoCoordinates
): KeyOfPixel => {
  const keys = new Float64Array(
    subject.spriteWidth * subject.spriteHeight
  ).fill(NaN);
  for (const piece of byColumn(subject, iso).pieces) {
    for (const run of piece.runs) {
      for (let x = run.x; x < run.x + run.width; x++) {
        keys[run.y * subject.spriteWidth + x] = piece.zIndex;
      }
    }
  }
  return (column, row) => keys[row * subject.spriteWidth + column];
};

/**
 * The same cut with the flat half the key used to carry, so that what the
 * sub-cell key buys can be measured rather than asserted.
 */
const flatKeys = (subject: Subject, iso: GlobalIsoCoordinates): KeyOfPixel => {
  const keys = new Float64Array(
    subject.spriteWidth * subject.spriteHeight
  ).fill(NaN);
  for (const piece of byColumn(subject, iso).pieces) {
    const flat = paintersOrderKey(piece.s, piece.e, Math.floor(iso.u)) + 0.5;
    for (const run of piece.runs) {
      for (let x = run.x; x < run.x + run.width; x++) {
        keys[run.y * subject.spriteWidth + x] = flat;
      }
    }
  }
  return (column, row) => keys[row * subject.spriteWidth + column];
};

/**
 * Whether a cell's artwork paints the pixel at (column, row) of its 32×24
 * sprite: the hexagon inscribed in it, corners cut at the 2:1 slope — how the
 * tile artwork rasterises, its bottom row four pixels wide rather than one.
 */
const cellPaints = (column: number, row: number) => {
  if (row < 0 || row >= CELL_HEIGHT) return false;
  const widest = Math.min(Math.max(CELL_HEIGHT / 3, row), row + 1);
  const from = Math.max(0, 16 - 2 * widest, 2 * widest - CELL_WIDTH);
  const to = Math.min(CELL_WIDTH, 2 * widest + 16, 64 - 2 * widest);
  return column >= from && column <= to - 1;
};

/**
 * Which side of the entity a cell is on, as a whole: slide the cell along the
 * view ray (1, 1, 2) and see over which range it overlaps the box. Reached only
 * after 0 and it is in front, only before and it is behind, across 0 and they
 * interpenetrate, never and they miss each other.
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
 * misses the box entirely.
 *
 * The ray is s = t, e = t + a, u = 2t + a - b, and along it t grows towards the
 * camera, so the larger of two depths is the one in front.
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

const CORNERS = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

type Verdict = "after" | "before" | "offSprite" | "offCell" | "onTheEdge";

/**
 * Ground truth for one pixel and one cell, from the geometry alone: is the
 * cell's surface nearer to the camera than the entity's, right here?
 *
 * A pixel is a square, so the question is asked at its four corners and only
 * answered when all four agree. Three things it will not answer, counted rather
 * than judged:
 *
 * - offSprite: the ray misses the hitbox, so the sprite draws something the box
 *   does not contain — the price of a sprite bigger than what it collides with.
 * - offCell: the pixel straddles the cell's own edge, where the artwork
 *   rasterises more generously than the geometry reaches.
 * - onTheEdge: the two surfaces cross inside the pixel, either order defensible.
 */
const verdictAt = (
  left: number,
  top: number,
  column: number,
  row: number,
  cell: { min: IsoCoordinates; max: IsoCoordinates },
  box: IsoBox
): Verdict => {
  let after = 0;
  let before = 0;
  for (const [dx, dy] of CORNERS) {
    const a = (left + column + dx - 16) / 16;
    const b = (top + row + dy - 8) / 8;
    const onEntity = frontOf(a, b, box.min, box.max);
    if (onEntity === undefined) return "offSprite";
    const onCell = frontOf(a, b, cell.min, cell.max);
    if (onCell === undefined) return "offCell";
    if (onCell > onEntity) after++;
    else if (onCell < onEntity) before++;
  }
  if (after === CORNERS.length) return "after";
  if (before === CORNERS.length) return "before";
  return "onTheEdge";
};

type Tally = {
  checked: number;
  offSprite: number;
  offCell: number;
  onTheEdge: number;
  /** settled pairs the cuts order differently */
  split: number;
  /** unsettled pairs the cuts order differently, by what left them unsettled */
  splitUnsettled: Record<"offSprite" | "offCell" | "onTheEdge", number>;
  mistakes: string[][];
};

const emptyTally = (cuts = 1): Tally => ({
  checked: 0,
  offSprite: 0,
  offCell: 0,
  onTheEdge: 0,
  split: 0,
  splitUnsettled: { offSprite: 0, offCell: 0, onTheEdge: 0 },
  mistakes: Array.from({ length: cuts }, () => []),
});

/**
 * Every (pixel, cell) pair around the entity, weighed against the truth above.
 *
 * Ground truth per pixel, not per cell: asking that a cell in front of the *box*
 * be drawn over every pixel it paints would be too strong, since a ledge can be
 * in front of the far corner of the hitbox and behind the near one.
 *
 * Several variants of the key can be weighed in one pass, which records not only
 * whether each is right but where they disagree at all.
 */
const weigh = (
  subject: Subject,
  iso: GlobalIsoCoordinates,
  cuts: KeyOfPixel[],
  into: Tally,
  radius = 6
) => {
  const { x: left, y: top } = byColumn(subject, iso);
  const box = IsoBox.standingOn(iso, subject.hitbox);
  const originS = Math.floor(iso.s);
  const originE = Math.floor(iso.e);
  const originU = Math.floor(iso.u);

  for (let s = originS - radius; s <= originS + radius; s++) {
    for (let e = originE - radius; e <= originE + radius; e++) {
      for (let u = originU - 2 * radius; u <= originU + 2 * radius; u++) {
        if (u < 0) continue;
        const side = sideOfCell(s, e, u, box);
        // their silhouettes miss each other, or the entity stands in the cell,
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
            const verdict = verdictAt(left, top, column, row, cell, box);
            const drawnAfter = cuts.map((keyOf) => key > keyOf(column, row));
            const agree = drawnAfter.every((after) => after === drawnAfter[0]);
            if (verdict === "after" || verdict === "before") {
              into.checked++;
              if (!agree) into.split++;
              drawnAfter.forEach((after, cut) => {
                if (after === (verdict === "after")) return;
                into.mistakes[cut].push(
                  `${iso.toString()}: cell ${s},${e},${u} at pixel ${column},${row} should be drawn ${verdict}`
                );
              });
              continue;
            }
            into[verdict]++;
            if (!agree) into.splitUnsettled[verdict]++;
          }
        }
      }
    }
  }
};

/**
 * Which side of one box the other is on, as a whole — the same three-axis
 * separation as sideOfCell, with a box in place of the cell. Used only to leave
 * out the pairs that interpenetrate, which collision is supposed to prevent and
 * which no key could order anyway.
 */
const sideOfBox = (them: IsoBox, us: IsoBox) => {
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
  if (from >= to) return "unrelated";
  if (from >= 0) return "front";
  if (to <= 0) return "behind";
  return "interpenetrating";
};

type PairTally = {
  judged: number;
  unsettled: number;
  wrong: number;
  tied: number;
};

/**
 * Two entities against each other, pixel by pixel.
 *
 * Same ground truth as the oracle above, with the second entity's box in place
 * of a cell: on the pixels where both sprites are drawn and the geometry has an
 * opinion, does the key agree.
 *
 * A tie is counted apart from a mistake. It is worse than one — not even wrong
 * in a way the order could be relied on — and it is what a flat half gives.
 */
const weighPair = (
  subject: Subject,
  first: GlobalIsoCoordinates,
  second: GlobalIsoCoordinates,
  keysOf: (subject: Subject, iso: GlobalIsoCoordinates) => KeyOfPixel,
  into: PairTally
) => {
  const boxes = [first, second].map((iso) =>
    IsoBox.standingOn(iso, subject.hitbox)
  );
  if (sideOfBox(boxes[1], boxes[0]) === "interpenetrating") return;
  const cuts = [first, second].map((iso) => byColumn(subject, iso));
  const keys = [first, second].map((iso) => keysOf(subject, iso));

  // every map pixel both sprites cover
  const fromX = Math.max(cuts[0].x, cuts[1].x);
  const toX = Math.min(cuts[0].x, cuts[1].x) + subject.spriteWidth;
  const fromY = Math.max(cuts[0].y, cuts[1].y);
  const toY = Math.min(cuts[0].y, cuts[1].y) + subject.spriteHeight;
  for (let mapY = fromY; mapY < toY; mapY++) {
    for (let mapX = fromX; mapX < toX; mapX++) {
      let ahead = 0;
      let behind = 0;
      let blind = false;
      for (const [dx, dy] of CORNERS) {
        const a = (mapX + dx - 16) / 16;
        const b = (mapY + dy - 8) / 8;
        const surfaces = boxes.map((box) => frontOf(a, b, box.min, box.max));
        if (surfaces[0] === undefined || surfaces[1] === undefined) {
          blind = true;
          break;
        }
        if (surfaces[1] > surfaces[0]) ahead++;
        else if (surfaces[1] < surfaces[0]) behind++;
      }
      if (blind || (ahead !== CORNERS.length && behind !== CORNERS.length)) {
        into.unsettled++;
        continue;
      }
      into.judged++;
      const drawn = keys.map((keyOf, index) =>
        keyOf(mapX - cuts[index].x, mapY - cuts[index].y)
      );
      if (drawn[0] === drawn[1]) {
        into.tied++;
        continue;
      }
      const secondIsInFront = ahead === CORNERS.length;
      if (drawn[1] > drawn[0] !== secondIsInFront) into.wrong++;
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

describe("sliceEntityByColumn", () => {
  it("covers the sprite exactly once, pixel by pixel", () => {
    for (const iso of sweep(0.1)) {
      const seen = new Uint8Array(
        CHARACTER.spriteWidth * CHARACTER.spriteHeight
      );
      for (const piece of byColumn(CHARACTER, iso).pieces) {
        for (const run of piece.runs) {
          expect(run.width).toBeGreaterThan(0);
          for (let x = run.x; x < run.x + run.width; x++) {
            seen[run.y * CHARACTER.spriteWidth + x]++;
          }
        }
      }
      expect(seen.filter((count) => count !== 1).length).toBe(0);
    }
  });

  it("cuts into as many pieces as the entity straddles columns, no more", () => {
    for (const iso of sweep(0.05)) {
      const { pieces } = byColumn(CHARACTER, iso);
      expect(pieces.length).toBeLessThanOrEqual(
        maxPieces(shape(CHARACTER, iso))
      );
      for (const piece of pieces) {
        // between the cell it stands in and the next one up, never on either:
        // that is the whole of what the key owes the cells around it
        const cell = paintersOrderKey(piece.s, piece.e, Math.floor(iso.u));
        expect(piece.zIndex).toBeGreaterThanOrEqual(cell);
        expect(piece.zIndex).toBeLessThan(cell + 1);
      }
    }
  });

  it("gives each piece at most one run per row of the sprite", () => {
    // What lets a renderer size a piece's buffers once and never resize them
    // (Pixi rebuilds a render group when a mesh's vertex count changes). It
    // holds because along a row the point the sprite shows only moves one way,
    // so a column, once left, is never returned to.
    for (const subject of [CHARACTER, GIANT]) {
      for (const iso of sweep(0.1)) {
        for (const piece of byColumn(subject, iso).pieces) {
          const rows = new Set(piece.runs.map((run) => run.y));
          expect(rows.size).toBe(piece.runs.length);
          expect(piece.runs.length).toBeLessThanOrEqual(subject.spriteHeight);
        }
      }
    }
  });

  it("puts every pixel in the right place in the draw order", () => {
    const tally = emptyTally();
    for (const iso of sweep(0.1))
      weigh(CHARACTER, iso, [columnKeys(CHARACTER, iso)], tally);
    expect(tally.mistakes[0].slice(0, 5)).toEqual([]);
    expect(tally.checked).toBeGreaterThan(100000);
  });

  it("holds at fractional heights, mid-jump", () => {
    const tally = emptyTally();
    for (const iso of sweep(0.2, [4.3, 4.5, 4.75])) {
      weigh(CHARACTER, iso, [columnKeys(CHARACTER, iso)], tally);
    }
    expect(tally.mistakes[0].slice(0, 5)).toEqual([]);
    // an oracle that settled nothing would pass the line above in silence
    expect(tally.checked).toBeGreaterThan(100000);
  });

  it("holds at positions that fall between pixels", () => {
    const tally = emptyTally();
    for (let index = 0; index < 200; index++) {
      const iso = new GlobalIsoCoordinates(
        11 + (index * 0.0137) ** 1.3,
        19.4813 + index * 0.00791,
        4
      );
      weigh(CHARACTER, iso, [columnKeys(CHARACTER, iso)], tally);
    }
    expect(tally.mistakes[0].slice(0, 5)).toEqual([]);
  });

  it("looks no further than it has to", () => {
    const tally = emptyTally();
    for (const iso of sweep(0.5))
      weigh(CHARACTER, iso, [columnKeys(CHARACTER, iso)], tally, 14);
    expect(tally.mistakes[0].slice(0, 5)).toEqual([]);
  });

  it("depends on where the entity stands inside its cell, not on which cell", () => {
    // Moving by whole cells shifts every key by that move's own key and leaves
    // the pieces where they are — as long as the sprite lands on the same
    // pixel. It does not always: placeSprite rounds x + 16 - width / 2, and a
    // position whose e - s is whole puts that exactly on a half, where float
    // noise decides. That wobble is placeSprite's, not the cut's.
    let moved = 0;
    let compared = 0;
    for (let a = 0; a < 12; a++) {
      for (let b = 0; b < 12; b++) {
        const hereIso = new GlobalIsoCoordinates(11 + a / 12, 19 + b / 12, 4);
        const here = byColumn(CHARACTER, hereIso);
        for (const [ds, de, du] of [
          [1, 0, 0],
          [0, 1, 0],
          [5, -4, 0],
          [0, 0, 3],
          [-3, 7, -2],
          [40, 40, 10],
        ]) {
          const thereIso = new GlobalIsoCoordinates(
            11 + ds + a / 12,
            19 + de + b / 12,
            4 + du
          );
          const there = byColumn(CHARACTER, thereIso);
          if (
            there.x - here.x !== 16 * (de - ds) ||
            there.y - here.y !== 8 * (de + ds) - 8 * du
          ) {
            moved++;
            continue;
          }
          const offset = paintersOrderKey(ds, de, du);
          expect(there.pieces.map((piece) => piece.runs)).toEqual(
            here.pieces.map((piece) => piece.runs)
          );
          there.pieces.forEach((piece, index) => {
            // Not to the last bit: the fraction sits under a whole part of some
            // thousands, and moving forty cells away spends a few of its
            // digits. Nine decimals is finer than two entities ever differ by.
            expect(piece.zIndex - offset).toBeCloseTo(
              here.pieces[index].zIndex,
              9
            );
          });
          compared++;
        }
      }
    }
    expect(compared).toBe(800);
    expect(moved).toBe(64);
  });
});

/**
 * The cut over a sweep of positions, against the oracle. Run it with
 * `MEASURE=1 npx vitest run EntityColumns` to read the numbers out.
 */
const measure = (
  subject: Subject,
  positions: GlobalIsoCoordinates[],
  radius: number
) => {
  const tally = emptyTally();
  for (const iso of positions) {
    weigh(subject, iso, [columnKeys(subject, iso)], tally, radius);
  }

  const pieceCounts = positions.map(
    (iso) => byColumn(subject, iso).pieces.length
  );
  const runCounts = positions.map((iso) =>
    byColumn(subject, iso).pieces.reduce(
      (total, piece) => total + piece.runs.length,
      0
    )
  );
  const mean = (counts: number[]) =>
    Math.round((counts.reduce((a, b) => a + b, 0) / counts.length) * 100) / 100;

  const started = performance.now();
  for (let pass = 0; pass < 5; pass++) {
    for (const iso of positions) byColumn(subject, iso);
  }
  const msPerCall =
    Math.round(
      ((performance.now() - started) / (5 * positions.length)) * 10000
    ) / 10000;

  return {
    subject: subject.name,
    positions: positions.length,
    pairs: {
      judged: tally.checked,
      // what hangs outside the hitbox is ordered by extension, not by geometry
      offSprite: tally.offSprite,
      offCell: tally.offCell,
      onTheEdge: tally.onTheEdge,
    },
    mistakes: tally.mistakes[0].length,
    meanPieces: mean(pieceCounts),
    maxPieces: Math.max(...pieceCounts),
    meanRuns: mean(runCounts),
    maxRuns: Math.max(...runCounts),
    msPerCall,
    firstMistakes: tally.mistakes[0].slice(0, 3),
  };
};

describe("where the sprite is placed", () => {
  /**
   * The projection of a world POINT, which is not what IsoCoordinates.toXY
   * returns: that one gives the top left of a cell's 32 × 24 sprite, and the
   * point itself sits 16 to the right of it and 8 below.
   */
  const project = (s: number, e: number, u: number) => ({
    x: 16 * (e - s) + 16,
    y: 8 * (e + s) - 8 * u + 8,
  });

  /** Whole cells, so the tip lands on a whole pixel and can be compared exactly */
  const iso = new GlobalIsoCoordinates(10, 20, 5);

  it("stands the sprite on the front tip of the cells it occupies", () => {
    for (const subject of [CHARACTER, GIANT, CUBE_MEDIUM, CUBE_LARGE]) {
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
      expect({
        subject: subject.name,
        bottom: cut.y + subject.spriteHeight,
      }).toEqual({ subject: subject.name, bottom: tip.y });
      // and centred on it, to the half pixel an odd sprite width costs
      expect(
        Math.abs(cut.x + subject.spriteWidth / 2 - tip.x)
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it("drops the sprite a level for every cell of footprint it gains", () => {
    // An anchor hard-coded for a one cell footprint leaves anything wider
    // hanging a whole level above the ground.
    const bottomOf = (subject: Subject) =>
      byColumn(subject, iso).y + subject.spriteHeight;
    expect(bottomOf(CUBE_LARGE) - bottomOf(CUBE_MEDIUM)).toBe(8);
    expect(bottomOf(CUBE_MEDIUM) - bottomOf(CHARACTER)).toBe(0);
  });
});

describe("two entities sharing a column", () => {
  /**
   * One character slid past another, in every direction, at every offset a
   * tenth of a cell apart. Whenever their hitboxes stay clear of each other
   * there is a right answer, and the key has to give it.
   */
  const pairs = () => {
    const here = new GlobalIsoCoordinates(11.3, 19.4, 4);
    const cases: [GlobalIsoCoordinates, GlobalIsoCoordinates][] = [];
    for (let ds = -2; ds <= 2.0001; ds += 0.1) {
      for (let de = -2; de <= 2.0001; de += 0.1) {
        for (const du of [0, 2]) {
          cases.push([
            here,
            new GlobalIsoCoordinates(
              Math.round((here.s + ds) * 100) / 100,
              Math.round((here.e + de) * 100) / 100,
              here.u + du
            ),
          ]);
        }
      }
    }
    return cases;
  };

  const sweepPairs = (
    keysOf: (subject: Subject, iso: GlobalIsoCoordinates) => KeyOfPixel
  ) => {
    const tally: PairTally = { judged: 0, unsettled: 0, wrong: 0, tied: 0 };
    for (const [first, second] of pairs()) {
      weighPair(CHARACTER, first, second, keysOf, tally);
    }
    return tally;
  };

  it("spreads the sub-cell key over the whole approach to a column", () => {
    // The key owes a reader as well as a sort: it rises steadily as the entity
    // walks up a column, rather than sitting on 0 and flipping to 1 in the sixth
    // of a pixel where the two are level. Both order correctly; only one
    // survives being added to a key of several thousand.
    // right across the cell the column is keyed on, from behind it to past it
    const keys: number[] = [];
    for (let step = 0; step <= 16; step++) {
      const iso = new GlobalIsoCoordinates(
        10.2 + step / 10,
        18.2 + step / 10,
        4
      );
      const piece = byColumn(CHARACTER, iso).pieces.find(
        (candidate) => candidate.s === 11 && candidate.e === 19
      );
      if (piece) keys.push(piece.zIndex - paintersOrderKey(11, 19, 4));
    }
    expect(keys.length).toBeGreaterThan(12);
    for (let index = 1; index < keys.length; index++) {
      expect(keys[index]).toBeGreaterThan(keys[index - 1]);
    }
    expect(Math.max(...keys) - Math.min(...keys)).toBeGreaterThan(0.25);
  });

  it("orders them the way the geometry does", () => {
    const withSubCell = sweepPairs(columnKeys);
    const flat = sweepPairs(flatKeys);
    report({ withSubCell, flat });

    // what the flat half could not do, and the whole reason for the fraction
    expect(flat.tied).toBeGreaterThan(0);
    expect(withSubCell.tied).toBe(0);
    expect(withSubCell.wrong).toBe(0);
    expect(withSubCell.judged).toBeGreaterThan(10000);
  });
});

describe("the cut, measured", () => {
  it("holds over a sweep of a character's positions", () => {
    const measured = measure(CHARACTER, sweep(0.1, [4, 4.5]), 6);
    report(measured);
    expect(measured.mistakes).toBe(0);
  });

  it("holds on something several cells wide", () => {
    // A giant is four cells across the diagonal and four levels tall, so a
    // whole column of cell keys fits inside its sprite. Nothing about the cut
    // notices: it never cuts in u, and the key of a piece is its column's.
    const measured = measure(GIANT, sweep(0.25), 8);
    report(measured);
    expect(measured.mistakes).toBe(0);
  });

  /** How far a cell that must be drawn alongside `subject` can be, in cells */
  const constrainingReach = (subject: Subject) => {
    let furthest = 0;
    for (const iso of sweep(1 / 12)) {
      const box = IsoBox.standingOn(iso, subject.hitbox);
      const keys = byColumn(subject, iso).pieces.map((piece) => piece.zIndex);
      const lowest = Math.min(...keys);
      const highest = Math.max(...keys);
      for (let s = Math.floor(iso.s) - 6; s <= Math.floor(iso.s) + 6; s++) {
        for (let e = Math.floor(iso.e) - 6; e <= Math.floor(iso.e) + 6; e++) {
          for (let u = 0; u <= Math.floor(iso.u) + 12; u++) {
            const key = paintersOrderKey(s, e, u);
            // only what has to be ordered against it at all: a cell whose
            // silhouette misses the entity's is free to sit anywhere
            if (key <= lowest || key >= highest) continue;
            if (sideOfCell(s, e, u, box) === "unrelated") continue;
            furthest = Math.max(
              furthest,
              Math.abs(s - Math.floor(iso.s)),
              Math.abs(e - Math.floor(iso.e))
            );
          }
        }
      }
    }
    return furthest;
  };

  it("is never constrained by a cell more than three cells away", () => {
    // What Map.BLOCK_SIDE is sized against: a cell landing between two of the
    // entity's keys AND meeting it on screen has to be drawn alongside it, so
    // it can never be left in a chunk of its own. The block guarantees four,
    // so the headroom is one cell — measured on the LARGEST entity, since the
    // reach grows with the footprint and the block is sized once for all.
    //
    // More than the footprint suggests, because a piece takes a key a fraction
    // ABOVE its column: a cell on the diagonal beyond the last column still
    // slips underneath it. Counting it is the safe way round.
    expect(constrainingReach(CHARACTER)).toBe(2);
    expect(constrainingReach(GIANT)).toBe(3);
  });
});
