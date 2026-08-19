import { Viewport } from "pixi-viewport";
import type { Point, Texture, Ticker } from "pixi.js";
import { Assets, Container, Text } from "pixi.js";
import { engine } from "../../getEngine";
import { Background } from "./Background";
import { ControlBar } from "./ControlBar";
import { Map, MapData } from "./map/Map";
import type { CharacterType } from "./character/Character";
import type { MapObjectType } from "./map/MapObject";
import type { TileType } from "./map/Tile";
import { TileFragmentsTextures } from "./map/TileFragmentsTextures";
import { debugViewEnabled, listenForDebugViewToggle } from "./debug/DebugView";
import { listenForKeyboardInput } from "./input/Keyboard";
import { sampleGamepad } from "./input/Gamepad";
import type { CameraMode, Pan } from "./Camera";
import {
  DEFAULT_ZOOM,
  INITIAL_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraPan,
  cameraZoom,
  groundToWatch,
  nextCameraMode,
  settleLevel,
} from "./Camera";

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
      entityType: "character";
      type: CharacterType;
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
  /** What the camera has been asked for but not yet spent. See cameraPan. */
  private carriedPan: Pan = { x: 0, y: 0 };
  /** Whether R3 was already in last frame, so a hold recentres once */
  private recentreHeld = false;
  /** Free, or pinned to the character. See nextCameraMode. */
  private cameraMode: CameraMode = "free";
  /** Where the camera's level is and how fast it is going. See settleLevel. */
  private followLevel?: number;
  private followSpeed = 0;
  /** The last floor the character stood on, which is what a jump is watched from */
  private lastStoodOn?: number;
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
    this.mapContainer
      .drag({ mouseButtons: "middle" })
      .pinch()
      .wheel()
      .clampZoom({ minScale: MIN_ZOOM, maxScale: MAX_ZOOM });
    this.mapContainer.setZoom(INITIAL_ZOOM);
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
      onClickCharacter: (type) => {
        this.cursorAction = {
          entityType: "character",
          type,
          mode: "add",
        };
      },
      tileFragmentsTextures: this.tileFragmentsTextures,
    });
    this.addChild(this.controlBar);

    // a child of the screen, not of the viewport, so it stays still while the
    // map pans and zooms under it
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
   * Frames per second, averaged over the last window. Counted whether or not
   * the overlay is on, so the number is already right when it appears.
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
   * cells per second. Toggled with F10, see DebugView.
   */
  private syncDebugReadout() {
    this.debugReadout.visible = debugViewEnabled();
    if (!this.debugReadout.visible) return;
    const lines = [`${Math.round(this.fps)} fps`];
    if (this.map?.character) {
      const { s, e, u } = this.map.characterVelocity;
      // the ground speed last, on its own: it is what paces the walk cycle
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
    if (!this.paused) {
      this.moveCamera(time);
      this.map?.update(time);
    }
    this.syncDebugReadout();
  }

  /**
   * Move the camera with the right stick, where the middle mouse button drags
   * it. Same viewport, same screen pixels, so the two never disagree.
   */
  private moveCamera(time: Ticker) {
    const pad = sampleGamepad();
    const seconds = time.deltaMS / 1000;
    // the press, not the hold
    const recentred = pad.recentreHeld && !this.recentreHeld;
    this.recentreHeld = pad.recentreHeld;

    const was = this.cameraMode;
    this.cameraMode = nextCameraMode(was, { recentred, stick: pad.right });
    if (recentred) this.mapContainer.setZoom(DEFAULT_ZOOM, true);

    // zooming is the same in both modes, and about the middle of the screen
    const zoom = cameraZoom(
      this.mapContainer.scale.x,
      pad.zoomIn - pad.zoomOut,
      seconds
    );
    if (zoom !== this.mapContainer.scale.x) {
      this.mapContainer.setZoom(zoom, true);
    }

    if (this.cameraMode === "following") {
      // R3 puts the camera on the character at once, without easing
      if (recentred) {
        this.followLevel = undefined;
        this.followSpeed = 0;
        this.lastStoodOn = undefined;
      }
      this.lookAtCharacter(seconds);
      return;
    }
    this.followLevel = undefined;
    this.followSpeed = 0;
    this.lastStoodOn = undefined;
    // what it was pinned to is not owed to a pan that starts now
    if (was === "following") this.carriedPan = { x: 0, y: 0 };
    const { move, carried } = cameraPan(this.carriedPan, pad.right, seconds);
    this.carriedPan = carried;
    this.mapContainer.x += move.x;
    this.mapContainer.y += move.y;
  }

  /**
   * Put the character in the middle of the screen, landing on whole SCREEN
   * pixels: with nearest-neighbour scaling, a viewport on a fraction of a pixel
   * makes the whole map shimmer.
   */
  private lookAtCharacter(seconds: number) {
    const centre = this.map?.characterCentre;
    if (!centre) return;
    // straight there the first frame, eased from then on, and the LEVEL alone:
    // walking slides the rest of the anchor a few pixels a frame
    if (centre.grounded) this.lastStoodOn = centre.standing;
    const watching = groundToWatch(this.lastStoodOn, centre);
    if (this.followLevel === undefined) {
      this.followLevel = watching;
      this.followSpeed = 0;
    } else {
      const settled = settleLevel(
        this.followLevel,
        this.followSpeed,
        watching,
        seconds
      );
      this.followLevel = settled.level;
      this.followSpeed = settled.velocity;
    }
    // y falls by 8 pixels a level, so lagging below the ground is a bigger y
    const y = centre.y + 8 * (centre.standing - this.followLevel);
    this.mapContainer.moveCenter(centre.x, y);
    this.mapContainer.x = Math.round(this.mapContainer.x);
    this.mapContainer.y = Math.round(this.mapContainer.y);
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
