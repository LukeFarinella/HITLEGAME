import * as Cesium from 'cesium';
import { feature, mesh } from 'topojson-client';

/**
 * US state boundaries drawn on the ORBIT globe, plus a highlight for whichever state (or block of
 * states) a selection currently falls in.
 *
 * The globe is the mission select, and a click anywhere on it deploys — so the operator needs to
 * see the thing their click is about to be attributed to. The centre of the 200-mile ring picks a
 * state, the state picks the contract, and none of that is legible over a black continent with no
 * lines on it. So: every state edge at 1:10m, dim, always up in orbit; and the state (or the whole
 * block) under the cursor pulled out in brand red on top of it.
 *
 * Two collections rather than one recoloured collection. The base is built once and never touched,
 * which keeps it in a single draw bucket; the highlight is rebuilt from cached rings on every
 * change, which for one state is a few hundred points and costs nothing. Mutating materials in
 * place would rebucket the whole base collection on every mouse move instead.
 */

/** Base line colour. Deliberately quiet — this is a substrate, not a readout. */
const BASE = Cesium.Color.fromCssColorString('#39424E');
/**
 * The state under the selection centre.
 *
 * Bone, not brand red: every coastline on this globe is already red, and a red state outline inside
 * a red continent is the one thing on the screen that has to be unmistakable and wasn't.
 */
const HOT = Cesium.Color.fromCssColorString('#F2EFEA');
/**
 * An ARMED selection — clicked once, waiting for the confirming second click.
 *
 * Amber, and thicker. It has to be unmistakably a different state from the hover outline, because
 * the whole two-step interaction rests on the operator knowing which one they are looking at: bone
 * means "this is what that click would take", amber means "this is what the NEXT click commits to".
 * Amber rather than red for the same reason the hover is bone — every coastline here is already red.
 */
const ARMED = Cesium.Color.fromCssColorString('#F2C13B');
/** Other members of the same block, when the selection resolves to a block rather than a state. */
const BLOCK = Cesium.Color.fromCssColorString('#6FA8B8');

/**
 * Drop points closer together than this along a ring (~2 km).
 *
 * 1:10m state outlines carry far more detail than orbit can resolve — the whole point of drawing
 * them here is the shape of the country, not the shape of a river. This is the same order as the
 * territory survey's own raster cell, so nothing that matters to a click is lost.
 */
const MIN_STEP_DEG = 0.02;

/** Only draw state lines once the camera is close enough for a state to be a meaningful area. */
const VISIBLE_FROM_M = 0;
const VISIBLE_TO_M = 1.4e7;

type Line = number[][];

export interface StateShape {
  /** FIPS, matching `StateTerritory.id`. */
  id: string;
  name: string;
  /** Every ring of every polygon, decimated for orbit. */
  rings: Line[];
}

function decimate(ring: Line): Line {
  const out: Line = [];
  let lastLon = NaN;
  let lastLat = NaN;
  for (let i = 0; i < ring.length; i++) {
    const [lon, lat] = ring[i];
    const last = i === ring.length - 1;
    if (!last && out.length && Math.abs(lon - lastLon) < MIN_STEP_DEG && Math.abs(lat - lastLat) < MIN_STEP_DEG) {
      continue;
    }
    out.push([lon, lat]);
    lastLon = lon;
    lastLat = lat;
  }
  return out;
}

export interface StateGeometry {
  /** Shared borders, drawn once each — the base layer. */
  lines: Line[];
  /** Per-state rings, for the highlight. */
  shapes: StateShape[];
}

let geometryPromise: Promise<StateGeometry> | null = null;

/**
 * Parse states-10m into both forms.
 *
 * The same module the territory survey and the theater build already import, so on any path that
 * has opened a save this is a cache hit rather than a download.
 */
