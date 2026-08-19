import { describe, expect, it } from "vitest";
import {
  CAMERA_SPEED,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraPan,
  cameraZoom,
  groundToWatch,
  nextCameraMode,
  settleLevel,
} from "./Camera";

const FRAME = 1 / 60;
const still = { x: 0, y: 0 };

/** Where the camera ends up after holding the stick for `frames` frames */
const hold = (stick: { x: number; y: number }, frames: number) => {
  let carried = still;
  const at = { x: 0, y: 0 };
  for (let frame = 0; frame < frames; frame++) {
    const step = cameraPan(carried, stick, FRAME);
    carried = step.carried;
    expect(Number.isInteger(step.move.x)).toBe(true);
    expect(Number.isInteger(step.move.y)).toBe(true);
    at.x += step.move.x;
    at.y += step.move.y;
  }
  return at;
};

describe("moving the camera with a stick", () => {
  it("pushes the view the way the stick points, at its stated speed", () => {
    // the view goes right, so the map goes left under it
    expect(hold({ x: 1, y: 0 }, 60).x).toBeCloseTo(-CAMERA_SPEED, 0);
    // and up the screen is a negative axis on a pad, so this is the view rising
    expect(hold({ x: 0, y: -1 }, 60).y).toBeGreaterThan(0);
  });

  it("still moves for a stick barely off centre", () => {
    // A sixth of a pixel a frame. Rounded on its own every frame it would be
    // nothing at all; carried, it comes to ten pixels a second.
    const nudge = 0.0167;
    expect(Math.round(nudge * CAMERA_SPEED * FRAME)).toBe(0);
    expect(Math.abs(hold({ x: nudge, y: 0 }, 60).x)).toBeGreaterThan(8);
  });
});

describe("zooming with the triggers", () => {
  const pull = (amount: number, frames: number, from = 1) => {
    let zoom = from;
    for (let frame = 0; frame < frames; frame++) {
      zoom = cameraZoom(zoom, amount, FRAME);
    }
    return zoom;
  };

  it("is the same gesture wherever it starts from", () => {
    // a ratio, not an amount: a quarter second of pulling multiplies the zoom
    // by the same factor at 0.5 as at 2, which is the whole point of not adding
    const factorAt = (from: number) => pull(1, 15, from) / from;
    expect(factorAt(0.5)).toBeCloseTo(factorAt(2), 6);
    // and a trigger only brushed moves it slowly rather than in the same jump
    expect(pull(0.1, 60)).toBeGreaterThan(1);
    expect(pull(0.1, 60)).toBeLessThan(pull(1, 60));
  });

  it("stops at both ends", () => {
    expect(pull(1, 600)).toBe(MAX_ZOOM);
    expect(pull(-1, 600)).toBe(MIN_ZOOM);
  });
});

describe("which level a following camera watches", () => {
  it("watches the ground it is standing on", () => {
    expect(groundToWatch(1, { standing: 5, feet: 5, grounded: true })).toBe(5);
  });

  it("holds the floor it left for the whole of a jump", () => {
    // however high it goes, and over a gap between two pillars of a height,
    // where the ground underneath drops away at once and used to send the
    // camera diving and back
    for (const feet of [5.2, 7.5, 10]) {
      expect(groundToWatch(5, { standing: 5, feet, grounded: false })).toBe(5);
    }
    expect(groundToWatch(5, { standing: 1, feet: 6.4, grounded: false })).toBe(
      5
    );
  });

  it("comes down with the character, at its own speed and no faster", () => {
    for (const feet of [4.5, 3, 1.2]) {
      expect(groundToWatch(5, { standing: 1, feet, grounded: false })).toBe(
        feet
      );
    }
  });

  it("waits until it has landed before rising to a higher floor", () => {
    expect(groundToWatch(1, { standing: 5, feet: 3, grounded: false })).toBe(1);
    expect(groundToWatch(1, { standing: 5, feet: 5, grounded: true })).toBe(5);
  });
});

describe("settling the camera over a change of level", () => {
  /** Where it and its speed have got to after `seconds`, cut into frames */
  const after = (seconds: number, step = FRAME) => {
    let at = { level: 0, velocity: 0 };
    for (let frame = 0; frame < Math.round(seconds / step); frame++) {
      at = settleLevel(at.level, at.velocity, 1, step);
    }
    return at;
  };

  it("starts from a standstill and still arrives quickly", () => {
    // the whole point of a spring here: an ease is at its fastest the instant
    // the target moves, which is what reads as a jolt when it steps a level. An
    // ease at the same stiffness covers 0.28 of the step in the first frame.
    const first = settleLevel(0, 0, 1, FRAME);
    expect(first.level).toBeGreaterThan(0);
    expect(first.level).toBeLessThan(0.06);
    // gentler must not mean laggy, which is where RISE_SPEED is set
    expect(after(0.2).level).toBeGreaterThan(0.85);
  });

  it("never overshoots, up or down", () => {
    let at = { level: 0, velocity: 0 };
    for (let frame = 0; frame < 120; frame++) {
      at = settleLevel(at.level, at.velocity, 1, FRAME);
      expect(at.level).toBeLessThanOrEqual(1);
    }
    at = { level: 1, velocity: 0 };
    for (let frame = 0; frame < 120; frame++) {
      at = settleLevel(at.level, at.velocity, 0, FRAME);
      expect(at.level).toBeGreaterThanOrEqual(0);
    }
  });

  it("does not care how the seconds are cut into frames", () => {
    // otherwise the camera settles at a speed that depends on the machine
    expect(after(0.2).level).toBeCloseTo(after(0.2, 1 / 120).level, 6);
  });

  it("settles rather than creeping towards it for ever", () => {
    // an asymptote would keep the rounded viewport twitching by a pixel
    expect(settleLevel(1 - 1e-9, 0, 1, FRAME)).toEqual({
      level: 1,
      velocity: 0,
    });
  });

  it("keeps up with a target that never stops moving", () => {
    // a fall: the camera trails a fixed distance rather than falling further
    // behind, about twice the speed of the drop over RISE_SPEED
    let at = { level: 10, velocity: 0 };
    let feet = 10;
    for (let frame = 0; frame < 60; frame++) {
      feet -= 0.2;
      at = settleLevel(at.level, at.velocity, feet, FRAME);
    }
    expect(at.level - feet).toBeLessThan(1.5);
    expect(at.velocity).toBeCloseTo(-12, 0);
  });
});

describe("the two camera modes", () => {
  const push = { x: 0.8, y: 0 };

  it("follows from R3 and lets go on the next touch of the stick", () => {
    expect(nextCameraMode("free", { recentred: true, stick: still })).toBe(
      "following"
    );
    expect(
      nextCameraMode("following", { recentred: false, stick: still })
    ).toBe("following");
    expect(nextCameraMode("following", { recentred: false, stick: push })).toBe(
      "free"
    );
  });

  it("takes the press over a hand already resting on the stick", () => {
    // otherwise R3 would do nothing at all to someone holding the stick
    expect(nextCameraMode("free", { recentred: true, stick: push })).toBe(
      "following"
    );
  });
});
