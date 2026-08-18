/**
 * Brings a Pokémon into the game, from its dex number alone.
 *
 *   node scripts/import-pokemon-sprites.mjs 4          -> 0004-charmander
 *   node scripts/import-pokemon-sprites.mjs 4 --force  -> download it again
 *   node scripts/import-pokemon-sprites.mjs 4 charmander   -> name it yourself
 *   node scripts/import-pokemon-sprites.mjs            -> redo every dump on disk
 *
 * It fetches the sprite dump, unpacks it, and writes what the game reads:
 *
 *   raw-sprites/<type>/                      the API answer, untouched, gitignored
 *   raw-assets/game{m}/characters/<type>/    the atlases AssetPack ships
 *   public/characters/<type>.json            the description, fetched at runtime
 *
 * One description per character, served rather than imported: there are over a
 * thousand of these to be had, and a bundle carrying all of them would be paid
 * for by everyone to play one.
 *
 * The dump stays OUT of raw-assets on purpose: it holds 34 animations and two
 * marker images each, and AssetPack would ship all of it — under names like
 * `Walk-Anim.png` that every character would claim at once. It is not committed
 * either: this script is how you get it back.
 *
 * WHAT THE DUMP DECLARES, and why none of it has to be guessed at:
 *
 * AnimData.xml gives every animation its FrameWidth, FrameHeight and one
 * Duration per frame, so the grid is the frame count across and whatever the
 * sheet's height leaves down — 8 rows for a directional animation, 1 for the
 * others. Durations are in ticks of a sixtieth of a second.
 *
 * `<anim>-Shadow.png` marks, per frame, ONE white pixel: where the feet meet the
 * ground. `<anim>-Offsets.png` marks four — black the middle of the body, green
 * the head, red and blue the hands. Both are what let a frame be placed without
 * knowing anything about the art in it.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { PNG } from "pngjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DUMPS = join(HERE, "../raw-sprites");
const ASSETS = join(HERE, "../raw-assets/game{m}/characters");
const DESCRIPTIONS = join(HERE, "../public/characters");

/** Where the dumps come from. The server files them under four digits. */
const SPRITES_URL = (dex) =>
  `https://spriteserver.pmdcollab.org/assets/${String(dex).padStart(4, "0")}/sprites.zip`;
/** Only ever asked for the name, and only when one was not given */
const NAME_URL = (dex) =>
  `https://pokeapi.co/api/v2/pokemon-species/${Number(dex)}`;

/**
 * The eight rows of a directional sheet, in the order they are stacked.
 *
 * Read off the sheets rather than off any documentation: in `Attack` the
 * character lunges the way it faces, and the ground marker follows it, so the
 * drift of that marker names the row. Row 0 lunges straight down the screen,
 * row 1 down and right, and so on counter-clockwise.
 *
 * Down the screen is s and e together, down-right is e alone: our axes fall
 * between the sheet's, which is why the four directions we had are its
 * diagonals and the four we gain are its straight ones.
 */
const ROW_DIRECTIONS = ["se", "e", "ne", "n", "nw", "w", "sw", "s"];

/**
 * The animations we take out of the dump, and the marker each is placed by.
 *
 * `ground` follows the white pixel frame by frame, so an animation that travels
 * inside its own frame — the lunge of an attack — is pinned back onto the spot
 * the engine says the character is on.
 *
 * `body` follows the black one instead, which also cancels a rise: the whole
 * arc of `Hop` is drawn into the sheet while its ground marker stays put, and
 * the engine has its own gravity to do that with.
 */
const WANTED = {
  idle: { source: "Idle", placeBy: "ground" },
  walk: { source: "Walk", placeBy: "ground" },
  hop: { source: "Hop", placeBy: "body", phases: true },
  attack: { source: "Attack", placeBy: "ground" },
};

/**
 * What the hitbox is measured on: the first frame of the walk cycle, which is
 * the pose the character holds when it is doing nothing. Not the idle sheet —
 * that one is a stretch and a yawn, and its silhouette is bigger than the
 * character ever is standing there.
 */
const MEASURED_ON = "walk";
const MEASURED_FRAME = 0;

const CELL_WIDTH = 32;
const LEVEL_HEIGHT = 8;

