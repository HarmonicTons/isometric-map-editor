/**
 * Visual debugging of the depth order, toggled with F10 (fn+F10 on macOS). Two
 * overlays on one switch: DebugOverlay draws the keys, Character tints its
 * pieces. Always off outside a browser.
 */
const TOGGLE_KEY = "F10";

let enabled = false;

export const debugViewEnabled = (): boolean => enabled;

let listening = false;

/** Start listening for the toggle. Browser only, and once per page. */
export const listenForDebugViewToggle = () => {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", (event) => {
    if (event.code !== TOGGLE_KEY) return;
    // Firefox opens its menu bar on F10
    event.preventDefault();
    enabled = !enabled;
    console.info(`Depth order overlay ${enabled ? "on" : "off"} (F10)`);
  });
};
