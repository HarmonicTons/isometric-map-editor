import { beforeAll, describe, expect, it, vi } from "vitest";
import { Container, Graphics, Ticker } from "pixi.js";
import {
  fallVelocity,
  Map as IsometricMap,
  MapData,
  walkVelocity,
} from "./Map";
import { buildHeadlessMap } from "./__tests__/composeMapImage";
import { GlobalIsoCoordinates, MAP_MAX_HEIGHT } from "./IsometricCoordinate";

/** Where a walk of one second lands on screen, in pixels */
const onScreen = (leftStickX: number, leftStickY: number) => {
  const { s, e } = walkVelocity(leftStickX, leftStickY);
  return { x: 16 * (e - s), y: 8 * (e + s) };
};

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Full deflection of the stick, all the way round */
const allDirections = Array.from({ length: 24 }, (_unused, index) => {
  const angle = (index / 24) * 2 * Math.PI;
  return [Math.cos(angle), Math.sin(angle)] as const;
});

/** Ground covered per second, which is what the grid measures */
const pace = (leftStickX: number, leftStickY: number) => {
  const { s, e } = walkVelocity(leftStickX, leftStickY);
  return round(Math.hypot(s, e));
};

describe("walkVelocity", () => {
  // Never the value of CHARACTER_SPEED, always a relation between two of
  // these: the speed is a knob, and a test that pins the knob is a test that
  // has to be edited every time it is turned.
  it("walks the same distance in every direction", () => {
    // What the grid measures, not what the screen shows. The two differ by the
    // 2:1 squash of the projection, and it is the grid that the ground, the
    // collisions and the walk cycle all live in.
    const speeds = allDirections.map(([x, y]) => pace(x, y));
    expect(new Set(speeds).size).toBe(1);
    expect(speeds[0]).toBeGreaterThan(0);
  });

  it("moves half as fast up and down the screen as across it", () => {
    // The point of the above, seen from the other side: covering the same
    // ground takes twice as long on screen when the projection halves it.
    expect(round(onScreen(1, 0).y)).toBe(0);
    expect(round(onScreen(0, 1).x)).toBe(0);
    expect(round(onScreen(1, 0).x / onScreen(0, 1).y)).toBe(2);
  });

  it("goes where the stick points", () => {
    for (const [x, y] of allDirections) {
      const screen = onScreen(x, y);
      // same bearing as the stick, to within a rounding error
      const wanted = Math.atan2(y, x);
      const got = Math.atan2(screen.y, screen.x);
      expect(round(Math.abs(wanted - got))).toBeLessThan(0.001);
    }
  });

  it("does not reward pushing the stick into a corner", () => {
    // The deflection is clamped, not the resulting speed: half a push is still
    // half the pace.
    expect(pace(1, 1)).toBe(pace(1, 0));
    expect(pace(0.5, 0)).toBe(round(pace(1, 0) / 2));
  });

  it("stands still on a centred stick", () => {
    expect(walkVelocity(0, 0)).toEqual({ s: 0, e: 0 });
  });
});

/** One frame at 60 Hz */
const FRAME = 1 / 60;

/** Where a jump takes the character, integrated frame by frame */
const jumpArc = () => {
  const heights: number[] = [];
  let speed = fallVelocity(0, { grounded: true, jump: true, seconds: FRAME });
  let height = 0;
  // until it is back where it started
  for (let frame = 0; frame < 600 && (height > 0 || speed > 0); frame++) {
    height += speed * FRAME;
    heights.push(height);
    speed = fallVelocity(speed, {
      grounded: false,
      jump: false,
      seconds: FRAME,
    });
  }
  return heights;
};

describe("fallVelocity", () => {
  it("stays put on the ground with nothing pressed", () => {
    // it keeps asking to go down; the floor is what refuses
    expect(
      fallVelocity(0, { grounded: true, jump: false, seconds: FRAME })
    ).toBeLessThan(0);
    // and the speed it landed with is not carried into the next frame
    const landed = fallVelocity(-12, {
      grounded: true,
      jump: false,
      seconds: FRAME,
    });
    expect(landed).toBe(
      fallVelocity(0, { grounded: true, jump: false, seconds: FRAME })
    );
  });

  it("leaves the ground when A is pressed", () => {
    expect(
      fallVelocity(0, { grounded: true, jump: true, seconds: FRAME })
    ).toBeGreaterThan(0);
  });

  it("ignores A in mid-air", () => {
    const falling = fallVelocity(-3, {
      grounded: false,
      jump: true,
      seconds: FRAME,
    });
    expect(falling).toBe(
      fallVelocity(-3, { grounded: false, jump: false, seconds: FRAME })
    );
  });

  it("clears a cell and comes back down", () => {
    const arc = jumpArc();
    // high enough to climb onto anything one cell tall, not so high it flies
    expect(Math.max(...arc)).toBeGreaterThan(1.1);
    expect(Math.max(...arc)).toBeLessThan(1.5);
    // and it is over quickly: a jump is not a float
    expect(arc.length * FRAME).toBeLessThan(0.7);
  });

  it("never falls fast enough to cross a cell in one frame", () => {
    let speed = 0;
    for (let frame = 0; frame < 600; frame++) {
      speed = fallVelocity(speed, {
        grounded: false,
        jump: false,
        seconds: FRAME,
      });
    }
    expect(Math.abs(speed * FRAME)).toBeLessThan(1);
  });
});

