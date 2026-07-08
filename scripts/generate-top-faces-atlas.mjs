/**
 * Regenerates the top-faces spritesheet atlas (raw-assets/game{m}/top-faces.json),
 * which describes every fragment of top-faces.png: all the possible combinations
 * of neighboring tiles with custom sprites.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TILES = [
  "dirt",
  "dirt_grass1",
  "dirt_grass2",
  "dirt_stones",
  "dirt_pile",
  "dirt_bush",
  "rock",
  "rock_moss",
];

const generateTopFacesAtlas = (tiles) => {
  const frame = (x, y) => ({
    x,
    y,
    w: 8,
    h: 8,
  });

  const frames = {};
  tiles.forEach((tile, i) => {
    const tileFrames = {
      [`${tile}-11-w:0,u:!,s:0.png`]: {
        frame: frame(i * 32, 0),
      },
      [`${tile}-12-w:0,u:!,n:0.png`]: {
        frame: frame(i * 32 + 8, 0),
      },
      [`${tile}-13-n:0,u:!,w:0.png`]: {
        frame: frame(i * 32 + 16, 0),
      },
      [`${tile}-14-n:0,u:!,e:0.png`]: {
        frame: frame(i * 32 + 24, 0),
      },
      [`${tile}-21-s:0,u:!,w:0.png`]: {
        frame: frame(i * 32, 8),
      },
      [`${tile}-22-s:0,u:!,e:0.png`]: {
        frame: frame(i * 32 + 8, 8),
      },
      [`${tile}-23-e:0,u:!,s:0.png`]: {
        frame: frame(i * 32 + 16, 8),
      },
      [`${tile}-24-e:0,u:!,n:0.png`]: {
        frame: frame(i * 32 + 24, 8),
      },

      [`${tile}-11-w:0,u:!.png`]: {
        frame: frame(i * 32, 16),
      },
      [`${tile}-12-w:0,u:!.png`]: {
        frame: frame(i * 32 + 8, 16),
      },
      [`${tile}-13-n:0,u:!.png`]: {
        frame: frame(i * 32 + 16, 16),
      },
      [`${tile}-14-n:0,u:!.png`]: {
        frame: frame(i * 32 + 24, 16),
      },
      [`${tile}-21-s:!,u:!.png`]: {
        frame: frame(i * 32, 24),
      },
      [`${tile}-22-s:!,u:!.png`]: {
        frame: frame(i * 32 + 8, 24),
      },
      [`${tile}-23-e:!,u:!.png`]: {
        frame: frame(i * 32 + 16, 24),
      },
      [`${tile}-24-e:!,u:!.png`]: {
        frame: frame(i * 32 + 24, 24),
      },

      [`${tile}-11-w:1,u:!.png`]: {
        frame: frame(i * 32, 32),
      },
      [`${tile}-11-w:1,wu:1,u:!.png`]: {
        frame: frame(i * 32, 32),
      },
      [`${tile}-12-w:1,u:!.png`]: {
        frame: frame(i * 32 + 8, 32),
      },
      [`${tile}-12-w:1,wu:1,u:!.png`]: {
        frame: frame(i * 32 + 8, 32),
      },
      [`${tile}-13-n:1,u:!.png`]: {
        frame: frame(i * 32 + 16, 32),
      },
      [`${tile}-13-n:1,nu:1,u:!.png`]: {
        frame: frame(i * 32 + 16, 32),
      },
      [`${tile}-14-n:1,u:!.png`]: {
        frame: frame(i * 32 + 24, 32),
      },
      [`${tile}-14-n:1,nu:1,u:!.png`]: {
        frame: frame(i * 32 + 24, 32),
      },
    };

    tiles.forEach((neighbor, j) => {
      Object.assign(tileFrames, {
        [`${tile}-11-w:${neighbor},wu:0,u:!.png`]: {
          frame: frame(i * 32, j * 16 + 48),
        },
        [`${tile}-12-w:${neighbor},wu:0,u:!.png`]: {
          frame: frame(i * 32 + 8, j * 16 + 48),
        },
        [`${tile}-13-n:${neighbor},nu:0,u:!.png`]: {
          frame: frame(i * 32 + 16, j * 16 + 48),
        },
        [`${tile}-14-n:${neighbor},nu:0,u:!.png`]: {
          frame: frame(i * 32 + 24, j * 16 + 48),
        },
        [`${tile}-21-s:${neighbor},u:!.png`]: {
          frame: frame(i * 32, j * 16 + 56),
        },
        [`${tile}-22-s:${neighbor},u:!.png`]: {
          frame: frame(i * 32 + 8, j * 16 + 56),
        },
        [`${tile}-23-e:${neighbor},u:!.png`]: {
          frame: frame(i * 32 + 16, j * 16 + 56),
        },
        [`${tile}-24-e:${neighbor},u:!.png`]: {
          frame: frame(i * 32 + 24, j * 16 + 56),
        },
      });
    });
    Object.assign(frames, tileFrames);
  });
  return {
    frames,
    meta: {
      image: "top-faces.png",
      format: "RGBA8888",
      size: {
        w: 32 * tiles.length,
        h: (3 + tiles.length) * 16,
      },
      scale: "1",
    },
  };
};

const tiles = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_TILES;
const atlas = generateTopFacesAtlas(tiles);

const outputPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "raw-assets",
  "game{m}",
  "top-faces.json"
);
writeFileSync(outputPath, JSON.stringify(atlas, null, 2) + "\n");

console.log(
  `Atlas written to ${outputPath} (${Object.keys(atlas.frames).length} frames, ${tiles.length} tile types)`
);
