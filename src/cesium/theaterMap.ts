import * as Cesium from 'cesium';

/**
 * A theater is ONE static mesh, built once, at a single fixed resolution.
 *
 * Deliberately not Cesium's streaming globe: no LOD, nothing re-loads as you zoom. We fetch the
 * terrarium tiles that cover the theater at a resolution matched to the mesh, stitch them, and bake
 * a procedural colour — no raster imagery anywhere.
 *
 * THE SHORELINE IS A SIGNED DISTANCE FIELD, NOT A MASK.
 * Deciding land/water per mesh vertex quantises the coast to the mesh (~300 m cells at 1024
 * samples) and interpolates the colour across each triangle — which is exactly the "raster
 * splotchiness" you see up close. Instead we bake the *signed distance to the vector coastline*
 * into a texture and threshold it in the fragment shader. Distance is linear either side of an
 * edge, so bilinear sampling reconstructs a straight coast segment EXACTLY, at any zoom, and
 * `fwidth` antialiases it to ~one pixel. The coast is then limited by the source vectors (Natural
 * Earth 1:10m, ~1 km between points), not by our grid — i.e. it reads as vector art.
 *
 * Terrarium encoding: elevation(m) = R*256 + G + B/256 - 32768
 */
const TILE_PX = 256;
const EARTH_CIRC = 40_075_016;
const BATHY_MAX_ZOOM = 10; // deeper than this the dataset serves all-zero ocean tiles
const LAND_LIFT_M = 1.0; // land sits ~3 ft above the water plane
const WATER_FLOOR_M = -0.5; // sea never pokes through it

/**
 * Signed distance is stored in one byte, so it's clamped to this band (metres). Only the sign
 * matters far from shore; near it, this gives ~6 m of precision — an order of magnitude finer
 * than the coastline vectors themselves.
 */
const SDF_BAND_M = 800;

/** Fraction of the theater radius where the map starts dissolving into blackness. */
const RIM_FADE_START = 0.93;

// --- palette: procedural, keyed to elevation -------------------------------------------------
type RGB = [number, number, number];
const SHALLOW: RGB = [56, 104, 140];
const DEEP: RGB = [7, 18, 34];
const LOW: RGB = [38, 52, 45];
const MID: RGB = [78, 82, 68];
const HIGH: RGB = [166, 174, 182];
const WATER_TINT: RGB = [18, 51, 80];
const WATER_ALPHA = 0.3; // the sea is 30% opaque so bathymetry reads straight through it

/** Emit a palette entry as a GLSL vec3 literal. */
const glslRGB = (c: RGB) => `vec3(${c.map((v) => (v / 255).toFixed(4)).join(', ')})`;
/** GLSL floats need a decimal point, always. */
const glslF = (n: number) => n.toFixed(3);

// --- shoreline signed distance field -----------------------------------------------------------

const EDT_INF = 1e20;

/**
 * One-dimensional squared distance transform (Felzenszwalb & Huttenlocher), the same formulation
 * mapbox/tiny-sdf uses. Walks a lower envelope of parabolas in O(n).
 */
function edt1d(grid: Float64Array, offset: number, stride: number, length: number, f: Float64Array, v: Int32Array, z: Float64Array) {
  v[0] = 0;
  z[0] = -EDT_INF;
  z[1] = EDT_INF;
  f[0] = grid[offset];
  for (let q = 1, k = 0, s = 0; q < length; q++) {
    f[q] = grid[offset + q * stride];
    const q2 = q * q;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q2 - r * r) / (q - r) / 2;
    } while (s <= z[k] && --k > -1);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = EDT_INF;
  }
  for (let q = 0, k = 0; q < length; q++) {
    while (z[k + 1] < q) k++;
    const r = v[k];
    grid[offset + q * stride] = f[r] + (q - r) * (q - r);
  }
}

function edt2d(grid: Float64Array, w: number, h: number) {
  const f = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  for (let x = 0; x < w; x++) edt1d(grid, x, w, h, f, v, z);
  for (let y = 0; y < h; y++) edt1d(grid, y * w, 1, w, f, v, z);
}