/**
 * How much of its own silhouette a character's footprint keeps.
 *
 * A body exactly as wide as a gap fits it only when it is aligned to the
 * flottant: the tolerance for threading a gap is the difference between the
 * two, and at equal size that difference is zero. Sliding along the wall never
 * finds the opening either, since it is a single point.
 *
 * A hair narrower than it looks is the old hand-written table's rule, and it is
 * what makes "hard to get through" out of "impossible": the passable window
 * becomes (gap - footprint) wide instead of nothing at all.
 *
 * Only the footprint. Shrinking the height would let characters under ceilings
 * they should not fit beneath.
 */
const FOOTPRINT_MARGIN = 0.99;

// ---------------------------------------------------------------- downloading

/**
 * The files of a zip, by name.
 *
 * Read through the central directory rather than by walking local headers: an
 * entry written by a streaming zipper carries its sizes AFTER its data, and
 * only the directory is guaranteed to have them. Stored and deflated entries
 * are all these dumps use.
 */
const unzip = (buffer) => {
  let end = buffer.length - 22;
  while (end >= 0 && buffer.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip: no end-of-central-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);

  const files = new Map();
  for (let entry = 0; entry < count; entry++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) {
      throw new Error(`corrupt zip: entry ${entry} is not where it says`);
    }
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const name = buffer.toString("utf8", at + 46, at + 46 + nameLength);
    const local = buffer.readUInt32LE(at + 42);
    at +=
      46 +
      nameLength +
      buffer.readUInt16LE(at + 30) +
      buffer.readUInt16LE(at + 32);

    if (name.endsWith("/")) continue;
    const data =
      local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(data, data + compressed);
    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, inflateRawSync(raw));
    else throw new Error(`${name} uses compression method ${method}`);
  }
  return files;
};

/** Fetch the dump and lay it out flat in `into`, replacing whatever was there */
const download = async (dex, into) => {
  const url = SPRITES_URL(dex);
  const answer = await fetch(url);
  if (!answer.ok) {
    throw new Error(`${url} answered ${answer.status} ${answer.statusText}`);
  }
  const files = unzip(Buffer.from(await answer.arrayBuffer()));
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });
  for (const [name, data] of files) {
    // the dumps are flat, and anything nested is not something we read
    writeFileSync(join(into, name.split("/").pop()), data);
  }
  if (!existsSync(join(into, "AnimData.xml"))) {
    throw new Error(`${url} holds no AnimData.xml`);
  }
  return files.size;
};

/** `Salamèche` -> `salameche`: no accents, nothing a file name would mind */
const slug = (name) =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * What to call the character, from the dex number alone.
 *
 * The dump carries no name — it is filed under a number — so one is asked for
 * separately. `name` on that endpoint is already the English name in the shape
 * a file wants it. Pass a name as a second argument and nothing is asked.
 */
const nameOf = async (dex) => {
  const answer = await fetch(NAME_URL(dex));
  if (!answer.ok) {
    throw new Error(
      `no name for dex ${dex}: ${answer.status}. Pass one as a second argument.`
    );
  }
  const { name } = await answer.json();
  if (!name) throw new Error(`dex ${dex} came back without a name`);
  return slug(name);
};

// ----------------------------------------------------------------- describing

const tag = (xml, name) => {
  const found = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return found ? found[1].trim() : undefined;
};

const readAnimData = (dump) => {
  const xml = readFileSync(join(dump, "AnimData.xml"), "utf8");
  const anims = {};
  for (const [, body] of xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const name = tag(body, "Name");
    anims[name] = {
      name,
      copyOf: tag(body, "CopyOf"),
      width: Number(tag(body, "FrameWidth")),
      height: Number(tag(body, "FrameHeight")),
      durations: [...body.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((d) =>
        Number(d[1])
      ),
    };
  }
  return { shadowSize: Number(tag(xml, "ShadowSize")), anims };
};

/** First pixel of `rgb` in one frame, as [x, y] from the frame's top left */
const markerIn = (png, row, column, width, height, rgb) => {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = ((row * height + y) * png.width + column * width + x) * 4;
      if (
        png.data[at + 3] !== 0 &&
        png.data[at] === rgb[0] &&
        png.data[at + 1] === rgb[1] &&
        png.data[at + 2] === rgb[2]
      ) {
        return [x, y];
      }
    }
  }
  throw new Error(`no ${rgb} marker in frame ${column} of row ${row}`);
};

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];

/**
 * Where the ground under the character is, in each frame of a sheet.
 *
 * Under `body` the offset from the body to the ground is taken from the frame
 * the character is resting in and then held: the sprite follows the body, so
 * whatever the sheet does with height is undone and the engine's own position
 * is the only thing left moving.
 */
