import * as Cesium from 'cesium';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

/**
 * Real roads, from OpenStreetMap.
 *
 * Source is OpenFreeMap (https://openfreemap.org) — free OSM vector tiles, no API key, and it
 * sends `Access-Control-Allow-Origin: *`, so unlike the terrarium bucket these need no dev proxy
 * and a hosted build works as-is.
 *
 * Same philosophy as the rest of the theater: fetch once at a fixed zoom, bake, never stream.
 */

const TILEJSON = 'https://tiles.openfreemap.org/planet';

/**
 * The tile URL carries a dated snapshot ("/planet/20260621_080001_pt/{z}/{x}/{y}.pbf") and the
 * unversioned path answers 200 with a zero-byte body and `X-Ofm-Debug: empty tile` — a silent
 * no-roads failure. So always resolve the real template from TileJSON rather than hardcoding a
 * snapshot that will quietly rot.
 */
let templatePromise: Promise<string> | null = null;
export function tileTemplate(): Promise<string> {
  templatePromise ??= (async () => {
    const res = await fetch(TILEJSON);
    if (!res.ok) throw new Error(`openfreemap tilejson: ${res.status}`);
    const tj = (await res.json()) as { tiles?: string[] };
    const t = tj.tiles?.[0];
    if (!t) throw new Error('openfreemap tilejson: no tile template');
    return t;
  })();
  return templatePromise;
}

/**
 * OSM highway classes we draw, in the order they stack. Anything else in the `transportation`
 * layer (rail, ferry, path, busway, transit, *_construction) is skipped — this is a road map.
 *
 * At z10 the layer carries motorway/trunk/primary/secondary; tertiary arrives at z11 and the
 * residential "minor" flood at z12, which at a 200-mile theater (~320 m/px zoomed out) would be an
 * unreadable smear for ~14x the tiles.
 */
export const ROAD_CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];
const KEEP = new Set<string>(ROAD_CLASSES);

export interface Road {
  cls: RoadClass;
  /** lon/lat pairs. */
  coords: number[][];
}

export interface RoadNet {
  roads: Road[];
  tiles: number;
  points: number;
  zoom: number;
}

/**
 * Chaikin corner-cutting: rounds a polyline's angular vertices into a smooth curve. OSM road
 * geometry is sparse and angular, and the raw ribbons read as jointed/faceted — the opposite of
 * the clean look a portfolio piece wants. Each iteration replaces every segment with points at 1/4
 * and 3/4, keeping the endpoints fixed so roads still meet exactly at their intersection nodes; two
 * iterations give visibly smooth curves. Collinear runs (straight roads) are left effectively
 * unchanged.
 */
function chaikin(pts: number[][], iterations: number): number[][] {
  if (pts.length < 3) return pts;
  let out = pts;
  for (let it = 0; it < iterations; it++) {
    const next: number[][] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Fetch + decode every road inside a bbox at one zoom. */
export async function fetchRoads(bbox: [number, number, number, number], zoom: number): Promise<RoadNet> {
  const template = await tileTemplate();
  const [w, s, e, n] = bbox;
  const xMin = Math.floor(lon2tileX(w, zoom));
  const xMax = Math.floor(lon2tileX(e, zoom));
  const yMin = Math.floor(lat2tileY(n, zoom));
  const yMax = Math.floor(lat2tileY(s, zoom));

  const jobs: [number, number][] = [];
  for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) jobs.push([x, y]);

  const roads: Road[] = [];
  let tiles = 0;
  let points = 0;

  await Promise.all(
    jobs.map(async ([x, y]) => {
      try {
        const url = template.replace('{z}', String(zoom)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) return; // genuinely empty tile (ocean, or an unversioned URL)
        const layer = new VectorTile(new PbfReader(new Uint8Array(buf))).layers.transportation;
        if (!layer) return;
        tiles++;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          const cls = f.properties.class as string;
          if (!KEEP.has(cls)) continue;
          // toGeoJSON does the tile->lon/lat unprojection (and the tile's own buffer overlap with
          // its neighbours just means a few duplicate line metres at seams — invisible).
          const g = f.toGeoJSON(x, y, zoom).geometry;
          const lines: number[][][] =
            g.type === 'LineString' ? [g.coordinates as number[][]]
            : g.type === 'MultiLineString' ? (g.coordinates as number[][][])
            : [];
          for (const line of lines) {
            if (line.length < 2) continue;
            const smooth = chaikin(line, 2);
            roads.push({ cls: cls as RoadClass, coords: smooth });
            points += smooth.length;
          }
        }
      } catch {
        /* a dropped tile costs a few roads, not the theater */
      }
    }),
  );

  return { roads, tiles, points, zoom };
}

