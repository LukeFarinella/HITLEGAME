import * as Cesium from 'cesium';

/**
 * GORGON obelisks — fixed defensive sites, one per source location.
 *
 * Two very different renderings of the same 115k points:
 *   orbit   : one additive orange splat each. Isolated sites read as a dot; where they crowd, the
 *             splats sum and ramp orange -> yellow -> white on their own. That IS the heatmap —
 *             no binning pass, no second data structure, one draw call.
 *   theater : a real obelisk each, oriented to its eye direction, sitting on the baked terrain.
 *
 * Data is built by `tools/build-obelisks.mjs` into `public/obelisks.bin`.
 */

/** Brand orange — the obelisk accent. Mirrors --orange in src/ui/theme.css. */
export const ORANGE = Cesium.Color.fromCssColorString('#E8701E');

// --- obelisk dimensions ------------------------------------------------------------------------
// Building-scale, not mountain-scale: ~6,000 of these land in a city theater, so they read as
// infrastructure. Washington Monument proportions (169 m tall on a 16.8 m base) are the reference
// for "tall skinny pyramid" and happen to be exactly the right silhouette.
const OBELISK_HEIGHT_M = 150;
const OBELISK_BASE_M = 14;
/** Sink the base slightly so it doesn't float on a sloped cell of the terrain mesh. */
const OBELISK_SINK_M = 6;

export interface ObeliskField {
  count: number;
  lon: Float32Array;
  lat: Float32Array;
  /** Degrees clockwise from north. Always resolved — see stableHeading. */
  heading: Float32Array;
  /** 1 where the heading came from the source rather than being invented. */
  headingIsReal: Uint8Array;
  realHeadings: number;
}

/**
 * ~98% of sites ship no usable direction. Facing them all north would read as an obvious artifact,
 * so derive a heading from the coordinates: arbitrary, but stable across reloads and machines, so
 * a given obelisk always looks the same way.
 */
function stableHeading(lon: number, lat: number): number {
  let h = Math.imul(Math.round(lon * 1e5) ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13) ^ Math.round(lat * 1e5), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 360;
}

export async function loadObelisks(): Promise<ObeliskField> {
  const res = await fetch(`${import.meta.env.BASE_URL}obelisks.bin`);
  if (!res.ok) throw new Error(`obelisks.bin: ${res.status}`);
  const buf = await res.arrayBuffer();
  const view = new DataView(buf);
  const magic = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (magic !== 'GOBL') throw new Error(`obelisks.bin: bad magic "${magic}"`);

  const count = view.getUint32(4, true);
  const lon = new Float32Array(count);
  const lat = new Float32Array(count);
  const heading = new Float32Array(count);
  const headingIsReal = new Uint8Array(count);
  let realHeadings = 0;

  for (let i = 0; i < count; i++) {
    const o = 8 + i * 12;
    lon[i] = view.getFloat32(o, true);
    lat[i] = view.getFloat32(o + 4, true);
    const h = view.getInt16(o + 8, true);
    const real = view.getInt16(o + 10, true) === 1;
    headingIsReal[i] = real ? 1 : 0;
    if (real) realHeadings++;
    heading[i] = h >= 0 ? h : stableHeading(lon[i], lat[i]);
  }
  return { count, lon, lat, heading, headingIsReal, realHeadings };
}

// --- orbit: additive heat splats ---------------------------------------------------------------

