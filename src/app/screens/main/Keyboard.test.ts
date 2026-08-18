import { describe, expect, it } from "vitest";
import { stickFromKeys } from "./Keyboard";
import { walkVelocity } from "./Map";

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Where holding these keys sends the character, in the grid */
const walk = (...keys: string[]) => {
  const { x, y } = stickFromKeys(keys);
  return walkVelocity(x, y);
};

const pace = ({ s, e }: { s: number; e: number }) => round(Math.hypot(s, e));

/**
 * The walk keys, asserted on the heading they produce IN THE GRID rather than
 * on the table they are read from — the table is the thing that can be wrong,
 * and a flipped sign in it is invisible to a test that quotes it back.
 *
 * The codes are physical positions: KeyW A S D is the ZQSD block on AZERTY.
 */
describe("the keyboard as a left stick", () => {
  it("sends D north-east, at the pace of a stick pushed to its limit", () => {
    const d = walk("KeyD");
    // north-east is s decreasing and e increasing, in equal measure
    expect(d.s).toBeLessThan(0);
    expect(d.e).toBeGreaterThan(0);
    expect(round(-d.s)).toBe(round(d.e));
    // and a stick held fully right asks for exactly the same thing
    expect(d).toEqual(walkVelocity(1, 0));
  });

  it("sends the other three to the other three corners of the grid", () => {
    // Z away from the camera, S towards it, Q to the left of the screen
    expect(walk("KeyW").s).toBeLessThan(0);
    expect(walk("KeyW").e).toBeLessThan(0);
    expect(walk("KeyS").s).toBeGreaterThan(0);
    expect(walk("KeyS").e).toBeGreaterThan(0);
    expect(walk("KeyA").s).toBeGreaterThan(0);
    expect(walk("KeyA").e).toBeLessThan(0);
  });

  it("does not reward holding two of them", () => {
    // the same clamp a stick pushed into a corner gets, and the reason the keys
    // are turned into a deflection rather than into a heading
    expect(pace(walk("KeyW", "KeyD"))).toBe(pace(walk("KeyD")));
    // and the diagonal really is between the two
    expect(walk("KeyW", "KeyD").e).toBeGreaterThan(walk("KeyW").e);
  });

  it("stands still on opposite keys, and on keys it does not know", () => {
    expect(walk("KeyA", "KeyD")).toEqual({ s: 0, e: 0 });
    expect(walk("KeyW", "KeyS")).toEqual({ s: 0, e: 0 });
    expect(stickFromKeys(["KeyP", "Space", "ArrowUp"])).toEqual({ x: 0, y: 0 });
  });
});
