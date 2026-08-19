import { describe, expect, it, vi } from "vitest";
import { sampleGamepad } from "./Gamepad";

const still = { x: 0, y: 0 };

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
    expect(withPad(null, sampleGamepad).left).toEqual(still);
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
    expect({ out: input.zoomOut, in: input.zoomIn }).toEqual({
      out: 0.42,
      in: 0.9,
    });
  });

  it("tells the two sticks apart", () => {
    const input = withPad(
      { axes: [0.5, -0.6, -0.7, 0.8], buttons: [] },
      sampleGamepad
    );
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
});
