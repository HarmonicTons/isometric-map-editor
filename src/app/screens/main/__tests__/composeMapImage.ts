import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Assets,
  Container,
  Rectangle,
  Sprite,
  Texture,
  TextureSource,
} from "pixi.js";
import { PNG } from "pngjs";
import { Map as IsometricMap, MapData } from "../Map";
import { TileFragmentsTextures } from "../TileFragmentsTextures";

/**
 * CPU compositor for snapshot tests: builds the map with the REAL Map class
 * (Pixi runs fine headless as long as nothing is rendered), then rasterizes
 * the scene graph it produced with pngjs. No game logic is duplicated here:
 * shell computation, chunking, painter's order, anchors... all come from the
 * app code. This file only re-implements the last step, turning a tree of
 * sprites into pixels, which is Pixi's job, not the app's.
 */

const rawAssetsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../raw-assets/game{m}"
);

type AtlasJson = {
  frames: Record<
    string,
    { frame: { x: number; y: number; w: number; h: number } }
  >;
  meta: { image: string };
};

type LoadedAssets = {
  /** The decoded spritesheet behind each headless texture source */
  sheetBySource: globalThis.Map<TextureSource, PNG>;
  textureNames: string[];
};

let loadedAssets: LoadedAssets | undefined;

/**
 * Loads every atlas of raw-assets/game{m} and registers each frame in Pixi's
 * cache as a real Texture (correct dimensions, no pixel upload), mimicking
 * what Assets.load does at runtime. Runs once: the cache is global.
 */
const loadAssets = (): LoadedAssets => {
  if (loadedAssets) return loadedAssets;
  const sheetBySource = new globalThis.Map<TextureSource, PNG>();
  const textureNames: string[] = [];
  for (const file of readdirSync(rawAssetsDir)) {
    if (!file.endsWith(".json")) continue;
    const atlas = JSON.parse(
      readFileSync(path.join(rawAssetsDir, file), "utf8")
    ) as AtlasJson;
    const sheet = PNG.sync.read(
      readFileSync(path.join(rawAssetsDir, atlas.meta.image))
    );
    const source = new TextureSource({
      width: sheet.width,
      height: sheet.height,
    });
    sheetBySource.set(source, sheet);
    for (const [name, { frame }] of Object.entries(atlas.frames)) {
      const texture = new Texture({
        source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
        label: name,
      });
      Assets.cache.set(name, texture);
      textureNames.push(name);
    }
  }
  loadedAssets = { sheetBySource, textureNames };
  return loadedAssets;
};

type Blit = {
  sheet: PNG;
  sx: number;
  sy: number;
  w: number;
  h: number;
  dx: number;
  dy: number;
};

/**
 * Walk the scene graph in Pixi's render order: a container renders itself,
 * then its children (sorted by zIndex when sortableChildren, stable on ties).
 * Only plain translated sprites are supported: anything else (scale,
 * rotation, tint, alpha) throws so a rendering feature the rasterizer cannot
 * reproduce can never be silently dropped from the snapshots.
 */
const collectBlits = (
  node: Container,
  parentX: number,
  parentY: number,
  sheetBySource: LoadedAssets["sheetBySource"],
  out: Blit[]
) => {
  if (!node.visible || !node.renderable) return;
  if (node.scale.x !== 1 || node.scale.y !== 1 || node.rotation !== 0) {
    throw new Error("Rasterizer only supports translated nodes");
  }
  const x = parentX + node.x;
  const y = parentY + node.y;
  if (node instanceof Sprite) {
    if (node.tint !== 0xffffff || node.alpha !== 1) {
      throw new Error("Rasterizer does not support tint nor alpha");
    }
    const sheet = sheetBySource.get(node.texture.source);
    if (!sheet) {
      throw new Error(`Unknown texture source for "${node.texture.label}"`);
    }
    const frame = node.texture.frame;
    out.push({
      sheet,
      sx: frame.x,
      sy: frame.y,
      w: frame.width,
      h: frame.height,
      dx: x - node.anchor.x * frame.width,
      dy: y - node.anchor.y * frame.height,
    });
  }
  if (node.sortableChildren) {
    node.sortChildren();
  }
  for (const child of node.children) {
    collectBlits(child, x, y, sheetBySource, out);
  }
};

export const composeMapImage = (mapData: MapData): PNG => {
  const { sheetBySource, textureNames } = loadAssets();
  const map = new IsometricMap(
    mapData,
    new TileFragmentsTextures(textureNames)
  );
  const blits: Blit[] = [];
  collectBlits(map, 0, 0, sheetBySource, blits);
  map.destroy({ children: true });

  if (blits.length === 0) {
    return new PNG({ width: 1, height: 1 });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { w, h, dx, dy } of blits) {
    minX = Math.min(minX, dx);
    minY = Math.min(minY, dy);
    maxX = Math.max(maxX, dx + w);
    maxY = Math.max(maxY, dy + h);
  }

  const image = new PNG({ width: maxX - minX, height: maxY - minY });
  for (const { sheet, sx, sy, w, h, dx, dy } of blits) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sourceIndex = ((sy + y) * sheet.width + sx + x) * 4;
        // Assets are binary-alpha: an opaque copy is exactly the GPU
        // source-over
        if (sheet.data[sourceIndex + 3] === 0) continue;
        const destIndex = ((dy - minY + y) * image.width + (dx - minX + x)) * 4;
        image.data[destIndex] = sheet.data[sourceIndex];
        image.data[destIndex + 1] = sheet.data[sourceIndex + 1];
        image.data[destIndex + 2] = sheet.data[sourceIndex + 2];
        image.data[destIndex + 3] = sheet.data[sourceIndex + 3];
      }
    }
  }
  return image;
};
