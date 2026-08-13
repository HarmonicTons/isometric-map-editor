import { beforeAll, describe, expect, it, vi } from "vitest";
import { Ticker } from "pixi.js";
import { fallVelocity, MapData, walkVelocity } from "./Map";
import { buildHeadlessMap } from "./__tests__/composeMapImage";
import { GlobalIsoCoordinates } from "./IsometricCoordinate";

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

describe("a character falling onto the ground", () => {
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  const floor = (): MapData => {
    const tiles: Record<string, string> = {};
    for (let s = 2; s <= 6; s++) {
      for (let e = 2; e <= 6; e++) tiles[`${s},${e},0`] = "dirt";
    }
    return { tiles, objects: {}, characters: { "4,4,6": "005-reptincel" } };
  };

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
