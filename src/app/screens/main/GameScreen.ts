import { Viewport } from "pixi-viewport";
import type { Point, Texture, Ticker } from "pixi.js";
import { Assets, Container, Text } from "pixi.js";
import { engine } from "../../getEngine";
import { Background } from "./Background";
import { ControlBar } from "./ControlBar";
import { Map, MapData } from "./Map";
import type { MapObjectType } from "./MapObject";
import type { TileType } from "./Tile";
import { TileFragmentsTextures } from "./TileFragmentsTextures";
import { debugViewEnabled, listenForDebugViewToggle } from "./DebugView";
import { listenForKeyboardInput } from "./Keyboard";

/** How long the frame rate is averaged over before it is shown, in ms */
const FPS_WINDOW = 500;

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
  /** DEBUG readout, see syncDebugReadout */
  private debugReadout: Text;
  private fps = 0;
  private frames = 0;
  private sinceFpsUpdate = 0;
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

    listenForDebugViewToggle();
    listenForKeyboardInput();

    // TODO: use another system to register the textures instead of using Pixi's cache
    // @ts-expect-error hack to access private property
    const textureCache = Assets.cache._cache as Map<string, Texture>;
    this.tileFragmentsTextures = new TileFragmentsTextures([
      ...textureCache.keys(),
    ]);

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

    // A child of the screen, not of the viewport: that is what keeps it still
    // while the map pans and zooms under it. Top right, the control bar has
    // the left edge.
    this.debugReadout = new Text({
      text: "",
      style: {
        fontFamily: "monospace",
        fontSize: 12,
        align: "right",
        fill: 0x6bc8ff,
        stroke: { color: 0x000000, width: 3 },
      },
    });
    this.debugReadout.anchor.set(1, 0);
    this.debugReadout.visible = false;
    this.addChild(this.debugReadout);
    this.placeDebugReadout(engine().screen.width);
  }

  private placeDebugReadout(width: number) {
    this.debugReadout.x = width - 12;
    this.debugReadout.y = 12;
  }

  /**
   * Frames per second, averaged over the last window: an instant reading swings
   * by twenty between two frames. Counted whether or not the overlay is on, so
   * the number is already right when it appears.
   */
  private countFrame(time: Ticker) {
    this.frames++;
    this.sinceFpsUpdate += time.deltaMS;
    if (this.sinceFpsUpdate < FPS_WINDOW) return;
    this.fps = (this.frames * 1000) / this.sinceFpsUpdate;
    this.frames = 0;
    this.sinceFpsUpdate = 0;
  }

  /**
   * DEBUG — the frame rate, and how fast the character is actually moving in
   * cells per second. Pinned to the corner rather than to the character so
   * that it stays readable while it moves. Toggled with F10, see DebugView.
   */
  private syncDebugReadout() {
    this.debugReadout.visible = debugViewEnabled();
    if (!this.debugReadout.visible) return;
    const lines = [`${Math.round(this.fps)} fps`];
    if (this.map?.character) {
      const { s, e, u } = this.map.characterVelocity;
      // the ground speed last, on its own: it is the one that should not
      // change with the direction, and the one that paces the walk cycle
      lines.push(
        `s ${s.toFixed(2)}`,
        `e ${e.toFixed(2)}`,
        `u ${u.toFixed(2)}`,
        `${Math.hypot(s, e).toFixed(2)} cells/s`
      );
    }
    const text = lines.join("\n");
    if (this.debugReadout.text !== text) this.debugReadout.text = text;
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
    this.countFrame(time);
    if (!this.paused && this.map) this.map.update(time);
    this.syncDebugReadout();
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
    this.placeDebugReadout(width);
  }

  /** Show screen with animations */
  public async show(): Promise<void> {}

  /** Hide screen with animations */
  public async hide() {}
}
