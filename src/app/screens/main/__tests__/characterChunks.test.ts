import { beforeAll, describe, expect, it, vi } from "vitest";
import { Container, Graphics, Mesh, Ticker } from "pixi.js";
import { buildHeadlessMap } from "./composeMapImage";
import { Map as IsometricMap, MapData } from "../Map";
import { GlobalIsoCoordinates } from "../IsometricCoordinate";
import { MapChunk } from "../MapChunk";

/**
 * The live block: the square of chunks a character is in, drawn as one
 * container so that its sprite can interleave with their cells.
 *
 * What is asserted here is the bookkeeping, not the depth order —
 * characterDrawOrder.test.ts owns that. A cell must be drawn exactly once
 * wherever it currently lives, and the chunks must get their cells back when
 * the character walks away, or the map would slowly hand everything it owns to
 * a single container and lose its chunking altogether.
 */

const CHARACTER = "005-reptincel";

/**
 * A long walkway that stops exactly on the chunk boundary at e = 8, so a
 * character walking along its edge crosses a boundary on every axis.
 */
const walkway = (): Record<string, string> => {
  const tiles: Record<string, string> = {};
  for (let s = 0; s <= 40; s++) {
    for (let e = 4; e <= 7; e++) {
      tiles[`${s},${e},0`] = "dirt";
    }
  }
  return tiles;
};

const tick = { deltaMS: 16, lastTime: 0 } as Ticker;

/** Chunks holding neither a cell nor a view: pure leak */
const emptyChunks = (map: IsometricMap) =>
  Object.entries(map.chunks)
    .filter(([, chunk]) => chunk.isEmpty && !chunk.hasViews)
    .map(([key]) => key);

/** The live block is the only child of the map that is not a chunk. */
const blockOf = (map: IsometricMap): Container | undefined =>
  map.children.find((child) => !(child instanceof MapChunk));

const descendants = (node: Container): Container[] =>
  node.children.flatMap((child) => [child, ...descendants(child)]);

/** Only character pieces are meshes: tiles and map objects are sprites. */
const characterPieces = (map: IsometricMap) =>
  descendants(map).filter((child) => child instanceof Mesh);

/**
 * Which side of the cell at the origin the cell `offset` away is on, by the
 * interval test along the view ray (1, 1, 2).
 */
const occlusion = (ds: number, de: number, du: number) => {
  const from = Math.max(ds - 1, de - 1, (du - 1) / 2);
  const to = Math.min(ds + 1, de + 1, (du + 1) / 2);
  if (from >= to) return "unrelated";
  return from >= 0 ? "front" : "behind";
};

/** Every offset at which a cell hides the one at the origin. */
const occludingOffsets = (() => {
  const offsets: [number, number, number][] = [];
  for (let ds = -8; ds <= 8; ds++) {
    for (let de = -8; de <= 8; de++) {
      for (let du = -16; du <= 16; du++) {
        if (occlusion(ds, de, du) === "front") offsets.push([ds, de, du]);
      }
    }
  }
  return offsets;
})();