/** Five cells square of ground at u = 0, with a character dropped over it */
const floor = (): MapData => {
  const tiles: Record<string, string> = {};
  for (let s = 2; s <= 6; s++) {
    for (let e = 2; e <= 6; e++) tiles[`${s},${e},0`] = "dirt";
  }
  return { tiles, objects: {}, characters: { "4,4,6": "005-reptincel" } };
};

describe("a character falling onto the ground", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  it("lands on it and stops there", () => {
    const map = buildHeadlessMap(floor());
    const tick = { deltaMS: 1000 / 60, lastTime: 0 } as Ticker;
    for (let frame = 0; frame < 120; frame++) map.update(tick);
    // the floor occupies u = 0, so its feet rest at u = 1
    expect(map.character!.globalIsoCoordinates.u).toBe(1);
    expect(map.character!.verticalSpeed).toBe(0);
    map.destroy({ children: true });
  });

  it("goes up before it comes down when it is given a jump", () => {
    const map = buildHeadlessMap(floor());
    const tick = { deltaMS: 1000 / 60, lastTime: 0 } as Ticker;
    for (let frame = 0; frame < 120; frame++) map.update(tick);

    map.character!.verticalSpeed = 10;
    let highest = 1;
    for (let frame = 0; frame < 120; frame++) {
      map.update(tick);
      highest = Math.max(highest, map.character!.globalIsoCoordinates.u);
    }
    expect(highest).toBeGreaterThan(2);
    expect(map.character!.globalIsoCoordinates).toEqual(
      new GlobalIsoCoordinates(4, 4, 1)
    );
    map.destroy({ children: true });
  });
});

/** The pieces of shadow that currently paint something */
const shadowsOf = (node: Container): Graphics[] =>
  node.children.flatMap((child) => [
    ...(child instanceof Graphics && child.width > 0 ? [child] : []),
    ...shadowsOf(child),
  ]);

/**
 * The level the shadow landed on, read back from its depth key: a key is
 * DIAGONAL_WEIGHT · (s + e) + u, and a shadow takes a quarter more.
 */
const levelOf = (piece: Graphics) => (piece.zIndex - 0.25) % MAP_MAX_HEIGHT;

/** The patch of map the shadow currently covers, in map pixels */
const whereItLands = (map: Container) => {
  const tops = shadowsOf(map).map(
    (piece) => piece.y + piece.getLocalBounds().y
  );
  const bottoms = shadowsOf(map).map(
    (piece) => piece.y + piece.getLocalBounds().maxY
  );
  return {
    top: Math.min(...tops),
    height: Math.max(...bottoms) - Math.min(...tops),
  };
};