const anchorsOf = (dump, anim, rows, placeBy) => {
  const shadow = PNG.sync.read(
    readFileSync(join(dump, `${anim.name}-Shadow.png`))
  );
  const offsets = PNG.sync.read(
    readFileSync(join(dump, `${anim.name}-Offsets.png`))
  );
  const { width, height } = anim;
  const anchors = [];
  for (let row = 0; row < rows; row++) {
    const ground = (column) =>
      markerIn(shadow, row, column, width, height, WHITE);
    const body = (column) =>
      markerIn(offsets, row, column, width, height, BLACK);
    const resting = ground(0);
    const restingBody = body(0);
    for (let column = 0; column < anim.durations.length; column++) {
      if (placeBy === "ground") {
        anchors.push(ground(column));
      } else {
        const [x, y] = body(column);
        anchors.push([
          x + resting[0] - restingBody[0],
          y + resting[1] - restingBody[1],
        ]);
      }
    }
  }
  return anchors;
};

/**
 * The four moments of a hop: leaving the ground, going up, coming down, landing.
 *
 * A hop sheet spends ten frames on what is really four poses — the frames of a
 * rise differ only in how high off the ground they are drawn, and that height is
 * exactly what `body` placement takes back out. Once each frame is placed, whole
 * runs of them are the SAME IMAGE, so grouping them by their pixels finds the
 * poses without anyone having to count.
 *
 * Which matters because the engine, not the sheet, decides how long a jump
 * lasts: it holds the rising pose while the character rises, however long that
 * is, and no sequence of ten frames can be stretched to fit.
 */
const hopPhases = (sheet, anim, anchors) => {
  const frames = anim.durations.length;
  const pixel = (column, x, y) => {
    if (y < 0 || y >= anim.height) return -1;
    const at = (y * sheet.width + column * anim.width + x) * 4;
    return sheet.data[at + 3] === 0 ? -1 : sheet.data[at];
  };
  // row 0, each frame shifted by its own anchor so only the pose is compared
  const same = (a, b) => {
    const shift = anchors[b][1] - anchors[a][1];
    for (let y = 0; y < anim.height; y++) {
      for (let x = 0; x < anim.width; x++) {
        if (pixel(a, x, y) !== pixel(b, x, y + shift)) return false;
      }
    }
    return true;
  };
  const takeoff = 0;
  let rising = 1;
  while (rising < frames && same(takeoff, rising)) rising++;
  let falling = rising + 1;
  while (falling < frames && same(rising, falling)) falling++;
  if (rising >= frames || falling >= frames) {
    throw new Error(`hop has no distinct rise and fall among ${frames} frames`);
  }
  return [takeoff, rising, falling, frames - 1];
};

/** The atlas AssetPack and Pixi read, one per animation */
const atlasOf = (type, name, anim, rows, image) => {
  const frames = {};
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < anim.durations.length; column++) {
      frames[`${type}_${name}-${ROW_DIRECTIONS[row]}${column + 1}.png`] = {
        frame: {
          x: column * anim.width,
          y: row * anim.height,
          w: anim.width,
          h: anim.height,
        },
      };
    }
  }
  return {
    frames,
    meta: {
      image,
      format: "RGBA8888",
      size: { w: anim.width * anim.durations.length, h: anim.height * rows },
      scale: "1",
    },
  };
};

/**
 * What the character occupies, read off the silhouette of one resting frame.
 *
 * Everything else in the game is drawn as the projection of a box: a footprint
 * of f cells wide covers 32f pixels, and its topmost point stands 8f + 8h above
 * the middle of its base — the very point the ground marker names. Reading the
 * silhouette back through that is what keeps a character the same size as the
 * scenery it walks on.
 *
 * The frame size cannot be used for this any more: the same character is drawn
 * in 32 by 32 walking and 64 by 64 attacking.
 */
const hitboxFrom = (sheet, anim, rows, anchor, column) => {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  // every row of it: the character has to fit whichever way it is facing
  for (let row = 0; row < rows; row++) {
    for (let y = 0; y < anim.height; y++) {
      for (let x = 0; x < anim.width; x++) {
        const at =
          ((row * anim.height + y) * sheet.width + column * anim.width + x) * 4;
        if (sheet.data[at + 3] === 0) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
      }
    }
  }
  const footprint = (maxX - minX + 1) / CELL_WIDTH;
  // the height inverts the projection of the silhouette, so it reads the
  // footprint the art really has, before the margin narrows what collides
  const levels = (anchor[1] - minY - LEVEL_HEIGHT * footprint) / LEVEL_HEIGHT;
  const round = (value) => Math.round(value * 1e4) / 1e4;
  const across = round(footprint * FOOTPRINT_MARGIN);
  return [across, across, round(Math.max(levels, 0.125))];
};

