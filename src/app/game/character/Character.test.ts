import { beforeAll, describe, expect, it } from "vitest";
import {
  Character,
  CharacterType,
  IDLE_EVERY,
  NOMINAL_WALK_SPEED,
  frameAtTicks,
  headingOf,
} from "./Character";
import { sliceEntityByColumn } from "./EntityColumns";
import { GlobalIsoCoordinates } from "../iso/IsometricCoordinate";
import { buildHeadlessMap } from "../__tests__/composeMapImage";
import type { MapData } from "../map/Map";

/** Registers every atlas in Pixi's cache. Building one map is enough. */
const loadTextures = () => {
  const map = buildHeadlessMap({
    tiles: { "0,0,0": "dirt" },
    objects: {},
    characters: {},
  } as unknown as MapData);
  map.destroy({ children: true });
};

const at = (s: number, e: number, u: number) =>
  new GlobalIsoCoordinates(s, e, u);

const stand = (type: string) =>
  new Character({
    type: type as CharacterType,
    globalIsoCoordinates: at(2, 2, 1),
  });

/** One frame of simulation, standing still on the ground unless told otherwise */
const still = {
  seconds: 1 / 60,
  grounded: true,
  jumped: false,
  attack: false,
};

describe("which way a character faces", () => {
  it("names the eight directions from a movement in the grid", () => {
    // our axes and the sheet's rows do not line up: `e` alone goes down AND
    // right on screen, the two together go straight down
    expect(headingOf(0, 1)).toBe("e");
    expect(headingOf(1, 0)).toBe("s");
    expect(headingOf(-1, 0)).toBe("n");
    expect(headingOf(0, -1)).toBe("w");
    expect(headingOf(1, 1)).toBe("se");
    expect(headingOf(-1, -1)).toBe("nw");
    expect(headingOf(-1, 1)).toBe("ne");
    expect(headingOf(1, -1)).toBe("sw");
  });

  it("keeps whatever it was facing when it is not going anywhere", () => {
    expect(headingOf(0, 0)).toBeUndefined();
  });

  it("rounds a heading to the nearest of the eight", () => {
    // a hair off due east stays east rather than flickering
    expect(headingOf(0.05, 1)).toBe("e");
    expect(headingOf(-0.05, 1)).toBe("e");
    // and halfway between east and south-east it commits to one of them
    expect(["e", "se"]).toContain(headingOf(0.5, 1));
  });
});

describe("the frame a run of durations is on", () => {
  const durations = [6, 8, 6, 8];

  it("holds each frame for as long as it says", () => {
    expect(frameAtTicks(durations, 0)).toBe(0);
    expect(frameAtTicks(durations, 5.9)).toBe(0);
    expect(frameAtTicks(durations, 6)).toBe(1);
    expect(frameAtTicks(durations, 13.9)).toBe(1);
    expect(frameAtTicks(durations, 14)).toBe(2);
  });

  it("loops, forwards and backwards", () => {
    const cycle = 28;
    expect(frameAtTicks(durations, cycle)).toBe(0);
    expect(frameAtTicks(durations, cycle + 7)).toBe(1);
    expect(frameAtTicks(durations, -1)).toBe(3);
  });
});

describe("where a character's sprite is put", () => {
  beforeAll(loadTextures);

  it("stands the frame's own ground pixel on the middle of the cell", () => {
    const character = stand("0004-charmander");
    character.update(still);
    const { anchorX, anchorY } = character.shape;
    const cut = sliceEntityByColumn(character.shape);
    // the middle of the top face of the cell it stands on, which is where
    // toXY's 32 by 24 diamond has its centre
    const xy = at(2, 2, 1).toXY();
    expect(cut.x + anchorX).toBe(xy.x + 16);
    expect(cut.y + anchorY).toBe(xy.y + 16);
    character.destroy();
  });
});

