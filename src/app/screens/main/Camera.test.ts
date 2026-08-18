import { describe, expect, it, vi } from "vitest";
import {
  CAMERA_SPEED,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_SPEED,
  cameraPan,
  cameraZoom,
  groundToWatch,
  nextCameraMode,
  settleLevel,
} from "./Camera";
import { sampleGamepad } from "./Gamepad";

const FRAME = 1 / 60;
const still = { x: 0, y: 0 };

/** Where the camera ends up after holding the stick for `frames` frames */
const hold = (stick: { x: number; y: number }, frames: number) => {
  let carried = still;
  const at = { x: 0, y: 0 };
  for (let frame = 0; frame < frames; frame++) {
    const step = cameraPan(carried, stick, FRAME);
    carried = step.carried;
    at.x += step.move.x;
    at.y += step.move.y;
  }
  return at;
};

describe("moving the camera with a stick", () => {
  it("pushes the view the way the stick points", () => {
    // the view goes right, so the map goes left under it
    expect(hold({ x: 1, y: 0 }, 60).x).toBeLessThan(0);
    expect(hold({ x: -1, y: 0 }, 60).x).toBeGreaterThan(0);
    // and up the screen is a negative axis on a pad, so this is the view rising
    expect(hold({ x: 0, y: -1 }, 60).y).toBeGreaterThan(0);
  });

  it("covers its stated speed in a second", () => {
    expect(Math.abs(hold({ x: 1, y: 0 }, 60).x)).toBeCloseTo(CAMERA_SPEED, 0);
  });

  it("lands on whole pixels", () => {
    let carried = still;
    for (let frame = 0; frame < 120; frame++) {
      const step = cameraPan(carried, { x: 0.37, y: -0.11 }, FRAME);
      carried = step.carried;
      expect(Number.isInteger(step.move.x)).toBe(true);
      expect(Number.isInteger(step.move.y)).toBe(true);
    }
  });

  it("still moves for a stick barely off centre", () => {
    // A sixth of a pixel a frame. Rounded on its own every frame it would be
    // nothing at all; carried, it comes to ten pixels a second.
    const nudge = 0.0167;
    const perFrame = nudge * CAMERA_SPEED * FRAME;
    expect(Math.round(perFrame)).toBe(0);
    expect(Math.abs(hold({ x: nudge, y: 0 }, 60).x)).toBeGreaterThan(8);
  });

  it("owes nothing once the stick is let go", () => {
    const { move, carried } = cameraPan({ x: 0.4, y: -0.4 }, still, FRAME);
    expect(move).toEqual(still);
    expect(carried).toEqual(still);
  });
});

describe("zooming with the triggers", () => {
  const hold = (pull: number, frames: number, from = 1) => {
    let zoom = from;
    for (let frame = 0; frame < frames; frame++) {
      zoom = cameraZoom(zoom, pull, FRAME);
    }
    return zoom;
  };

  it("goes closer on one trigger and further on the other", () => {
    expect(hold(1, 30)).toBeGreaterThan(1);
    expect(hold(-1, 30)).toBeLessThan(1);
    expect(hold(0, 30)).toBe(1);
  });

  it("is the same gesture wherever it starts from", () => {
    // a ratio, not an amount: a quarter second of pulling multiplies the zoom
    // by the same factor at 0.5 as at 2, which is the whole point of not adding
    // (well clear of both ends, where the clamp would flatten the comparison)
    const factorAt = (from: number) => hold(1, 15, from) / from;
    expect(factorAt(0.5)).toBeCloseTo(factorAt(2), 6);
  });

  it("does not care how the seconds are cut into frames", () => {
    // a hitching frame has to zoom as far as the frames it stands in for
    const oneStep = cameraZoom(1, 1, 0.5);
    let stepped = 1;
    for (let frame = 0; frame < 30; frame++)
      stepped = cameraZoom(stepped, 1, FRAME);
    expect(stepped).toBeCloseTo(oneStep, 6);
  });

  it("stops at both ends", () => {
    expect(hold(1, 600)).toBe(MAX_ZOOM);
    expect(hold(-1, 600)).toBe(MIN_ZOOM);
    // and does not wander past them once there
    expect(cameraZoom(MAX_ZOOM, 1, FRAME)).toBe(MAX_ZOOM);
    expect(cameraZoom(MIN_ZOOM, -1, FRAME)).toBe(MIN_ZOOM);
  });

  it("crosses its whole range in a couple of seconds", () => {
    const seconds = Math.log(MAX_ZOOM / MIN_ZOOM) / ZOOM_SPEED;
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(4);
  });

  it("follows a trigger only brushed", () => {
    // the reason for taking the triggers rather than the shoulders: a light
    // pull has to move the zoom slowly, not in the same jump as a full one
    expect(hold(0.1, 60)).toBeLessThan(hold(1, 60));
    expect(hold(0.1, 60)).toBeGreaterThan(1);
  });
});

