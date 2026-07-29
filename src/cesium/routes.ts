import * as Cesium from 'cesium';

/**
 * The selected platforms' commanded routes, drawn on the ground.
 *
 * An order you can't see is an order you have to remember, so the whole route is on the map while
 * its platform is selected: where it's going now, everything queued behind that, and whether the
 * whole thing loops. EVERY selected platform gets its own line — order twelve units to a ridge and
 * you see twelve threads converging on it, which is the only way to tell "they are all going" from
 * "most of them are going and two are stuck behind a river".
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
/**
 * How many routes are drawn at once.
 *
 * Past a few dozen the map stops being a picture of what is happening and becomes scribble, and an
 * army of sixty under one order would draw sixty near-identical threads to the same point — which
 * says nothing the first dozen did not already say.
 */
const MAX_ROUTES = 24;

export type RouteAction = 'investigate' | 'detain' | 'prison' | 'execute' | 'strike' | null;

export class RouteLayer {
  readonly lines = new Cesium.PolylineCollection();
  readonly markers = new Cesium.PointPrimitiveCollection();
  /** What the current drawing was built from, so an unchanged route isn't rebuilt every frame. */
  private signature = '';

  /**
   * Draw a single route. `from` is the platform's own position — the first leg starts there, which
   * is why this is re-run as it moves.
   */
  draw(
    from: { lon: number; lat: number } | null,
    legs: { lon: number; lat: number }[],
    action: RouteAction,
    loops: boolean,
    heightAt: (lon: number, lat: number) => number,
  ): void {
    this.drawMany(from && legs.length ? [{ from, legs, action, loops }] : [], heightAt);
  }

  /**
   * Draw every route in one pass.
   *
   * Capped: past a few dozen threads the map is scribble rather than information, and the cap keeps
   * a whole army under orders both legible and cheap. Rebuilt only when the SET of routes changes;
   * the per-frame call is a signature compare on unchanged geometry.
   */
  drawMany(
    routes: {
      from: { lon: number; lat: number };
      legs: { lon: number; lat: number }[];
      action: RouteAction;
      loops: boolean;
    }[],
    heightAt: (lon: number, lat: number) => number,
  ): void {
    const use = routes.filter((r) => r.legs.length).slice(0, MAX_ROUTES);
    const sig = use
      .map(
        (r) =>
          `${r.action}|${r.loops}|${r.from.lon.toFixed(4)},${r.from.lat.toFixed(4)}|` +
          r.legs.map((l) => `${l.lon.toFixed(4)},${l.lat.toFixed(4)}`).join(';'),
      )
      .join('#');
    if (sig === this.signature) return;
    this.signature = sig;

    this.lines.removeAll();
    this.markers.removeAll();
    for (const r of use) this.addRoute(r.from, r.legs, r.action, r.loops, heightAt);
  }

  private addRoute(
    from: { lon: number; lat: number },
    legs: { lon: number; lat: number }[],
    action: RouteAction,
    loops: boolean,
    heightAt: (lon: number, lat: number) => number,
  ): void {
    // Lethal intent is red whether it's a single beam or an area weapon.
    const colour =
      action === 'execute' || action === 'strike'
        ? RED
        : action === 'detain' || action === 'prison'
          ? AMBER
          : WHITE;
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
