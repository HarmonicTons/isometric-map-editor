import { Container, Graphics, Text } from "pixi.js";
import { debugViewEnabled } from "./DebugView";
import {
  GlobalIsoCoordinates,
  IsoString,
  LocalIsoCoordinates,
} from "../iso/IsometricCoordinate";
import { NORTH_EDGE_RUNS, WEST_EDGE_RUNS } from "../iso/Shadows";
import type { MapChunk } from "../map/MapChunk";
import type { Character } from "../character/Character";

/**
 * The two F10 overlays. They read the map through a narrow view of it rather
 * than importing Map, which would be a cycle.
 */
export type DebugSubject = Container & {
  chunks: Record<IsoString, MapChunk>;
  character: Character | undefined;
  isCellOccupied(iso: GlobalIsoCoordinates): boolean;
  isInShell(iso: GlobalIsoCoordinates): boolean;
  isTileAt(iso: GlobalIsoCoordinates): boolean;
};

export class DebugOverlay {
  /** One line per chunk, drawn on demand. See syncChunkBounds. */
  private chunkBoundsOverlay?: Container;
  private chunkBounds: Record<
    IsoString,
    { line: Graphics; signature: string }
  > = {};

  /** One label per cell and per character piece. See syncDepthKeys. */
  private depthKeyOverlay?: Container;
  private depthKeyLabels: Text[] = [];

  constructor(private map: DebugSubject) {}

  public sync() {
    this.syncChunkBounds();
    this.syncDepthKeys();
  }

  /**
   * A red line along every chunk boundary, laid on the top face of the tiles
   * that sit on it — a boundary is where a local coordinate is 0, so a tile
   * draws the NORTH and WEST edges of its own face.
   *
   * One Graphics per chunk, rebuilt only when its cells changed, all in an
   * overlay above the map so the lines show through the terrain in front.
   */
  private syncChunkBounds() {
    if (!debugViewEnabled()) {
      if (this.chunkBoundsOverlay) this.chunkBoundsOverlay.visible = false;
      return;
    }
    if (!this.chunkBoundsOverlay) {
      this.chunkBoundsOverlay = new Container();
      // above every chunk, and just under the depth key labels
      this.chunkBoundsOverlay.zIndex = Number.MAX_SAFE_INTEGER - 1;
      this.map.addChild(this.chunkBoundsOverlay);
    }
    this.chunkBoundsOverlay.visible = true;

    for (const key of Object.keys(this.chunkBounds) as IsoString[]) {
      if (this.map.chunks[key]) continue;
      this.chunkBounds[key].line.destroy();
      delete this.chunkBounds[key];
    }

    for (const key of Object.keys(this.map.chunks) as IsoString[]) {
      const chunk = this.map.chunks[key];
      const drawn = (this.chunkBounds[key] ??= {
        line: this.chunkBoundsOverlay.addChild(
          new Graphics({ eventMode: "none" })
        ),
        signature: "",
      });
      const signature = `${chunk.revision}`;
      if (drawn.signature === signature) continue;
      drawn.signature = signature;
      drawn.line.clear();
      for (const cellKey of Object.keys(chunk.cells) as IsoString[]) {
        const local = LocalIsoCoordinates.fromString(cellKey);
        if (local.s !== 0 && local.e !== 0) continue;
        const iso = chunk.toGlobalIsoCoordinates(local);
        // only a top face that is actually drawn: a buried tile has none, and
        // a map object is not a face at all
        if (!this.map.isTileAt(iso) || this.map.isTileAt(iso.move("up")))
          continue;
        if (!this.map.isInShell(iso)) continue;
        const xy = iso.toXY();
        const runs = [
          ...(local.s === 0 ? NORTH_EDGE_RUNS : []),
          ...(local.e === 0 ? WEST_EDGE_RUNS : []),
        ];
        for (const run of runs) {
          drawn.line.rect(xy.x + run.x, xy.y + run.y, run.width, 1);
        }
      }
      drawn.line.fill({ color: 0xff0000, alpha: 1 });
    }
  }