describe("which level a following camera watches", () => {
  const onGround = { standing: 5, feet: 5, grounded: true };

  it("watches the ground it is standing on", () => {
    expect(groundToWatch(undefined, onGround)).toBe(5);
    expect(groundToWatch(1, onGround)).toBe(5);
  });

  it("does not move for a jump straight up", () => {
    // the floor it left, held for the whole arc, however high it goes
    for (const feet of [5.2, 6, 7.5, 10]) {
      expect(groundToWatch(5, { standing: 5, feet, grounded: false })).toBe(5);
    }
  });

  it("does not move for a jump between two pillars of a height", () => {
    // over the gap the ground underneath becomes the bottom of it at once —
    // which is exactly what used to send the camera diving and back
    expect(groundToWatch(5, { standing: 1, feet: 6.4, grounded: false })).toBe(
      5
    );
  });

  it("comes down with the character, at its own speed and no faster", () => {
    // falling off a cliff: it tracks the feet the whole way down
    for (const feet of [4.5, 3, 1.2]) {
      expect(groundToWatch(5, { standing: 1, feet, grounded: false })).toBe(
        feet
      );
    }
    // and settles on the floor it lands on
    expect(groundToWatch(5, { standing: 1, feet: 1, grounded: true })).toBe(1);
  });

  it("waits until it has landed before rising to a higher floor", () => {
    // jumping onto something taller: the camera has no business going up
    // before the character has got there
    expect(groundToWatch(1, { standing: 5, feet: 3, grounded: false })).toBe(1);
    expect(groundToWatch(1, { standing: 5, feet: 5, grounded: true })).toBe(5);
  });
});

