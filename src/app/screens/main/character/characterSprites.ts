/**
 * What a character's sprites look like, as data.
 *
 * Written by scripts/import-pokemon-sprites, one file per character under
 * public/characters, and FETCHED like a map rather than imported: there are a
 * thousand of these to be had and a bundle holding all of them would be paid
 * for by everyone to play one.
 *
 * Hence loading being a step of its own — `loadCharacterSprites` before the map
 * is built, `characterSprites` synchronously ever after, since a Character is
 * created deep inside a constructor and cannot wait for a round trip.
 */

import type { CharacterType } from "./Character";

export type CharacterAnimationName = "idle" | "walk" | "hop" | "attack";

/**
 * The characters the editor can drop on a map, in the order the control bar
 * shows them.
 *
 * Loaded at start-up whatever the map holds, since any of them can be placed on
 * any map at any time — see main.ts. Which is why this is a short list and not
 * everything under public/characters: each one is a fetch nobody asked for.
 */
export const PLACEABLE_CHARACTERS = ["0004-charmander"] as CharacterType[];

/**
 * The eight directions, in the order the rows of a sheet are stacked: `se`
 * points straight down the screen and each next one is 45° counter-clockwise.
 * Grid names, not screen ones — `e` alone is down and to the right.
 */
export const DIRECTIONS = ["se", "e", "ne", "n", "nw", "w", "sw", "s"] as const;

export type CharacterDirection = (typeof DIRECTIONS)[number];

export type SpriteAnimation = {
  frames: number;
  /** how long each frame is held, in ticks of a sixtieth of a second */
  durations: number[];
  /**
   * The pixel of each frame that sits on the ground the character stands on,
   * indexed `row * frames + frame`. Row is the index in DIRECTIONS.
   */
  anchors: [number, number][];
  /**
   * Hop only: the frames of leaving the ground, rising, falling and landing.
   * The engine holds each for as long as its own physics is in that state,
   * which is why a hop is four poses rather than a sequence.
   */
  phases?: [number, number, number, number];
};

export type CharacterSprites = {
  /** what it occupies, in cells: s, e, u */
  hitbox: [number, number, number];
  animations: Partial<Record<CharacterAnimationName, SpriteAnimation>>;
};

const loaded = new globalThis.Map<string, CharacterSprites>();

/** Where a description is served from, next to the maps */
const urlOf = (type: string) =>
  `${import.meta.env.BASE_URL}characters/${type}.json`;

/**
 * Make a description available without fetching it. What the headless tests
 * use, reading the same files straight off disk.
 */
export const registerCharacterSprites = (
  type: string,
  sprites: CharacterSprites
) => {
  loaded.set(type, sprites);
};

/** Fetch descriptions. Await this before building the Map — see main.ts. */
export const loadCharacterSprites = async (types: Iterable<string>) => {
  const wanted = [...new Set(types)].filter((type) => !loaded.has(type));
  await Promise.all(
    wanted.map(async (type) => {
      const answer = await fetch(urlOf(type));
      if (!answer.ok) {
        throw new Error(
          `No sprites for character ${type}: ${urlOf(type)} answered ${answer.status}`
        );
      }
      registerCharacterSprites(type, (await answer.json()) as CharacterSprites);
    })
  );
};

/** Whether a description is already in hand */
export const characterSpritesLoaded = (type: string): boolean =>
  loaded.has(type);

export const characterSprites = (type: string): CharacterSprites => {
  const sprites = loaded.get(type);
  if (!sprites) {
    throw new Error(
      `Character ${type} was never loaded: loadCharacterSprites has to run first`
    );
  }
  return sprites;
};

export const animationOf = (
  sprites: CharacterSprites,
  wanted: CharacterAnimationName
): SpriteAnimation => {
  const animation = sprites.animations[wanted];
  if (!animation) throw new Error(`This character has no ${wanted} animation`);
  return animation;
};
