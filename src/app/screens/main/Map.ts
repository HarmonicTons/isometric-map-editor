import { Container, FederatedPointerEvent, Point, Ticker } from "pixi.js";
import { CursorAction } from "./GameScreen";
import { IsoCoordinates, isoDirections } from "./IsometricCoordinate";
import { MapObject } from "./MapObject";
import { Tile } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";

const UMAX = 256;

export type MapData = {
  objects: Record<string, string>;
  tiles: Record<string, string>;
};

/**
 * Map class representing a collection of isometric tiles.
 */
export class Map extends Container {
  public tiles: Record<string, Tile> = {};
  public objects: Record<string, MapObject> = {};

  constructor(
    mapData: MapData,
    public getCursorAction: () => CursorAction,
    public tileFragmentsTextures: TileFragmentsTextures
  ) {
    super();
    const { tiles, objects } = mapData;
    for (const key in tiles) {
      const type = tiles[key];
      if (!type) continue;
      const iso = IsoCoordinates.fromString(key);
      this.createTile(iso, type);
    }
    for (const key in objects) {
      const type = objects[key];
      if (!type) continue;
      const iso = IsoCoordinates.fromString(key);
      this.createObject(iso, type);
    }

    this.updateAllTileNeighborhood();
  }

  public toJson(): string {
    const result: MapData = { objects: {}, tiles: {} };
    for (const key in this.objects) {
      result.objects[key] = this.objects[key].type;
    }
    for (const key in this.tiles) {
      result.tiles[key] = this.tiles[key].type;
    }
    return JSON.stringify(result);
  }

  private createObject(iso: IsoCoordinates, type: string) {
    const mapObject = new MapObject({ type, isoCoordinates: iso });
    mapObject.x = iso.e * 16 - iso.s * 16;
    mapObject.y = iso.e * 8 + iso.s * 8 - iso.u * 8 + 24;
    this.objects[iso.toString()] = mapObject;
    this.addChild(mapObject);
    mapObject.zIndex = iso.paintersOrderKey(UMAX);

    mapObject.on("rightdown", (evt) => {
      evt.stopPropagation();
      this.removeMapObjectAt(iso);
    });

    let startPos: Point | null = null;
    mapObject
      .on("pointerdown", (evt) => {
        startPos = evt.global.clone();
      })
      .on("pointerup", (evt) => {
        const endPos = evt.global;
        if (startPos === null) return;
        const moved =
          Math.abs(endPos.x - startPos.x) > 5 ||
          Math.abs(endPos.y - startPos.y) > 5;
        startPos = null;
        if (moved) return;
        const action = this.getCursorAction();
        if (action.mode === "remove") {
          this.removeMapObjectAt(iso);
        }
      });
  }

  private createTile(iso: IsoCoordinates, type: string) {
    const tile = new Tile({
      type,
      getTileNeighbor: (relativeCoordinates) => {
        const neighborIso = iso.add(relativeCoordinates);
        const neighborTile = this.getTileAt(neighborIso);
        return neighborTile ? neighborTile.type : undefined;
      },
      isoCoordinates: iso,
      tileFragmentsTextures: this.tileFragmentsTextures,
    });
    tile.x = iso.e * 16 - iso.s * 16;
    tile.y = iso.e * 8 + iso.s * 8 - iso.u * 8;
    this.tiles[iso.toString()] = tile;
    this.addChild(tile);
    tile.zIndex = iso.paintersOrderKey(UMAX);

    tile.on("rightdown", (evt) => {
      evt.stopPropagation();
      this.removeTileAt(iso);
    });

    const handlePress = (evt: FederatedPointerEvent) => {
      const action = this.getCursorAction();
      if (action.mode === "remove") {
        this.removeTileAt(iso);
        return;
      }
      const localX = Math.floor(evt.getLocalPosition(tile).x);
      const localY = Math.floor(evt.getLocalPosition(tile).y);
      const side = Tile.getSideFromLocalCoordinates({ x: localX, y: localY });
      if (action.entityType === "tile") {
        if (side === "up") {
          this.addTileAt(iso.move("up"), action.type);
        }
        if (side === "south") {
          this.addTileAt(iso.move("south"), action.type);
        }
        if (side === "east") {
          this.addTileAt(iso.move("east"), action.type);
        }
      }
      if (action.entityType === "object") {
        if (side === "up") {
          this.addMapObjectAt(iso.move("up"), action.type);
        }
        if (side === "south") {
          this.addMapObjectAt(iso.move("south"), action.type);
        }
        if (side === "east") {
          this.addMapObjectAt(iso.move("east"), action.type);
        }
      }
    };

    let startPos: Point | null = null;
    tile
      .on("pointerdown", (evt) => {
        startPos = evt.global.clone();
      })
      .on("pointerup", (evt) => {
        const endPos = evt.global;
        if (startPos === null) return;
        const moved =
          Math.abs(endPos.x - startPos.x) > 5 ||
          Math.abs(endPos.y - startPos.y) > 5;
        startPos = null;
        if (moved) return;
        handlePress(evt);
      });
  }

