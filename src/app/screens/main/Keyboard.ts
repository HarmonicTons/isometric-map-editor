/**
 * The keyboard as a second left stick, so the character can be walked without a
 * gamepad.
 *
 * Held keys are remembered and read once a frame rather than acted on as they
 * arrive, which is what makes them a stick: the same `walkVelocity` turns them
 * into a heading, two keys at once give a diagonal for free, and Map needs no
 * second path through the simulation. See Map.sampleInput.
 */

/**
 * `code`, not `key`: the physical position of the key, whatever the layout.
 *
 * The positions are the ones named W A S D on a US keyboard, which are exactly
 * the ZQSD block on an AZERTY one — the same four keys under the same four
 * fingers either way. Reading `key` instead would bind the letters, and the
 * cluster would fall apart on the other layout.
 */
const WALK_KEYS: Record<string, { x: number; y: number }> = {
  KeyW: { x: 0, y: -1 },
  KeyA: { x: -1, y: 0 },
  KeyS: { x: 0, y: 1 },
  KeyD: { x: 1, y: 0 },
};

const JUMP_KEY = "Space";

/**
 * Where the held keys point, as a stick deflection in screen space.
 *
 * Screen space and not grid space, so that it means the same thing as a real
 * stick and goes through the same projection: pushing right walks north-east,
 * which is what right looks like on an isometric map.
 *
 * Opposite keys cancel, and a diagonal comes out longer than 1 — as it does on
 * a stick pushed into a corner, which `walkVelocity` already clamps rather than
 * rewards.
 */
export const stickFromKeys = (held: Iterable<string>) => {
  let x = 0;
  let y = 0;
  for (const code of held) {
    const key = WALK_KEYS[code];
    if (!key) continue;
    x += key.x;
    y += key.y;
  }
  return { x, y };
};

const held = new Set<string>();

let listening = false;

/**
 * Start remembering what is held. Browser only, and once per page: a second
 * listener would do no harm, but nothing needs one.
 */
export const listenForKeyboardInput = () => {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", (event) => {
    // Ctrl+S is a save, Cmd+D a bookmark: a shortcut is not a walk, and
    // swallowing one would be both rude and hard to guess at.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (!(event.code in WALK_KEYS) && event.code !== JUMP_KEY) return;
    // only the jump: space scrolls the page. The letters are left alone so
    // that they still reach anything that ever wants to be typed into.
    if (event.code === JUMP_KEY) event.preventDefault();
    held.add(event.code);
  });
  window.addEventListener("keyup", (event) => held.delete(event.code));
  // A key released while the page is not focused fires no keyup, and the
  // character would keep walking on its own once the window comes back.
  window.addEventListener("blur", () => held.clear());
};

/** What the keyboard is asking for this frame, in the same shape as a gamepad */
export const keyboardInput = () => ({
  ...stickFromKeys(held),
  jumpHeld: held.has(JUMP_KEY),
});
