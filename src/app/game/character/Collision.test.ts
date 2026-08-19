import { describe, expect, it } from "vitest";
import { fallVelocity, jumpSpeedFor, walkVelocity } from "./Collision";

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
  // Never the value of CHARACTER_SPEED, always a relation between two of these:
  // a test that pins a knob has to be edited every time it is turned.
  it("walks the same distance in every direction", () => {
    // In the grid, not on the screen: the two differ by the projection's 2:1
    // squash, and the grid is where collisions and the walk cycle live.
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
const jumpArc = (bodyHeight: number) => {
  const jumpSpeed = jumpSpeedFor(bodyHeight);
  const heights: number[] = [];
  let speed = fallVelocity(0, {
    grounded: true,
    jump: true,
    jumpSpeed,
    seconds: FRAME,
  });
  let height = 0;
  // until it is back where it started
  for (let frame = 0; frame < 600 && (height > 0 || speed > 0); frame++) {
    height += speed * FRAME;
    heights.push(height);
    speed = fallVelocity(speed, {
      grounded: false,
      jump: false,
      jumpSpeed,
      seconds: FRAME,
    });
  }
  return heights;
};

/** The shortest thing imported so far, and so the smallest jump in the game */
/** A body of a plausible size, for the tests that need one */
const JUMP = jumpSpeedFor(1.5);

describe("fallVelocity", () => {
  it("stays put on the ground with nothing pressed", () => {
    // it keeps asking to go down; the floor is what refuses
    expect(
      fallVelocity(0, {
        grounded: true,
        jump: false,
        jumpSpeed: JUMP,
        seconds: FRAME,
      })
    ).toBeLessThan(0);
    // and the speed it landed with is not carried into the next frame
    const landed = fallVelocity(-12, {
      grounded: true,
      jump: false,
      jumpSpeed: JUMP,
      seconds: FRAME,
    });
    expect(landed).toBe(
      fallVelocity(0, {
        grounded: true,
        jump: false,
        jumpSpeed: JUMP,
        seconds: FRAME,
      })
    );
  });

  it("leaves the ground when A is pressed", () => {
    expect(
      fallVelocity(0, {
        grounded: true,
        jump: true,
        jumpSpeed: JUMP,
        seconds: FRAME,
      })
    ).toBeGreaterThan(0);
  });

  it("ignores A in mid-air", () => {
    const falling = fallVelocity(-3, {
      grounded: false,
      jump: true,
      jumpSpeed: JUMP,
      seconds: FRAME,
    });
    expect(falling).toBe(
      fallVelocity(-3, {
        grounded: false,
        jump: false,
        jumpSpeed: JUMP,
        seconds: FRAME,
      })
    );
  });

  it("takes a character as high as it is tall", () => {
    // measured off the arc the game actually walks, which overshoots the true
    // apex by half a frame of speed — hence the loose bound
    for (const height of [1.5, 2.5, 5]) {
      expect(Math.max(...jumpArc(height))).toBeCloseTo(height, 0);
    }
    // and it is over quickly: a jump is not a float
    expect(jumpArc(1.5).length * FRAME).toBeLessThan(0.8);
  });

  it("never lets anything be too short to climb a step", () => {
    // Nothing imported is anywhere near this — it is what keeps a future
    // character from being unable to get onto the scenery at all.
    expect(jumpSpeedFor(0.4)).toBe(jumpSpeedFor(1));
    expect(Math.max(...jumpArc(0.4))).toBeGreaterThan(1);
  });
});
