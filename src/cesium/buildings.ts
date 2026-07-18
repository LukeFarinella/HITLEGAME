import * as Cesium from 'cesium';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import { tileTemplate } from './roads';

/**
 * Real OSM building footprints, extruded to their real heights.
 *
 * Unlike roads, buildings CANNOT cover the theater. OpenMapTiles only carries the `building`
 * layer at z13-14, and only z14 has `render_height` (z13 merges every building into one
 * property-less blob). A 200-mile box at z14 is ~27,900 tiles. So buildings are a CORE around the
 * theater centre — the objective area — and the rest of the theater stays bare terrain.
 *
 * Measured at a 6 km core: SF 147,689 footprints / NYC 228,732, which is ~3M vertices of extrusion
 * and far too much. OSM counts every shed, garage and carport. Filtering to real structures
 * (>=10 m tall, >=150 m² footprint) keeps the skyline and drops ~85% of the count: SF 19,430 /
 * NYC 43,521.
 */

const BUILDING_ZOOM = 14; // the only zoom with render_height
const EXTENT_LAYER = 'building';

export interface BuildingSet {
  /** Footprint outer ring + holes, as lon/lat. */
  polys: { rings: number[][][]; height: number; minHeight: number }[];
  tiles: number;
  points: number;
  /** How many footprints the height/area filter dropped. */
  skipped: number;
}

const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Shoelace area of a lon/lat ring, in m². */
function ringArea(ring: number[][], lat0: number): number {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_540;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * kx * (ring[i][1] * ky) - ring[i][0] * kx * (ring[j][1] * ky);
  }
  return Math.abs(a / 2);
}

export async function fetchBuildings(
  center: { lon: number; lat: number },
  radiusM: number,
  minHeight: number,
  minArea: number,
): Promise<BuildingSet> {
  const template = await tileTemplate();
  const z = BUILDING_ZOOM;
  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));

  const xMin = Math.floor(lon2tileX(center.lon - dLon, z));
  const xMax = Math.floor(lon2tileX(center.lon + dLon, z));
  const yMin = Math.floor(lat2tileY(center.lat + dLat, z));
  const yMax = Math.floor(lat2tileY(center.lat - dLat, z));

  const jobs: [number, number][] = [];
  for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) jobs.push([x, y]);

  const polys: BuildingSet['polys'] = [];
  let tiles = 0;
  let points = 0;
  let skipped = 0;

  await Promise.all(
    jobs.map(async ([x, y]) => {
      try {
        const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
        const res = await fetch(url);
        if (!res.ok) return;
        const buf = await res.arrayBuffer();
        if (buf.byteLength === 0) return;
        const layer = new VectorTile(new PbfReader(new Uint8Array(buf))).layers[EXTENT_LAYER];
        if (!layer) return;
        tiles++;
        for (let i = 0; i < layer.length; i++) {
          const f = layer.feature(i);
          // OpenFreeMap merges every footprint that shares a height into ONE feature, so a
          // "feature" here is a whole height class and the polygons inside it are the buildings.
          const height = (f.properties.render_height as number) ?? 0;
          const minH = (f.properties.render_min_height as number) ?? 0;
          if (height < minHeight) {
            skipped++;
            continue;
          }
          const g = f.toGeoJSON(x, y, z).geometry;
          const list: number[][][][] =
            g.type === 'Polygon' ? [g.coordinates as number[][][]]
            : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][])
            : [];
          for (const rings of list) {
            if (!rings.length || rings[0].length < 4) continue;
            if (ringArea(rings[0], center.lat) < minArea) {
              skipped++;
              continue;
            }
            for (const r of rings) points += r.length;
            polys.push({ rings, height, minHeight: minH });
          }
        }
      } catch {
        /* a dropped tile costs a few buildings, not the theater */
      }
    }),
  );

  return { polys, tiles, points, skipped };
}

// --- rendering ---------------------------------------------------------------------------------