  private getTileAt(iso: IsoCoordinates): Tile | undefined {
    return this.tiles[iso.toString()];
  }
  private getMapObjectAt(iso: IsoCoordinates): MapObject | undefined {
    return this.objects[iso.toString()];
  }
  private getEntityAt(iso: IsoCoordinates): Tile | MapObject | undefined {
    return this.getTileAt(iso) || this.getMapObjectAt(iso);
  }

  private removeTileAt(iso: IsoCoordinates) {
    console.info("removing tile at", iso.s, iso.e, iso.u);
    const existingTile = this.getTileAt(iso);
    if (existingTile) {
      this.removeChild(existingTile);
      existingTile.destroy({ children: true });
      delete this.tiles[iso.toString()];
      // Update neighborhood
      this.updateTileNeighbors(iso);
    }
  }

  private removeMapObjectAt(iso: IsoCoordinates) {
    console.info("removing map object at", iso.s, iso.e, iso.u);
    const existingObject = this.getMapObjectAt(iso);
    if (existingObject) {
      this.removeChild(existingObject);
      existingObject.destroy({ children: true });
      delete this.objects[iso.toString()];
    }
  }

  public addTileAt(iso: IsoCoordinates, type: string) {
    if (this.getEntityAt(iso)) {
      console.warn("Entity already exists at", iso.s, iso.e, iso.u);
      return;
    }
    console.info("adding tile at", iso.s, iso.e, iso.u);
    this.createTile(iso, type);

    // Update neighborhood
    this.updateTileNeighbors(iso);
  }

  public addMapObjectAt(iso: IsoCoordinates, type: string) {
    if (this.getEntityAt(iso)) {
      console.warn("Entity already exists at", iso.s, iso.e, iso.u);
      return;
    }
    console.info("adding map object at", iso.s, iso.e, iso.u);
    this.createObject(iso, type);
  }

  /**
   * Update a tile sprite
   * If the tile has no visible fragments, it will be removed from the map
   * If the tile has visible fragments and is not in the map, it will be added to the map
   */
  private refreshTile(tile: Tile) {
    tile.updateNeighborhood();
    if (tile.hasVisibleFragments && !tile.parent) {
      this.addChild(tile);
      return;
    }
    if (!tile.hasVisibleFragments && tile.parent) {
      this.removeChild(tile);
      return;
    }
  }

  /**
   * This won't work with tiles that are not UNESWD
   * TODO note which tile depends on which tile in a linked list
   */
  public updateTileNeighbors(iso: IsoCoordinates) {
    // Update neighborhood

    for (const direction of isoDirections) {
      const neighborTile = this.getTileAt(iso.move(direction));
      if (!neighborTile) {
        continue;
      }
      this.refreshTile(neighborTile);
    }
    // HACK: hard code tiles to update
    const uuuNeighborTile = this.getTileAt(
      iso.move("up").move("up").move("up")
    );
    if (uuuNeighborTile) this.refreshTile(uuuNeighborTile);
    const uuNeighborTile = this.getTileAt(iso.move("up").move("up"));
    if (uuNeighborTile) this.refreshTile(uuNeighborTile);
    const unNeighborTile = this.getTileAt(iso.move("up").move("north"));
    if (unNeighborTile) this.refreshTile(unNeighborTile);
    const uwNeighborTile = this.getTileAt(iso.move("up").move("west"));
    if (uwNeighborTile) this.refreshTile(uwNeighborTile);
    const ddNeighborTile = this.getTileAt(iso.move("down").move("down"));
    if (ddNeighborTile) this.refreshTile(ddNeighborTile);
    const dsNeighborTile = this.getTileAt(iso.move("down").move("south"));
    if (dsNeighborTile) this.refreshTile(dsNeighborTile);
    const deNeighborTile = this.getTileAt(iso.move("down").move("east"));
    if (deNeighborTile) this.refreshTile(deNeighborTile);
  }

  private updateAllTileNeighborhood() {
    for (const key in this.tiles) {
      const tile = this.tiles[key];
      this.refreshTile(tile);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  public update(_time: Ticker) {}
}
