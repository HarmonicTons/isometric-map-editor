/**
 * Visual debugging of the depth order, toggled with F10. Two overlays on one
 * switch: the key written on every cell around the character
 * (Map.syncDepthKeys), and a colour plus a key on every piece of its sprite
 * (Character.showPiece). Off outside a browser, so the tests see what ships.
 *
 * On macOS press fn+F10 unless the function keys are set to standard.
 */
const TOGGLE_KEY = "F10";

let enabled = false;

export const debugViewEnabled = (): boolean => enabled;

let listening = false;

/**
 * Start listening for the toggle. Browser only, and once per page: a second
 * listener would toggle the flag straight back and make F10 a no-op.
 */
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
