import { Container, FillGradient, Graphics, Text } from "pixi.js";
import { clamp } from "../../engine/utils/maths";
import { engine } from "../getEngine";

export class Background extends Container {
  public linearGradient: FillGradient;
  public background: Graphics;
  public title: Text;

  constructor() {
    super();

    const linearGradient = new FillGradient({
      type: "linear",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 1 },
      colorStops: [
        { offset: 0, color: "#54b8f5" },
        { offset: 1, color: "#d5fcfd" },
      ],
      textureSpace: "local",
    });
    this.linearGradient = linearGradient;
    const background = new Graphics()
      .rect(0, 0, engine().screen.width, engine().screen.height)
      .fill(linearGradient);
    this.addChild(background);
    this.background = background;

    const title = new Text({
      text: "Isometric Map Editor",
    });
    title.style.fill = "white";
    title.alpha = 0.5;
    title.style.fontFamily = "Final Fantasy Tactics Advance";
    title.anchor.set(1, 1);
    this.addChild(title);
    this.title = title;
  }

  public resize(width: number, height: number) {
    this.background.clear();
    this.background.rect(0, 0, width, height).fill(this.linearGradient);

    const isLandscape = width > height;

    this.title.style.fontSize = clamp(Math.floor(width / 15), 45, 120);
    this.title.anchor.set(1, isLandscape ? 1 : 0);
    this.title.x = isLandscape ? width - 32 : width - 12;
    this.title.y = isLandscape ? height - 32 : 0;
  }
}
