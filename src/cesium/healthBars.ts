import * as Cesium from 'cesium';

/**
 * Health bars over the machines that are in a fight.
 *
 * Two billboards per bar — a dark backing and a coloured fill drawn on top of it, both anchored
 * LEFT so the fill's width IS the health. That is the whole trick: a billboard's width is in
 * PIXELS, so the bar is the same size on screen at 500 m and at 50 km, and shortening it is one
 * number rather than a new texture. Doing it with geometry would mean a bar that vanishes at
 * altitude, which is exactly when you most want to know how a fight is going.
 *
 * Colour is SIDE, not health. This game already has a colour language — red is the company, green
 * is Millstone, everywhere from the obelisks to the enemy Nexus marker — and a bar that turned amber
 * at half health would be the one place on the map where colour meant something else. The length is
 * the health; the colour is whose it is.
 *
 * Who gets one is decided upstream in UnitField.healthBars: hurt, or fighting. Everything else on
 * the board stays clean.
 */

/** Bar size on screen, in pixels. Small: there can be forty of these in a bad moment. */
const BAR_W = 26;
const BAR_H = 3.5;
/** Pixels above the unit's own position. Clears the mesh at the zoom levels a fight is watched at. */
const LIFT_PX = 20;

/** Player red and Millstone green — the same two colours everything else on the map uses. */
const SIDE_FILL = [
  Cesium.Color.fromCssColorString('#E23A2E'),
  Cesium.Color.fromCssColorString('#3FBF6F'),
] as const;
/** The backing. Near-black rather than a mid grey, so a nearly-dead bar still reads as a bar. */
const BACKING = Cesium.Color.fromCssColorString('#0A0C10').withAlpha(0.85);

/** A 4x4 white chip. Billboards tint it, so one texture serves every bar on the board. */
function chipTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 4;
  const g = c.getContext('2d')!;
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, 4, 4);
  return c;
}
let chip: HTMLCanvasElement | null = null;

export interface HealthBarDatum {
  lon: number;
  lat: number;
  alt: number;
  /** 0–1. The fill's width is this times {@link BAR_W}. */
  frac: number;
  side: 0 | 1;
}

export class HealthBars {
  readonly collection = new Cesium.BillboardCollection();
  /** Backing/fill pairs, grown on demand and reused — a fight's population churns constantly. */
  private pairs: { back: Cesium.Billboard; fill: Cesium.Billboard }[] = [];

  /**
   * Draw exactly `n` bars from `data`. Pairs past `n` are hidden rather than removed, so a wave
   * arriving and dying does not thrash the collection.
   */
  show(data: readonly HealthBarDatum[], n: number): void {
    chip ??= chipTexture();
    const image = chip as unknown as string;
    while (this.pairs.length < n) {
      const common = {
        image,
        position: Cesium.Cartesian3.ZERO,
        // Anchored LEFT so growing the fill grows it rightward from a fixed origin, and BOTTOM so
        // the bar sits on a predictable line above the machine.
        horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        height: BAR_H,
        // A health bar is information about a fight, and a fight behind a building is still a fight.
        disableDepthTestDistance: 1e12,
        show: false,
      };
      const back = this.collection.add({ ...common, width: BAR_W, color: BACKING });
      const fill = this.collection.add({ ...common, width: BAR_W });
      this.pairs.push({ back, fill });
    }

    for (let i = 0; i < this.pairs.length; i++) {
      const pair = this.pairs[i];
      if (i >= n) {
        pair.back.show = false;
        pair.fill.show = false;
        continue;
      }
      const d = data[i];
      const pos = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt);
      // Half a bar left of centre, so a LEFT-anchored bar reads as centred over the machine.
      const offset = new Cesium.Cartesian2(-BAR_W / 2, -LIFT_PX);
      pair.back.position = pos;
      pair.back.pixelOffset = offset;
      pair.back.show = true;
      pair.fill.position = pos;
      pair.fill.pixelOffset = offset;
      // Never let a living unit's bar vanish entirely: at 1% the bar is still a sliver, because a
      // bar that disappeared would read as "dead" while the thing is still shooting at you.
      pair.fill.width = Math.max(1.5, BAR_W * d.frac);
      pair.fill.color = SIDE_FILL[d.side];
      pair.fill.show = true;
    }
  }

  /** Nothing is fighting — take every bar down. */
  clear(): void {
    for (const p of this.pairs) {
      p.back.show = false;
      p.fill.show = false;
    }
  }
}