// --- rendering ---------------------------------------------------------------------------------

/**
 * Roads are ONE merged primitive, expanded into ribbons in the vertex shader.
 *
 * Two things forced this shape:
 *
 * 1. NOT a PolylineCollection. Measured: ~27k draped road lines in one cost ~1,200 ms per frame,
 *    and hiding that single collection took the same frame to 22.8 ms. It re-walks every polyline
 *    on the CPU each update — the same per-object trap units and borders already avoid.
 * 2. NOT GL lines. `ALIASED_LINE_WIDTH_RANGE` is [1,1] on ANGLE/D3D11 and every other mainstream
 *    backend, so `PrimitiveType.LINES` can only ever be 1 px.
 *
 * So each point carries two vertices (side -1/+1) and the shader pushes them apart along the
 * screen-space normal. That's the same technique PolylineCollection uses; the difference is it
 * happens once per vertex on the GPU instead of once per line per frame on the CPU.
 *
 * Width is `max(real metres, a pixel floor)`: a motorway is genuinely ~24 m wide up close, but at
 * theater scale (~320 m/px) that's a fourteenth of a pixel, so the floor keeps the network legible
 * when zoomed out and real geometry takes over as you descend.
 */
const ROAD_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 tangent;    // unit direction of the line at this point (ECEF)
in vec3 side;       // unit vector across the road, IN THE GROUND PLANE (ECEF)
in vec3 params;     // x = side (-1/+1), y = half-width in metres, z = end-cap extend (-1/0/+1)
in vec4 color;
in float batchId;
out vec4 v_color;

uniform float u_minHalfPx;

void main() {
  vec4 p = czm_computePosition();

  // Half-width in METRES, floored so the network stays legible when zoomed out. The floor is
  // converted from pixels into metres here rather than applied in screen space, which is the whole
  // difference: the ribbon is always a real surface lying on the ground, it just refuses to get
  // thinner than u_minHalfPx on screen.
  float mpp = czm_metersPerPixel(czm_modelViewRelativeToEye * p);
  float halfM = max(params.y, u_minHalfPx * mpp);

  // Widen across the ground plane and extend the caps along the road, both in world space. Doing
  // this on the screen — as this shader used to — drew roads as strokes ON TOP of the terrain
  // rather than as surfaces lying in it, which is why they never read as flat however they were
  // draped.
  p.xyz += side * params.x * halfM + tangent * params.z * halfM;

  v_color = color;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const ROAD_FS = `
in vec4 v_color;
void main() {
  out_FragColor = v_color;
}`;

/**
 * Spacing to resample a road centreline to, in metres.
 *
 * Vector-tile roads carry only enough vertices to describe their SHAPE — often a single straight
 * run across a valley. Draping those sparse points onto the terrain samples the ground where the
 * points happen to be and interpolates through everything in between, so a road crossing any relief
 * cuts into the hillside at one end and floats off it at the other. Resampling fixes that: every
 * ~18 m the ribbon gets a vertex that actually knows how high the ground is there.
 */
const RESAMPLE_M = 18;

/**
 * Catmull-Rom through four control points.
 *
 * Chosen over a corner-cutting scheme (Chaikin) because it passes THROUGH the original vertices:
 * road alignment stays exactly where the data says it is, and the smoothing only affects the curve
 * between points. Corner cutting looked better in isolation and pulled junctions off the grid.
 */
function catmullRom(p0: number[], p1: number[], p2: number[], p3: number[], t: number): number[] {
  const t2 = t * t;
  const t3 = t2 * t;
  const out: number[] = [0, 0];
  for (let k = 0; k < 2; k++) {
    out[k] =
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3);
  }
  return out;
}

