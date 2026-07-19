import * as Cesium from 'cesium';

/**
 * The distress pulse on a site under attack.
 *
 * A ring that expands and fades over the targeted obelisk, repeating for as long as the attack
 * runs. It is sized in PIXELS rather than metres on purpose: a world-space ring is legible standing
 * over the site and invisible from theater altitude, which is exactly backwards — the moment you
 * most need to know a site is being taken is when you are looking at the whole map and it is one
 * pixel of geometry. A screen-space ring holds the same apparent size at every zoom.
 *
 * Three billboards on a staggered phase, so it reads as a repeating ripple rather than a blink.
 */

const RINGS = 3;
/** Seconds for one ring to travel from smallest to largest. */
const PERIOD = 1.6;
const MIN_PX = 14;
const MAX_PX = 108;
const TEX_PX = 128;

/** A soft ring, drawn once. Thick enough to survive being scaled down to 14 px. */
function ringTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = TEX_PX;
  c.height = TEX_PX;
  const g = c.getContext('2d')!;
  g.translate(TEX_PX / 2, TEX_PX / 2);
  g.strokeStyle = '#E23A2E';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(0, 0, TEX_PX / 2 - 7, 0, Math.PI * 2);
  g.stroke();
  g.strokeStyle = 'rgba(226, 58, 46, 0.45)';
  g.lineWidth = 3;
  g.beginPath();
  g.arc(0, 0, TEX_PX / 2 - 17, 0, Math.PI * 2);
  g.stroke();
  return c;
}

export class AttackPulse {
  readonly collection = new Cesium.BillboardCollection();
  private rings: Cesium.Billboard[] = [];
  private t = 0;
  private active = false;

  constructor() {
    const image = ringTexture() as unknown as string;
    for (let i = 0; i < RINGS; i++) {
      this.rings.push(
        this.collection.add({
          position: Cesium.Cartesian3.ZERO,
          image,
          width: MIN_PX,
          height: MIN_PX,
          show: false,
          // Has to read through terrain and buildings: a site behind a ridge is still being taken.
          disableDepthTestDistance: 1e12,
        }),
      );
    }
  }

  /** Put the pulse on a site. Call every frame while the attack is live. */
  at(position: Cesium.Cartesian3): void {
    this.active = true;
    for (const r of this.rings) r.position = position;
  }

  /** No attack running — stand the pulse down. */
  clear(): void {
    if (!this.active) return;
    this.active = false;
    for (const r of this.rings) r.show = false;
  }

  update(dt: number): void {
    if (!this.active) return;
    this.t += dt;
    for (let i = 0; i < this.rings.length; i++) {
      // Even phase spacing, so one ring is always near the start of its travel.
      const phase = ((this.t / PERIOD + i / RINGS) % 1 + 1) % 1;
      const px = MIN_PX + (MAX_PX - MIN_PX) * phase;
      const r = this.rings[i];
      r.show = true;
      r.width = px;
      r.height = px;
      // Fade as it expands, so the ring dissolves outward instead of popping.
      r.color = Cesium.Color.WHITE.withAlpha(Math.max(0, 1 - phase) * 0.9);
    }
  }

  destroy(): void {
    this.collection.destroy();
  }
}
