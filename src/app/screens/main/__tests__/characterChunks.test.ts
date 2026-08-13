import { beforeAll, describe, expect, it, vi } from "vitest";
import { Container, Mesh, Ticker } from "pixi.js";
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

describe("the live block", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("reclaims the chunks it walked through", () => {
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "0,7.2,1": CHARACTER },
    } as MapData);
    expect(emptyChunks(map)).toEqual([]);

    for (let step = 0; step <= 200; step++) {
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
        step * 0.2,
        7.2,
        1
      );
      map.update(tick);
    }
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
    const drawn = () =>
      descendants(map).filter((child) => child.parent === blockOf(map)).length +
      Object.values(map.chunks).reduce(
        (total, chunk) => total + chunk.children.length,
        0
      );
    const expected = drawn();

    for (let step = 0; step <= 200; step++) {
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
        step * 0.2,
        7.2,
        1
      );
      map.update(tick);
      // the character's own pieces are the only thing whose count may vary
      expect(drawn() - map.character!.bandCount).toBe(
        expected - map.character!.bandCount
      );
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