/** Smooth a centreline and resample it to roughly {@link RESAMPLE_M} spacing. */
function resample(line: number[][]): number[][] {
  const n = line.length;
  if (n < 2) return line;
  const mPerLat = 111_320;
  const mLon = mPerLat * Math.cos((line[0][1] * Math.PI) / 180);
  const out: number[][] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = line[Math.max(0, i - 1)];
    const p1 = line[i];
    const p2 = line[i + 1];
    const p3 = line[Math.min(n - 1, i + 2)];
    const segM = Math.hypot((p2[0] - p1[0]) * mLon, (p2[1] - p1[1]) * mPerLat);
    // Cap the subdivision so one absurdly long way can't blow the vertex budget on its own.
    const steps = Math.max(1, Math.min(64, Math.ceil(segM / RESAMPLE_M)));
    for (let sIdx = 0; sIdx < steps; sIdx++) out.push(catmullRom(p0, p1, p2, p3, sIdx / steps));
  }
  out.push(line[n - 1]);
  return out;
}

export interface RoadGroup {
  /** lon/lat polylines, already clipped to whatever region should draw. */
  lines: number[][][];
  color: Cesium.Color;
  /** Real-world width in metres. */
  widthM: number;
}

/**
 * Drape road groups onto the baked terrain and merge them into one ribbon primitive.
 * `bounds` is supplied rather than derived: BoundingSphere.fromVertices takes a number[], and
 * Array.from() on a million-vertex Float64Array is a pointless megabyte-scale copy when the
 * theater's own centre and radius already bound it exactly.
 */
