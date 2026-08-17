/**
 * Visual debugging of the depth order, toggled with F10.
 *
 * Two overlays on the same switch, because neither says much without the
 * other: every cell around the character gets its depth key written on it
 * (Map.syncDepthKeys), and every piece of the character's sprite gets its own
 * tint and its own key (Character.showPiece). Together they show which piece
 * was given which key, and against which cells.
 *
 * Off by default, and off everywhere outside a browser: the tests and the
 * headless rasterizer have to see exactly what ships.
 */

/**
 * `code`, not `key`: it is the physical key, whatever the layout.
 *
 * F10 is free in the browser — F11 is fullscreen and F12 the devtools — but
 * macOS keeps it for Mute unless "Use F1, F2, etc. keys as standard function
 * keys" is on, in which case press fn+F10 instead. The event is identical.
 */
const TOGGLE_KEY = "F10";

let enabled = false;

export const debugViewEnabled = (): boolean => enabled;

/** Start listening for the toggle. Browser only: there is no window in node. */
export const listenForDebugViewToggle = () => {
  window.addEventListener("keydown", (event) => {
    if (event.code !== TOGGLE_KEY) return;
    // Firefox opens its menu bar on F10
    event.preventDefault();
    enabled = !enabled;
    console.info(`Depth order overlay ${enabled ? "on" : "off"} (F10)`);
  });
};