// Inlined WGS84 lon/lat/height -> ECEF. `Cesium.Cartesian3.fromDegrees` allocates a Cartographic
// scratch and re-does the trig each call; at ~940k vertices for a full city core that overhead
// dominated the build. The surface normal (cosLat·cosLon, cosLat·sinLon, sinLat) is already unit
// length, so the usual normalize is skipped.
const WGS84_A2 = 6378137.0 * 6378137.0;
const WGS84_B2 = 6356752.314245179 * 6356752.314245179;
const D2R = Math.PI / 180;
function ecef(lonDeg: number, latDeg: number, h: number, out: Float64Array, o: number): void {
  const lon = lonDeg * D2R;
  const lat = latDeg * D2R;
  const cosLat = Math.cos(lat);
  const nx = cosLat * Math.cos(lon);
  const ny = cosLat * Math.sin(lon);
  const nz = Math.sin(lat);
  const kx = WGS84_A2 * nx;
  const ky = WGS84_A2 * ny;
  const kz = WGS84_B2 * nz;
  const gamma = Math.sqrt(nx * kx + ny * ky + nz * kz);
  out[o] = kx / gamma + nx * h;
  out[o + 1] = ky / gamma + ny * h;
  out[o + 2] = kz / gamma + nz * h;
}

/**
 * Flat shading WITHOUT duplicating vertices: the normal is recovered per-fragment from the
 * derivatives of the eye-space position. That lets walls and roof share one bottom ring and one
 * top ring — 2 vertices per footprint point instead of the 4-per-wall-quad a normal attribute
 * would force, which is the difference between ~0.9M vertices and ~3.5M for a city core.
 */
