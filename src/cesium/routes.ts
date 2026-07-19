import * as Cesium from 'cesium';

/**
 * The selected platform's commanded route, drawn on the ground.
 *
 * An order you can't see is an order you have to remember, so the whole route is on the map while
 * its platform is selected: where it's going now, everything queued behind that, and whether the
 * whole thing loops.
 *
 * The line styles carry the meaning:
 *   SOLID WHITE  — the leg being flown right now.
 *   DOTTED WHITE — legs queued behind it.
 *   SOLID RED    — a route carrying a lethal order. The colour is the intent, not the geometry.
 *
 * Rebuilt only when the route actually changes; the per-frame pass just re-anchors the first leg to
 * the platform, which is the only part that moves.
 */

const WHITE = Cesium.Color.fromCssColorString('#ECEEF1');
const RED = Cesium.Color.fromCssColorString('#E23A2E');
const AMBER = Cesium.Color.fromCssColorString('#F2A83B');
/** Metres above the terrain, so a route doesn't z-fight the ground it's drawn on. */
const LIFT_M = 45;
/** Points sampled along each leg, so a line follows relief instead of cutting through it. */
const SAMPLES = 24;
const MARKER_PX = 7;

export type RouteAction = 'investigate' | 'detain' | 'execute' | 'strike' | null;

export class RouteLayer {
  readonly lines = new Cesium.PolylineCollection();
  readonly markers = new Cesium.PointPrimitiveCollection();
  /** What the current drawing was built from, so an unchanged route isn't rebuilt every frame. */
  private signature = '';

  /**
   * Draw a route. `from` is the platform's own position — the first leg starts there, which is why
   * this is re-run as it moves.
   */
  draw(
    from: { lon: number; lat: number } | null,
    legs: { lon: number; lat: number }[],
    action: RouteAction,
    loops: boolean,
    heightAt: (lon: number, lat: number) => number,
  ): void {
    const sig =
      !from || !legs.length
        ? ''
        : `${action}|${loops}|${from.lon.toFixed(4)},${from.lat.toFixed(4)}|` +
          legs.map((l) => `${l.lon.toFixed(4)},${l.lat.toFixed(4)}`).join(';');
    if (sig === this.signature) return;
    this.signature = sig;

    this.lines.removeAll();
    this.markers.removeAll();
    if (!from || !legs.length) return;

    // Lethal intent is red whether it's a single beam or an area weapon.
    const colour = action === 'execute' || action === 'strike' ? RED : action === 'detain' ? AMBER : WHITE;
    const points = [from, ...legs];
    // A closed route draws the return leg too, so the patrol reads as a circuit rather than a line
    // that happens to end near where it started.
    if (loops) points.push(from);

    for (let i = 0; i + 1 < points.length; i++) {
      const first = i === 0;
      this.lines.add({
        positions: this.sampleLeg(points[i], points[i + 1], heightAt),
        // Deliberately hairline: a route is an annotation over the map, not a feature of it, and
        // several platforms under orders at once should read as pencil rather than as pipework.
        width: first ? 1.4 : 1,
        material: first
          ? Cesium.Material.fromType('Color', { color: colour })
          : // Queued legs are dashed: same route, not yet being flown.
            Cesium.Material.fromType('PolylineDash', {
              color: colour.withAlpha(0.75),
              dashLength: 18,
            }),
      });
    }

    for (const l of legs) {
      this.markers.add({
        position: Cesium.Cartesian3.fromDegrees(l.lon, l.lat, heightAt(l.lon, l.lat) + LIFT_M),
        color: colour,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
        outlineWidth: 1,
        pixelSize: MARKER_PX,
        disableDepthTestDistance: 1e12,
      });
    }
  }

  /** Sample a leg so it drapes over relief rather than tunnelling through it. */
  private sampleLeg(
    a: { lon: number; lat: number },
    b: { lon: number; lat: number },
    heightAt: (lon: number, lat: number) => number,
  ): Cesium.Cartesian3[] {
    const out: Cesium.Cartesian3[] = [];
    for (let k = 0; k <= SAMPLES; k++) {
      const t = k / SAMPLES;
      const lon = a.lon + (b.lon - a.lon) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      out.push(Cesium.Cartesian3.fromDegrees(lon, lat, heightAt(lon, lat) + LIFT_M));
    }
    return out;
  }

  clear(): void {
    if (this.signature === '') return;
    this.signature = '';
    this.lines.removeAll();
    this.markers.removeAll();
  }
}
