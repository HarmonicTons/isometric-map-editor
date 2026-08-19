import { Sprite } from "pixi.js";
import { NoTextureFoundError } from "../NoTextureFoundError";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import { IsoCoordinates } from "../iso/IsometricCoordinate";
import type { TileType } from "./Tile";

/**
 * The name of the 12 tileFragments of a tile
 */
export const tileFragmentKeys = [
  "11",
  "12",
  "13",
  "14",
  "21",
  "22",
  "23",
  "24",
  "31",
  "32",
  "33",
  "34",
] as const;
export type TileFragmentKey = (typeof tileFragmentKeys)[number];

/**
 * Resolve the type of a neighboring tile from coordinates relative to the
 * fragment's own tile.
 */
export type GetTileNeighbor = (
  relative: IsoCoordinates
) => TileType | undefined;

/**
 * The X,Y position of each fragment
 */
const tileFragmentPosition: Record<TileFragmentKey, { x: number; y: number }> =
  {
    "11": { x: 0, y: 0 },
    "12": { x: 8, y: 0 },
    "13": { x: 16, y: 0 },
    "14": { x: 24, y: 0 },
    "21": { x: 0, y: 8 },
    "22": { x: 8, y: 8 },
    "23": { x: 16, y: 8 },
    "24": { x: 24, y: 8 },
    "31": { x: 0, y: 16 },
    "32": { x: 8, y: 16 },
    "33": { x: 16, y: 16 },
    "34": { x: 24, y: 16 },
  };

/**
 * An isometric tile fragment
 * A tile is made of 12 fragments (4 columns x 3 lines)
 */
export class TileFragment extends Sprite {
  constructor({
    type,
    key,
    getTileNeighbor,
    height,
    tileFragmentsTextures,
  }: {
    type: TileType;
    key: TileFragmentKey;
    getTileNeighbor: GetTileNeighbor;
    height: number;
    tileFragmentsTextures: TileFragmentsTextures;
  }) {
    const texture = tileFragmentsTextures.getFragmentTexture({
      type,
      fragment: key,
      getTileNeighbor,
      height,
    });
    if (!texture) {
      throw new NoTextureFoundError();
    }
    const position = tileFragmentPosition[key];

    super({ texture, position });
  }
}
