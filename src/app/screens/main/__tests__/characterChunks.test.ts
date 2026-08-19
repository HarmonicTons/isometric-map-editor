import { beforeAll, describe, expect, it, vi } from "vitest";
import { Container, Mesh, Ticker } from "pixi.js";
import { buildHeadlessMap } from "./composeMapImage";
import { Map as IsometricMap, MapData } from "../Map";
import { GlobalIsoCoordinates } from "../IsometricCoordinate";
import { MapChunk } from "../MapChunk";

/**
 * A character drawn by the chunks it stands over — the bookkeeping, not the
 * depth order (characterDrawOrder.test.ts owns that). A piece must be in the
 * right chunk, leave it when the character does, and never conjure a chunk into
 * existence on its way past.
 */

const CHARACTER = "0004-charmander";

/**
 * A long walkway straddling the chunk boundary at e = 8, so a character
 * walking along it crosses a boundary on every axis.
 */
const walkway = (): Record<string, string> => {
  const tiles: Record<string, string> = {};
  for (let s = 0; s <= 40; s++) {
    for (let e = 4; e <= 11; e++) {
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

describe("a character drawn by the chunks it stands over", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("is safe to put in a chunk, since chunks never contradict a cell key", () => {
    // What the whole thing rests on. A chunk is atomic in the draw order and
    // ranked by its diagonal alone, so a piece dropped into one inherits that
    // rank against every cell outside it. That is only sound if the coarse
    // rank never disagrees with the cell keys it stands in for. Rather than
    // trust the argument — the block's version of it was wrong twice before it
    // was right — take every pair of cells where one hides the other, keep the
    // pairs that straddle a chunk boundary, and check the ranks agree.
    const contradictions: string[] = [];
    let checked = 0;
    for (const size of [4, 8]) {
      const chunkOf = (v: number) => Math.floor(v / size);
      const rankOf = (s: number, e: number) => chunkOf(s) + chunkOf(e);
      const sameChunk = (s: number, e: number, fs: number, fe: number) =>
        chunkOf(s) === chunkOf(fs) && chunkOf(e) === chunkOf(fe);
      for (let s = -size; s < 2 * size; s++) {
        for (let e = -size; e < 2 * size; e++) {
          for (let u = 0; u < 24; u++) {
            for (const [ds, de, du] of occludingOffsets) {
              const fs = s + ds;
              const fe = e + de;
              // only pairs a boundary runs between: the rest is settled inside
              // one container, by the cells' own keys
              if (sameChunk(s, e, fs, fe)) continue;
              checked++;
              if (rankOf(fs, fe) > rankOf(s, e)) continue;
              contradictions.push(
                `size ${size}: ${fs},${fe},${u + du} hides ${s},${e},${u} but is not drawn after it`
              );
            }
          }
        }
      }
    }
    expect(contradictions.slice(0, 3)).toEqual([]);
    // it would pass just as well examining nothing at all
    expect(checked).toBeGreaterThan(100_000);
  });

  it("puts every piece in the chunk that owns its column", () => {
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "7.6,7.6,1": CHARACTER },
    } as MapData);
    map.update(tick);
    // By key rather than by identity: two columns on the same diagonal take
    // the same key — they never hide one another — so which mesh is which is
    // not a question, and where each key is drawn is the whole of it.
    const keysPerChunk = (
      entries: { chunk: string; zIndex: number }[]
    ): Record<string, number[]> => {
      const grouped: Record<string, number[]> = {};
      for (const { chunk, zIndex } of entries) {
        (grouped[chunk] ??= []).push(zIndex);
      }
      for (const keys of Object.values(grouped)) keys.sort();
      return grouped;
    };

    const wanted = keysPerChunk(
      map.character!.slicing!.pieces.map((cut) => ({
        chunk: `${Math.floor(cut.s / 8)},${Math.floor(cut.e / 8)},0`,
        zIndex: cut.zIndex,
      }))
    );
    // the position is a corner of four chunks: this checks all of them
    expect(Object.keys(wanted)).toHaveLength(4);
    expect(
      keysPerChunk(
        characterPieces(map).map((mesh) => ({
          chunk: (mesh.parent as MapChunk).chunkIsoCoordinates.toString(),
          zIndex: mesh.zIndex,
        }))
      )
    ).toEqual(wanted);
    map.destroy({ children: true });
  });

  it("never creates a chunk just by walking through it", () => {
    // Walking must not touch the set of chunks at all: a piece is drawn by a
    // chunk that is already there, or the character has left the map — which
    // Map.isSolidAt makes impossible.
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

  it("leaves no piece behind in a chunk it has walked out of", () => {
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "0,7.2,1": CHARACTER },
    } as MapData);
    map.update(tick);
    const cells = Object.values(map.chunks).reduce(
      (total, chunk) => total + chunk.children.length,
      0
    );

    for (let step = 0; step <= 200; step++) {
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
        step * 0.2,
        7.2,
        1
      );
      map.update(tick);
      // exactly the pieces it is currently cut into, nowhere else
      expect(characterPieces(map)).toHaveLength(
        map.character!.slicing!.pieces.length
      );
    }
    // and the cells are back to exactly what they were, none added or dropped
    map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(0, 7.2, 1);
    map.update(tick);
    expect(
      Object.values(map.chunks).reduce(
        (total, chunk) => total + chunk.children.length,
        0
      )
    ).toBe(cells);
    map.destroy({ children: true });
  });

  it("cannot walk off the map, so there is always a chunk to draw it in", () => {
    // What makes chunkOver total, and the reason it may simply throw. The wall
    // is at the edge of the CHUNKS, not of the terrain: the walkway stops at
    // e = 11, so the character does fall off it, and the map stops at e = 15.
    const map = buildHeadlessMap({
      tiles: walkway(),
      objects: {},
      characters: { "4,10,1": CHARACTER },
    } as MapData);
    // straight down the screen, far enough to cross the map several times over
    vi.stubGlobal("navigator", {
      getGamepads: () => [{ axes: [0, 1], buttons: [{ pressed: false }] }],
    });
    try {
      for (let frame = 0; frame < 600; frame++) map.update(tick);
    } finally {
      vi.unstubAllGlobals();
    }
    // it left the walkway and fell, and stopped at the last column of chunk 1
    expect(map.character!.globalIsoCoordinates.u).toBeLessThan(0);
    expect(map.character!.globalIsoCoordinates.e).toBeGreaterThan(11);
    expect(map.character!.globalIsoCoordinates.e).toBeLessThan(16);
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
    expect(characterPieces(map)).toHaveLength(
      map.character!.slicing!.pieces.length
    );
    map.destroy({ children: true });
    warn.mockRestore();
  });
});
