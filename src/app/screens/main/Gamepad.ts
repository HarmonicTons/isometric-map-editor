/**
 * The first gamepad that is there, read once a frame.
 *
 * Polled rather than remembered from `gamepadconnected`: the browser leaves a
 * null in the slot once a pad is unplugged and fires no event.
 *
 * One reader for the whole app, so the deadzone and the button numbering are
 * decided in one place.
 */

/** A stick at rest does not read zero, and a worn one reads further off still */
const DEADZONE = 0.15;

export type Stick = { x: number; y: number };

const past = (value: number | undefined) =>
  value !== undefined && Math.abs(value) > DEADZONE ? value : 0;

export type GamepadInput = {
  /** where it wants to walk, in screen directions */
  left: Stick;
  /** where it wants to look, in screen directions */
  right: Stick;
  /**
   * How hard the triggers are pulled, 0 to 1 each — analog in the standard
   * mapping, which is what makes them the right thing to zoom with.
   */
  zoomIn: number;
  zoomOut: number;
  jumpHeld: boolean;
  attackHeld: boolean;
  /** the right stick pressed in */
  recentreHeld: boolean;
};

const NOTHING: GamepadInput = {
  left: { x: 0, y: 0 },
  right: { x: 0, y: 0 },
  zoomIn: 0,
  zoomOut: 0,
  jumpHeld: false,
  attackHeld: false,
  recentreHeld: false,
};

export const sampleGamepad = (): GamepadInput => {
  // node has a navigator, but no gamepads on it
  const gamepad = globalThis.navigator
    ?.getGamepads?.()
    .find((pad) => pad !== null);
  if (!gamepad) return NOTHING;
  const [leftX, leftY, rightX, rightY] = gamepad.axes;
  return {
    left: { x: past(leftX), y: past(leftY) },
    right: { x: past(rightX), y: past(rightY) },
    // 0 is A on an Xbox pad, Cross on a PlayStation one: the standard mapping
    jumpHeld: gamepad.buttons[0]?.pressed === true,
    // 2 is X, or Square
    attackHeld: gamepad.buttons[2]?.pressed === true,
    // 6 and 7 are the triggers, L2 and R2, the only buttons with a value
    // rather than just a state
    zoomIn: gamepad.buttons[7]?.value ?? 0,
    zoomOut: gamepad.buttons[6]?.value ?? 0,
    // 11 is the right stick pressed in, R3
    recentreHeld: gamepad.buttons[11]?.pressed === true,
  };
};
