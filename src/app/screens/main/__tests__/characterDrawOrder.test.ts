import { beforeAll, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { composeMapImage } from "./composeMapImage";
import { MapData } from "../Map";

/**
 * End-to-end depth order of a character, asserted on rendered pixels only.
 *
 * EntityColumns has its own exhaustive test, but it checks the cut against its
 * own idea of a tile's zIndex. This one goes through the real Map and MapChunk
 * and never looks at a key: it renders the same scene with and without the
 * character and asks who won on the pixels both want.
 */

/** The character straddles the chunk boundary at s = 8 */
const CHARACTER = "7.6,15.6,1";
/** Cell in the row in front: it must hide the character */
const IN_FRONT = "9,16,2";
/** Cell behind, one row back and one level down: the character must hide it */
const BEHIND = "7,15,0";

const scene = ({
  inFront = "dirt",
  behind = "dirt",
  withCharacter = false,
}: {
  inFront?: string;
  behind?: string;
  withCharacter?: boolean;
}): MapData => {
  const tiles: Record<string, string> = {};
  for (let s = 4; s <= 12; s++) {
    for (let e = 12; e <= 20; e++) {
      tiles[`${s},${e},0`] = "dirt";
    }
  }
  // Both cells always exist, only their material changes: the neighbourhood
  // stays identical, so a diff isolates exactly the faces of one cell.
  tiles[IN_FRONT] = inFront;
  tiles[BEHIND] = behind;
  return {
    tiles,
    objects: {},
    characters: withCharacter ? { [CHARACTER]: "0004-charmander" } : {},
  };
};

const samePixel = (a: PNG, b: PNG, index: number) =>
  a.data[index] === b.data[index] &&
  a.data[index + 1] === b.data[index + 1] &&
  a.data[index + 2] === b.data[index + 2] &&
  a.data[index + 3] === b.data[index + 3];

/** Indices of the pixels that differ between two renders of the same scene */
const changedPixels = (a: PNG, b: PNG): number[] => {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  const changed: number[] = [];
  for (let index = 0; index < a.data.length; index += 4) {
    if (!samePixel(a, b, index)) changed.push(index);
  }
  return changed;
};

const intersect = (a: number[], b: number[]) => {
  const inB = new Set(b);
  return a.filter((index) => inB.has(index));
};

describe("character draw order", () => {
  let plain: PNG;
  let withCharacter: PNG;
  let characterPixels: number[];

  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    plain = composeMapImage(scene({}));
    withCharacter = composeMapImage(scene({ withCharacter: true }));
    characterPixels = changedPixels(withCharacter, plain);
  });

  it("draws the character somewhere at all", () => {
    expect(characterPixels.length).toBeGreaterThan(100);
  });

  it("never erases what is behind it", () => {
    // A character can only cover the scene, never punch through it. A gap
    // between two of its pieces would show up here, and a diff-of-renders test
    // would not notice: the gap is in both renders it compares.
    const erased = characterPixels.filter(
      (index) =>
        plain.data[index + 3] !== 0 && withCharacter.data[index + 3] === 0
    );
    expect(erased).toEqual([]);
  });

  it("lets the cell in front hide it", () => {
    const marked = composeMapImage(scene({ inFront: "rock" }));
    const contested = intersect(changedPixels(marked, plain), characterPixels);
    // without this the test would pass on a scene where they never overlap
    expect(contested.length).toBeGreaterThan(0);

    const both = composeMapImage(
      scene({ inFront: "rock", withCharacter: true })
    );
    const lost = contested.filter((index) => !samePixel(both, marked, index));
    expect(lost).toEqual([]);
  });

  it("lets a wall it stands flush against hide it", () => {
    // Its hitbox stops at s = 8, but the volume its sprite fills is wider and
    // pokes into the wall. That one cell interpenetrates the character, so
    // nothing orders it — the wall still has to win, carried by the cells
    // around it.
    const flushTiles: Record<string, string> = {};
    for (let s = 4; s <= 12; s++) {
      for (let e = 12; e <= 20; e++) flushTiles[`${s},${e},0`] = "dirt";
    }
    const bare = composeMapImage({
      tiles: flushTiles,
      objects: {},
      characters: {},
    });
    const walled = { ...flushTiles };
    for (let e = 12; e <= 20; e++) {
      for (let u = 1; u <= 2; u++) walled[`8,${e},${u}`] = "rock";
    }
    const wallOnly = composeMapImage({
      tiles: walled,
      objects: {},
      characters: {},
    });
    const characterOnly = composeMapImage({
      tiles: flushTiles,
      objects: {},
      characters: { "7.2,15,1": "0004-charmander" },
    });
    const both = composeMapImage({
      tiles: walled,
      objects: {},
      characters: { "7.2,15,1": "0004-charmander" },
    });
    const contested = intersect(
      changedPixels(wallOnly, bare),
      changedPixels(characterOnly, bare)
    );
    expect(contested.length).toBeGreaterThan(0);
    const lost = contested.filter((index) => !samePixel(both, wallOnly, index));
    expect(lost).toEqual([]);
  });

  it("draws the same thing however the map is cut into chunks", () => {
    // The decisive one. A single huge chunk puts every cell and every piece of
    // the character in one container sorted by the global depth key, which is
    // exact by construction; the real chunk size has to reproduce it pixel for
    // pixel, including where the character straddles the corner where four
    // chunks meet. This is what sending each piece to its own column's chunk
    // is for.
    const cluttered = (s: number, e: number): MapData => {
      const tiles: Record<string, string> = {};
      for (let ts = 3; ts <= 13; ts++) {
        for (let te = 3; te <= 13; te++) {
          tiles[`${ts},${te},0`] = "dirt";
          // a scattered ceiling two levels over its head, and pillars around
          // it — but never inside the volume it stands in
          if ((ts + te) % 3 === 0) tiles[`${ts},${te},3`] = "rock";
          if (Math.abs(ts - s) <= 1.5 && Math.abs(te - e) <= 1.5) continue;
          if ((ts * 3 + te) % 7 === 0) {
            tiles[`${ts},${te},1`] = "rock";
            tiles[`${ts},${te},2`] = "rock";
          }
        }
      }
      return {
        tiles,
        objects: {},
        characters: { [`${s},${e},1`]: "0004-charmander" },
      };
    };

    // the first four are the worst positions there are: drawing the whole
    // character in one chunk gets about a hundred pixels wrong at each
    for (const [s, e] of [
      [7.9, 7],
      [7.9, 9.5],
      [7, 7.9],
      [9.5, 7.9],
      [7.9, 7.9],
      [7.6, 8.3],
      [8.4, 8.4],
      [5.2, 7.8],
    ]) {
      const map = cluttered(s, e);
      const chunked = composeMapImage(map, 8);
      const whole = composeMapImage(map, 1024);
      expect({
        at: `${s},${e}`,
        wrong: changedPixels(chunked, whole).length,
      }).toEqual({ at: `${s},${e}`, wrong: 0 });
    }
  });

  it("hides the cell behind it", () => {
    const marked = composeMapImage(scene({ behind: "rock" }));
    const contested = intersect(changedPixels(marked, plain), characterPixels);
    expect(contested.length).toBeGreaterThan(0);

    const both = composeMapImage(
      scene({ behind: "rock", withCharacter: true })
    );
    const lost = contested.filter(
      (index) => !samePixel(both, withCharacter, index)
    );
    expect(lost).toEqual([]);
  });
});