const BUILDING_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 aux;    // x = height above the building's base (m), y = the building's total height (m)
in float batchId;
out vec3 v_posEC;
out vec2 v_aux;
void main() {
  vec4 p = czm_computePosition();
  v_posEC = (czm_modelViewRelativeToEye * p).xyz;
  v_aux = aux;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const BUILDING_FS = `
in vec3 v_posEC;
in vec2 v_aux;

const vec3 WALL_LOW  = vec3(0.098, 0.110, 0.129);
const vec3 WALL_HIGH = vec3(0.404, 0.443, 0.494);

void main() {
  vec3 n = normalize(cross(dFdx(v_posEC), dFdy(v_posEC)));
  // Derivative normals are sign-ambiguous; point it back at the camera.
  if (dot(n, normalize(-v_posEC)) < 0.0) n = -n;

  vec3 l = normalize(czm_lightDirectionEC);
  float diff = max(dot(n, l), 0.0);

  // Taller structures read lighter, and every wall brightens toward its own roofline, so the
  // massing stays legible against dark terrain even where the light doesn't fall on it.
  float tall = clamp(v_aux.y / 120.0, 0.0, 1.0);
  float up = clamp(v_aux.x / max(v_aux.y, 1.0), 0.0, 1.0);
  vec3 base = mix(WALL_LOW, WALL_HIGH, tall * 0.75 + up * 0.25);

  out_FragColor = vec4(base * (0.34 + 0.95 * diff), 1.0);
}`;


function buildingAppearance(): Cesium.Appearance {
  return new Cesium.Appearance({
    vertexShaderSource: BUILDING_VS,
    fragmentShaderSource: BUILDING_FS,
    translucent: false,
    closed: false,
    renderState: {
      depthTest: { enabled: true },
      // Footprint winding isn't guaranteed consistent, and the FS recovers its own normal anyway,
      // so culling would only ever hide the wrong faces.
      cull: { enabled: false },
    },
  });
}

/**
 * Extrude the footprints into primitives, **one per chunk of buildings**, calling `onChunk` as each
 * is ready. A full city core is ~80k buildings / ~2.4M triangles: extruding it in one pass froze
 * the page for ~9 s and, worse, showed NOTHING until the whole thing landed. Emitting a primitive
 * every few thousand buildings makes the city visibly fill in from the first ~second while the
 * fly-in keeps rendering. `isStale()` aborts a build the user has navigated away from.
 *
 * Ground height is sampled ONCE per building (at its first vertex), not per vertex: a footprint is
 * tens of metres across and the terrain mesh is ~300 m per vertex, so per-vertex sampling would
 * only add a skew to something that should sit level.
 */
const BUILD_CHUNK = 3000;

export async function buildBuildings(
  set: BuildingSet,
  heightAt: (lon: number, lat: number) => number,
  bounds: Cesium.BoundingSphere,
  sink: number,
  isStale: () => boolean,
  onChunk: (primitive: Cesium.Primitive) => void,
): Promise<{ count: number; triangles: number }> {
  const polys = set.polys;
  const flat: number[] = []; // reused per building
  const holes: number[] = [];
  let total = 0;
  let triangles = 0;

  for (let start = 0; start < polys.length; start += BUILD_CHUNK) {
    if (isStale()) break;
    const end = Math.min(polys.length, start + BUILD_CHUNK);

    // size this chunk's buffers to its own point sum (a JS number[] + final Uint32Array conversion
    // is what made the old single-pass build slow — typed arrays with a running counter avoid it)
    let pts = 0;
    for (let i = start; i < end; i++) for (const r of polys[i].rings) pts += r.length;
    const positions = new Float64Array(pts * 2 * 3);
    const aux = new Float32Array(pts * 2 * 2);
    const indices = new Uint32Array(pts * 9);
    let v = 0;
    let ix = 0;

    for (let bi = start; bi < end; bi++) {
      const b = polys[bi];
      const outer = b.rings[0];
      // toGeoJSON closes rings (last === first); drop the repeat so we don't emit a zero-area wall.
      const closed =
        outer.length > 1 && outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1];
      const rings = b.rings.map((r) => (closed ? r.slice(0, -1) : r));
      if (rings[0].length < 3) continue;

      const ground = heightAt(rings[0][0][0], rings[0][0][1]) - sink;
      const base = ground + b.minHeight;
      const top = ground + Math.max(b.height, b.minHeight + 1);
      const wallH = top - base;

      const ringStart: number[] = [];
      for (const ring of rings) {
        ringStart.push(v);
        for (const [lon, lat] of ring) {
          ecef(lon, lat, base, positions, v * 3);
          aux[v * 2] = 0;
          aux[v * 2 + 1] = wallH;
          v++;
        }
        for (const [lon, lat] of ring) {
          ecef(lon, lat, top, positions, v * 3);
          aux[v * 2] = wallH;
          aux[v * 2 + 1] = wallH;
          v++;
        }
      }

      for (let r = 0; r < rings.length; r++) {
        const k = rings[r].length;
        const bot = ringStart[r];
        const tp = bot + k;
        for (let i = 0; i < k; i++) {
          const j = (i + 1) % k;
          indices[ix++] = bot + i;
          indices[ix++] = bot + j;
          indices[ix++] = tp + i;
          indices[ix++] = tp + i;
          indices[ix++] = bot + j;
          indices[ix++] = tp + j;
        }
      }

      flat.length = 0;
      holes.length = 0;
      for (let r = 0; r < rings.length; r++) {
        if (r > 0) holes.push(flat.length / 2);
        for (const [lon, lat] of rings[r]) flat.push(lon, lat);
      }
      const tris = earcut(flat, holes, 2);
      const topOf = (n: number) => {
        let r = 0;
        let acc = 0;
        while (r + 1 < rings.length && n >= acc + rings[r].length) {
          acc += rings[r].length;
          r++;
        }
        return ringStart[r] + rings[r].length + (n - acc);
      };
      for (let i = 0; i < tris.length; i += 3) {
        indices[ix++] = topOf(tris[i]);
        indices[ix++] = topOf(tris[i + 1]);
        indices[ix++] = topOf(tris[i + 2]);
      }
      total++;
    }

    if (ix) {
      const geometry = new Cesium.Geometry({
        attributes: {
          position: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.DOUBLE,
            componentsPerAttribute: 3,
            values: positions.subarray(0, v * 3),
          }),
          aux: new Cesium.GeometryAttribute({
            componentDatatype: Cesium.ComponentDatatype.FLOAT,
            componentsPerAttribute: 2,
            values: aux.subarray(0, v * 2),
          }),
        } as unknown as Cesium.GeometryAttributes,
        indices: indices.subarray(0, ix),
        primitiveType: Cesium.PrimitiveType.TRIANGLES,
        boundingSphere: bounds,
      });
      triangles += ix / 3;
      const primitive = new Cesium.Primitive({
        geometryInstances: new Cesium.GeometryInstance({ geometry }),
        appearance: buildingAppearance(),
        asynchronous: false,
      });
      if (isStale()) {
        primitive.destroy();
        break;
      }
      onChunk(primitive);
    }

    await new Promise((r) => setTimeout(r)); // let the chunk render before the next one
  }

  return { count: total, triangles };
}
