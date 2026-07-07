import { Viewport } from "pixi-viewport";
import type { Point, Ticker } from "pixi.js";
import { Container } from "pixi.js";
import { engine } from "../../getEngine";
import { Background } from "./Background";
import { ControlBar } from "./ControlBar";
import { Map, MapData } from "./Map";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import type { TileType } from "./Tile";
import type { MapObjectType } from "./MapObject";

export type CursorAction =
  | {
      entityType: "tile";
      type: TileType;
      mode: "add";
    }
  | {
      entityType: "object";
      type: MapObjectType;
      mode: "add";
    }
  | {
      mode: "remove";
    };

/** The screen that holds the app */
export class GameScreen extends Container {
  /** Assets bundles required by this screen */
  public static assetBundles = ["game"];
  public background: Background;
  public controlBar: ControlBar;

  public mapContainer: Viewport;
  private paused = false;
  private map?: Map;
  public tileFragmentsTextures: TileFragmentsTextures;
  public cursorAction: CursorAction;

  constructor() {
    super();

    this.background = new Background();
    this.addChild(this.background);

    this.mapContainer = new Viewport({
      events: engine().renderer.events,
      screenWidth: engine().screen.width,
      screenHeight: engine().screen.height,
    });
    this.addChild(this.mapContainer);
    this.mapContainer.drag({ mouseButtons: "middle" }).pinch().wheel();
    this.mapContainer.setZoom(1);
    const centerX = Math.round(engine().screen.width * 0.5);
    const centerY = Math.round(engine().screen.height * 0.5);
    this.mapContainer.x = centerX;
    this.mapContainer.y = centerY;
    this.mapContainer.on("pointermove", (evt) => {
      const local = this.map?.toLocal(evt.global);
      this.map?.updatePointerPosition(local, this.cursorAction.mode);
    });
    let startPos: Point | null = null;
    this.mapContainer
      .on("pointerdown", (evt) => {
        startPos = evt.global.clone();
      })
      .on("pointerup", (evt) => {
        const endPos = evt.global;
        if (startPos === null) return;
        // drag protection
        const moved =
          Math.abs(endPos.x - startPos.x) + Math.abs(endPos.y - startPos.y) > 6;
        startPos = null;
        if (moved || !this.map) return;
        const isWheelClick = evt.button === 1;
        if (isWheelClick) return;
        const isRightClick = evt.button === 2;
        const action = this.cursorAction;
        const local = this.map.toLocal(evt.global);
        if (isRightClick || action.mode === "remove") {
          this.map.removeEntityAtPointerPosition(local);
        } else {
          this.map.addEntityAtPointerPosition(local, action);
        }
        const isTouch = evt.pointerType === "touch";
        if (!isTouch) {
          this.map.updatePointerPosition(local, this.cursorAction.mode);
        }
      });

    this.tileFragmentsTextures = new TileFragmentsTextures();

    this.cursorAction = {
      entityType: "tile",
      type: "dirt" as TileType,
      mode: "add",
    };

    this.controlBar = new ControlBar({
      getCursorAction: () => this.cursorAction,
      onClickRemove: () => {
        this.cursorAction = {
          mode: "remove",
        };
      },
      onClickTile: (type) => {
        this.cursorAction = {
          entityType: "tile",
          type,
          mode: "add",
        };
      },
      onClickObject: (type) => {
        this.cursorAction = {
          entityType: "object",
          type,
          mode: "add",
        };
      },
      tileFragmentsTextures: this.tileFragmentsTextures,
    });
    this.addChild(this.controlBar);
  }

  public extractToPng = async () => {
    const base64 = await engine().renderer.extract.base64(this.mapContainer);
    // Download as PNG
    const link = document.createElement("a");
    link.href = base64;
    link.download = "map.png";
    link.click();
  };

  public extractToJson = async () => {
    // if (!this.map) return;
    // const json = this.map.toJson();
    // const blob = new Blob([json], { type: "application/json" });
    // const url = URL.createObjectURL(blob);
    // const link = document.createElement("a");
    // link.href = url;
    // link.download = "map.json";
    // link.click();
  };

  /** Prepare the screen just before showing */
  public prepare(mapData: MapData) {
    this.map?.destroy({ children: true });
    this.map = new Map(mapData, this.tileFragmentsTextures);
    this.mapContainer.addChild(this.map);
  }

  /** Update the screen */

  public update(time: Ticker) {
    if (this.paused || !this.map) return;
    this.map.update(time);
  }

  /** Pause gameplay - automatically fired when a popup is presented */
  public async pause() {
    this.mapContainer.interactiveChildren = false;
    this.paused = true;
  }

  /** Resume gameplay */
  public async resume() {
    this.mapContainer.interactiveChildren = true;
    this.paused = false;
  }

  /** Fully reset */
  public reset() {}

  /** Resize the screen, fired whenever window size changes */
  public resize(width: number, height: number) {
    this.background.resize(width, height);
    this.mapContainer.resize(width, height);
    this.controlBar.resize(width, height);
  }

  /** Show screen with animations */
  public async show(): Promise<void> {}

  /** Hide screen with animations */
  public async hide() {}
}