describe("settling the camera over a change of level", () => {
  /** Where it and its speed have got to after `seconds`, cut into frames */
  const after = (seconds: number, to = 1) => {
    let at = { level: 0, velocity: 0 };
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      at = settleLevel(at.level, at.velocity, to, FRAME);
    }
    return at;
  };

  it("starts from a standstill rather than at full speed", () => {
    // the whole point of a spring here: an ease is at its fastest the instant
    // the target moves, which is what reads as a jolt when it steps a level
    const first = settleLevel(0, 0, 1, FRAME);
    expect(first.level).toBeGreaterThan(0);
    // a plain ease at the same stiffness covers 0.28 of the step in that first
    // frame; the spring covers a sixth of that, and builds up from there
    expect(first.level).toBeLessThan(0.06);
    // and it is winding up, not winding down
    expect(after(0.1).velocity).toBeGreaterThan(first.velocity);
  });

  it("arrives about as quickly as a plain ease did", () => {
    // gentler must not mean laggy: nine tenths of a level inside a fifth of a
    // second, which is where RISE_SPEED is set
    expect(after(0.2).level).toBeGreaterThan(0.85);
    expect(after(0.5).level).toBeCloseTo(1, 2);
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

  it("takes the same time however the seconds are cut into frames", () => {
    // otherwise the camera settles at a speed that depends on the machine
    let sixty = { level: 0, velocity: 0 };
    for (let frame = 0; frame < 12; frame++) {
      sixty = settleLevel(sixty.level, sixty.velocity, 1, 1 / 60);
    }
    let oneTwenty = { level: 0, velocity: 0 };
    for (let frame = 0; frame < 24; frame++) {
      oneTwenty = settleLevel(oneTwenty.level, oneTwenty.velocity, 1, 1 / 120);
    }
    expect(sixty.level).toBeCloseTo(oneTwenty.level, 6);
    expect(sixty.velocity).toBeCloseTo(oneTwenty.velocity, 6);
  });

  it("settles rather than creeping towards it for ever", () => {
    // an asymptote would keep the rounded viewport twitching by a pixel
    expect(settleLevel(1 - 1e-9, 0, 1, FRAME)).toEqual({
      level: 1,
      velocity: 0,
    });
  });

  it("keeps up with a target that never stops moving", () => {
    // a fall: the ground it watches is the character's own feet, dropping
    // every frame, and the camera has to stay near it rather than fall behind
    let at = { level: 10, velocity: 0 };
    let feet = 10;
    for (let frame = 0; frame < 60; frame++) {
      feet -= 0.2;
      at = settleLevel(at.level, at.velocity, feet, FRAME);
    }
    // it trails a fixed distance rather than falling further behind: at this
    // stiffness, twice the speed of the drop over RISE_SPEED, so about a level
    expect(at.level - feet).toBeLessThan(1.5);
    expect(at.velocity).toBeCloseTo(-12, 0);
  });
});

describe("the two camera modes", () => {
  const push = { x: 0.8, y: 0 };

  it("starts free and stays free while the stick is worked", () => {
    expect(nextCameraMode("free", { recentred: false, stick: still })).toBe(
      "free"
    );
    expect(nextCameraMode("free", { recentred: false, stick: push })).toBe(
      "free"
    );
  });

  it("follows from the moment R3 is pressed", () => {
    expect(nextCameraMode("free", { recentred: true, stick: still })).toBe(
      "following"
    );
    // and keeps following, on its own, for as long as nothing is asked of it
    expect(
      nextCameraMode("following", { recentred: false, stick: still })
    ).toBe("following");
  });

  it("lets go the moment the right stick is touched again", () => {
    expect(nextCameraMode("following", { recentred: false, stick: push })).toBe(
      "free"
    );
    // a stick barely off centre is not a touch: Gamepad has already zeroed it
    expect(
      nextCameraMode("following", { recentred: false, stick: { x: 0, y: 0 } })
    ).toBe("following");
  });

  it("takes the press over a hand already resting on the stick", () => {
    // otherwise R3 would do nothing at all to someone holding the stick, and
    // what ends a follow is the NEXT touch rather than the current one
    expect(nextCameraMode("free", { recentred: true, stick: push })).toBe(
      "following"
    );
  });
});

describe("reading the gamepad", () => {
  const withPad = <T>(pad: unknown, read: () => T): T => {
    vi.stubGlobal("navigator", { getGamepads: () => [pad] });
    try {
      return read();
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("reads nothing at all when no pad is plugged in", () => {
    expect(withPad(null, sampleGamepad)).toEqual({
      left: still,
      right: still,
      zoomIn: 0,
      zoomOut: 0,
      jumpHeld: false,
      attackHeld: false,
      recentreHeld: false,
    });
  });

  it("reads how far each trigger is pulled, not just whether it is", () => {
    const input = withPad(
      {
        axes: [0, 0, 0, 0],
        buttons: [
          ...Array.from({ length: 6 }, () => ({ pressed: false, value: 0 })),
          { pressed: true, value: 0.42 },
          { pressed: true, value: 0.9 },
        ],
      },
      sampleGamepad
    );
    expect(input.zoomOut).toBe(0.42);
    expect(input.zoomIn).toBe(0.9);
  });

  it("takes a pad whose triggers are switches at its word", () => {
    const buttons = Array.from({ length: 8 }, () => ({
      pressed: false,
      value: 0,
    }));
    buttons[7] = { pressed: true, value: 1 };
    const input = withPad({ axes: [0, 0, 0, 0], buttons }, sampleGamepad);
    expect(input.zoomIn).toBe(1);
    expect(input.zoomOut).toBe(0);
  });

  it("tells the two sticks apart", () => {
    const input = withPad(
      { axes: [0.5, -0.6, -0.7, 0.8], buttons: [] },
      sampleGamepad
    );
    expect(input.zoomIn).toBe(0);
    expect(input.left).toEqual({ x: 0.5, y: -0.6 });
    expect(input.right).toEqual({ x: -0.7, y: 0.8 });
  });

  it("ignores a stick that is only resting off centre", () => {
    // a worn stick never reads zero, and the camera would drift on its own
    const input = withPad(
      { axes: [0.1, -0.1, 0.05, 0.14], buttons: [] },
      sampleGamepad
    );
    expect(input.left).toEqual(still);
    expect(input.right).toEqual(still);
  });

  it("survives a pad with fewer axes than a standard one", () => {
    const input = withPad({ axes: [0.5, 0.5], buttons: [] }, sampleGamepad);
    expect(input.right).toEqual(still);
  });
});