export function loadStateGeometry(): Promise<StateGeometry> {
  geometryPromise ??= (async () => {
    const topo = (await import('us-atlas/states-10m.json')).default as unknown as {
      objects: { states: unknown };
    };

    // mesh with a !== b keeps only SHARED edges deduplicated — an interior border is one line, not
    // two coincident ones.
    const raw = (mesh(topo as never, topo.objects.states as never, ((a: unknown, b: unknown) => a !== b) as never) as
      unknown as { coordinates: Line[] }).coordinates;

    const fc = feature(topo as never, topo.objects.states as never) as unknown as {
      features: {
        id: string;
        properties: { name: string };
        geometry: { type: string; coordinates: number[][][] | number[][][][] };
      }[];
    };

    const shapes: StateShape[] = fc.features.map((f) => {
      const polys =
        f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates as number[][][]]
          : (f.geometry.coordinates as number[][][][]);
      const rings: Line[] = [];
      for (const poly of polys) for (const ring of poly) rings.push(decimate(ring));
      return { id: f.id, name: f.properties.name, rings };
    });

    return { lines: raw.map(decimate), shapes };
  })();
  return geometryPromise;
}

export class StateLines {
  private readonly scene: Cesium.Scene;
  private readonly base: Cesium.PolylineCollection;
  private readonly hot: Cesium.PolylineCollection;
  private readonly byId = new Map<string, StateShape>();
  private visible = false;
  private hotSig = '';

  constructor(scene: Cesium.Scene, geo: StateGeometry) {
    this.scene = scene;
    this.base = scene.primitives.add(new Cesium.PolylineCollection());
    this.hot = scene.primitives.add(new Cesium.PolylineCollection());
    this.base.show = false;
    this.hot.show = false;
    for (const s of geo.shapes) this.byId.set(s.id, s);
    for (const line of geo.lines) this.add(this.base, line, BASE, 1);
  }

  // Each polyline gets its own Material instance: a collection destroys every material it holds,
  // and the highlight collection is emptied constantly, so a shared instance would be destroyed
  // twice. Batching does not depend on sharing it — identical colours still collapse to one bucket.
  private add(into: Cesium.PolylineCollection, line: Line, color: Cesium.Color, width: number): void {
    if (line.length < 2) return;
    const flat: number[] = [];
    for (const [lon, lat] of line) flat.push(lon, lat);
    into.add({
      positions: Cesium.Cartesian3.fromDegreesArray(flat),
      width,
      material: Cesium.Material.fromType('Color', { color }),
      // State lines are noise from 16,000 km, where a state is a smudge a few pixels across.
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(VISIBLE_FROM_M, VISIBLE_TO_M),
    });
  }

  set show(on: boolean) {
    this.visible = on;
    this.base.show = on;
    this.hot.show = on;
  }

  /**
   * Pull out a set of states — the one under the selection, and the rest of its block behind it.
   *
   * `primary` is the state the selection resolves to; `also` are the rest of its block, drawn in a
   * muted blue, which is what makes "this takes the whole SOUTHERN BLOCK" readable as one shape
   * rather than as fifty-one separate ones. `armed` switches the primary from the hover look to the
   * waiting-for-confirmation look — see {@link ARMED}.
   */
  highlight(primary: string | null, also: readonly string[] = [], armed = false): void {
    const sig = `${primary ?? '-'}|${also.join(',')}|${armed ? 'a' : ''}`;
    if (sig === this.hotSig) return;
    this.hotSig = sig;
    this.hot.removeAll();
    for (const id of also) {
      if (id === primary) continue;
      const s = this.byId.get(id);
      if (s) for (const ring of s.rings) this.add(this.hot, ring, BLOCK, 2);
    }
    const p = primary ? this.byId.get(primary) : undefined;
    if (p) for (const ring of p.rings) this.add(this.hot, ring, armed ? ARMED : HOT, armed ? 5 : 3);
    this.hot.show = this.visible;
  }

  destroy(): void {
    this.scene.primitives.remove(this.base);
    this.scene.primitives.remove(this.hot);
  }
}