const HEAT_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
uniform float u_pointSize;
void main() {
  vec4 p = czm_computePosition();
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
  gl_PointSize = u_pointSize;
}`;

/**
 * Each splat is a bright tight CORE plus a dim wide HALO, added straight onto the framebuffer
 * (the blend is ONE/ONE, so RGB is pre-weighted here and alpha is unused).
 *
 * The two lobes exist because one lobe can't do both jobs. Site density spans ~4 orders of
 * magnitude — one obelisk in open country versus ~7,500 inside a city — and a single linear
 * gaussian either makes the lone site invisible or blows every metro out to flat white, losing
 * the gradient that makes it a heatmap at all. So: the core carries "this is one orange site" and
 * barely overlaps its neighbours; the halo is low enough to sum over hundreds of sites before it
 * clips, and that summing is what paints the heat.
 */
const HEAT_FS = `
uniform vec3 u_color;
uniform float u_intensity;
uniform float u_dot;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;
  float core = exp(-d * d * 20.0) * u_dot;
  float halo = exp(-d * d * 2.5) * u_intensity;
  out_FragColor = vec4(u_color * (core + halo), 1.0);
}`;

/** Lift the splats off the ellipsoid so they don't z-fight the globe surface. */
const HEAT_LIFT_M = 1500;

/**
 * Depth-test so geometry in front still hides them, but never write depth: these have to
 * accumulate through each other, and a splat that wrote depth would reject the very neighbours
 * it's meant to sum with.
 */
const ADDITIVE_RENDER_STATE = {
  depthTest: { enabled: true },
  depthMask: false,
  blending: {
    enabled: true,
    equationRgb: Cesium.BlendEquation.ADD,
    equationAlpha: Cesium.BlendEquation.ADD,
    functionSourceRgb: Cesium.BlendFunction.ONE,
    functionSourceAlpha: Cesium.BlendFunction.ONE,
    functionDestinationRgb: Cesium.BlendFunction.ONE,
    functionDestinationAlpha: Cesium.BlendFunction.ONE,
  },
};

/**
 * Appearance.getRenderState() rewrites depthMask, and swaps a custom blend for ALPHA_BLEND
 * whenever it decides the appearance is translucent. Neither is negotiable for additive work, so
 * state the render state outright instead of letting it be derived.
 */
function forceRenderState(appearance: Cesium.Appearance, uniforms: Record<string, unknown>) {
  (appearance as unknown as { uniforms: Record<string, unknown> }).uniforms = uniforms;
  const rs = appearance.renderState;
  appearance.getRenderState = () => rs;
}

function additivePoints(
  positions: Float64Array,
  vs: string,
  fs: string,
  uniforms: Record<string, unknown>,
): Cesium.Primitive {
  const n = positions.length / 3;
  const indices = new Uint32Array(n);
  for (let i = 0; i < n; i++) indices[i] = i;

  const geometry = new Cesium.Geometry({
    attributes: {
      position: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      }),
    } as unknown as Cesium.GeometryAttributes,
    indices,
    primitiveType: Cesium.PrimitiveType.POINTS,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
  });

  const appearance = new Cesium.Appearance({
    vertexShaderSource: vs,
    fragmentShaderSource: fs,
    translucent: false,
    closed: false,
    renderState: ADDITIVE_RENDER_STATE,
  });
  forceRenderState(appearance, uniforms);

  return new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance,
    asynchronous: false,
  });
}

/**
 * `mask` (1 = live) limits the splats to the sites the player actually holds, so orbit reads as a
 * map of the campaign: held states glow, everything still to be taken sits dark. Undefined shows
 * the whole field. Returns undefined when nothing is live — there is no valid zero-point primitive.
 */
export function createHeatField(
  field: ObeliskField,
  pointSize: number,
  intensity: number,
  dot: number,
  mask?: Uint8Array,
): Cesium.Primitive | undefined {
  const live: number[] = [];
  for (let i = 0; i < field.count; i++) if (!mask || mask[i]) live.push(i);
  if (!live.length) return undefined;

  const positions = new Float64Array(live.length * 3);
  const scratch = new Cesium.Cartesian3();
  for (let k = 0; k < live.length; k++) {
    const i = live[k];
    Cesium.Cartesian3.fromDegrees(field.lon[i], field.lat[i], HEAT_LIFT_M, undefined, scratch);
    positions[k * 3] = scratch.x;
    positions[k * 3 + 1] = scratch.y;
    positions[k * 3 + 2] = scratch.z;
  }
  return additivePoints(positions, HEAT_VS, HEAT_FS, {
    u_color: Cesium.Cartesian3.fromElements(ORANGE.red, ORANGE.green, ORANGE.blue),
    u_pointSize: pointSize,
    u_intensity: intensity,
    u_dot: dot,
  });
}

// --- theater: obelisk geometry -----------------------------------------------------------------

const OBELISK_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;      // face-local: x across the face, y from base (0) to apex (1)
in float eye;    // 1 on the single face that looks along the site's heading
in float batchId;
out vec3 v_normalEC;
out vec2 v_st;
out float v_eye;
void main() {
  vec4 p = czm_computePosition();
  v_normalEC = czm_normal * normal;
  v_st = st;
  v_eye = eye;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

/**
 * The shaft is a brand-orange gradient, dark at the base and hot at the tip, and it is half
 * emissive rather than fully lit. That matters for legibility, not decoration: at the theater's
 * opening altitude a 150 m obelisk is barely a pixel tall, so a purely diffuse body just averages
 * into the terrain and disappears. Carrying its own light keeps the gradient readable however few
 * pixels it gets, and the tip flare (a separate additive splat) does the rest.
 */
const OBELISK_FS = `
in vec3 v_normalEC;
in vec2 v_st;
in float v_eye;

