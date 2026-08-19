import type { Stick } from "./Gamepad";

/**
 * Moving the camera with a stick, in the same screen pixels a drag moves it in.
 *
 * Kept out of GameScreen because of the rounding: the viewport has to land on
 * whole pixels — this is pixel art, and half a pixel of offset smears every
 * tile at once — while a stick asks for a fraction of one per frame. Carrying
 * what is left over is what lets a stick barely off centre move the camera at
 * all instead of rounding every frame's worth of it away to nothing.
 */

/**
 * How fast the stick moves the camera, in screen pixels per second.
 *
 * Screen pixels and not cells, so that it behaves like the drag it stands in
 * for: a drag moves the map by however far the pointer went, whatever the zoom.
 * Zoomed out it therefore covers more ground, which is the point of being
 * zoomed out.
 */
export const CAMERA_SPEED = 600;

/**
 * How far the zoom can be taken, as a multiple of the map's own pixels.
 *
 * There were no bounds at all before: a wheel needs so many notches to get
 * anywhere absurd that nobody found them, while a trigger held down crosses the
 * whole range in a couple of seconds and would sail straight past.
 */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;

/**
 * The zoom a map opens at.
 *
 * One map pixel per screen pixel, which is what editing wants: the most of the
 * map on screen at once, and the art at the size it was drawn.
 */
export const INITIAL_ZOOM = 1;

/**
 * What R3 puts the zoom at, along with pinning the camera on the character.
 *
 * Playing is the other half of the app and wants the opposite of editing —
 * close in on the character, where the animation is worth looking at. Which is
 * why it takes a button to get here and the map does not open on it.
 */
export const DEFAULT_ZOOM = 4;

/**
 * How fast a fully pulled trigger zooms, in e-folds per second — the whole
 * range from one end to the other takes about two seconds and a half.
 */
export const ZOOM_SPEED = 1.5;

/**
 * The zoom after one frame of pulling the triggers, `pull` being how much more
 * the near one is pulled than the far one.
 *
 * MULTIPLIED rather than added to. Zoom is a ratio: a tenth per second added
 * would be imperceptible at 8 and violent at 0.5, whereas a tenth per second
 * of growth is the same gesture wherever it starts from. Which is also why the
 * rate is an exponent — a frame twice as long has to zoom twice as far in
 * ratio, not twice as far in scale.
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
 * Two modes rather than a follow that a pan fights against: while it follows,
 * the stick is not competing with anything, and the moment it is touched the
 * camera is simply free again. The triggers are deliberately not a way out —
 * zooming in on what you are watching is not asking to stop watching it.
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

/**
 * The level a following camera should be watching.
 *
 * On the ground, the ground: that is what makes a jump not move the camera at
 * all, since the character comes back to the same floor it left.
 *
 * In the air, the floor it left — but never higher than the character itself.
 * Reading the ground while airborne is what made the camera dive: step off a
 * cliff and the floor underneath becomes the bottom of it AT ONCE, so the
 * camera would be down there before the character had even finished going up.
 * Worse over a gap between two pillars of the same height, where the floor
 * plunges and comes back for a jump that barely changed height at all.
 *
 * Clamping to the character's own feet is what lets a real fall still be
 * followed: falling below the floor it left, the camera comes down with it, at
 * exactly the speed it is falling and not one bit faster.
 */
export const groundToWatch = (
  lastStoodOn: number | undefined,
  { standing, feet, grounded }: GroundState
): number => (grounded ? standing : Math.min(lastStoodOn ?? standing, feet));

export type GroundState = {
  /** the level it stands on, or would if it were not in the air */
  standing: number;
  /** the level its feet are actually at */
  feet: number;
  grounded: boolean;
};

/**
 * How stiff the camera is about following the ground, in radians per second.
 *
 * Higher is tighter and quicker; lower is looser and lazier. It sets the whole
 * response: at 20 a step of one level is nine tenths covered in a fifth of a
 * second — as quickly as the plain ease it replaces got there, but starting
 * from nothing instead of from its top speed.
 */
export const RISE_SPEED = 20;

/** Closer than this, and slower than this, it is simply there */
const SETTLED = 0.002;

/**
 * Move the camera's level towards the ground it should be watching, as a
 * critically damped spring.
 *
 * A SPRING rather than a fraction of the gap per second, because of how the two
 * start. An exponential ease is at its fastest the instant the target moves and
 * only ever slows down — which is fine when the target slides, and reads as a
 * jolt when it steps. That is exactly the case here: falling, the camera tracks
 * the character's own feet and the target is continuous; landing on something
 * higher, the ground under it changes by a whole level at once. A spring starts
 * from the speed it already had — nought, when nothing was moving — winds up,
 * and eases out.
 *
 * Critically damped, so it never overshoots a step: the camera settling below
 * the floor and floating back up would be worse than the jolt.
 *
 * The closed form of x'' = −2ω x' − ω² x, so a long frame moves it exactly as
 * far as the frames it stands in for rather than approximately.
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
  // x(t) = (gap + (velocity + ω gap) t) e^(−ω t)
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
 * Pushed right, the camera goes right — so the map moves LEFT under it, which
 * is the opposite of what the hand does in a drag. It is the view being pushed
 * around here rather than the map.
 *
 * A stick back at rest owes nothing: keeping the fraction would start the next
 * nudge mid-pixel, for no gain.
 */
export const cameraPan = (
  carried: Pan,
  stick: Stick,
  seconds: number
): { move: Pan; carried: Pan } => {
  if (stick.x === 0 && stick.y === 0) {
    return { move: { x: 0, y: 0 }, carried: { x: 0, y: 0 } };
  }
  const wanted = {
    x: carried.x - stick.x * CAMERA_SPEED * seconds,
    y: carried.y - stick.y * CAMERA_SPEED * seconds,
  };
  const move = { x: Math.round(wanted.x), y: Math.round(wanted.y) };
  return { move, carried: { x: wanted.x - move.x, y: wanted.y - move.y } };
};
