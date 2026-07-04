import { TextureStyle } from "pixi.js";
import { setEngine } from "./app/getEngine";
import { LoadScreen } from "./app/screens/LoadScreen";
import { GameScreen } from "./app/screens/main/GameScreen";
import { userSettings } from "./app/utils/userSettings";
import { CreationEngine } from "./engine/engine";

/**
 * Importing these modules will automatically register there plugins with the engine.
 */
import "@pixi/sound";
// import "@esotericsoftware/spine-pixi-v8";

// Register service worker for PWA support
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/isometric-map-editor/sw.js");
  });
}

(async () => {
  // Ensure the font is loaded before starting the application
  await document.fonts.load('1em "Final Fantasy Tactics Advance"');
  // Keep pixel art style
  TextureStyle.defaultOptions.scaleMode = "nearest";
  TextureStyle.defaultOptions.addressMode = "clamp-to-edge";
  // Create a new creation engine instance
  const engine = new CreationEngine();
  setEngine(engine);

  // Initialize the creation engine instance
  await engine.init({
    background: "#202828",
    resizeOptions: { minWidth: 0, minHeight: 0, letterbox: false },
    // pixel-perfect option: disabled because it generates small gaps on some zoom level
    // roundPixels: true,
    resolution: window.devicePixelRatio ?? 1,
    resizeTo: window,
    autoDensity: true,
  });

  // Initialize the user settings
  userSettings.init();

  // Show the load screen
  await engine.navigation.showScreen(LoadScreen);
  // Load the map in queryparams from the JSON file
  const params = new URLSearchParams(window.location.search);
  const mapName = params.get("map") ?? "deti-plains";
  const mapData = await fetch(`${import.meta.env.BASE_URL}maps/${mapName}.json`)
    .then((res) => res.json())
    .catch(() => {
      console.error(`Failed to load map data for ${mapName}`);
      return { tiles: { "0,0,0": "dirt" }, objects: {} };
    });
  // Show the main screen once the load screen is dismissed
  await engine.navigation.showScreen(GameScreen, mapData);
})();
