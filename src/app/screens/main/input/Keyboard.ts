/**
 * The keyboard as a second gamepad: held keys are remembered and read once a
 * frame, so Map needs no second path through the simulation.
 *
 * `code` everywhere, not `key`: the physical position, so WASD on QWERTY is
 * ZQSD on AZERTY.
 */
const WALK_KEYS: Record<string, { x: number; y: number }> = {
  KeyW: { x: 0, y: -1 },
  KeyA: { x: -1, y: 0 },
  KeyS: { x: 0, y: 1 },
  KeyD: { x: 1, y: 0 },
};

const JUMP_KEY = "Space";
/** just above D, so it falls under the same hand as the walk block */
const ATTACK_KEY = "KeyE";

/**
 * Where the held keys point, as a stick deflection in SCREEN space. A diagonal
 * comes out longer than 1, which walkVelocity clamps.
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

/** Start remembering what is held. Browser only, and once per page. */
export const listenForKeyboardInput = () => {
  if (listening) return;
  listening = true;
  window.addEventListener("keydown", (event) => {
    // Ctrl+S is a save, Cmd+D a bookmark: a shortcut is not a walk
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      !(event.code in WALK_KEYS) &&
      event.code !== JUMP_KEY &&
      event.code !== ATTACK_KEY
    ) {
      return;
    }
    // only the jump: space scrolls the page, the letters harm nothing
    if (event.code === JUMP_KEY) event.preventDefault();
    held.add(event.code);
  });
  window.addEventListener("keyup", (event) => held.delete(event.code));
  // a key released while unfocused fires no keyup, and the character would
  // keep walking on its own once the window comes back
  window.addEventListener("blur", () => held.clear());
};

/** What the keyboard is asking for this frame, in the same shape as a gamepad */
export const keyboardInput = () => ({
  ...stickFromKeys(held),
  jumpHeld: held.has(JUMP_KEY),
  attackHeld: held.has(ATTACK_KEY),
});