const vec3 SHAFT_BASE = vec3(0.075, 0.055, 0.050);
const vec3 SHAFT_TIP  = vec3(0.910, 0.439, 0.118);

void main() {
  vec3 grad = mix(SHAFT_BASE, SHAFT_TIP, pow(v_st.y, 1.4));
  vec3 n = normalize(v_normalEC);
  vec3 l = normalize(czm_lightDirectionEC);
  vec3 col = grad * (0.30 + 0.80 * max(dot(n, l), 0.0)) + grad * 0.55;

  // The eye: a glowing lens on the face that looks along the heading.
  float band = smoothstep(0.045, 0.015, abs(v_st.y - 0.70));
  float lens = smoothstep(0.17, 0.06, abs(v_st.x - 0.5));
  col = mix(col, vec3(1.0, 0.72, 0.32), v_eye * band * lens);

  // The tip the electrical attack will fire from.
  col += SHAFT_TIP * smoothstep(0.88, 1.0, v_st.y) * 0.75;

  out_FragColor = vec4(col, 1.0);
}`;

/** Additive flare sitting on each apex, so a field of obelisks reads from altitude. */
const FLARE_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in float batchId;
uniform float u_pointSize;
void main() {
  vec4 p = czm_computePosition();
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
  gl_PointSize = u_pointSize;
}`;

const FLARE_FS = `
uniform vec3 u_color;
uniform float u_intensity;
void main() {
  float d = length(gl_PointCoord - vec2(0.5)) * 2.0;
  if (d > 1.0) discard;
  out_FragColor = vec4(u_color * exp(-d * d * 4.0) * u_intensity, 1.0);
}`;

export interface ObeliskPyramids {
  primitive: Cesium.Primitive;
  /** Additive apex flares — what carries the field at altitude. */
  flare: Cesium.Primitive;
  count: number;
  /** In-theater obelisk sites: lon/lat pairs and matching apex ECEF (x,y,z) — for the sensor field. */
  lonLat: Float64Array;
  apex: Float64Array;
}

/**
 * Build every obelisk inside the theater disc as one merged primitive (one draw call).
 * `maxRadial` is in units of the theater radius; sites past it are dropped rather than faded,
 * since the terrain out there is already dissolving into black.
 *
 * `mask` (1 = live) is the ownership filter — a state at DOWNTOWN tier fields one obelisk in its
 * theater, not the thousands the data holds. Same mask the orbit heat uses, so the two views agree.
 */
