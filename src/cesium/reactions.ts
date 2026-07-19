import * as Cesium from 'cesium';

/**
 * The crowd reacting.
 *
 * Every order the operator gives lands on a street with people on it, and until now the only thing
 * that registered it was a counter on a panel. These are the faces that pop over the contacts
 * standing nearby: approval when a call was right, dismay when it wasn't, and a company logo when
 * GORGON itself gets what it wanted — which is deliberately a different axis from the other two,
 * because the company being pleased and the public being pleased are not the same event.
 *
 * A pooled BillboardCollection: bursts are frequent and short-lived, so allocating per face would
 * churn. Faces rise and fade over their lifetime and the slot returns to the pool.
 */

const POOL = 96;
const LIFETIME = 2.2;
/** Metres a face drifts upward over its life. */
const RISE_M = 260;
const FACE_PX = 30;

export type ReactionKind = 'approve' | 'dismay' | 'company';

const ICON_PX = 64;

function faceCanvas(draw: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = ICON_PX;
  c.height = ICON_PX;
  const g = c.getContext('2d')!;
  g.translate(ICON_PX / 2, ICON_PX / 2);
  g.lineWidth = 4;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  draw(g);
  return c;
}

/** A round face with two eyes and a mouth curve. `smile` > 0 curves up, < 0 curves down. */
function roundFace(color: string, smile: number): HTMLCanvasElement {
  return faceCanvas((g) => {
    g.fillStyle = 'rgba(11, 12, 14, 0.82)';
    g.strokeStyle = color;
    g.beginPath();
    g.arc(0, 0, 24, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.fillStyle = color;
    for (const x of [-9, 9]) {
      g.beginPath();
      g.arc(x, -7, 3.4, 0, Math.PI * 2);
      g.fill();
    }
    g.beginPath();
    // Quadratic through (-11, 6) and (11, 6) with the control point setting the curve.
    g.moveTo(-11, smile > 0 ? 5 : 11);
    g.quadraticCurveTo(0, 5 + smile * 12, 11, smile > 0 ? 5 : 11);
    g.stroke();
  });
}

/** The company mark: a squared head with a single sensor band. Pleased, in its way. */
function robotFace(color: string): HTMLCanvasElement {
  return faceCanvas((g) => {
    g.fillStyle = 'rgba(11, 12, 14, 0.86)';
    g.strokeStyle = color;
    g.beginPath();
    g.roundRect(-22, -20, 44, 40, 6);
    g.fill();
    g.stroke();
    g.beginPath();
    g.moveTo(0, -20);
    g.lineTo(0, -27);
    g.stroke();
    g.fillStyle = color;
    g.fillRect(-13, -8, 26, 5); // sensor band
    g.beginPath();
    g.moveTo(-8, 9);
    g.lineTo(8, 9);
    g.stroke();
  });
}

const FACES: Record<ReactionKind, HTMLCanvasElement> = {
  approve: roundFace('#4F9E7A', 1),
  dismay: roundFace('#D9A038', -1),
  company: robotFace('#E23A2E'),
};

interface Face {
  b: Cesium.Billboard;
  base: Cesium.Cartesian3;
  age: number;
  live: boolean;
}

export class Reactions {
  readonly collection = new Cesium.BillboardCollection();
  private faces: Face[] = [];
  private cursor = 0;
  private scratch = new Cesium.Cartesian3();

  constructor() {
    for (let i = 0; i < POOL; i++) {
      const b = this.collection.add({
        position: Cesium.Cartesian3.ZERO,
        image: FACES.approve as unknown as string,
        width: FACE_PX,
        height: FACE_PX,
        show: false,
        // Reactions read over terrain and buildings; see the note in rebuildMarks about Infinity.
        disableDepthTestDistance: 1e12,
      });
      this.faces.push({ b, base: new Cesium.Cartesian3(), age: 0, live: false });
    }
  }

  /** Pop one face at a world position. Oldest slot wins when the pool is saturated. */
  pop(at: Cesium.Cartesian3, kind: ReactionKind): void {
    const f = this.faces[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    Cesium.Cartesian3.clone(at, f.base);
    // Billboard.image is typed as string but accepts any image source Cesium can upload — a
    // canvas among them, which is how every other procedural marker in this project is drawn.
    (f.b as unknown as { image: HTMLCanvasElement }).image = FACES[kind];
    f.b.position = at;
    f.b.show = true;
    f.age = 0;
    f.live = true;
  }

  /** Age the live faces: drift up, fade out, return to the pool. */
  update(dt: number): void {
    for (const f of this.faces) {
      if (!f.live) continue;
      f.age += dt;
      if (f.age >= LIFETIME) {
        f.live = false;
        f.b.show = false;
        continue;
      }
      const t = f.age / LIFETIME;
      // Rise along the local up vector — which at these scales is just the position's own normal.
      const up = Cesium.Cartesian3.normalize(f.base, this.scratch);
      f.b.position = Cesium.Cartesian3.add(
        f.base,
        Cesium.Cartesian3.multiplyByScalar(up, RISE_M * t, this.scratch),
        new Cesium.Cartesian3(),
      );
      // Hold full opacity briefly, then fade — so a burst registers before it starts leaving.
      f.b.color = Cesium.Color.WHITE.withAlpha(t < 0.45 ? 1 : 1 - (t - 0.45) / 0.55);
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}
