import {
  GlobalIsoCoordinates,
  IsoAxis,
  isoAxes,
  IsoBox,
  IsoCoordinates,
  IsoDirection,
  isoDirectionByAxis,
} from "../iso/IsometricCoordinate";
import { NOMINAL_WALK_SPEED } from "./Character";

/**
 * Moving a box through the map: what the sticks ask for, what gravity does, and
 * how far either actually gets.
 *
 * Everything here takes the map as a single predicate — `isSolid` — so none of
 * it knows what a chunk or a tile is.
 */

/** Whether a cell refuses to let anything through */
export type IsSolid = (iso: GlobalIsoCoordinates) => boolean;

/** Fall acceleration, in cells per second squared */
const GRAVITY = 40;

/**
 * Fastest it can fall, in cells per second. A feel knob, not a safety net: Pixi
 * clamps a hitching frame to 100 ms, so a long drop still crosses two cells
 * between two frames. What keeps it out of the floor is the sweep in
 * `freeDistance`, which marches the box however far the move reaches.
 */
const TERMINAL_SPEED = 20;

/** How far below its feet the ground is looked for: only a floor it rests on */
export const GROUND_PROBE = 1e-6;

/**
 * How fast a body `height` cells tall leaves the ground, in cells per second.
 *
 * A character jumps its own height, which needs no tuning since a body already
 * has one. A jump reaches v² / 2g, hence the square root; the floor keeps
 * anything imported able to climb the one-cell steps scenery is built from.
 */
export const jumpSpeedFor = (height: number): number =>
  Math.sqrt(2 * GRAVITY * Math.max(1, height));

/** The character's vertical speed after one frame, in cells per second. */
export const fallVelocity = (
  verticalSpeed: number,
  {
    grounded,
    jump,
    jumpSpeed,
    seconds,
  }: {
    grounded: boolean;
    jump: boolean;
    /** what this body leaves the ground at: see jumpSpeedFor */
    jumpSpeed: number;
    seconds: number;
  }
): number => {
  if (jump && grounded) return jumpSpeed;
  // standing on the floor: whatever speed it fell in with is spent
  const carried = grounded && verticalSpeed <= 0 ? 0 : verticalSpeed;
  return Math.max(-TERMINAL_SPEED, carried - GRAVITY * seconds);
};

/**
 * Where the stick asks the character to walk, in cells per second.
 *
 * The stick points on the screen, the character walks in the grid, so this
 * undoes the projection x = 16(e − s), y = 8(e + s). Normalising in the GRID is
 * what keeps the speed constant in cells: normalised on screen, walking up it
 * would cover twice the ground of walking across it.
 */
export const walkVelocity = (
  leftStickX: number,
  leftStickY: number
): { s: number; e: number } => {
  const towardS = leftStickY / 8 - leftStickX / 16;
  const towardE = leftStickY / 8 + leftStickX / 16;
  const length = Math.hypot(towardS, towardE);
  if (length === 0) return { s: 0, e: 0 };
  // a stick pushed into a corner is longer than one pushed straight
  const push = Math.min(1, Math.hypot(leftStickX, leftStickY));
  const pace = (push * NOMINAL_WALK_SPEED) / length;
  return { s: towardS * pace, e: towardE * pace };
};

/**
 * First solid cell met by marching a box along a direction, or undefined if
 * there is none within `searchDepth` cells.
 *
 * Scanning from the box's leading face, so a cell it already overlaps is
 * never returned.
 */
const firstSolidCellTowards = (
  isSolid: IsSolid,
  box: IsoBox,
  direction: IsoDirection,
  searchDepth: number
): GlobalIsoCoordinates | undefined => {
  const offset = IsoCoordinates.directionsOffsets[direction];
  const axis: IsoAxis = offset.s !== 0 ? "s" : offset.e !== 0 ? "e" : "u";
  const step = offset[axis];
  const [crossA, crossB] = isoAxes.filter((candidate) => candidate !== axis);
  const [aMin, aMax] = box.cellRange(crossA);
  const [bMin, bMax] = box.cellRange(crossB);
  const [lo, hi] = box.cellRange(axis);

  let v = step > 0 ? hi : lo;
  for (let depth = 0; depth < searchDepth; depth++) {
    v += step;
    for (let a = aMin; a <= aMax; a++) {
      for (let b = bMin; b <= bMax; b++) {
        const iso = new GlobalIsoCoordinates(0, 0, 0);
        iso[axis] = v;
        iso[crossA] = a;
        iso[crossB] = b;
        if (isSolid(iso)) return iso;
      }
    }
  }
  return undefined;
};

/**
 * How far the box may actually travel along one axis, given the intended
 * `delta`: the delta itself when nothing is in the way, or the exact
 * distance to the obstacle. Never changes sign, so a box can never be
 * pushed backwards.
 */
export const freeDistance = (
  isSolid: IsSolid,
  box: IsoBox,
  axis: IsoAxis,
  delta: number
): number => {
  if (delta === 0) return 0;
  const direction =
    isoDirectionByAxis[axis][delta > 0 ? "positive" : "negative"];
  // nothing beyond the reach of this move can block it
  const searchDepth = Math.ceil(Math.abs(delta)) + 1;
  const obstacle = firstSolidCellTowards(isSolid, box, direction, searchDepth);
  if (!obstacle) return delta;
  return delta > 0
    ? Math.min(delta, obstacle[axis] - box.max[axis])
    : Math.max(delta, obstacle[axis] + 1 - box.min[axis]);
};

/**
 * Where a hitbox standing at `from` ends up after asking to move by
 * (deltaS, deltaE), stopped by whatever is in the way and sliding along it.
 *
 * One axis at a time, the second swept from where the FIRST left the box:
 * against the same starting box neither sweep ever sees the cell diagonally
 * ahead, and a 1×1 pillar approached corner-on would be passable. The larger
 * component goes first, so the outcome does not depend on which axis happens
 * to be called s.
 */
export const slideAlong = (
  isSolid: IsSolid,
  from: GlobalIsoCoordinates,
  hitbox: IsoCoordinates,
  deltaS: number,
  deltaE: number
): GlobalIsoCoordinates => {
  const delta: Record<"s" | "e", number> = { s: deltaS, e: deltaE };
  const order: ("s" | "e")[] =
    Math.abs(deltaS) >= Math.abs(deltaE) ? ["s", "e"] : ["e", "s"];
  let at = from;
  for (const axis of order) {
    const box = IsoBox.standingOn(at, hitbox);
    const step = freeDistance(isSolid, box, axis, delta[axis]);
    const move = new IsoCoordinates(0, 0, 0);
    move[axis] = step;
    at = at.add(move);
  }
  return at;
};

/** Whether something is resting on a floor rather than falling */
export const isGrounded = (isSolid: IsSolid, box: IsoBox): boolean =>
  freeDistance(isSolid, box, "u", -GROUND_PROBE) === 0;
