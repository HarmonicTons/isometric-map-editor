import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MapData } from "../Map";
import { composeMapImage } from "./composeMapImage";

/**
 * Pixel-perfect snapshot tests: these maps are pixel-exact replicas of their
 * FFTA renders and cover a large set of tile combinations. The test fails if
 * a single pixel of their composed render changes.
 *
 * On failure, <map>.actual.png and <map>.diff.png are written next to the
 * golden for visual inspection. To accept a new render:
 *   UPDATE_SNAPSHOTS=1 npm test
 */

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const mapsDir = path.resolve(testsDir, "../../../../../public/maps");
const snapshotsDir = path.join(testsDir, "__image_snapshots__");

const SNAPSHOT_MAPS = [
  "single",
  "checkboard",
  "rock-cubes",
  "dirt-grass",
  "rock-grass",
  "wall-dirt",
  "deti-plains",
  "koring-wood",
];

describe("map render snapshots", () => {
  // Map's constructor is chatty
  beforeAll(() => {
    vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  SNAPSHOT_MAPS.forEach((mapName) => {
    it(`renders ${mapName} pixel-for-pixel`, () => {
      const mapData = JSON.parse(
        readFileSync(path.join(mapsDir, `${mapName}.json`), "utf8")
      ) as MapData;
      const actual = composeMapImage(mapData);

      const goldenPath = path.join(snapshotsDir, `${mapName}.png`);
      const actualPath = path.join(snapshotsDir, `${mapName}.actual.png`);
      const diffPath = path.join(snapshotsDir, `${mapName}.diff.png`);

      if (!existsSync(goldenPath) || process.env.UPDATE_SNAPSHOTS) {
        mkdirSync(snapshotsDir, { recursive: true });
        writeFileSync(goldenPath, PNG.sync.write(actual));
        console.warn(`Golden snapshot written: ${goldenPath}`);
        return;
      }

      const golden = PNG.sync.read(readFileSync(goldenPath));

      if (golden.width !== actual.width || golden.height !== actual.height) {
        writeFileSync(actualPath, PNG.sync.write(actual));
        expect.fail(
          `Render size changed: expected ${golden.width}x${golden.height}, ` +
            `got ${actual.width}x${actual.height}. Actual render written to ` +
            `${actualPath}. Run UPDATE_SNAPSHOTS=1 npm test to accept it.`
        );
      }

      if (Buffer.compare(golden.data, actual.data) === 0) {
        rmSync(actualPath, { force: true });
        rmSync(diffPath, { force: true });
        return;
      }

      const diff = new PNG({ width: golden.width, height: golden.height });
      const differingPixels = pixelmatch(
        golden.data,
        actual.data,
        diff.data,
        golden.width,
        golden.height,
        { threshold: 0 }
      );
      writeFileSync(actualPath, PNG.sync.write(actual));
      writeFileSync(diffPath, PNG.sync.write(diff));
      expect.fail(
        `${differingPixels} pixel(s) differ from the golden snapshot. ` +
          `See ${diffPath}. Run UPDATE_SNAPSHOTS=1 npm test to accept the ` +
          `new render.`
      );
    });
  });
});
