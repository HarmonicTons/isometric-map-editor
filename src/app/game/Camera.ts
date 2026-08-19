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
 * the near one is pulled than the far one. Multiplicative, and clamped.
 */
export const cameraZoom = (
  zoom: number,
  pull: number,
  seconds: number
): number => {
  const wanted = zoom * Math.exp(pull * ZOOM_SPEED * seconds);
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, wanted));
};

/** Free, or pinned to the character */
export type CameraMode = "free" | "following";

/** R3 starts following, the next touch of the right stick ends it */
export const nextCameraMode = (
  mode: CameraMode,
  { recentred, stick }: { recentred: boolean; stick: Stick }
): CameraMode => {
  // the press wins the frame it happens on, so a hand already resting on the
  // stick does not cancel it
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
 * The level a following camera should be watching: the ground it stands on, or
 * while it is in the air, the floor it left — but never above its own feet, so
 * a fall is followed and a jump is not.
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
 * Move the camera's level towards the ground it should be watching: glued to it
 * while the character falls, and easing in and out over a change of level
 * without ever overshooting it.
 *
 * A critically damped spring, in closed form — x'' = −2ω x' − ω² x — so a long
 * frame moves it exactly as far as the frames it stands in for.
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
 * How far to move the viewport this frame, in whole pixels, and the fraction to
 * carry into the next — without it a stick barely off centre moves nothing.
 */
export const cameraPan = (
  carried: Pan,
  stick: Stick,
  seconds: number
): { move: Pan; carried: Pan } => {
  if (stick.x === 0 && stick.y === 0) {
    return { move: { x: 0, y: 0 }, carried: { x: 0, y: 0 } };
  }
  // pushed right the camera goes right, so the map moves left under it
  const wanted = {
    x: carried.x - stick.x * CAMERA_SPEED * seconds,
    y: carried.y - stick.y * CAMERA_SPEED * seconds,
  };
  const move = { x: Math.round(wanted.x), y: Math.round(wanted.y) };
  return { move, carried: { x: wanted.x - move.x, y: wanted.y - move.y } };
};
