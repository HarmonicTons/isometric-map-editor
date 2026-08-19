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
 * The dump stays out of raw-assets and out of git: it holds many animations per
 * character, under names every character would claim at once. This script is
 * how you get it back.
 *
 * WHAT THE DUMP DECLARES:
 *
 * AnimData.xml gives every animation its FrameWidth, FrameHeight and one
 * Duration per frame, in ticks of a sixtieth of a second — so the grid is the
 * frame count across and 8 rows down for a directional animation, 1 for the
 * others.
 *
 * `<anim>-Shadow.png` marks, per frame, ONE white pixel: where the feet meet the
 * ground. `<anim>-Offsets.png` marks four — black the middle of the body, green
 * the head, red and blue the hands.
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
 * The eight rows of a directional sheet, in the order they are stacked: row 0
 * faces straight down the screen, each next one 45° counter-clockwise.
 */
const ROW_DIRECTIONS = ["se", "e", "ne", "n", "nw", "w", "sw", "s"];

/**
 * The animations we take out of the dump, and the marker each is placed by:
 * `ground` pins a frame by the feet, `body` by the middle of the body, which
 * also cancels the rise a hop sheet draws into itself.
 */
const WANTED = {
  idle: { source: "Idle", placeBy: "ground" },
  walk: { source: "Walk", placeBy: "ground" },
  hop: { source: "Hop", placeBy: "body", phases: true },
  attack: { source: "Attack", placeBy: "ground" },
};

/**
 * What the hitbox is measured on: the first frame of the walk cycle, which is
 * the pose a character holds when it is doing nothing.
 */
const MEASURED_ON = "walk";
const MEASURED_FRAME = 0;

const CELL_WIDTH = 32;
const LEVEL_HEIGHT = 8;

/**
 * How much of its own silhouette a character's footprint keeps: the window for
 * threading a gap is (gap - footprint) wide, so a body exactly as wide as a gap
 * could never get through one. The height is left alone.
 */
const FOOTPRINT_MARGIN = 0.99;

// ---------------------------------------------------------------- downloading

/**
 * The files of a zip, by name. Read through the central directory, which is the
 * only place an entry's sizes are guaranteed to be. Stored and deflated only.
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
 * What to call the character, from the dex number alone — the dump is filed
 * under a number and carries no name. Pass one as a second argument to skip it.
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
  return { anims };
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
 * Where the ground under the character is, in each frame of a sheet. Under
 * `body` the offset from the body to the ground is taken from the resting frame
 * and then held, which undoes whatever the sheet does with height.
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
 * The four moments of a hop: leaving the ground, going up, coming down,
 * landing. The apex is where the body anchor is highest, the middle of each
 * half is the pose that half holds, and the sheet's first and last frames are
 * the other two.
 */
const hopPhases = (anim, anchors) => {
  const frames = anim.durations.length;
  const height = anchors.slice(0, frames).map(([, y]) => y);
  const apex = Math.min(...height);
  const middle = (from, to) => Math.round((from + to) / 2);
  return [
    0,
    middle(0, height.indexOf(apex)),
    middle(height.lastIndexOf(apex), frames - 1),
    frames - 1,
  ];
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
 * Everything in the game is drawn as the projection of a box: a footprint f
 * cells wide covers 32f pixels, and its topmost point stands 8f + 8h above the
 * middle of its base — the point the ground marker names. The frame size is no
 * use here: the same character is 32×32 walking and 64×64 attacking.
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
  const { anims } = readAnimData(dump);
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
      frames: anim.durations.length,
      durations: anim.durations,
      anchors,
      ...(phases ? { phases: hopPhases(anim, anchors) } : {}),
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
  return { hitbox, animations };
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
          .map(([name, a]) => `${name} ${a.frames}x8`)
          .join("  ")
    );
  } catch (error) {
    failed.push(`${type}: ${error.message}`);
  }
}

console.log(`\n${types.length - failed.length} imported, ${failed.length} failed`);
for (const message of failed) console.log(`  FAILED  ${message}`);
if (failed.length) process.exitCode = 1;
