import * as Cesium from 'cesium';

/**
 * The selected units' commanded routes, drawn on the ground.
 *
 * An order you can't see is an order you have to remember, so every selected unit's route is on the
 * map: one thin thread along the path it will actually take, and one node where it is going. EVERY
 * selected unit gets its own — order twelve to a ridge and you see twelve threads converging, which
 * is the only way to tell "they are all going" from "most of them are going and two are stuck behind
 * a river".
 *
 * ONE THREAD, ONE NODE. This used to draw a marker on every waypoint and dash the queued legs, which
 * was built for a route the operator had typed in by hand. It is wrong for units that route along
 * roads: a leg is a street corner rather than a decision, a worker crossing a city produces dozens
 * of them, and a dot on every corner turned "where is it going" into a dotted line you had to trace.
 * The path drawn is still the real path — only the per-corner furniture is gone.
 *
 * COLOUR IS THE ORDER. Four intents, four colours, and they are the same four everywhere so the map
 * can be read without a key: blue is building, green is moving, yellow is patrolling, red is
 * fighting. The blue and green are lifted from where those meanings already live on this map (the
 * build-site ring, the valid-placement marker) rather than invented here.
 *
 * Rebuilt only when the set of routes actually changes; the per-frame pass is a signature compare.
 */

/** What a route is FOR, and therefore what colour it is. */
export type RouteIntent = 'build' | 'move' | 'patrol' | 'attack';

const INTENT_COLOUR: Record<RouteIntent, Cesium.Color> = {
  build: Cesium.Color.fromCssColorString('#3FA0E0'),
  move: Cesium.Color.fromCssColorString('#3FBF6F'),
  patrol: Cesium.Color.fromCssColorString('#E7C13B'),
  attack: Cesium.Color.fromCssColorString('#E23A2E'),
};

/** Metres above the terrain, so a route doesn't z-fight the ground it's drawn on. */
const LIFT_M = 45;
/** Points sampled along each leg, so a line follows relief instead of cutting through it. */
const SAMPLES = 24;
/** The destination node. Bigger than the old per-waypoint dots, because it is now the only one. */
const DEST_PX = 9;
/**
 * How many routes are drawn at once.
 *
 * Raised from 24 when routes collapsed to a thread and a dot: the old style spent a primitive per
 * leg and a marker per waypoint, so a couple of dozen orders was both expensive and scribble. A
 * collapsed route is one polyline and one point, so a whole commanded group stays legible — which
 * is the case that needed the headroom, since ordering a control group is ordering everything in it.
 */
const MAX_ROUTES = 48;

export interface RouteSpec {
  /** The unit's own position — the thread starts here, which is why this is re-run as it moves. */
  from: { lon: number; lat: number };
  /** Every commanded leg, current first. */
  legs: { lon: number; lat: number }[];
  intent: RouteIntent;
  /** A closed route draws its return leg, so a patrol reads as a circuit. */
  loops: boolean;
}

export class RouteLayer {
  readonly lines = new Cesium.PolylineCollection();
  readonly markers = new Cesium.PointPrimitiveCollection();
  /** What the current drawing was built from, so an unchanged route isn't rebuilt every frame. */
  private signature = '';

  /**
   * Draw every route in one pass.
   *
   * Capped at {@link MAX_ROUTES}: past that the map stops being a picture of what is happening, and
   * an army of sixty under one order says nothing the first forty threads did not.
   */
  drawMany(routes: RouteSpec[], heightAt: (lon: number, lat: number) => number): void {
    const use = routes.filter((r) => r.legs.length).slice(0, MAX_ROUTES);
    const sig = use
      .map(
        (r) =>
          `${r.intent}|${r.loops}|${r.from.lon.toFixed(4)},${r.from.lat.toFixed(4)}|` +
          r.legs.map((l) => `${l.lon.toFixed(4)},${l.lat.toFixed(4)}`).join(';'),
      )
      .join('#');
    if (sig === this.signature) return;
    this.signature = sig;

    this.lines.removeAll();
    this.markers.removeAll();
    for (const r of use) this.addRoute(r, heightAt);
  }

  /**
   * One thread, one node.
   *
   * Drawn as a SINGLE polyline through every sampled leg rather than one per leg: it is one drive,
   * so it should be one line, and it costs one primitive instead of thirty for a road route.
   */
  private addRoute(r: RouteSpec, heightAt: (lon: number, lat: number) => number): void {
    const colour = INTENT_COLOUR[r.intent];
    const points = [r.from, ...r.legs];
    // A patrol closes its circuit — that IS the information a patrol carries.
    if (r.loops) points.push(r.from);

    const path: Cesium.Cartesian3[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const leg = this.sampleLeg(points[i], points[i + 1], heightAt);
      // Drop each leg's first sample after the first leg: it is the previous leg's last point.
      path.push(...(i === 0 ? leg : leg.slice(1)));
    }
    if (path.length < 2) return;

    this.lines.add({
      positions: path,
      // Deliberately hairline: a route is an annotation over the map, not a feature of it, and a
      // commanded group should read as pencil rather than as pipework.
      width: 1.4,
      material: Cesium.Material.fromType('Color', { color: colour }),
    });

    // The destination. On a loop the last leg point is the far side of the circuit, which is still
    // the most useful single thing to mark.
    const dest = r.legs[r.legs.length - 1];
    this.markers.add({
      position: Cesium.Cartesian3.fromDegrees(dest.lon, dest.lat, heightAt(dest.lon, dest.lat) + LIFT_M),
      color: colour,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
      outlineWidth: 1,
      pixelSize: DEST_PX,
      disableDepthTestDistance: 1e12,
    });
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