export function buildRoadPrimitive(
  groups: RoadGroup[],
  heightAt: (lon: number, lat: number) => number,
  lift: number,
  bounds: Cesium.BoundingSphere,
  minHalfPx: number,
): { primitive: Cesium.Primitive; segments: number } | undefined {
  // Every ribbon gets two extra "cap" points (one per end) that the shader extends outward by half
  // a width, so ways meeting at an intersection overlap instead of leaving a gap.
  // Resample once, up front: the counts below and the emit pass must see identical geometry.
  const shaped: { g: RoadGroup; lines: number[][][] }[] = [];
  let nPts = 0;
  let nSeg = 0;
  for (const g of groups) {
    const lines: number[][][] = [];
    for (const line of g.lines) {
      if (line.length < 2) continue;
      const r = resample(line);
      lines.push(r);
      nPts += r.length + 2;
      nSeg += r.length + 1;
    }
    if (lines.length) shaped.push({ g, lines });
  }
  if (!nSeg) return undefined;

  // two vertices per point (side -1 / +1), six indices per segment
  const positions = new Float64Array(nPts * 2 * 3);
  const tangents = new Float32Array(nPts * 2 * 3);
  /** Across-the-road unit vector in the ground plane. Computed here because both inputs are known. */
  const sides = new Float32Array(nPts * 2 * 3);
  const params = new Float32Array(nPts * 2 * 3);
  const colors = new Uint8Array(nPts * 2 * 4);
  const indices = new Uint32Array(nSeg * 6);

  const pt = new Cesium.Cartesian3();
  const pts: Cesium.Cartesian3[] = [];

  let v = 0;
  let ix = 0;

  const up = new Cesium.Cartesian3();
  const sideVec = new Cesium.Cartesian3();

  const emit = (
    pos: Cesium.Cartesian3,
    t: Cesium.Cartesian3,
    half: number,
    cap: number,
    cr: number,
    cg: number,
    cb: number,
    ca: number,
  ) => {
    // Ground-plane normal: up is geocentric here, which over a 200 mile theater is close enough to
    // the surface normal that no one will ever measure the difference.
    Cesium.Cartesian3.normalize(pos, up);
    Cesium.Cartesian3.cross(up, t, sideVec);
    if (Cesium.Cartesian3.magnitudeSquared(sideVec) === 0) Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, sideVec);
    Cesium.Cartesian3.normalize(sideVec, sideVec);

    for (let s = 0; s < 2; s++) {
      positions[v * 3] = pos.x;
      positions[v * 3 + 1] = pos.y;
      positions[v * 3 + 2] = pos.z;
      tangents[v * 3] = t.x;
      tangents[v * 3 + 1] = t.y;
      tangents[v * 3 + 2] = t.z;
      sides[v * 3] = sideVec.x;
      sides[v * 3 + 1] = sideVec.y;
      sides[v * 3 + 2] = sideVec.z;
      params[v * 3] = s === 0 ? -1 : 1;
      params[v * 3 + 1] = half;
      params[v * 3 + 2] = cap;
      colors[v * 4] = cr;
      colors[v * 4 + 1] = cg;
      colors[v * 4 + 2] = cb;
      colors[v * 4 + 3] = ca;
      v++;
    }
  };

  for (const { g, lines } of shaped) {
    const cr = Math.round(g.color.red * 255);
    const cg = Math.round(g.color.green * 255);
    const cb = Math.round(g.color.blue * 255);
    const ca = Math.round(g.color.alpha * 255);
    const half = g.widthM / 2;

    for (const line of lines) {
      if (line.length < 2) continue;

      pts.length = 0;
      for (const [lon, lat] of line) {
        Cesium.Cartesian3.fromDegrees(lon, lat, heightAt(lon, lat) + lift, undefined, pt);
        pts.push(Cesium.Cartesian3.clone(pt));
      }
      const n = pts.length;

      const dirOf = (a: Cesium.Cartesian3, b: Cesium.Cartesian3): Cesium.Cartesian3 => {
        const t = Cesium.Cartesian3.subtract(b, a, new Cesium.Cartesian3());
        if (Cesium.Cartesian3.magnitudeSquared(t) === 0) Cesium.Cartesian3.clone(Cesium.Cartesian3.UNIT_X, t);
        return Cesium.Cartesian3.normalize(t, t);
      };

      const first = v;
      // start cap (extends backward from pts[0])
      emit(pts[0], dirOf(pts[0], pts[1]), half, -1, cr, cg, cb, ca);
      // body points, tangent = average of adjacent directions so joins don't notch
      for (let i = 0; i < n; i++) {
        const prev = pts[Math.max(0, i - 1)];
        const next = pts[Math.min(n - 1, i + 1)];
        emit(pts[i], dirOf(prev, next), half, 0, cr, cg, cb, ca);
      }
      // end cap (extends forward from pts[n-1])
      emit(pts[n - 1], dirOf(pts[n - 2], pts[n - 1]), half, 1, cr, cg, cb, ca);

      // quads across the n+2 ribbon points
      for (let i = 0; i < n + 1; i++) {
        const a = first + i * 2;
        const b = a + 1;
        const c = a + 2;
        const dd = a + 3;
        indices[ix++] = a;
        indices[ix++] = c;
        indices[ix++] = b;
        indices[ix++] = b;
        indices[ix++] = c;
        indices[ix++] = dd;
      }
    }
  }

  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
      tangent: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: tangents,
      }),
      side: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: sides,
      }),
      params: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 3,
        values: params,
      }),
      color: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
        componentsPerAttribute: 4,
        normalize: true,
        values: colors,
      }),
    } as unknown as Cesium.GeometryAttributes,
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: bounds,
  });

  const appearance = new Cesium.Appearance({
    vertexShaderSource: ROAD_VS,
    fragmentShaderSource: ROAD_FS,
    translucent: true, // road classes carry alpha
    closed: false,
    renderState: { depthTest: { enabled: true }, cull: { enabled: false } },
  });
  (appearance as unknown as { uniforms: Record<string, unknown> }).uniforms = { u_minHalfPx: minHalfPx };

  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance,
    asynchronous: false,
  });

  return { primitive, segments: nSeg };
}