/**
 * Read a dump, write the character's atlases into a folder of its own, and
 * return what the runtime needs to know about it.
 *
 * The type is in the file names as well as in the folder: AssetPack gives every
 * asset a bare basename alias on top of its path, and two characters would
 * claim the same `walk.json`.
 */
const describe = (type, dump) => {
  const { shadowSize, anims } = readAnimData(dump);
  const into = join(ASSETS, type);
  rmSync(into, { recursive: true, force: true });
  mkdirSync(into, { recursive: true });

  const animations = {};
  let hitbox;
  for (const [name, { source, placeBy, phases }] of Object.entries(WANTED)) {
    let anim = anims[source];
    if (!anim) throw new Error(`${type} has no ${source} animation`);
    if (anim.copyOf) anim = anims[anim.copyOf];
    const file = join(dump, `${anim.name}-Anim.png`);
    const sheet = PNG.sync.read(readFileSync(file));
    const rows = sheet.height / anim.height;
    if (!Number.isInteger(rows)) {
      throw new Error(
        `${type} ${source}: ${sheet.height} px does not divide into rows of ${anim.height}`
      );
    }
    if (rows !== ROW_DIRECTIONS.length) {
      throw new Error(
        `${type} ${source} has ${rows} rows: it is not a directional sheet`
      );
    }
    const anchors = anchorsOf(dump, anim, rows, placeBy);
    animations[name] = {
      // what the frame names carry between the type and the direction. Its own
      // field because the sheets we had before this format spell it otherwise
      key: name,
      width: anim.width,
      height: anim.height,
      frames: anim.durations.length,
      durations: anim.durations,
      anchors,
      ...(phases ? { phases: hopPhases(sheet, anim, anchors) } : {}),
    };
    if (name === MEASURED_ON) {
      hitbox = hitboxFrom(
        sheet,
        anim,
        rows,
        anchors[MEASURED_FRAME],
        MEASURED_FRAME
      );
    }

    const image = `${type}_${name}.png`;
    writeFileSync(join(into, image), readFileSync(file));
    writeFileSync(
      join(into, `${type}_${name}.json`),
      `${JSON.stringify(atlasOf(type, name, anim, rows, image), null, 2)}\n`
    );
  }
  return { hitbox, shadowSize, directions: ROW_DIRECTIONS, animations };
};

// ------------------------------------------------------------------ the tools

const argv = process.argv.slice(2);
const force = argv.includes("--force");
const args = argv.filter((arg) => !arg.startsWith("--"));
const [dexArg, nameArg] = args;

/** The dumps to work from: the one asked for, or everything already on disk */
const types = [];
if (dexArg !== undefined) {
  const dex = String(Number(dexArg)).padStart(4, "0");
  if (!/^\d{4}$/.test(dex)) {
    throw new Error(`"${dexArg}" is not a dex number`);
  }
  const type = `${dex}-${nameArg ? slug(nameArg) : await nameOf(dex)}`;
  const dump = join(DUMPS, type);
  if (!existsSync(join(dump, "AnimData.xml")) || force) {
    process.stdout.write(`fetching ${SPRITES_URL(dex)} ... `);
    console.log(`${await download(dex, dump)} files -> raw-sprites/${type}`);
  } else {
    console.log(`raw-sprites/${type} is already there (--force to fetch again)`);
  }
  types.push(type);
} else {
  types.push(
    ...readdirSync(DUMPS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  );
}

mkdirSync(DESCRIPTIONS, { recursive: true });

const failed = [];
for (const type of types) {
  try {
    const sprites = describe(type, join(DUMPS, type));
    writeFileSync(
      join(DESCRIPTIONS, `${type}.json`),
      `${JSON.stringify(sprites, null, 2)}\n`
    );
    const { hitbox, animations } = sprites;
    console.log(
      `${type}  hitbox ${hitbox.join(" x ")}  ` +
        Object.entries(animations)
          .map(([name, a]) => `${name} ${a.frames}x8 ${a.width}x${a.height}`)
          .join("  ")
    );
  } catch (error) {
    failed.push(`${type}: ${error.message}`);
  }
}

console.log(`\n${types.length - failed.length} imported, ${failed.length} failed`);
for (const message of failed) console.log(`  FAILED  ${message}`);
if (failed.length) process.exitCode = 1;