describe("the character's shadow", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  /** A map whose character has landed and stopped */
  const landed = (data = floor()): IsometricMap => {
    const map = buildHeadlessMap(data);
    const tick = { deltaMS: 1000 / 60, lastTime: 0 } as Ticker;
    for (let frame = 0; frame < 120; frame++) map.update(tick);
    return map;
  };

  it("lies on the ground below the character", () => {
    const map = landed();
    const pieces = shadowsOf(map);
    expect(pieces.length).toBeGreaterThan(0);
    // the floor occupies u = 0, and every piece landed on it
    for (const piece of pieces) expect(levelOf(piece)).toBe(0);
    map.destroy({ children: true });
  });

  it("is drawn over the ground it lies on and under the character", () => {
    const map = landed();
    for (const piece of shadowsOf(map)) {
      // a quarter above the key of the cell it lies on, so over that cell...
      expect(piece.zIndex % 1).toBe(0.25);
      // ...and under every band of the character, which is what keeping the
      // shadow inside the footprint buys: no cell it lands on is ever in
      // front of the character it belongs to.
      for (const band of map.character!.slicing!.bands) {
        expect(band.zIndex).toBeGreaterThan(piece.zIndex);
      }
    }
    map.destroy({ children: true });
  });

  it("stays on the ground while the character is above it", () => {
    // What it is for: the height of a jump is only readable against something
    // that does not move with it.
    const map = landed();
    const onTheGround = whereItLands(map);
    map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(4, 4, 3);
    map.update({ deltaMS: 1000 / 60, lastTime: 0 } as Ticker);
    expect(whereItLands(map)).toEqual(onTheGround);
    map.destroy({ children: true });
  });

  it("keys every piece to the cell it lies on, not to the last of them", () => {
    // One key for the whole shadow reads much better than a key per cell, and
    // is wrong: it lifts the pieces lying on cells behind — the ones a
    // character on an edge drops into the hole beside it — over the tile and
    // over the character that ought to hide them. A character straddling two
    // diagonals is what tells the two apart.
    const map = landed();
    map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(4.5, 4, 1);
    map.update({ deltaMS: 1000 / 60, lastTime: 0 } as Ticker);
    const keys = shadowsOf(map).map((piece) => piece.zIndex);
    expect(new Set(keys).size).toBe(keys.length);
    // and each of them a quarter above a real cell of the map
    for (const key of keys) expect(key % 1).toBe(0.25);
    map.destroy({ children: true });
  });

  it("keeps the piece under the character below its sprite", () => {
    // The cell it stands on is the nearest of them, so its piece is the one
    // that can reach the sprite at all.
    const map = landed();
    const lowest = Math.min(
      ...map.character!.slicing!.bands.map((band) => band.zIndex)
    );
    expect(Math.min(...shadowsOf(map).map((p) => p.zIndex))).toBeLessThan(
      lowest
    );
    map.destroy({ children: true });
  });

  it("follows the ground down over the edge of a step", () => {
    // A character on the lip of a step: the half of its shadow that misses the
    // step has to land a level below, not hang in the air beside it. The same
    // character in the same place, once on a plateau and once on its edge, is
    // what isolates the step from everything else.
    const plateau = (stepAt?: number): MapData => {
      const tiles: Record<string, string> = {};
      for (let s = 2; s <= 6; s++) {
        for (let e = 2; e <= 6; e++) {
          tiles[`${s},${e},0`] = "dirt";
          if (stepAt === undefined || s < stepAt) tiles[`${s},${e},1`] = "dirt";
        }
      }
      return { tiles, objects: {}, characters: { "3,4,6": "005-reptincel" } };
    };
    /** How tall the shadow is with the character straddling s = 5 */
    const spread = (data: MapData) => {
      const map = landed(data);
      map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(4.3, 4, 2);
      map.update({ deltaMS: 1000 / 60, lastTime: 0 } as Ticker);
      const { height } = whereItLands(map);
      map.destroy({ children: true });
      return height;
    };

    // exactly one cell lower, which is eight pixels of screen
    expect(spread(plateau(5)) - spread(plateau())).toBe(8);
  });

  it("is not drawn when there is nothing below to catch it", () => {
    const map = landed();
    map.character!.globalIsoCoordinates = new GlobalIsoCoordinates(20, 20, 3);
    map.update({ deltaMS: 1000 / 60, lastTime: 0 } as Ticker);
    expect(shadowsOf(map)).toEqual([]);
    map.destroy({ children: true });
  });
});

describe("a tile with something floating over it", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  /** A tile's shade is the one Graphics among its fragments */
  const isShaded = (map: IsometricMap, s: number, e: number, u: number) => {
    const tile = map.getEntityAt(new GlobalIsoCoordinates(s, e, u));
    expect(tile).toBeDefined();
    return tile!.children.some((child) => child instanceof Graphics);
  };

  /** A floor at u = 0, with whatever is passed floating over it */
  const under = (floating: Record<string, string>): IsometricMap => {
    const tiles: Record<string, string> = { ...floating };
    for (let s = 2; s <= 6; s++) {
      for (let e = 2; e <= 6; e++) tiles[`${s},${e},0`] = "dirt";
    }
    return buildHeadlessMap({ tiles, objects: {}, characters: {} } as MapData);
  };

  it("is shaded, and its neighbours are not", () => {
    const map = under({ "4,4,2": "dirt" });
    expect(isShaded(map, 4, 4, 0)).toBe(true);
    expect(isShaded(map, 3, 4, 0)).toBe(false);
    expect(isShaded(map, 4, 3, 0)).toBe(false);
    // and the floating tile itself has nothing over it
    expect(isShaded(map, 4, 4, 2)).toBe(false);
    map.destroy({ children: true });
  });

  it("needs a gap: a tile resting on another casts nothing", () => {
    // there is nowhere for the shadow to fall, and no face to fall on
    const map = under({ "4,4,1": "dirt" });
    expect(isShaded(map, 4, 4, 0)).toBe(false);
    expect(isShaded(map, 4, 4, 1)).toBe(false);
    map.destroy({ children: true });
  });

  it("is shaded from any height", () => {
    // a shadow does not fade with distance here any more than a character's
    const map = under({ "4,4,40": "dirt" });
    expect(isShaded(map, 4, 4, 0)).toBe(true);
    map.destroy({ children: true });
  });

  it("catches up when the map is edited under it", () => {
    const map = under({});
    expect(isShaded(map, 4, 4, 0)).toBe(false);
    map.addTileAt(new GlobalIsoCoordinates(4, 4, 9), "dirt" as never);
    expect(isShaded(map, 4, 4, 0)).toBe(true);
    map.removeEntityAt(new GlobalIsoCoordinates(4, 4, 9));
    expect(isShaded(map, 4, 4, 0)).toBe(false);
    map.destroy({ children: true });
  });
});