  /**
   * The depth key written on every cell around the character and on every piece
   * of its sprite. Only the cells it can reach: a whole map's worth of text
   * would be unreadable.
   */
  private syncDepthKeys() {
    const character = this.map.character;
    if (!debugViewEnabled() || !character) {
      this.depthKeyLabels.forEach((label) => (label.visible = false));
      return;
    }
    if (!this.depthKeyOverlay) {
      this.depthKeyOverlay = new Container();
      // above every chunk, whatever their diagonal
      this.depthKeyOverlay.zIndex = Number.MAX_SAFE_INTEGER;
      this.map.addChild(this.depthKeyOverlay);
    }

    let used = 0;
    /** Two lines, the pair centred on (x, y). */
    const write = (
      top: string,
      bottom: string,
      x: number,
      y: number,
      fill: number
    ) => {
      const label = (this.depthKeyLabels[used] ??=
        this.depthKeyOverlay!.addChild(
          new Text({
            text: "",
            // thirteen characters in a 32 px cell, so the type is tiny and
            // the resolution is what keeps it readable once zoomed in
            resolution: 8,
            anchor: 0.5,
            style: {
              fontFamily: "monospace",
              fontSize: 2,
              align: "center",
              fill: 0xffffff,
              // in style pixels, so it has to shrink with the type
              stroke: { color: 0x000000, width: 0.5 },
            },
          })
        ));
      used++;
      label.visible = true;
      const text = `${top}\n${bottom}`;
      // both of these rebuild the text's texture, so only when they change
      if (label.text !== text) label.text = text;
      if (label.style.fill !== fill) label.style.fill = fill;
      label.x = x;
      label.y = y;
    };

    const { s, e, u } = character.globalIsoCoordinates;
    const radius = 3;
    for (let cs = Math.floor(s) - radius; cs <= Math.floor(s) + radius; cs++) {
      for (
        let ce = Math.floor(e) - radius;
        ce <= Math.floor(e) + radius;
        ce++
      ) {
        for (let cu = Math.floor(u) - 2; cu <= Math.floor(u) + 3; cu++) {
          const iso = new GlobalIsoCoordinates(cs, ce, cu);
          // only what is actually drawn: a buried cell's label would float over
          // the tiles hiding it
          if (!this.map.isCellOccupied(iso) || !this.map.isInShell(iso))
            continue;
          const xy = iso.toXY();
          // the middle of the cell's top face, which is the top half of its
          // 32×24 sprite
          write(
            iso.toString(),
            `${iso.paintersOrderKey()}`,
            xy.x + 16,
            xy.y + 8,
            0xffffff
          );
        }
      }
    }
    const cut = character.cut;
    const columns = cut?.columns ?? [];
    columns.forEach((column, index) => {
      // at the centroid of the pixels it covers: the centre of the bounding
      // box of a column cut along a diagonal falls inside the neighbouring one
      let covered = 0;
      let x = 0;
      let y = 0;
      for (const run of column.runs) {
        covered += run.width;
        x += (run.x + run.width / 2) * run.width;
        y += (run.y + 0.5) * run.width;
      }
      // which column it stands over, except on the nearest one, where the
      // character's own position is worth more
      const where =
        index === columns.length - 1
          ? `${s.toFixed(1)},${e.toFixed(1)},${u.toFixed(1)}`
          : `${column.s},${column.e}`;
      write(
        // one decimal is enough to separate two characters sharing a column
        where,
        column.zIndex.toFixed(1),
        cut!.x + x / covered,
        cut!.y + y / covered,
        0xffe066
      );
    });
    for (let index = used; index < this.depthKeyLabels.length; index++) {
      this.depthKeyLabels[index].visible = false;
    }
  }
}
