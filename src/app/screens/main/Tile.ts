import { Container, Polygon, Sprite, Texture } from "pixi.js";
import { IsoCoordinates, IsoDirection } from "./IsometricCoordinate";
import { NoTextureFoundError } from "./NoTextureFoundError";
import { TileFragment, tileFragmentKeys } from "./TileFragment";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

export type GetTileNeighbor = (
  relativeCoordinates: IsoCoordinates
) => string | undefined;

/**
 * An isometric tile
 */
export class Tile extends Container {
  public type: string;
  public isoCoordinates: IsoCoordinates;
  public tileFragmentsTextures: TileFragmentsTextures;
  public getTileNeighbor: GetTileNeighbor;
  constructor({
    type,
    getTileNeighbor,
    isoCoordinates,
    disableCursor = false,
    tileFragmentsTextures,
  }: {
    /**
     * the type, ex: wall or stone
     */
    type: string;
    getTileNeighbor: GetTileNeighbor;
    isoCoordinates: IsoCoordinates;
    disableCursor?: boolean;
    tileFragmentsTextures: TileFragmentsTextures;
  }) {
    super();
    this.type = type;
    this.isoCoordinates = isoCoordinates;
    this.tileFragmentsTextures = tileFragmentsTextures;
    this.getTileNeighbor = getTileNeighbor;

    this.interactive = true;
    // The hit area is a polygon that covers the entire tile (hexagon shape)
    this.hitArea = new Polygon([
      0, 7, 15, 0, 17, 0, 32, 7, 32, 16, 17, 23, 15, 23, 0, 16,
    ]);

    this.setTileFragments();
    if (!disableCursor) {
      this.addCursor();
    }
  }

  public get hasVisibleFragments(): boolean {
    return this.children.length > 0;
  }

  /**
   * Get the side of the tile that was clicked based on the local coordinates of the click
   */
  public static getSideFromLocalCoordinates({
    x,
    y,
  }: {
    x: number;
    y: number;
  }): IsoDirection {
    if (x < 16) {
      if (7.5 + x / 2 >= y) {
        return "up";
      }
      return "south";
    }
    if (23.5 - x / 2 >= y) {
      return "up";
    }
    return "east";
  }

  public updateNeighborhood() {
    this.removeChildren();
    this.setTileFragments();
  }

  private setTileFragments() {
    tileFragmentKeys.forEach((key) => {
      try {
        const fragment = new TileFragment({
          type: this.type,
          key,
          getTileNeighbor: this.getTileNeighbor,
          height: this.isoCoordinates.u,
          tileFragmentsTextures: this.tileFragmentsTextures,
        });
        this.addChild(fragment);
      } catch (e) {
        if (e instanceof NoTextureFoundError) {
          // can safely ignore, just means this fragment is empty
          return;
        }
        throw e;
      }
    });
  }

  /**
   * Add a cursor that indicates where a new tile will be added
   */
  private addCursor() {
    const cursorUTexture = Texture.from("cursor-u.png");
    const cursorUSprite = new Sprite(cursorUTexture);

    const cursorETexture = Texture.from("cursor-e.png");
    const cursorESprite = new Sprite(cursorETexture);
    cursorESprite.anchor.set(-1, -0.5);

    const cursorSTexture = Texture.from("cursor-s.png");
    const cursorSSprite = new Sprite(cursorSTexture);
    cursorSSprite.anchor.set(0, -0.5);

    this.on("mousemove", (evt) => {
      const side = Tile.getSideFromLocalCoordinates(evt.getLocalPosition(this));
      if (side === "up") {
        this.addChild(cursorUSprite);
      }
      if (side === "east") {
        this.addChild(cursorESprite);
      }
      if (side === "south") {
        this.addChild(cursorSSprite);
      }
    });
    this.on("mousemove", (evt) => {
      const side = Tile.getSideFromLocalCoordinates(evt.getLocalPosition(this));
      if (side !== "up") {
        this.removeChild(cursorUSprite);
      }
      if (side !== "east") {
        this.removeChild(cursorESprite);
      }
      if (side !== "south") {
        this.removeChild(cursorSSprite);
      }
    });
    this.on("mouseleave", () => {
      this.removeChild(cursorUSprite);
      this.removeChild(cursorESprite);
      this.removeChild(cursorSSprite);
    });
  }
}
