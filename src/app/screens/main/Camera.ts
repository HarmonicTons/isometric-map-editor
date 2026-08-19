import type { Stick } from "./input/Gamepad";

/** How fast the stick moves the camera, in SCREEN pixels per second */
export const CAMERA_SPEED = 600;

/** How far the zoom can be taken, as a multiple of the map's own pixels */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;

/** The zoom a map opens at: one map pixel per screen pixel, for editing */
export const INITIAL_ZOOM = 1;

/** What R3 puts the zoom at, along with pinning the camera on the character */
export const DEFAULT_ZOOM = 4;

/** How fast a fully pulled trigger zooms, in e-folds per second */
export const ZOOM_SPEED = 1.5;

/**
 * The zoom after one frame of pulling the triggers, `pull` being how much more
 * the near one is pulled than the far one.
 *
 * Multiplied rather than added to: a tenth per second added would be
 * imperceptible at 8 and violent at 0.5, where a tenth of growth is the same
 * gesture wherever it starts from.
 */
export const cameraZoom = (
  zoom: number,
  pull: number,
  seconds: number
): number => {
  const wanted = zoom * Math.exp(pull * ZOOM_SPEED * seconds);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, wanted));
};

/**
 * Free, or pinned to the character.
 *
 * The triggers are deliberately not a way out: zooming in on what you are
 * watching is not asking to stop watching it.
 */
export type CameraMode = "free" | "following";

export const nextCameraMode = (
  mode: CameraMode,
  { recentred, stick }: { recentred: boolean; stick: Stick }
): CameraMode => {
  // the press wins the frame it happens on: what ends the follow is the NEXT
  // touch of the stick, even if a hand was already resting on it
  if (recentred) return "following";
  if (stick.x !== 0 || stick.y !== 0) return "free";
  return mode;
};

export type GroundState = {
  /** the level it stands on, or would if it were not in the air */
  standing: number;
  /** the level its feet are actually at */
  feet: number;
  grounded: boolean;
};

/**
 * The level a following camera should be watching.
 *
 * In the air it keeps the floor it left, so a jump does not move the camera —
 * reading the ground while airborne makes it dive the moment the character
 * clears a cliff. Clamping to the feet is what lets a real fall be followed,
 * at exactly the speed it is falling.
 */
export const groundToWatch = (
  lastStoodOn: number | undefined,
  { standing, feet, grounded }: GroundState
): number => (grounded ? standing : Math.min(lastStoodOn ?? standing, feet));

/** How stiff the camera is about following the ground, in radians per second */
export const RISE_SPEED = 20;

/** Closer than this, and slower than this, it is simply there */
const SETTLED = 0.002;

/**
 * Move the camera's level towards the ground it should be watching, as a
 * critically damped spring — the closed form of x'' = −2ω x' − ω² x.
 *
 * A spring rather than a fraction of the gap per second because of how the two
 * start: falling, the target slides with the character's feet, but landing on
 * something higher moves it a whole level at once, and an exponential ease is
 * at its fastest the instant that happens. Critically damped so it never
 * overshoots: the camera settling below the floor would be worse than the jolt.
 */
export const settleLevel = (
  current: number,
  velocity: number,
  target: number,
  seconds: number
): { level: number; velocity: number } => {
  const gap = current - target;
  if (Math.abs(gap) < SETTLED && Math.abs(velocity) < SETTLED) {
    return { level: target, velocity: 0 };
  }
  const decay = Math.exp(-RISE_SPEED * seconds);
  const drift = velocity + RISE_SPEED * gap;
  const left = (gap + drift * seconds) * decay;
  return {
    level: target + left,
    velocity: (drift - RISE_SPEED * (gap + drift * seconds)) * decay,
  };
};

export type Pan = { x: number; y: number };

/**
 * How far to move the viewport this frame, and what to carry into the next.
 *
 * The viewport has to land on whole pixels — this is pixel art — while a stick
 * asks for a fraction of one per frame, so what is left over is carried: it is
 * what lets a stick barely off centre move the camera at all.
 */
export const cameraPan = (
  carried: Pan,
  stick: Stick,
  seconds: number
): { move: Pan; carried: Pan } => {
  if (stick.x === 0 && stick.y === 0) {
    return { move: { x: 0, y: 0 }, carried: { x: 0, y: 0 } };
  }
  // pushed right, the camera goes right, so the map moves left under it
  const wanted = {
    x: carried.x - stick.x * CAMERA_SPEED * seconds,
    y: carried.y - stick.y * CAMERA_SPEED * seconds,
  };
  const move = { x: Math.round(wanted.x), y: Math.round(wanted.y) };
  return { move, carried: { x: wanted.x - move.x, y: wanted.y - move.y } };
};
