import * as Cesium from 'cesium';

/**
 * Action marks — a glyph that pops on the map exactly where an order lands.
 *
 * Every sanction the operator (or a Process Action) commits used to register only as a counter and a
 * fading toast. These are the events made spatial: a citation slip where a fine was written, an eye
 * where an investigation opened, cuffs at a detention, bars at a sentencing, a crosshair at a kill.
 * A process firing on its own becomes a visible stream of them across the theater — which is the
 * whole point of being able to watch what you set running.
 *
 * Billboards, deliberately: they're sized in PIXELS, so a mark reads the same from street level or
 * from the 95 km entry view — the operator can see the programme working from any zoom. Pooled and
 * recycled like the crowd reactions (game/reactions.ts), which this is a sibling of; the two even
 * share the rise-and-fade shape, because both are "something just happened here" made briefly visible.
 */

const POOL = 128;
const LIFETIME = 1.7;
/** Metres a mark drifts upward over its life. */
const RISE_M = 240;
const MARK_PX = 28;
const ICON_PX = 64;

export type ActionKind = 'fine' | 'investigate' | 'detain' | 'prison' | 'execute';

function markCanvas(color: string, draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_PX;
  c.height = ICON_PX;
  const g = c.getContext('2d')!;
  g.translate(ICON_PX / 2, ICON_PX / 2);
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // A dark disc behind every glyph so it reads over bright terrain and buildings alike.
  g.fillStyle = 'rgba(11, 12, 14, 0.82)';
  g.strokeStyle = color;
  g.beginPath();
  g.arc(0, 0, 26, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.strokeStyle = color;
  g.fillStyle = color;
  draw(g);
  return c;
}

/** Citation slip — a torn ticket with a $ on it. */
function fineGlyph(color: string): HTMLCanvasElement {
  return markCanvas(color, (g) => {
    g.lineWidth = 3;
    g.strokeRect(-11, -13, 22, 26);
    g.beginPath();
    g.moveTo(-6, -6);
    g.lineTo(6, -6);
    g.moveTo(-6, 0);
    g.lineTo(6, 0);
    g.stroke();
    g.font = 'bold 12px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('$', 0, 8);
  });
}

/** Investigation — a magnifier over an eye. */
function investigateGlyph(color: string): HTMLCanvasElement {
  return markCanvas(color, (g) => {
    g.lineWidth = 3;
    g.beginPath();
    g.arc(-3, -3, 10, 0, Math.PI * 2);
    g.stroke();
    // pupil
    g.beginPath();
    g.arc(-3, -3, 3, 0, Math.PI * 2);
    g.fill();
    // handle
    g.beginPath();
    g.moveTo(5, 5);
    g.lineTo(13, 13);
    g.stroke();
  });
}

/** Detention — a pair of linked cuffs. */
function detainGlyph(color: string): HTMLCanvasElement {
  return markCanvas(color, (g) => {
    g.lineWidth = 3;
    for (const x of [-8, 8]) {
      g.beginPath();
      g.arc(x, 2, 8, 0, Math.PI * 2);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-2, -4);
    g.lineTo(2, -4);
    g.stroke();
  });
}

/** Sentencing — cell bars. */
function prisonGlyph(color: string): HTMLCanvasElement {
  return markCanvas(color, (g) => {
    g.lineWidth = 3;
    for (const x of [-8, 0, 8]) {
      g.beginPath();
      g.moveTo(x, -12);
      g.lineTo(x, 12);
      g.stroke();
    }
    g.beginPath();
    g.moveTo(-12, -12);
    g.lineTo(12, -12);
    g.moveTo(-12, 12);
    g.lineTo(12, 12);
    g.stroke();
  });
}

/** Execution — a crosshair. */
function executeGlyph(color: string): HTMLCanvasElement {
  return markCanvas(color, (g) => {
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, 11, 0, Math.PI * 2);
    g.stroke();
    for (const [dx, dy] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      g.beginPath();
      g.moveTo(dx * 11, dy * 11);
      g.lineTo(dx * 16, dy * 16);
      g.stroke();
    }
    g.beginPath();
    g.arc(0, 0, 2.5, 0, Math.PI * 2);
    g.fill();
  });
}

const GLYPHS: Record<ActionKind, HTMLCanvasElement> = {
  fine: fineGlyph('#D9A038'),
  investigate: investigateGlyph('#6FD3E8'),
  detain: detainGlyph('#B7BDC5'),
  prison: prisonGlyph('#9AA3AE'),
  execute: executeGlyph('#E23A2E'),
};

interface Mark {
  b: Cesium.Billboard;
  base: Cesium.Cartesian3;
  age: number;
  live: boolean;
}

export class ActionMarks {
  readonly collection = new Cesium.BillboardCollection();
  private marks: Mark[] = [];
  private cursor = 0;
  private scratch = new Cesium.Cartesian3();

  constructor() {
    for (let i = 0; i < POOL; i++) {
      const b = this.collection.add({
        position: Cesium.Cartesian3.ZERO,
        image: GLYPHS.fine as unknown as string,
        width: MARK_PX,
        height: MARK_PX,
        show: false,
        // Read over terrain and buildings at any range — same trick the reactions use.
        disableDepthTestDistance: 1e12,
      });
      this.marks.push({ b, base: new Cesium.Cartesian3(), age: 0, live: false });
    }
  }

  /** Pop one mark of a kind at a world position. Oldest slot wins when the pool is saturated. */
  pop(at: Cesium.Cartesian3, kind: ActionKind): void {
    const m = this.marks[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    Cesium.Cartesian3.clone(at, m.base);
    // Billboard.image is typed as string but accepts a canvas — how every procedural marker here draws.
    (m.b as unknown as { image: HTMLCanvasElement }).image = GLYPHS[kind];
    m.b.position = at;
    m.b.show = true;
    m.b.color = Cesium.Color.WHITE;
    m.age = 0;
    m.live = true;
  }

  /** Age the live marks: drift up, fade out, return to the pool. */
  update(dt: number): void {
    for (const m of this.marks) {
      if (!m.live) continue;
      m.age += dt;
      if (m.age >= LIFETIME) {
        m.live = false;
        m.b.show = false;
        continue;
      }
      const t = m.age / LIFETIME;
      const up = Cesium.Cartesian3.normalize(m.base, this.scratch);
      m.b.position = Cesium.Cartesian3.add(
        m.base,
        Cesium.Cartesian3.multiplyByScalar(up, RISE_M * t, this.scratch),
        new Cesium.Cartesian3(),
      );
      // A short beat at full opacity so a burst registers, then fade.
      m.b.color = Cesium.Color.WHITE.withAlpha(t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6);
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}