describe("what a character plays", () => {
  beforeAll(loadTextures);

  it("rests on the first frame of its walk cycle", () => {
    const character = stand("0004-charmander");
    character.update(still);
    expect(character.showing).toEqual({ animation: "walk", frame: 0 });

    // resting and walking are the same sheet now, so what tells them apart is
    // that the cycle turns: 0.4 cells is past the 6 ticks frame 0 is held for
    character.globalIsoCoordinates = at(2.4, 2, 1);
    character.update(still);
    expect(character.showing.animation).toBe("walk");
    expect(character.showing.frame).not.toBe(0);

    // pressed against a wall it covers no ground, and standing on the spot is
    // not walking
    character.update(still);
    expect(character.showing).toEqual({ animation: "walk", frame: 0 });
    character.destroy();
  });

  it("breaks the stillness with one run of its idle animation", () => {
    const character = stand("0004-charmander");
    const stand10s = (seconds: number) => {
      const frames = [];
      for (let tick = 0; tick < seconds * 60; tick++) {
        character.update(still);
        frames.push(character.showing.animation);
      }
      return frames;
    };

    // nothing at all for the first IDLE_EVERY seconds
    expect(new Set(stand10s(IDLE_EVERY - 0.1))).toEqual(new Set(["walk"]));

    // then one run of it, and back to resting
    const after = stand10s(4);
    expect(after).toContain("idle");
    expect(after[after.length - 1]).toBe("walk");
    // the idle sheet is 36 ticks long: it played once, not on a loop
    const played = after.filter((name) => name === "idle").length;
    expect(played).toBe(36);
    character.destroy();
  });

  it("postpones a break rather than banking it while it walks", () => {
    const character = stand("0004-charmander");
    for (let tick = 0; tick < IDLE_EVERY * 60 - 10; tick++) {
      character.update(still);
    }
    // one step, and the wait starts over
    character.globalIsoCoordinates = at(2.1, 2, 1);
    character.update(still);
    for (let tick = 0; tick < 60; tick++) character.update(still);
    expect(character.showing.animation).toBe("walk");
    character.destroy();
  });

  it("turns the walk cycle by the ground covered, at the drawn rhythm", () => {
    const character = stand("0004-charmander");
    // the walk sheet is 6, 8, 6, 8 ticks; at the speed it is drawn for, a whole
    // cycle is 28 ticks of ground
    const cycle = (28 / 60) * NOMINAL_WALK_SPEED;
    const walk = (cells: number) => {
      const { s, e, u } = character.globalIsoCoordinates;
      character.globalIsoCoordinates = at(s, e + cells, u);
      character.update(still);
      return character.showing.frame;
    };
    walk(0.001);
    const first = character.showing.frame;
    walk(cycle);
    expect(character.showing.frame).toBe(first);
    // and half of it lands mid-cycle rather than back at the start
    expect(walk(cycle / 2)).not.toBe(first);
    character.destroy();
  });

  it("follows the engine's own rise and fall, not the sheet's", () => {
    const character = stand("0004-charmander");
    const hop = (step: Partial<typeof still>) => {
      character.update({ ...still, ...step });
      return character.showing;
    };

    expect(hop({ jumped: true, grounded: false }).animation).toBe("hop");
    const takeoff = character.showing.frame;

    character.verticalSpeed = 5;
    const rising = hop({ grounded: false }).frame;
    character.verticalSpeed = -5;
    const falling = hop({ grounded: false }).frame;
    const landing = hop({ grounded: true }).frame;

    // The two in the air are genuinely different poses; what separated the
    // sheet's other frames was height, which the engine owns. Landing is the
    // sheet's own last frame — the same drawing as the takeoff, as it happens,
    // which is why a hop is three poses over four moments.
    expect(rising).not.toBe(falling);
    expect(rising).not.toBe(takeoff);
    expect(falling).not.toBe(landing);
    expect(landing).toBeGreaterThan(falling);
    character.destroy();
  });

  it("holds a rise for as long as it lasts, however long the sheet is", () => {
    const character = stand("0004-charmander");
    character.update({ ...still, jumped: true, grounded: false });
    character.verticalSpeed = 5;
    const frames = new Set<number>();
    // far longer than the ten frames the sheet has
    for (let tick = 0; tick < 200; tick++) {
      character.update({ ...still, grounded: false });
      frames.add(character.showing.frame);
    }
    expect(frames.size).toBe(1);
    character.destroy();
  });

  it("attacks on the press, for as long as its sheet lasts, then lets go", () => {
    const character = stand("0004-charmander");
    character.update({ ...still, attack: true });
    expect(character.showing.animation).toBe("attack");

    // 24 ticks of durations, so it is still going at 20 and done well after
    for (let tick = 0; tick < 20; tick++) character.update(still);
    expect(character.showing.animation).toBe("attack");
    for (let tick = 0; tick < 10; tick++) character.update(still);
    expect(character.showing).toEqual({ animation: "walk", frame: 0 });
    character.destroy();
  });

  it("pins a lunging attack to where the engine says the character is", () => {
    const character = stand("0004-charmander");
    character.direction = "e";
    character.update({ ...still, attack: true });

    const xy = at(2, 2, 1).toXY();
    const drawn = new Set<string>();
    for (let tick = 0; tick < 24; tick++) {
      const { anchorX, anchorY } = character.shape;
      const cut = sliceEntityByColumn(character.shape);
      // wherever the sheet has moved the character inside its frame, the frame
      // moves the other way and the ground point does not budge
      expect(cut.x + anchorX).toBe(xy.x + 16);
      expect(cut.y + anchorY).toBe(xy.y + 16);
      drawn.add(`${cut.x},${cut.y}`);
      character.update(still);
    }
    // which is only worth anything because the sheet really does travel
    expect(drawn.size).toBeGreaterThan(1);
    character.destroy();
  });
});
