import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Assets,
  Container,
  Mesh,
  MeshGeometry,
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
 * The quads of a character piece, read back from its mesh.
 *
 * Character.fillGeometry writes four vertices per quad — top-left, top-right,
 * bottom-right, bottom-left — with the matching corners of the animation frame
 * as UVs. Nothing else is supported: a quad that is not axis-aligned, or whose
 * UVs do not match its shape, throws rather than rasterize into something the
 * GPU would not draw.
 */
const meshQuads = (geometry: MeshGeometry, frame: Rectangle) => {
  const { positions, uvs } = geometry;
  if (positions.length % 8 !== 0) {
    throw new Error("Rasterizer only supports meshes built as quads");
  }
  const quads: {
    sx: number;
    sy: number;
    w: number;
    h: number;
    dx: number;
    dy: number;
  }[] = [];
  for (let quad = 0; quad < positions.length; quad += 8) {
    const left = positions[quad];
    const top = positions[quad + 1];
    const right = positions[quad + 2];
    const bottom = positions[quad + 5];
    if (
      positions[quad + 3] !== top ||
      positions[quad + 4] !== right ||
      positions[quad + 6] !== left ||
      positions[quad + 7] !== bottom
    ) {
      throw new Error("Rasterizer only supports axis-aligned quads");
    }
    // UVs are fractions of the frame, so multiplying back lands a hair off a
    // whole texel. Rounding is not cosmetic here: a fractional index into the
    // sheet reads undefined, which used to blit holes into the character.
    const sx = Math.round(frame.x + uvs[quad] * frame.width);
    const sy = Math.round(frame.y + uvs[quad + 1] * frame.height);
    const sw = Math.round(frame.x + uvs[quad + 2] * frame.width) - sx;
    const sh = Math.round(frame.y + uvs[quad + 5] * frame.height) - sy;
    if (sw !== right - left || sh !== bottom - top) {
      throw new Error("Rasterizer only supports meshes drawn at 1:1");
    }
    quads.push({ sx, sy, w: right - left, h: bottom - top, dx: left, dy: top });
  }
  return quads;
};

/**
 * Walk the scene graph in Pixi's render order: a container renders itself,
 * then its children (sorted by zIndex when sortableChildren, stable on ties).
 * Only plain translated sprites and quad meshes are supported: anything else
 * (scale, rotation, tint, alpha) throws so a rendering feature the rasterizer
 * cannot reproduce can never be silently dropped from the snapshots.
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
  if (node instanceof Mesh) {
    if (node.tint !== 0xffffff || node.alpha !== 1) {
      throw new Error("Rasterizer does not support tint nor alpha");
    }
    const sheet = sheetBySource.get(node.texture.source);
    if (!sheet) {
      throw new Error(`Unknown texture source for "${node.texture.label}"`);
    }
    for (const quad of meshQuads(node.geometry, node.texture.frame)) {
      out.push({
        sheet,
        sx: quad.sx,
        sy: quad.sy,
        w: quad.w,
        h: quad.h,
        dx: Math.round(x + quad.dx),
        dy: Math.round(y + quad.dy),
      });
    }
  } else if (node instanceof Sprite) {
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
      // A no-op today: every sprite sits on a whole pixel. Kept so that a
      // sprite placed between two pixels lands
      // somewhere sane instead of corrupting the buffer, but a snapshot taken
      // through it would then be off by up to a pixel from the GPU.
      dx: Math.round(x - node.anchor.x * frame.width),
      dy: Math.round(y - node.anchor.y * frame.height),
    });
  }
  if (node.sortableChildren) {
    node.sortChildren();
  }
  for (const child of node.children) {
    collectBlits(child, x, y, sheetBySource, out);
  }
};

/**
 * A real Map, built headless. Pixi runs fine in Node as long as nothing is
 * rendered, so tests can exercise the actual chunking, painter's order and
 * character slicing rather than a stand-in. The caller owns it and must
 * destroy it.
 */
export const buildHeadlessMap = (
  mapData: MapData,
  chunksSize?: number
): IsometricMap =>
  new IsometricMap(
    mapData,
    new TileFragmentsTextures(loadAssets().textureNames),
    chunksSize
  );

export const composeMapImage = (
  mapData: MapData,
  /** test hook: mutate the built map before it is rasterized */
  mangle?: (map: IsometricMap) => void,
  chunksSize?: number
): PNG => {
  const { sheetBySource } = loadAssets();
  const map = buildHeadlessMap(mapData, chunksSize);
  mangle?.(map);
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
