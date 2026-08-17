import { beforeAll, describe, expect, it, vi } from "vitest";
import { Container, Graphics, Ticker } from "pixi.js";
import { buildHeadlessMap } from "./composeMapImage";
import { GlobalIsoCoordinates } from "../IsometricCoordinate";
import type { Map as IsometricMap, MapData } from "../Map";

// the overlay only draws while the depth-order view is on, and nothing can
// press F10 in node
let overlayOn = true;
vi.mock("../DebugView", () => ({
  debugViewEnabled: () => overlayOn,
  listenForDebugViewToggle: () => {},
}));

/**
 * DEBUG — the red line along every chunk boundary. See Map.syncChunkBounds.
 *
 * Asserted through what it draws rather than through the rule it draws by: the
 * point of the overlay is that a boundary is visible on screen, and counting
 * the rectangles is the closest a headless test gets to looking at it.
 */
describe("the chunk boundary overlay", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  /** Flat ground, twelve cells square, cut into nine chunks of four */
  const flat = (characters: Record<string, string> = {}): IsometricMap => {
    const tiles: Record<string, string> = {};
    for (let s = 0; s < 12; s++) {
      for (let e = 0; e < 12; e++) tiles[`${s},${e},0`] = "dirt";
    }
    return buildHeadlessMap({ tiles, objects: {}, characters } as MapData, 4);
  };

  const tick = { deltaMS: 1000 / 60, lastTime: 0 } as Ticker;

  /** The overlay sits just under the depth-key labels */
  const overlayOf = (map: IsometricMap): Container =>
    map.children.find(
      (child) => child.zIndex === Number.MAX_SAFE_INTEGER - 1
    ) as Container;

  /** How many rectangles the whole overlay currently paints */
  const rects = (map: IsometricMap): number =>
    overlayOf(map)
      .children.filter((child): child is Graphics => child instanceof Graphics)
      .reduce(
        (total, line) =>
          total +
          line.context.instructions.reduce(
            (count, instruction) =>
              count +
              ((
                instruction.data as {
                  path?: { instructions?: { action: string }[] };
                }
              ).path?.instructions?.filter((step) => step.action === "rect")
                .length ?? 0),
            0
          ),
        0
      );

  it("draws a line on the boundary cells and nowhere else", () => {
    const map = flat();
    map.update(tick);
    const painted = rects(map);
    expect(painted).toBeGreaterThan(0);
    // one Graphics per chunk, three by three
    expect(overlayOf(map).children).toHaveLength(9);

    // A cell in the middle of its chunk is on no boundary, so taking it away
    // cannot change the line — and the overlay has to notice it was edited at
    // all, which is what the chunk's revision counter is for.
    map.removeEntityAt(new GlobalIsoCoordinates(6, 6, 0));
    map.update(tick);
    expect(rects(map)).toBe(painted);

    // one on a boundary does: local s === 0 for a chunk starting at s = 4
    map.removeEntityAt(new GlobalIsoCoordinates(4, 6, 0));
    map.update(tick);
    expect(rects(map)).toBeLessThan(painted);

    map.destroy({ children: true });
  });

  it("leaves out the boundaries the live block has dissolved", () => {
    // While four chunks lend their cells to one container they are one for the
    // draw order, so the two seams inside the block are not boundaries any
    // more. What has to survive is the block's own outline.
    const alone = flat();
    alone.update(tick);
    const whole = rects(alone);
    alone.destroy({ children: true });

    const withCharacter = flat({ "5,5,4": "005-reptincel" });
    for (let frame = 0; frame < 120; frame++) withCharacter.update(tick);
    const cut = rects(withCharacter);
    expect(cut).toBeLessThan(whole);

    // and it follows the character: standing somewhere the block covers a
    // different pair of chunks dissolves a different set of seams
    withCharacter.character!.globalIsoCoordinates = new GlobalIsoCoordinates(
      1,
      1,
      1
    );
    withCharacter.update(tick);
    const movedAway = rects(withCharacter);
    expect(movedAway).toBeLessThan(whole);
    expect(movedAway).not.toBe(cut);
    withCharacter.destroy({ children: true });
  });

  it("goes away with the overlay", () => {
    const map = flat();
    map.update(tick);
    expect(overlayOf(map).visible).toBe(true);

    overlayOn = false;
    try {
      map.update(tick);
      expect(overlayOf(map).visible).toBe(false);
    } finally {
      overlayOn = true;
    }
    map.update(tick);
    expect(overlayOf(map).visible).toBe(true);
    map.destroy({ children: true });
  });
});