/**
 * Rasterise the vector land polygons over the bbox and return per-texel *coverage* (0..1).
 * The canvas antialiases the fill, and that partial coverage is what buys us sub-texel accuracy
 * in the distance field below — a hard 0/1 mask would put the coast back on a grid.
 */
function rasterCoverage(landPolys: number[][][][], bbox: [number, number, number, number], N: number): Float32Array {
  const [w, s, e, n] = bbox;
  const c = document.createElement('canvas');
  c.width = N;
  c.height = N;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.clearRect(0, 0, N, N);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const poly of landPolys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const px = ((ring[i][0] - w) / (e - w)) * (N - 1);
        const py = ((n - ring[i][1]) / (n - s)) * (N - 1);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
  ctx.fill('evenodd'); // lakes punch through
  const d = ctx.getImageData(0, 0, N, N).data;
  const cov = new Float32Array(N * N);
  for (let i = 0; i < cov.length; i++) cov[i] = d[i * 4 + 3] / 255;
  return cov;
}

interface ShoreField {
  /** Signed distance in metres, positive on land. */
  sdf: Float32Array;
  res: number;
  /** RGBA canvas with the distance encoded into the red channel. */
  canvas: HTMLCanvasElement;
}

function buildShoreField(
  landPolys: number[][][][],
  bbox: [number, number, number, number],
  N: number,
  metersPerTexel: number,
): ShoreField {
  const cov = rasterCoverage(landPolys, bbox, N);

  // Two transforms: distance to the nearest land texel, and to the nearest water texel. Their
  // difference is the signed distance. Partially covered texels seed a sub-texel offset.
  const toLand = new Float64Array(N * N);
  const toWater = new Float64Array(N * N);
  for (let i = 0; i < cov.length; i++) {
    const a = cov[i];
    if (a === 1) {
      toLand[i] = 0;
      toWater[i] = EDT_INF;
    } else if (a === 0) {
      toLand[i] = EDT_INF;
      toWater[i] = 0;
    } else {
      const d = 0.5 - a;
      toLand[i] = d > 0 ? d * d : 0;
      toWater[i] = d < 0 ? d * d : 0;
    }
  }
  edt2d(toLand, N, N);
  edt2d(toWater, N, N);

  const sdf = new Float32Array(N * N);
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = (Math.sqrt(toWater[i]) - Math.sqrt(toLand[i])) * metersPerTexel;
  }

  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(N, N);
  for (let i = 0; i < sdf.length; i++) {
    const t = Math.max(-1, Math.min(1, sdf[i] / SDF_BAND_M)) * 0.5 + 0.5;
    const b = Math.round(t * 255);
    img.data[i * 4] = b;
    img.data[i * 4 + 1] = b;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return { sdf, res: N, canvas };
}

/**
 * The distance field reaches the shader as a Cesium `Material`, which is the only public way to
 * hand a canvas to a custom `Appearance` (it owns the upload and the texture's lifetime).
 * Material renames its uniforms, but *only inside its own source* — so the uniforms stay wrapped
 * in this helper and the appearance shaders below just call `gorgon_shoreDistance()`.
 */
function shoreMaterial(canvas: HTMLCanvasElement, translucent: boolean): Cesium.Material {
  return new Cesium.Material({
    fabric: {
      // No `type`: Cesium assigns a GUID, so each theater's material is its own cache entry
      // rather than colliding with the last one's texture.
      uniforms: { image: canvas, band: SDF_BAND_M },
      // Cesium uploads image sources with flipY on (Texture defaults it to true, and Material
      // doesn't override it), so canvas row 0 — our NORTH edge — lands at v=1. `st.y` is 0 at
      // north, hence the flip here. Skipping it mirrors the coast about the bbox's centre
      // latitude, which is subtle enough to look almost right and read as a blurry shoreline.
      source: `
        float gorgon_shoreDistance(vec2 st) {
          return (texture(image, vec2(st.x, 1.0 - st.y)).r * 2.0 - 1.0) * band;
        }`,
    },
    translucent,
  });
}