describe("the live block", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("is ranked so that it never contradicts a chunk left outside it", () => {
    // What BLOCK_SIDE rests on. Merging chunks gives the whole set one rank
    // where each had its own, so a chunk outside can end up needing to be
    // drawn both before one block chunk and after another. Rather than trust
    // the argument in that doc-block — which was wrong twice before it was
    // right — take every pair of cells where one hides the other, keep the
    // pairs that straddle the block's edge, and check the ranks agree.
    const contradictions: string[] = [];
    let checked = 0;
    for (const size of [4, 8]) {
      for (const side of [2, 3]) {
        for (const [cs0, ce0] of [
          [0, 0],
          [-2, 1],
        ]) {
          // the rank syncBlock gives the block: its middle diagonal
          const rank = cs0 + ce0 + side - 1;
          const chunkOf = (v: number) => Math.floor(v / size);
          const inBlock = (s: number, e: number) =>
            chunkOf(s) >= cs0 &&
            chunkOf(s) < cs0 + side &&
            chunkOf(e) >= ce0 &&
            chunkOf(e) < ce0 + side;
          /** Where the cell is drawn among the map's children */
          const rankOf = (s: number, e: number) =>
            inBlock(s, e) ? rank : chunkOf(s) + chunkOf(e);

          const from = cs0 * size - 8;
          const to = (cs0 + side) * size + 8;
          const fromE = ce0 * size - 8;
          const toE = (ce0 + side) * size + 8;
          for (let s = from; s < to; s++) {
            for (let e = fromE; e < toE; e++) {
              for (let u = 0; u < 24; u++) {
                for (const [ds, de, du] of occludingOffsets) {
                  const fs = s + ds;
                  const fe = e + de;
                  // only pairs the block's edge runs between: the rest is
                  // settled inside one container, by the cells' own keys
                  if (inBlock(s, e) === inBlock(fs, fe)) continue;
                  checked++;
                  if (rankOf(fs, fe) > rankOf(s, e)) continue;
                  contradictions.push(
                    `size ${size} side ${side} at ${cs0},${ce0}: ${fs},${fe},${u + du} hides ${s},${e},${u} but is not drawn after it`
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(contradictions.slice(0, 3)).toEqual([]);
    // it would pass just as well examining nothing at all
    expect(checked).toBeGreaterThan(100_000);
  });

  it("never creates a chunk just by walking through it", () => {
    // The character used to hand its pieces to whichever chunk ordered them,
    // creating empty ones as it went and having to reclaim them. It draws in
    // the block now, so walking must not touch the set of chunks at all.
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "0,7.2,1": CHARACTER },
    } as MapData);
    const before = Object.keys(map.chunks).sort();
    expect(emptyChunks(map)).toEqual([]);

    for (let step = 0; step <= 200; step++) {
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
        step * 0.2,
        7.2,
        1
      );
      map.update(tick);
    }
    expect(Object.keys(map.chunks).sort()).toEqual(before);
    expect(emptyChunks(map)).toEqual([]);
    map.destroy({ children: true });
  });

  it("draws every cell exactly once, wherever it walks", () => {
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "0,7.2,1": CHARACTER },
    } as MapData);
    map.update(tick);
    // Everything the map draws that is a cell. The character's bands (meshes)
    // and its shadow (graphics) are the two things whose count varies as it
    // walks, and neither of them is a cell.
    const cellsDrawn = () =>
      descendants(map).filter(
        (child) =>
          child.parent === blockOf(map) &&
          !(child instanceof Mesh) &&
          !(child instanceof Graphics)
      ).length +
      Object.values(map.chunks).reduce(
        (total, chunk) => total + chunk.children.length,
        0
      );
    const expected = cellsDrawn();

    for (let step = 0; step <= 200; step++) {
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
        step * 0.2,
        7.2,
        1
      );
      map.update(tick);
      expect(cellsDrawn()).toBe(expected);
    }
    map.destroy({ children: true });
  });

  it("gives a chunk its cells back once the character has left it", () => {
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "4,5,1": CHARACTER },
    } as MapData);
    map.update(tick);
    const home = map.chunks["0,0,0"];
    // lent: the chunk draws nothing itself while it is in the block
    expect(home.children).toEqual([]);
    expect(home.hasViews).toBe(true);

    map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(36, 5, 1);
    map.update(tick);
    expect(home.children.length).toBeGreaterThan(0);
    map.destroy({ children: true });
  });

  it("takes the pieces of a character it replaces with it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "3.5,5,1": CHARACTER, "20.5,5,1": CHARACTER },
    } as MapData);

    expect(warn).toHaveBeenCalled();
    // exactly the pieces of the surviving character, nothing orphaned
    map.update(tick);
    expect(characterPieces(map)).toHaveLength(map.character!.bandCount);
    map.destroy({ children: true });
    warn.mockRestore();
  });
});