export function buildObeliskPyramids(
  field: ObeliskField,
  center: { lon: number; lat: number },
  radiusM: number,
  heightAt: (lon: number, lat: number) => number,
  maxRadial: number,
  flarePx: number,
  flareIntensity: number,
  mask?: Uint8Array,
): ObeliskPyramids | undefined {
  const rLat = radiusM / 111_320;
  const rLon = rLat / Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));
  const limit = maxRadial * maxRadial;

  // Linear scan over 115k with a cheap bbox reject first — a few ms, so no spatial index earns
  // its keep here.
  const picked: number[] = [];
  for (let i = 0; i < field.count; i++) {
    if (mask && !mask[i]) continue;
    const dLon = field.lon[i] - center.lon;
    if (dLon < -rLon || dLon > rLon) continue;
    const dLat = field.lat[i] - center.lat;
    if (dLat < -rLat || dLat > rLat) continue;
    const x = dLon / rLon;
    const y = dLat / rLat;
    if (x * x + y * y <= limit) picked.push(i);
  }
  if (!picked.length) return undefined;

  const n = picked.length;
  const positions = new Float64Array(n * 12 * 3);
  const sts = new Float32Array(n * 12 * 2);
  const eyes = new Float32Array(n * 12);
  const indices = new Uint32Array(n * 12);
  const apexes = new Float64Array(n * 3);
  const lonLat = new Float64Array(n * 2);

  const r = OBELISK_BASE_M / Math.SQRT2; // half-diagonal of the square base
  const origin = new Cesium.Cartesian3();
  const frame = new Cesium.Matrix4();
  const local = new Cesium.Cartesian3();
  const world = new Cesium.Cartesian3();

  let v = 0;
  let o = 0;
  for (const i of picked) {
    const lon = field.lon[i];
    const lat = field.lat[i];
    const ground = heightAt(lon, lat) - OBELISK_SINK_M;
    Cesium.Cartesian3.fromDegrees(lon, lat, ground, undefined, origin);
    Cesium.Transforms.eastNorthUpToFixedFrame(origin, undefined, frame);

    Cesium.Cartesian3.fromElements(0, 0, OBELISK_HEIGHT_M, local);
    Cesium.Matrix4.multiplyByPoint(frame, local, world);
    apexes[o * 3] = world.x;
    apexes[o * 3 + 1] = world.y;
    apexes[o * 3 + 2] = world.z;
    lonLat[o * 2] = lon;
    lonLat[o * 2 + 1] = lat;
    o++;

    const h = (field.heading[i] * Math.PI) / 180;
    // Corner k sits at bearing h - 45 + 90k, so face k (corner k -> corner k+1) looks along
    // bearing h + 90k — i.e. face 0 looks exactly along the site's heading.
    const cx: number[] = [];
    const cy: number[] = [];
    for (let k = 0; k < 4; k++) {
      const t = h - Math.PI / 4 + (k * Math.PI) / 2;
      cx.push(r * Math.sin(t)); // east
      cy.push(r * Math.cos(t)); // north
    }

    for (let k = 0; k < 4; k++) {
      const k2 = (k + 1) % 4;
      // (corner k, apex, corner k+1) winds so the face normal points outward and up.
      const tri: [number, number, number][] = [
        [cx[k], cy[k], 0],
        [0, 0, OBELISK_HEIGHT_M],
        [cx[k2], cy[k2], 0],
      ];
      const uv: [number, number][] = [
        [0, 0],
        [0.5, 1],
        [1, 0],
      ];
      for (let t = 0; t < 3; t++) {
        Cesium.Cartesian3.fromElements(tri[t][0], tri[t][1], tri[t][2], local);
        Cesium.Matrix4.multiplyByPoint(frame, local, world);
        positions[v * 3] = world.x;
        positions[v * 3 + 1] = world.y;
        positions[v * 3 + 2] = world.z;
        sts[v * 2] = uv[t][0];
        sts[v * 2 + 1] = uv[t][1];
        eyes[v] = k === 0 ? 1 : 0;
        indices[v] = v;
        v++;
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
      st: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: sts,
      }),
      eye: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 1,
        values: eyes,
      }),
    } as unknown as Cesium.GeometryAttributes,
    indices,
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
  });
  // No vertices are shared between faces, so this yields flat per-face normals.
  Cesium.GeometryPipeline.computeNormal(geometry);

  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.Appearance({
      vertexShaderSource: OBELISK_VS,
      fragmentShaderSource: OBELISK_FS,
      translucent: false,
      closed: false,
      renderState: {
        depthTest: { enabled: true },
        cull: { enabled: false },
      },
    }),
    asynchronous: false,
  });

  const flare = additivePoints(apexes, FLARE_VS, FLARE_FS, {
    u_color: Cesium.Cartesian3.fromElements(ORANGE.red, ORANGE.green, ORANGE.blue),
    u_pointSize: flarePx,
    u_intensity: flareIntensity,
  });

  return { primitive, flare, count: n, lonLat, apex: apexes };
}