// --- shaders ------------------------------------------------------------------------------------

const TERRAIN_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in vec2 aux;          // x = elevation (m), y = normalised distance from the theater centre
in float batchId;
out vec3 v_normalEC;
out vec2 v_st;
out float v_height;
out float v_radial;
void main() {
  vec4 p = czm_computePosition();
  v_normalEC = czm_normal * normal;
  v_st = st;
  v_height = aux.x;
  v_radial = aux.y;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

/** `landRef`/`depthRef` are baked per theater — the ramp is normalised to the relief we loaded. */
function terrainFS(landRef: number, depthRef: number) {
  return `
in vec3 v_normalEC;
in vec2 v_st;
in float v_height;
in float v_radial;

vec3 gorgon_sea(float h) {
  float t = clamp(h / ${glslF(depthRef)}, 0.0, 1.0);
  return mix(${glslRGB(SHALLOW)}, ${glslRGB(DEEP)}, sqrt(t));
}
vec3 gorgon_land(float h) {
  float t = clamp(h / ${glslF(landRef)}, 0.0, 1.0);
  return t < 0.5
    ? mix(${glslRGB(LOW)}, ${glslRGB(MID)}, t / 0.5)
    : mix(${glslRGB(MID)}, ${glslRGB(HIGH)}, (t - 0.5) / 0.5);
}

void main() {
  float sd = gorgon_shoreDistance(v_st);
  // fwidth(sd) is how many metres of distance-field one pixel covers, so this stays a ~1px edge
  // whether the camera is at 400 m or 400 km.
  float aa = max(fwidth(sd), 1e-3) * 0.5;
  float land = smoothstep(-aa, aa, sd);
  vec3 col = mix(gorgon_sea(v_height), gorgon_land(v_height), land);

  vec3 n = normalize(v_normalEC);
  vec3 l = normalize(czm_lightDirectionEC);
  col *= 0.45 + 0.75 * max(dot(n, l), 0.0);

  // Dissolve the rim into the void instead of cutting it off.
  col *= 1.0 - smoothstep(${glslF(RIM_FADE_START)}, 1.0, v_radial);
  out_FragColor = vec4(col, 1.0);
}`;
}

const WATER_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec2 st;
in vec2 aux;
in float batchId;
out vec2 v_st;
out float v_radial;
void main() {
  vec4 p = czm_computePosition();
  v_st = st;
  v_radial = aux.y;
  gl_Position = czm_modelViewProjectionRelativeToEye * p;
}`;

const WATER_FS = `
in vec2 v_st;
in float v_radial;
void main() {
  float sd = gorgon_shoreDistance(v_st);
  float aa = max(fwidth(sd), 1e-3) * 0.5;
  float sea = 1.0 - smoothstep(-aa, aa, sd);
  float a = ${glslF(WATER_ALPHA)} * sea * (1.0 - smoothstep(${glslF(RIM_FADE_START)}, 1.0, v_radial));
  if (a < 0.004) discard;
  out_FragColor = vec4(${glslRGB(WATER_TINT)}, a);
}`;

// --- tile math ---------------------------------------------------------------------------------
const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Pick the zoom whose ground resolution matches the mesh spacing (and keeps bathymetry valid). */
function chooseZoom(lat: number, spanMeters: number, samples: number): number {
  const cos = Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  const z = Math.round(Math.log2((EARTH_CIRC * cos * samples) / (TILE_PX * spanMeters)));
  return Math.max(6, Math.min(BATHY_MAX_ZOOM, z));
}

export interface TheaterMapOptions {
  /** Grid samples per side. */
  samples?: number;
  /** Shoreline distance-field texels per side. Independent of (and finer than) the mesh. */
  shoreRes?: number;
  /** Vertical exaggeration. */
  exaggeration?: number;
}

export interface TheaterMap {
  /** Lit terrain + bathymetry. */
  primitive: Cesium.Primitive;
  /** Translucent sea surface, clipped to the coastline by the same distance field. */
  water: Cesium.Primitive;
  /** Sample the baked (already shore-snapped) grid — used to drape borders/grid lines. */
  heightAt(lon: number, lat: number): number;
  /**
   * Signed distance to the coastline in metres, positive on land, negative at sea.
   *
   * The same field the terrain and water shaders clip against, so navigation agrees with what is
   * drawn to the pixel. Shipping follows it: a boat holding a fixed negative value is holding a
   * fixed distance offshore, whatever shape the coast is.
   */
  shoreDistance(lon: number, lat: number): number;
  /** Frees the distance-field textures. The primitives are owned by the scene. */
  destroyMaterials(): void;
  bbox: [number, number, number, number];
  minHeight: number;
  maxHeight: number;
  zoom: number;
  tiles: number;
  vertices: number;
  triangles: number;
}

/** Fetch + stitch the terrarium tiles covering a bbox into one elevation grid. */
async function fetchElevation(bbox: [number, number, number, number], zoom: number) {
  const [w, s, e, n] = bbox;
  const xMin = Math.floor(lon2tileX(w, zoom));
  const xMax = Math.floor(lon2tileX(e, zoom));
  const yMin = Math.floor(lat2tileY(n, zoom));
  const yMax = Math.floor(lat2tileY(s, zoom));
  const cols = xMax - xMin + 1;
  const rows = yMax - yMin + 1;

  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE_PX;
  canvas.height = rows * TILE_PX;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  let loaded = 0;
  await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const cx = i % cols;
      const cy = (i / cols) | 0;
      try {
        const res = await fetch(`/tiles/terrarium/${zoom}/${xMin + cx}/${yMin + cy}.png`);
        if (!res.ok) return;
        const bmp = await createImageBitmap(await res.blob());
        ctx.drawImage(bmp, cx * TILE_PX, cy * TILE_PX);
        bmp.close();
        loaded++;
      } catch {
        /* missing tile -> stays 0 */
      }
    }),
  );
  if (!loaded) throw new Error('no elevation tiles loaded');

  const W = canvas.width;
  const H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H).data;
  const grid = new Float32Array(W * H);
  for (let p = 0, k = 0; p < grid.length; p++, k += 4) {
    grid[p] = img[k] * 256 + img[k + 1] + img[k + 2] / 256 - 32768;
  }

  const originX = xMin * TILE_PX;
  const originY = yMin * TILE_PX;
  const sample = (lon: number, lat: number) => {
    const gx = Math.max(0, Math.min(W - 1, lon2tileX(lon, zoom) * TILE_PX - originX));
    const gy = Math.max(0, Math.min(H - 1, lat2tileY(lat, zoom) * TILE_PX - originY));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(W - 1, x0 + 1);
    const y1 = Math.min(H - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = grid[y0 * W + x0];
    const b = grid[y0 * W + x1];
    const c = grid[y1 * W + x0];
    const d = grid[y1 * W + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  return { sample, tiles: loaded };
}

/** Bilinear lookup into an NxN grid laid out north-to-south, addressed in lon/lat. */
function samplerFor(grid: Float32Array, N: number, bbox: [number, number, number, number]) {
  return (lon: number, lat: number) => {
    const gx = Math.max(0, Math.min(N - 1, ((lon - bbox[0]) / (bbox[2] - bbox[0])) * (N - 1)));
    const gy = Math.max(0, Math.min(N - 1, ((bbox[3] - lat) / (bbox[3] - bbox[1])) * (N - 1)));
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(N - 1, x0 + 1);
    const y1 = Math.min(N - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const a = grid[y0 * N + x0];
    const b = grid[y0 * N + x1];
    const c = grid[y1 * N + x0];
    const d = grid[y1 * N + x1];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
}

export async function buildTheaterMap(
  center: { lon: number; lat: number },
  radiusM: number,
  landPolys: number[][][][],
  options: TheaterMapOptions = {},
): Promise<TheaterMap> {
  const N = options.samples ?? 1024;
  const shoreRes = options.shoreRes ?? 2048;
  const exag = options.exaggeration ?? 1;
  const span = radiusM * 2;

  const dLat = radiusM / 111_320;
  const dLon = dLat / Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));
  const bbox: [number, number, number, number] = [center.lon - dLon, center.lat - dLat, center.lon + dLon, center.lat + dLat];

  // The bbox is ~square in metres (dLon compensates for the meridian convergence), so one
  // metres-per-texel covers both axes.
  const shore = buildShoreField(landPolys, bbox, shoreRes, span / shoreRes);
  const shoreAt = samplerFor(shore.sdf, shoreRes, bbox);

  const zoom = chooseZoom(center.lat, span, N);
  const elev = await fetchElevation(bbox, zoom);

  // --- bake the grid: sample -> shore-snap -> record range.
  // The snap reads the same distance field the shader does, so the geometry's waterline and the
  // painted one can't disagree.
  const heights = new Float32Array(N * N);
  let minHeight = Infinity;
  let maxHeight = -Infinity;
  for (let j = 0; j < N; j++) {
    const lat = bbox[3] - (j / (N - 1)) * (bbox[3] - bbox[1]);
    for (let i = 0; i < N; i++) {
      const lon = bbox[0] + (i / (N - 1)) * (bbox[2] - bbox[0]);
      const raw = elev.sample(lon, lat);
      const h = shoreAt(lon, lat) > 0 ? Math.max(raw, LAND_LIFT_M) : Math.min(raw, WATER_FLOOR_M);
      heights[j * N + i] = h;
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
  }

  // --- vertices
  const rLat = radiusM / 111_320;
  const rLon = rLat / Math.max(0.15, Math.cos((center.lat * Math.PI) / 180));
  /** Normalised distance from the theater centre: 1.0 exactly on the 200-mi rim. */
  const radialAt = (lon: number, lat: number) => {
    const dx = (lon - center.lon) / rLon;
    const dy = (lat - center.lat) / rLat;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const positions = new Float64Array(N * N * 3);
  const sts = new Float32Array(N * N * 2);
  const aux = new Float32Array(N * N * 2);
  const carto: number[] = [];
  for (let j = 0; j < N; j++) {
    const lat = bbox[3] - (j / (N - 1)) * (bbox[3] - bbox[1]);
    for (let i = 0; i < N; i++) {
      const idx = j * N + i;
      const lon = bbox[0] + (i / (N - 1)) * (bbox[2] - bbox[0]);
      carto.push(lon, lat, heights[idx] * exag);
      sts[idx * 2] = i / (N - 1);
      sts[idx * 2 + 1] = j / (N - 1);
      aux[idx * 2] = heights[idx];
      aux[idx * 2 + 1] = radialAt(lon, lat);
    }
  }
  const cart = Cesium.Cartesian3.fromDegreesArrayHeights(carto);
  for (let i = 0; i < cart.length; i++) {
    positions[i * 3] = cart[i].x;
    positions[i * 3 + 1] = cart[i].y;
    positions[i * 3 + 2] = cart[i].z;
  }

  // --- indices, clipped to the circle so the theater reads as a disc
  const idx: number[] = [];
  const inside = (i: number, j: number) => aux[(j * N + i) * 2 + 1] <= 1;
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      if (!inside(i, j) || !inside(i + 1, j) || !inside(i, j + 1) || !inside(i + 1, j + 1)) continue;
      const a = j * N + i;
      const b = a + 1;
      const c = a + N;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  const geometry = new Cesium.Geometry({
    // Cesium's GeometryAttributes type marks normal/st/tangent as required; we only supply the
    // ones we have and let GeometryPipeline.computeNormal add the rest.
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
      aux: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: aux,
      }),
    } as unknown as Cesium.GeometryAttributes,
    indices: new Uint32Array(idx),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
  });
  Cesium.GeometryPipeline.computeNormal(geometry);

  const terrainMaterial = shoreMaterial(shore.canvas, false);
  const primitive = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({ geometry }),
    appearance: new Cesium.Appearance({
      material: terrainMaterial,
      vertexShaderSource: TERRAIN_VS,
      fragmentShaderSource: terrainFS(Math.max(1, maxHeight), Math.min(-1, minHeight)),
      translucent: false,
      closed: false,
      // The base Appearance does NOT default this (only its subclasses do). Leaving it undefined
      // makes getRenderState() throw and Cesium halts the whole render loop.
      // (getRenderState() clones this and sets depthMask itself.)
      renderState: {
        depthTest: { enabled: true },
        cull: { enabled: false }, // terrain is a sheet; don't cull either face
      },
    }),
    asynchronous: false,
  });

  const waterMaterial = shoreMaterial(shore.canvas, true);
  const water = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: buildWaterDisc(bbox, radialAt),
    }),
    appearance: new Cesium.Appearance({
      material: waterMaterial,
      vertexShaderSource: WATER_VS,
      fragmentShaderSource: WATER_FS,
      translucent: true,
      closed: false,
      renderState: {
        depthTest: { enabled: true },
        cull: { enabled: false },
      },
    }),
    asynchronous: false,
  });

  return {
    primitive,
    water,
    heightAt: samplerFor(heights, N, bbox),
    shoreDistance: shoreAt,
    destroyMaterials() {
      terrainMaterial.destroy();
      waterMaterial.destroy();
    },
    bbox,
    minHeight,
    maxHeight,
    zoom,
    tiles: elev.tiles,
    vertices: N * N,
    triangles: idx.length / 3,
  };
}

/**
 * Flat sea surface at h=0 over the theater disc. It only needs enough tessellation to follow the
 * ellipsoid's curve — the shoreline comes from the distance field in the fragment shader, not from
 * this geometry.
 */
const WATER_SAMPLES = 129;
function buildWaterDisc(
  bbox: [number, number, number, number],
  radialAt: (lon: number, lat: number) => number,
): Cesium.Geometry {
  const M = WATER_SAMPLES;
  const carto: number[] = [];
  const sts = new Float32Array(M * M * 2);
  const aux = new Float32Array(M * M * 2);
  for (let j = 0; j < M; j++) {
    const lat = bbox[3] - (j / (M - 1)) * (bbox[3] - bbox[1]);
    for (let i = 0; i < M; i++) {
      const lon = bbox[0] + (i / (M - 1)) * (bbox[2] - bbox[0]);
      const k = j * M + i;
      carto.push(lon, lat, 0);
      sts[k * 2] = i / (M - 1);
      sts[k * 2 + 1] = j / (M - 1);
      aux[k * 2] = 0;
      aux[k * 2 + 1] = radialAt(lon, lat);
    }
  }
  const cart = Cesium.Cartesian3.fromDegreesArrayHeights(carto);
  const positions = new Float64Array(M * M * 3);
  for (let i = 0; i < cart.length; i++) {
    positions[i * 3] = cart[i].x;
    positions[i * 3 + 1] = cart[i].y;
    positions[i * 3 + 2] = cart[i].z;
  }

  const idx: number[] = [];
  const inside = (i: number, j: number) => aux[(j * M + i) * 2 + 1] <= 1;
  for (let j = 0; j < M - 1; j++) {
    for (let i = 0; i < M - 1; i++) {
      if (!inside(i, j) || !inside(i + 1, j) || !inside(i, j + 1) || !inside(i + 1, j + 1)) continue;
      const a = j * M + i;
      const b = a + 1;
      const c = a + M;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }

  return new Cesium.Geometry({
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
      aux: new Cesium.GeometryAttribute({
        componentDatatype: Cesium.ComponentDatatype.FLOAT,
        componentsPerAttribute: 2,
        values: aux,
      }),
    } as unknown as Cesium.GeometryAttributes,
    indices: new Uint32Array(idx),
    primitiveType: Cesium.PrimitiveType.TRIANGLES,
    boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions)),
  });
}

/** Where the map starts dissolving, as a fraction of the theater radius. */
export { RIM_FADE_START };
