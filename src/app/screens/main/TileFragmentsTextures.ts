import { maxBy, sumBy } from "lodash";
import { Assets, Texture } from "pixi.js";
import { IsoCoordinates } from "./IsometricCoordinate";
import { GetTileNeighbor, TileFragmentKey } from "./TileFragment";

export type TextureData = {
  name: string;
  type: string;
  fragment: TileFragmentKey;
  height: [number, number] | null;
  score: number;
  neighborhood: Array<{
    relativeCoordinates: IsoCoordinates;
    rule: string;
  }>;
};

export type FragmentData = {
  type: string;
  fragment: TileFragmentKey;
  getTileNeighbor: GetTileNeighbor;
  height: number;
};

export type TextureByFragment = Map<TileFragmentKey, Array<TextureData>>;

export type TextureByTileType = Map<string, TextureByFragment>;

const directionMapping: Record<string, IsoCoordinates> = {
  u: new IsoCoordinates(0, 0, 1),
  n: new IsoCoordinates(-1, 0, 0),
  e: new IsoCoordinates(0, 1, 0),
  s: new IsoCoordinates(1, 0, 0),
  w: new IsoCoordinates(0, -1, 0),
  d: new IsoCoordinates(0, 0, -1),
};

export class TileFragmentsTextures {
  public texturesInCache: TextureByTileType;
  constructor() {
    this.texturesInCache = new Map();

    this.init();
  }

  public static parseTextureName(textureName: string): TextureData {
    const [type, fragment, neighborhoodStr, height] = textureName
      .slice(0, ".png".length * -1)
      .split("-");

    const neighborhood = neighborhoodStr.split(",").map((s) => {
      const [directions, rule] = s.split(":");
      const relativeCoordinates = directions.split("").reduce(
        (iso, direction) => {
          const offset = directionMapping[direction];
          return iso.add(offset);
        },
        new IsoCoordinates(0, 0, 0)
      );
      return {
        relativeCoordinates,
        rule,
      };
    });

    const score = sumBy(neighborhood, ({ rule }) => {
      if (rule === "*") return 0;
      if (rule === "1") return 1;
      if (rule === "!") return 2;
      return 5;
    });

    return {
      name: textureName,
      type,
      fragment: fragment as TileFragmentKey,
      neighborhood,
      score,
      height: height
        ? (height.split(":").map(Number) as [number, number])
        : null,
    };
  }

  public static isTexureValid({
    fragmentData,
    textureData,
  }: {
    textureData: TextureData;
    fragmentData: FragmentData;
  }): boolean {
    if (textureData.type !== fragmentData.type) {
      return false;
    }
    if (textureData.fragment !== fragmentData.fragment) {
      return false;
    }
    if (textureData.height) {
      const [mod, val] = textureData.height;
      if (fragmentData.height % mod !== val - 1) {
        return false;
      }
    }

    return textureData.neighborhood.every(({ relativeCoordinates, rule }) => {
      const neighborType = fragmentData.getTileNeighbor(relativeCoordinates);
      if (rule === "*") return true;
      if (rule === "0") return neighborType === undefined;
      if (rule === "1") return neighborType !== undefined;
      if (rule === "=")
        return TileFragmentsTextures.areSameTypes(
          neighborType,
          fragmentData.type
        );
      if (rule === "!")
        return (
          TileFragmentsTextures.areSameTypes(
            neighborType,
            fragmentData.type
          ) === false
        );
      return neighborType === rule;
    });
  }

  public static areSameTypes(type1?: string, type2?: string): boolean {
    if (type1 === type2) return true;
    const baseType1 = type1?.split("_")[0];
    const baseType2 = type2?.split("_")[0];
    return baseType1 === baseType2;
  }

  private init() {
    // TODO: use another system to register the textures instead of using Pixi's cache
    // @ts-expect-error hack to access private property
    const cache = Assets.cache._cache as Map<string, Texture>;
    const fragmentTextureRegex =
      /([a-z0-9_]+)-([1-4]{2})-([u,n,e,s,w,d]+:[^,-]+)+(,[u,n,e,s,w,d]+:[^,-]+)*(-\d+:\d+)?\.png/;
    const validTextures = [...cache.keys()].filter((k) =>
      fragmentTextureRegex.test(k)
    );
    validTextures.forEach((textureName) => {
      try {
        const data = TileFragmentsTextures.parseTextureName(textureName);
        if (!this.texturesInCache.has(data.type)) {
          this.texturesInCache.set(data.type, new Map());
        }
        const byFragment = this.texturesInCache.get(data.type)!;
        if (!byFragment.has(data.fragment)) {
          byFragment.set(data.fragment, []);
        }
        const textures = byFragment.get(data.fragment)!;
        textures.push(data);
      } catch (e) {
        console.warn(`Unable to parse texture named "${textureName}"`, e);
        return;
      }
    });
  }

  public getAllValidTexturesForFragment(
    fragmentData: FragmentData
  ): Array<TextureData> {
    const typeTextures = this.texturesInCache.get(fragmentData.type);
    if (!typeTextures) {
      return [];
    }
    const fragmentTextures = typeTextures.get(fragmentData.fragment);
    if (!fragmentTextures) {
      return [];
    }
    return fragmentTextures.filter((textureData) =>
      TileFragmentsTextures.isTexureValid({
        textureData,
        fragmentData,
      })
    );
  }

  public getFragmentTexture(fragmentData: FragmentData): Texture | null {
    const [type, variant] = fragmentData.type.split("_");
    const validTextures = [
      ...this.getAllValidTexturesForFragment(fragmentData),
      ...(variant
        ? this.getAllValidTexturesForFragment({
            ...fragmentData,
            type,
          }).map((t) => ({ ...t, score: t.score - 1 }))
        : []),
    ];

    if (validTextures.length === 0) {
      return null;
    }

    const textureData = maxBy(validTextures, "score")!;

    const texture = Texture.from(textureData.name);
    if (!texture) {
      return null;
    }
    return texture;
  }
}
