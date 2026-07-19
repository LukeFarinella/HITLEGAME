import * as Cesium from 'cesium';

/**
 * Directed-energy beams: the visible half of an execution.
 *
 * A fixed pool of polylines that get repositioned and faded rather than created and destroyed.
 * Beams are transient (a fraction of a second) and can arrive in bursts when a marked convoy rolls
 * into an armed obelisk's range, so allocating per shot would churn Cesium Materials — and every
 * Polyline destroys its own material with the collection, which makes that churn expensive.
 */

const POOL = 32;
/** Seconds a beam stays on screen. Long enough to register, short enough to stay a flash. */
const LIFETIME = 0.7;
const BEAM_COLOR = Cesium.Color.fromCssColorString('#FF3B2E');
/**
 * Pixels, not metres — a beam holds this thickness at any altitude. Wide enough that a shot fired
 * across a theater reads as an event from the altitude the whole theater is watched from.
 */
const BEAM_WIDTH = 7;

interface Beam {
  line: Cesium.Polyline;
  positions: [Cesium.Cartesian3, Cesium.Cartesian3];
  material: Cesium.Material;
  age: number;
  live: boolean;
}

export class LaserBeams {
  readonly collection = new Cesium.PolylineCollection();
  private beams: Beam[] = [];
  private cursor = 0;

  constructor() {
    for (let i = 0; i < POOL; i++) {
      const positions: [Cesium.Cartesian3, Cesium.Cartesian3] = [
        new Cesium.Cartesian3(),
        new Cesium.Cartesian3(),
      ];
      const material = Cesium.Material.fromType('Color', { color: BEAM_COLOR.withAlpha(0) });
      const line = this.collection.add({ positions, width: BEAM_WIDTH, material, show: false });
      this.beams.push({ line, positions, material, age: 0, live: false });
    }
  }

  /**
   * Fire one beam. Oldest slot wins if the pool is saturated — dropping the tail of a burst is
   * better than growing the pool for a worst case that lasts half a second.
   */
  fire(from: Cesium.Cartesian3, to: Cesium.Cartesian3): void {
    const b = this.beams[this.cursor];
    this.cursor = (this.cursor + 1) % POOL;
    Cesium.Cartesian3.clone(from, b.positions[0]);
    Cesium.Cartesian3.clone(to, b.positions[1]);
    b.line.positions = b.positions; // reassign so Cesium re-uploads
    b.age = 0;
    b.live = true;
    b.line.show = true;
  }

  /** Age the live beams and fade them out. Call once per frame. */
  update(dt: number): void {
    for (const b of this.beams) {
      if (!b.live) continue;
      b.age += dt;
      if (b.age >= LIFETIME) {
        b.live = false;
        b.line.show = false;
        continue;
      }
      // Hot flat start, then a fast falloff — reads as a discharge rather than a fading line.
      const t = b.age / LIFETIME;
      const alpha = t < 0.25 ? 1 : 1 - (t - 0.25) / 0.75;
      (b.material.uniforms as { color: Cesium.Color }).color = BEAM_COLOR.withAlpha(alpha);
    }
  }
}
