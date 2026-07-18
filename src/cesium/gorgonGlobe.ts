import * as Cesium from 'cesium';
import { mesh, feature } from 'topojson-client';
// Only the coarse set is loaded up front (0.7 MB). The 1:10m data is several MB and would block
// the main thread on startup — it's dynamically imported the first time a theater is entered.
import countries50m from 'world-atlas/countries-50m.json';
import { buildTheaterMap, RIM_FADE_START, type TheaterMap } from './theaterMap';
import { loadObelisks, createHeatField, buildObeliskPyramids, type ObeliskField } from './obelisks';
import { fetchRoads, buildRoadPrimitive, type RoadClass, type RoadGroup, type RoadNet } from './roads';
import { buildBuildings } from './buildings';
import { generateBuildings } from './procBuildings';
import { UnitField, KIND_LABEL, KIND_SPEED } from './units';
import { SensorField } from './sensors';

const RED = Cesium.Color.fromCssColorString('#E23A2E');
const STEEL = Cesium.Color.fromCssColorString('#8A9AA8');
const ASH = Cesium.Color.fromCssColorString('#7E858E');
const GUN = Cesium.Color.fromCssColorString('#2B313A');
const GRID = Cesium.Color.fromCssColorString('#6FA8B8'); // tactical grid line color
const GROUND_ORBIT = Cesium.Color.fromCssColorString('#0D1013'); // near-black globe

const THEATER_DIAMETER_MI = 200;
const THEATER_RADIUS_M = (THEATER_DIAMETER_MI / 2) * 1609.344; // 200-mi circle

const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
if (token) Cesium.Ion.defaultAccessToken = token;

/**
 * Phones get lighter terrain + a smaller render target so there's headroom for units.
 * Force either path with `?mobile=1` / `?mobile=0` (handy for testing the phone build on desktop).
 *
 * Detection is SCREEN-SIZE only. A `(pointer: coarse)` check used to be OR'd in, but touchscreen
 * laptops (and this preview pane) report coarse while being full desktops — so they silently got
 * the degraded phone build (sparse buildings, coarse roads). Size is the reliable "actual phone"
 * signal; the smaller dimension catches portrait and landscape.
 */
const forcedMobile = new URLSearchParams(window.location.search).get('mobile');
const IS_MOBILE =
  forcedMobile !== null ? forcedMobile === '1' : Math.min(window.innerWidth, window.innerHeight) < 640;

const viewer = new Cesium.Viewer('cesiumContainer', {
  baseLayer: false,
  baseLayerPicker: false,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  animation: false,
  timeline: false,
  fullscreenButton: false,
  infoBox: false,
  selectionIndicator: false,
});

const scene = viewer.scene;
const globe = scene.globe;
const camera = scene.camera;

// ---- GORGON dark tactical styling ----
globe.baseColor = GROUND_ORBIT;
globe.enableLighting = true;
globe.showGroundAtmosphere = true;
// Fixed studio light instead of the real sun, so a theater is never on the night side
// and terrain relief always reads.
scene.light = new Cesium.DirectionalLight({
  direction: Cesium.Cartesian3.normalize(new Cesium.Cartesian3(-0.5, -0.6, -0.62), new Cesium.Cartesian3()),
  intensity: 2.2,
});
scene.backgroundColor = Cesium.Color.fromCssColorString('#05070c');
if (scene.skyBox) scene.skyBox.show = false;
if (scene.sun) scene.sun.show = false;
if (scene.moon) scene.moon.show = false;
if (scene.skyAtmosphere) {
  scene.skyAtmosphere.brightnessShift = -0.5;
  scene.skyAtmosphere.hueShift = -0.02;
}
scene.fog.enabled = true;
scene.highDynamicRange = false;
if (IS_MOBILE) {
  // Retina phones render 3x the pixels for little visual gain — buy that back for units.
  viewer.resolutionScale = 0.75;
  globe.maximumScreenSpaceError = 3; // fewer terrain tiles in flight (default 2)
}

// ---- no streaming terrain, anywhere ----
// The globe is a plain ellipsoid: orbit is a clean selection view that never streams tiles.
// A theater is ONE static mesh built at a single fixed resolution (see theaterMap.ts).
viewer.terrainProvider = new Cesium.EllipsoidTerrainProvider();

/** Grid samples per side for the theater mesh — the whole map, loaded once. */
const THEATER_SAMPLES = IS_MOBILE ? 512 : 1024;
/** Shoreline distance-field texels per side. Finer than the mesh: it's what makes the coast crisp. */
const SHORE_RES = IS_MOBILE ? 1024 : 2048;

/**
 * Sutherland–Hodgman: clip a ring to an axis-aligned box. Exact for a rectangular (convex) clip,
 * which is all we need — a general boolean library chokes on planet-scale input.
 */
type Pt = number[];
function clipRing(ring: Pt[], w: number, s: number, e: number, n: number): Pt[] {
  const lerp = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const edge = (pts: Pt[], inside: (p: Pt) => boolean, cross: (a: Pt, b: Pt) => Pt): Pt[] => {
    const res: Pt[] = [];
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const curIn = inside(cur);
      const prevIn = inside(prev);
      if (curIn) {
        if (!prevIn) res.push(cross(prev, cur));
        res.push(cur);
      } else if (prevIn) {
        res.push(cross(prev, cur));
      }
    }
    return res;
  };
  let out: Pt[] = ring;
  out = edge(out, (p) => p[0] >= w, (a, b) => lerp(a, b, (w - a[0]) / (b[0] - a[0])));
  if (out.length < 3) return [];
  out = edge(out, (p) => p[0] <= e, (a, b) => lerp(a, b, (e - a[0]) / (b[0] - a[0])));
  if (out.length < 3) return [];
  out = edge(out, (p) => p[1] >= s, (a, b) => lerp(a, b, (s - a[1]) / (b[1] - a[1])));
  if (out.length < 3) return [];
  out = edge(out, (p) => p[1] <= n, (a, b) => lerp(a, b, (n - a[1]) / (b[1] - a[1])));
  return out.length < 3 ? [] : out;
}

/** Land clipped to the theater box — small enough to rasterise per terrain tile cheaply. */
function landInBox(landPolys: number[][][][], bbox: [number, number, number, number]): number[][][][] {
  const [w, s, e, n] = bbox;
  const out: number[][][][] = [];
  for (const poly of landPolys) {
    // cheap reject on the outer ring's bbox — skips ~everything on the planet
    let pw = Infinity;
    let pe = -Infinity;
    let ps = Infinity;
    let pn = -Infinity;
    for (const p of poly[0]) {
      if (p[0] < pw) pw = p[0];
      if (p[0] > pe) pe = p[0];
      if (p[1] < ps) ps = p[1];
      if (p[1] > pn) pn = p[1];
    }
    if (pe < w || pw > e || pn < s || ps > n) continue;

    const rings: number[][][] = [];
    for (const ring of poly) {
      const c = clipRing(ring as Pt[], w, s, e, n);
      if (c.length > 2) rings.push(c);
    }
    if (rings.length) out.push(rings);
  }
  return out;
}

function theaterBbox(lon: number, lat: number): [number, number, number, number] {
  const dLat = (THEATER_RADIUS_M * 1.25) / 111_320;
  const dLon = dLat / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

// ---- borders, sized to the view ----
// The entity system must stay free for thousands of units, and resolution should match distance:
//   orbit   : ONE batched PolylineCollection of 1:50m country lines at sea level. From 16,000 km
//             up, 1:10m detail and US state lines are invisible — pure cost. No states here.
//   theater : 1:10m countries + states, clipped to the 200-mi box and clamped so they hug relief.
type Line = number[][];
const meshLines = (topo: unknown, obj: unknown, filter?: (a: unknown, b: unknown) => boolean) =>
  (mesh(topo as never, obj as never, filter as never) as unknown as { coordinates: Line[] }).coordinates;

// orbit: coarse, cheap
const countryCoords50 = meshLines(countries50m, (countries50m as unknown as { objects: { countries: unknown } }).objects.countries);

/** 1:10m detail — fetched on first theater entry, then cached. */
interface Detail {
  countryLines: Line[];
  stateLines: Line[];
  /** Land polygons for the shoreline mask, derived from the country polygons (no extra download). */
  landPolys: number[][][][];
}
let detailPromise: Promise<Detail> | null = null;
function loadDetail(): Promise<Detail> {
  detailPromise ??= (async () => {
    const [c10, s10] = await Promise.all([
      import('world-atlas/countries-10m.json'),
      import('us-atlas/states-10m.json'),
    ]);
    const cTopo = c10.default as unknown as { objects: { countries: unknown } };
    const sTopo = s10.default as unknown as { objects: { states: unknown } };

    const fc = feature(cTopo as never, cTopo.objects.countries as never) as unknown as {
      features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[];
    };
    // Countries tile the land without overlapping, so an even-odd fill of every country polygon
    // is exactly the land union — and inner rings (lakes) still punch through.
    const landPolys: number[][][][] = [];
    for (const f of fc.features) {
      const g = f.geometry;
      if (g.type === 'Polygon') landPolys.push(g.coordinates as number[][][]);
      else if (g.type === 'MultiPolygon') landPolys.push(...(g.coordinates as number[][][][]));
    }

    return {
      countryLines: meshLines(cTopo, cTopo.objects.countries),
      stateLines: meshLines(sTopo, sTopo.objects.states, (a, b) => a !== b),
      landPolys,
    };
  })();
  return detailPromise;
}

// NOTE ON POLYLINE MATERIALS: every Polyline destroys its own material when its collection is
// destroyed, so a Material instance may not be shared between polylines that get torn down — the
// second _destroy() throws "This object was destroyed". Batching does not depend on sharing the
// instance anyway: PolylineCollection buckets by material.type and groups draw calls by the
// material's *uniform values*, so N identical Color materials still collapse to one bucket.
// This collection is built once and never removed, so one shared instance is safe here.
const matCountry = Cesium.Material.fromType('Color', { color: RED.withAlpha(0.9) });

const borderLines = scene.primitives.add(new Cesium.PolylineCollection());
function addBorderLine(line: Line, material: Cesium.Material, width: number) {
  const flat: number[] = [];
  for (const [lon, lat] of line) flat.push(lon, lat);
  if (flat.length < 4) return;
  borderLines.add({ positions: Cesium.Cartesian3.fromDegreesArray(flat), width, material });
}
for (const l of countryCoords50) addBorderLine(l, matCountry, 1.6);

/**
 * Split lines down to only the parts inside the theater disc, cut exactly at the boundary.
 *
 * Everything stops at RIM_FADE_START rather than at the rim itself: past that the terrain is
 * dissolving into black, and a border line that kept its full brightness out there would hang in
 * the void and give the disc a hard edge again — the opposite of what the fade is for.
 */
const LINE_CLIP_R = RIM_FADE_START;
function linesInDisc(all: Line[], lon0: number, lat0: number, rLon: number, rLat: number): Line[] {
  const q = (p: number[]) => Math.hypot((p[0] - lon0) / rLon, (p[1] - lat0) / rLat) / LINE_CLIP_R;
  /** Point where segment a->b crosses q=1, linearised on q (which is near-linear over a step). */
  const cross = (a: number[], b: number[], qa: number, qb: number) => {
    const t = Math.min(1, Math.max(0, (1 - qa) / (qb - qa)));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  const out: Line[] = [];
  for (const line of all) {
    let run: Line = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      const qp = q(p);
      if (qp <= 1) {
        // entering: start the run on the boundary, not at the first inside point
        if (run.length === 0 && i > 0) run.push(cross(line[i - 1], p, q(line[i - 1]), qp));
        run.push(p);
      } else {
        if (run.length) {
          run.push(cross(line[i - 1], p, q(line[i - 1]), qp));
          if (run.length > 1) out.push(run);
          run = [];
        }
      }
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

/**
 * Theater overlays (borders, state lines, grid) live in ONE batched PolylineCollection, draped by
 * sampling the theater mesh. Cesium's clampToGround needs the globe, and the globe is hidden in a
 * theater — sampling our own baked grid is both correct here and cheaper than ground primitives.
 */
let theaterLines: Cesium.PolylineCollection | undefined;

// Takes a colour, not a Material: this collection is destroyed on every theater exit, so each
// polyline needs its own instance to destroy (see the note on matCountry above).
function drapeLines(lines: Line[], map: TheaterMap, color: Cesium.Color, width: number, lift: number) {
  if (!theaterLines) return;
  for (const line of lines) {
    const pos: Cesium.Cartesian3[] = [];
    for (const [lon, lat] of line) {
      pos.push(Cesium.Cartesian3.fromDegrees(lon, lat, map.heightAt(lon, lat) + lift));
    }
    if (pos.length > 1) {
      theaterLines.add({ positions: pos, width, material: Cesium.Material.fromType('Color', { color }) });
    }
  }
}

function hideTheaterLines() {
  if (theaterLines) {
    scene.primitives.remove(theaterLines); // remove() destroys the collection
    theaterLines = undefined;
  }
}

// faint graticule for orbit orientation
const grat = scene.primitives.add(new Cesium.PolylineCollection());
const addGrat = (deg: number[]) =>
  grat.add({
    positions: Cesium.Cartesian3.fromDegreesArray(deg),
    width: 1,
    material: Cesium.Material.fromType('Color', { color: GUN.withAlpha(0.35) }),
  });
for (let lon = -180; lon < 180; lon += 30) {
  const s: number[] = [];
  for (let lat = -90; lat <= 90; lat += 3) s.push(lon, lat);
  addGrat(s);
}
for (let lat = -60; lat <= 60; lat += 30) {
  const s: number[] = [];
  for (let lon = -180; lon <= 180; lon += 3) s.push(lon, lat);
  addGrat(s);
}

// ---- 200-mile selection ring (globe mode) ----
const cursor = viewer.entities.add({
  position: Cesium.Cartesian3.fromDegrees(0, 0),
  show: false,
  ellipse: {
    semiMinorAxis: THEATER_RADIUS_M,
    semiMajorAxis: THEATER_RADIUS_M,
    material: RED.withAlpha(0.06),
    outline: true,
    outlineColor: RED,
    height: 0,
  },
});

function destDeg(lat: number, lon: number, dist: number, brg: number) {
  const R = 6_371_000;
  const dr = dist / R;
  const p1 = Cesium.Math.toRadians(lat);
  const l1 = Cesium.Math.toRadians(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(dr) + Math.cos(p1) * Math.sin(dr) * Math.cos(brg));
  const l2 = l1 + Math.atan2(Math.sin(brg) * Math.sin(dr) * Math.cos(p1), Math.cos(dr) - Math.sin(p1) * Math.sin(p2));
  return { lat: Cesium.Math.toDegrees(p2), lon: Cesium.Math.toDegrees(l2) };
}
// ---- tactical grid, draped over the theater mesh ----
const GRID_CELL_M = 10 * 1609.344; // 10-mile cells

/** Square grid in local metres around the theater centre, as lon/lat lines. */
function gridLines(lon0: number, lat0: number, radius: number, cell: number): Line[] {
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const toLon = (e: number) => lon0 + e / mPerLon;
  const toLat = (n: number) => lat0 + n / mPerLat;

  const out: Line[] = [];
  const n = Math.ceil(radius / cell);
  const step = radius / 48; // enough points to follow the relief
  for (let i = -n; i <= n; i++) {
    const off = i * cell;
    const vertical: Line = [];
    const horizontal: Line = [];
    for (let d = -radius; d <= radius; d += step) {
      vertical.push([toLon(off), toLat(d)]);
      horizontal.push([toLon(d), toLat(off)]);
    }
    out.push(vertical, horizontal);
  }
  return out;
}

// ---- roads ----
// Fetched once per theater from OpenFreeMap and draped on the baked mesh, same as the borders.
// z11 carries motorway/trunk/primary/secondary/tertiary for ~7.5 MB over a 200-mi box; z12 would
// add every residential street for ~14x the tiles, which at ~320 m/px is an unreadable smear.
const ROAD_ZOOM = IS_MOBILE ? 10 : 11;
/** Drawn faintest first, so motorways win at junctions. */
const ROAD_ORDER: RoadClass[] = ['tertiary', 'secondary', 'primary', 'trunk', 'motorway'];
// Neutral steel, so roads read as terrain texture and don't fight the red borders or orange
// obelisks. Widths are real metres — roughly carriageway + shoulders per class — and the shader
// holds them to a pixel floor when they'd otherwise vanish at theater scale.
const ROAD_MIN_HALF_PX = 0.6; // -> ~1.2 px minimum, so the network still reads zoomed out
const ROAD_STYLE: Record<RoadClass, { color: Cesium.Color; widthM: number }> = {
  motorway: { color: STEEL.withAlpha(0.95), widthM: 32 },
  trunk: { color: STEEL.withAlpha(0.75), widthM: 24 },
  primary: { color: ASH.withAlpha(0.68), widthM: 16 },
  secondary: { color: ASH.withAlpha(0.5), widthM: 11 },
  tertiary: { color: ASH.withAlpha(0.36), widthM: 8 },
};
let roadPrimitive: Cesium.Primitive | undefined;

function removeRoads() {
  if (roadPrimitive) {
    scene.primitives.remove(roadPrimitive);
    roadPrimitive = undefined;
  }
}

// ---- buildings ----
// Buildings are generated procedurally from road density (procBuildings.ts), not fetched. Generate
// out to the metro scale — density self-limits the countryside — and cap the total for framerate.
const BUILDING_GEN_RADIUS_M = IS_MOBILE ? 14_000 : 26_000;
const BUILDING_MAX = IS_MOBILE ? 35_000 : 120_000;
const BUILDING_MAX_HEIGHT_M = 230;
const BUILDING_SINK_M = 2;

// Buildings arrive as a stream of chunk primitives, so the city fills in progressively.
let buildingPrimitives: Cesium.Primitive[] = [];

function removeBuildings() {
  for (const p of buildingPrimitives) scene.primitives.remove(p);
  buildingPrimitives = [];
}

// ---- live units ----
// Land vehicles route on the real road graph, ships wander water, aircraft fly, foot units mill.
// Each kind is one GPU-instanced batch (one draw call) stepped every frame; states show as colour.
const UNIT_COUNTS = IS_MOBILE
  ? { land: 1400, sea: 60, air: 50, foot: 1400 }
  : { land: 4200, sea: 150, air: 120, foot: 3200 };

let unitField: UnitField | undefined;

function addUnits(center: { lon: number; lat: number }, map: TheaterMap, net: RoadNet | undefined) {
  removeUnits();
  const field = new UnitField(center, THEATER_RADIUS_M, map.heightAt, net, UNIT_COUNTS);
  for (const k of ['land', 'sea', 'air', 'foot'] as const) scene.primitives.add(field.batches[k]);
  unitField = field;
  updateUnitHud();
}

function removeUnits() {
  if (unitField) {
    for (const k of ['land', 'sea', 'air', 'foot'] as const) scene.primitives.remove(unitField.batches[k]);
    unitField = undefined;
  }
}

function updateUnitHud() {
  if (!unitField) {
    setText('g-units', '0');
    return;
  }
  const s = unitField.stateCounts();
  setText('g-units', `${unitField.count} · ${s.normal}N ${s.protected}P ${s.infected}I`);
}

// Step the sim every frame. preUpdate fires before the scene renders, so positions written here
// are what gets drawn this frame. Real wall-clock dt (the Cesium clock is frozen for the studio
// light), clamped inside tick() so a backgrounded tab doesn't teleport everyone.
let lastTickMs = performance.now();
scene.preUpdate.addEventListener(() => {
  const now = performance.now();
  const dt = (now - lastTickMs) / 1000;
  lastTickMs = now;
  if (unitField) {
    unitField.tick(dt);
    if (sensorField) {
      const inf = unitField.infectedPositions();
      sensorField.updateThreat(inf.buf, inf.count); // lights up obelisks that see an infected
    }
    unitField.render(sensorField); // out-of-range units drawn faint
    updateUnitPanel(); // keep the selection panel + reticle tracking the live unit
  }
});

// ---- obelisks ----
// One dataset, two renderings: additive orange splats in orbit (they sum into a heatmap where
// sites crowd), real geometry in a theater. Loaded once, in the background — the globe is usable
// before it lands, so nothing here blocks startup.
const HEAT_POINT_PX = IS_MOBILE ? 5 : 7;
// The two dials for the orbit heat. HEAT_DOT is how bright a lone obelisk reads; HEAT_INTENSITY is
// how fast crowding ramps orange -> yellow -> white. Measured at 0.12: white stays a ~4% core of
// the densest metros instead of the ~17% blowout a single-lobe splat gave.
const HEAT_INTENSITY = 0.12;
const HEAT_DOT = 0.55;

/** Apex flares: a 150 m obelisk is ~1 px tall at the theater's opening altitude. */
const FLARE_PX = IS_MOBILE ? 4 : 5;
const FLARE_INTENSITY = 0.5;

let obelisks: ObeliskField | undefined;
let heatField: Cesium.Primitive | undefined;
let obeliskPyramids: Cesium.Primitive | undefined;
let obeliskFlare: Cesium.Primitive | undefined;

void loadObelisks()
  .then((field) => {
    obelisks = field;
    const heat = createHeatField(field, HEAT_POINT_PX, HEAT_INTENSITY, HEAT_DOT);
    heat.show = mode === 'globe';
    scene.primitives.add(heat);
    heatField = heat;
    setText('g-obelisks', String(field.count));
    // A theater entered before the data landed still wants its obelisks.
    if (mode === 'theater' && theaterMap && theaterCenter) {
      addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
    }
  })
  .catch((e) => {
    console.warn('[GORGON] obelisks failed to load:', e);
    setText('g-obelisks', 'ERR');
  });

// Each obelisk watches a disc of this radius. Dense in cities, so metro units read as "seen" and
// units out in the country render faint. Tunable.
const SENSOR_RANGE_M = 750;
let sensorField: SensorField | undefined;

function addObeliskPyramids(lon: number, lat: number, map: TheaterMap) {
  if (!obelisks) return;
  removeObeliskPyramids();
  const built = buildObeliskPyramids(
    obelisks,
    { lon, lat },
    THEATER_RADIUS_M,
    map.heightAt,
    RIM_FADE_START,
    FLARE_PX,
    FLARE_INTENSITY,
  );
  if (!built) {
    setText('g-obelisks', '0 IN THEATER');
    return;
  }
  obeliskPyramids = scene.primitives.add(built.primitive);
  obeliskFlare = scene.primitives.add(built.flare);
  setText('g-obelisks', `${built.count} IN THEATER`);

  // Sensor network: range rings + coverage/threat grids driving unit opacity and the red alert glow.
  sensorField = new SensorField(built.lonLat, built.apex, SENSOR_RANGE_M, map.bbox, map.heightAt);
  if (sensorField.rings) scene.primitives.add(sensorField.rings);
  scene.primitives.add(sensorField.glow);
}

function removeObeliskPyramids() {
  if (obeliskPyramids) {
    scene.primitives.remove(obeliskPyramids);
    obeliskPyramids = undefined;
  }
  if (obeliskFlare) {
    scene.primitives.remove(obeliskFlare);
    obeliskFlare = undefined;
  }
  if (sensorField) {
    if (sensorField.rings) scene.primitives.remove(sensorField.rings);
    scene.primitives.remove(sensorField.glow); // remove() destroys the collection
    sensorField = undefined;
  }
}

// ---- rim bokeh (theater mode) ----
/**
 * Defocuses the theater towards its edge, so the map sits in a pool of focus and everything
 * outside it is just black.
 *
 * This can't be Cesium's depth-of-field stage: that focuses on a plane at a fixed distance, and we
 * want blur by *ground distance from the theater centre*, which is a different axis entirely (the
 * near rim and the far rim are at very different depths but should blur the same). So the stage
 * reconstructs each fragment's world position from the depth buffer and blurs on radius.
 *
 * Sky fragments read as infinitely far, so they blur too — which is what makes the terrain bleed
 * outwards into the void instead of stopping at a cut line.
 */
const BOKEH_TAPS = 16;
const BOKEH_MAX_PX = IS_MOBILE ? 6 : 11;
const bokehShader = `
uniform sampler2D colorTexture;
uniform sampler2D depthTexture;
uniform vec3 u_center;
uniform float u_r0;
uniform float u_r1;
uniform float u_maxBlurPx;
uniform float u_logDepth;
in vec2 v_textureCoordinates;

/**
 * Eye-space position of whatever the depth buffer holds at this fragment.
 *
 * Cesium only unpacks logarithmic depth inside czm_readDepth / czm_windowToEyeCoordinates when
 * LOG_DEPTH is #defined, and it does NOT define it for custom post-process stages — so those
 * helpers hand back the raw log-Z as if it were an NDC depth and every fragment reconstructs to
 * roughly the far plane. Linearising the log-Z first and using the ordinary path doesn't work
 * either: at theatre range the linear NDC depth is ~0.99999, which is only a couple of
 * significant digits once it's in a float32. So do what Cesium's own LOG_DEPTH branch does and
 * carry distance-from-camera through in w, where the precision survives.
 *
 * (czm_screenToEyeCoordinates isn't a registered builtin name, but it ships in the same source
 * as czm_windowToEyeCoordinates — which the fallback below references, pulling both in.)
 */
vec4 gorgonEyeCoordinates(vec2 fragXY, float rawDepth) {
  if (u_logDepth < 0.5) {
    return czm_windowToEyeCoordinates(fragXY, rawDepth);
  }
  float near = czm_currentFrustum.x;
  float far = czm_currentFrustum.y;
  float depthFromCamera = exp2(rawDepth * czm_log2FarDepthFromNearPlusOne) - 1.0 + near;
  vec2 screenXY = (fragXY - czm_viewport.xy) / czm_viewport.zw;
  float ndcZ = far * (1.0 - near / depthFromCamera) / (far - near);
  vec4 eye = czm_screenToEyeCoordinates(vec4(screenXY, ndcZ, 1.0));
  eye.w = 1.0 / depthFromCamera;
  return eye;
}

void main() {
  float rawDepth = texture(depthTexture, v_textureCoordinates).r;
  vec4 eye = gorgonEyeCoordinates(gl_FragCoord.xy, rawDepth);
  vec3 world = (czm_inverseView * vec4(eye.xyz / eye.w, 1.0)).xyz;

  float t = smoothstep(u_r0, u_r1, distance(world, u_center));
  if (t <= 0.0) {
    out_FragColor = texture(colorTexture, v_textureCoordinates);
    return;
  }

  // Uniform disc of taps on a golden-angle spiral — a flat kernel, not a gaussian, which is what
  // gives defocus its round-highlight character.
  vec2 texel = 1.0 / czm_viewport.zw;
  float radius = t * u_maxBlurPx;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ${BOKEH_TAPS}; i++) {
    float fi = float(i) + 0.5;
    float a = fi * 2.39996323;
    vec2 off = vec2(cos(a), sin(a)) * sqrt(fi / ${BOKEH_TAPS}.0) * radius * texel;
    sum += texture(colorTexture, v_textureCoordinates + off).rgb;
  }
  out_FragColor = vec4(sum / ${BOKEH_TAPS}.0, 1.0);
}`;

let bokehStage: Cesium.PostProcessStage | undefined;
function showBokeh(lon: number, lat: number) {
  hideBokeh();
  // add() is typed as returning the stage union; it hands back exactly what we passed in.
  bokehStage = scene.postProcessStages.add(
    new Cesium.PostProcessStage({
      fragmentShader: bokehShader,
      uniforms: {
        u_center: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        // Blur starts well inside the fade so the dissolve is already soft when it begins.
        u_r0: THEATER_RADIUS_M * 0.78,
        u_r1: THEATER_RADIUS_M * 1.0,
        u_maxBlurPx: BOKEH_MAX_PX,
        u_logDepth: scene.logarithmicDepthBuffer ? 1 : 0,
      },
    }),
  ) as Cesium.PostProcessStage;
}
function hideBokeh() {
  if (bokehStage) {
    scene.postProcessStages.remove(bokehStage); // remove() destroys the stage
    bokehStage = undefined;
  }
}

// ---- unit layer ----
// PointPrimitiveCollection batches every unit into ~one draw call. Entities do NOT scale to
// thousands (per-entity updater each frame), so units live here, not in viewer.entities.
const units = scene.primitives.add(new Cesium.PointPrimitiveCollection());
const UNIT_COLORS = {
  land: Cesium.Color.fromCssColorString('#E23A2E'),
  sea: Cesium.Color.fromCssColorString('#6FA8B8'),
  air: Cesium.Color.fromCssColorString('#ECEEF1'),
};

/** Stress test: scatter n dummy land/sea/air units across the theater to measure headroom. */
function spawnUnits(n: number): number {
  units.removeAll();
  const c = theaterCenter;
  if (!c) return 0;
  const kinds = ['land', 'sea', 'air'] as const;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % 3];
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * THEATER_RADIUS_M;
    const p = destDeg(c.lat, c.lon, r, a);
    const alt = kind === 'air' ? 2000 + Math.random() * 9000 : 0;
    units.add({
      position: Cesium.Cartesian3.fromDegrees(p.lon, p.lat, alt),
      color: UNIT_COLORS[kind],
      pixelSize: kind === 'air' ? 5 : 6,
      outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
      outlineWidth: 1,
      // air units stay visible; ground units get hidden by terrain they're behind
      disableDepthTestDistance: kind === 'air' ? Number.POSITIVE_INFINITY : 0,
    });
  }
  setText('g-units', String(n));
  return n;
}
function clearUnits() {
  units.removeAll();
  setText('g-units', '0');
}

// ---- single-unit selection (theater, LMB click) ----
// Click a unit to select it; a panel + a tracking reticle show its live status. The instanced
// units aren't in Cesium's pick pipeline (custom DrawCommand), so UnitField.pick projects each
// unit's cached world position to the screen and takes the nearest within a pixel radius.
const SELECT_PX = 26;
const panelEl = el('unit-panel');
const reticleEl = el('unit-reticle');
const reticleWin = new Cesium.Cartesian2();

const STATE_LABEL: Record<string, string> = { normal: 'NORMAL', protected: 'PROTECTED', infected: 'INFECTED' };
const STATE_HEX: Record<string, string> = { normal: '#EDEFF2', protected: '#F2C13B', infected: '#E23A2E' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function hideUnitPanel() {
  if (panelEl) (panelEl as HTMLElement).hidden = true;
  if (reticleEl) (reticleEl as HTMLElement).hidden = true;
}

/** Refresh the panel text + reticle position from the current selection. Called each frame. */
function updateUnitPanel() {
  if (!unitField) return hideUnitPanel();
  const sel = unitField.selected();
  if (!sel) return hideUnitPanel();

  if (panelEl) {
    (panelEl as HTMLElement).hidden = false;
    setText('up-id', sel.id);
    setText('up-type', KIND_LABEL[sel.kind]);
    const stEl = el('up-status');
    if (stEl) {
      stEl.textContent = STATE_LABEL[sel.state];
      stEl.className = `v state-${sel.state}`;
    }
    const dot = el('up-dot');
    if (dot) (dot as HTMLElement).style.color = STATE_HEX[sel.state];
    setText(
      'up-pos',
      `${Math.abs(sel.lat).toFixed(3)}°${sel.lat >= 0 ? 'N' : 'S'} ${Math.abs(sel.lon).toFixed(3)}°${sel.lon >= 0 ? 'E' : 'W'}`,
    );
    let deg = (Cesium.Math.toDegrees(sel.heading) + 360) % 360;
    const dir = COMPASS[Math.round(deg / 45) % 8];
    setText('up-hdg', `${Math.round(deg)}° ${dir} · ${KIND_SPEED[sel.kind]} M/S`);
    const seen = !sensorField || sensorField.isCovered(sel.lon, sel.lat);
    const senEl = el('up-sensor');
    if (senEl) {
      senEl.textContent = seen ? 'TRACKED' : 'OUT OF RANGE';
      senEl.className = `v ${seen ? 'sensor-tracked' : 'sensor-dark'}`;
    }
  }

  if (reticleEl) {
    const w = unitField.selectedScreen(scene, reticleWin);
    if (w) {
      (reticleEl as HTMLElement).hidden = false;
      (reticleEl as HTMLElement).style.left = `${w.x}px`;
      (reticleEl as HTMLElement).style.top = `${w.y}px`;
    } else {
      (reticleEl as HTMLElement).hidden = true;
    }
  }
}

// ---- camera controls: globe orbit vs C2 theater ----
const ctrl = scene.screenSpaceCameraController;
const defaults = {
  rotate: ctrl.rotateEventTypes,
  tilt: ctrl.tiltEventTypes,
  translate: ctrl.translateEventTypes,
  look: ctrl.lookEventTypes,
  zoom: ctrl.zoomEventTypes,
  minZoom: ctrl.minimumZoomDistance,
  maxZoom: ctrl.maximumZoomDistance,
};

/**
 * C2 camera scheme.
 * NOTE on Cesium semantics: in 3D, `translateEventTypes` is a no-op (it's a 2D/Columbus concept).
 * Panning across the surface IS `rotate` (it swings the camera over the globe), and `tilt` orbits
 * the point under the cursor — horizontal drag rotates heading, vertical drag pitches. So:
 *   MMB drag  -> rotate  = pan across the theater
 *   RMB drag  -> tilt    = rotate + tilt about the surface point
 *   wheel     -> zoom    (RIGHT_DRAG must be removed from zoom or it fights tilt)
 *   LMB       -> nothing = free for marquee select
 * Touch has no RMB/MMB, so phones keep one-finger pan + pinch zoom.
 */
function applyC2Controls() {
  ctrl.enableRotate = true;
  ctrl.enableTilt = true;
  ctrl.enableZoom = true;
  ctrl.enableTranslate = false;
  ctrl.enableLook = false;
  ctrl.lookEventTypes = [];
  ctrl.translateEventTypes = [];

  if (IS_MOBILE) {
    ctrl.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG]; // one finger pans
    ctrl.tiltEventTypes = [];
    ctrl.zoomEventTypes = [Cesium.CameraEventType.PINCH, Cesium.CameraEventType.WHEEL];
  } else {
    ctrl.rotateEventTypes = [Cesium.CameraEventType.MIDDLE_DRAG];
    ctrl.tiltEventTypes = [Cesium.CameraEventType.RIGHT_DRAG];
    ctrl.zoomEventTypes = [Cesium.CameraEventType.WHEEL];
  }
  ctrl.minimumZoomDistance = 400;
  ctrl.maximumZoomDistance = 700_000; // stay within theater scale
}
function restoreGlobeControls() {
  ctrl.enableRotate = true;
  ctrl.enableTilt = true;
  ctrl.enableZoom = true;
  ctrl.enableTranslate = true;
  ctrl.enableLook = true;
  ctrl.rotateEventTypes = defaults.rotate;
  ctrl.tiltEventTypes = defaults.tilt;
  ctrl.translateEventTypes = defaults.translate;
  ctrl.lookEventTypes = defaults.look;
  ctrl.zoomEventTypes = defaults.zoom;
  ctrl.minimumZoomDistance = defaults.minZoom;
  ctrl.maximumZoomDistance = defaults.maxZoom;
}

// ---- mode + chrome ----
type Mode = 'globe' | 'theater';
let mode: Mode = 'globe';
let theaterCenter: { lon: number; lat: number } | null = null;

// Function declarations (not const arrows): these are called during module evaluation by the
// terrain block above, which would hit the temporal dead zone with `const`.
function el(id: string) {
  return document.getElementById(id);
}
function setText(id: string, t: string) {
  const e = el(id);
  if (e) e.textContent = t;
}
function updateChrome() {
  setText('g-mode', mode === 'globe' ? 'ORBITAL · SELECT THEATER' : 'THEATER · C2 ACTIVE');
  const title = el('g-title');
  if (title) title.style.display = mode === 'globe' ? '' : 'none';
  const exit = el('g-exit');
  if (exit) (exit as HTMLButtonElement).hidden = mode !== 'theater';
  el('globe-ui')?.classList.toggle('in-theater', mode === 'theater');
}

let theaterMap: TheaterMap | undefined;
/** Bumped on every enter/exit so a slow build can tell it's been superseded. */
let theaterToken = 0;

/**
 * A theater is the map and nothing else: no sky glow, no fog, no horizon — the disc floats in
 * blackness. Orbit wants all of that back, so both directions are explicit.
 */
function setVoid(on: boolean) {
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = !on;
  scene.fog.enabled = !on;
  scene.backgroundColor = on ? Cesium.Color.BLACK : Cesium.Color.fromCssColorString('#05070c');
}

function enterTheater(carto: Cesium.Cartographic) {
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  mode = 'theater';
  theaterCenter = { lon, lat };
  cursor.show = false;
  borderLines.show = false;
  grat.show = false;
  if (heatField) heatField.show = false; // the theater draws real obelisks instead
  setVoid(true);
  updateChrome();
  // Apply immediately, NOT on flyTo completion: a flight that's interrupted (user grabs the
  // camera mid-flight) would otherwise never hand over the C2 scheme.
  applyC2Controls();
  // Arrive framed on the city, not at theater-overview height: buildings are real-scale, so at the
  // old 95 km they were sub-pixel and you saw a road network with no buildings. flyToBoundingSphere
  // aims the camera AT the centre (robust to terrain height) at an oblique range that reads as a
  // skyline — the shot a portfolio piece wants. Zoom out for the theater overview.
  camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, 0), 3500), {
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-38), 7500),
    duration: 3.0,
  });
  void buildTheater(lon, lat, ++theaterToken);
}

/** Fetch once, build one mesh, drape the overlays on it. Nothing streams after this. */
async function buildTheater(lon: number, lat: number, tok: number) {
  setText('g-terrain', 'LOADING MAP…');
  try {
    const detail = await loadDetail();
    if (tok !== theaterToken) return;

    const bbox = theaterBbox(lon, lat);
    const land = landInBox(detail.landPolys, bbox);
    // Roads and terrain are independent fetches — overlap them rather than paying for both in
    // series. A road failure must not cost the theater, hence the catch.
    const roadsPromise = fetchRoads(bbox, ROAD_ZOOM).catch((e) => {
      console.warn('[GORGON] roads failed to load:', e);
      return undefined;
    });
    const map = await buildTheaterMap({ lon, lat }, THEATER_RADIUS_M, land, {
      samples: THEATER_SAMPLES,
      shoreRes: SHORE_RES,
    });
    if (tok !== theaterToken) return;

    // The static mesh replaces the globe entirely inside a theater.
    globe.show = false;
    theaterMap = map;
    scene.primitives.add(map.primitive);
    scene.primitives.add(map.water);
    addObeliskPyramids(lon, lat, map);
    showBokeh(lon, lat);

    // Overlays draped by sampling the mesh we just baked.
    theaterLines = scene.primitives.add(new Cesium.PolylineCollection());
    const rLat = THEATER_RADIUS_M / 111_320;
    const rLon = rLat / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const lift = 40; // metres, so lines sit above the surface instead of z-fighting
    const grid = linesInDisc(gridLines(lon, lat, THEATER_RADIUS_M, GRID_CELL_M), lon, lat, rLon, rLat);
    drapeLines(grid, map, GRID.withAlpha(0.4), 1, lift);

    drapeLines(linesInDisc(detail.stateLines, lon, lat, rLon, rLat), map, STEEL.withAlpha(0.75), 1, lift);
    drapeLines(linesInDisc(detail.countryLines, lon, lat, rLon, rLat), map, RED, 2, lift);

    // Roads sit closest to the ground; the grid and borders stack above them. They live in their
    // own merged primitive rather than the PolylineCollection above — there are ~30k of them, and
    // that collection charges per line, per frame.
    const net = await roadsPromise;
    if (tok !== theaterToken) return;
    if (net) {
      const groups: RoadGroup[] = [];
      const byClass = new Map<RoadClass, Line[]>();
      for (const r of net.roads) {
        let list = byClass.get(r.cls);
        if (!list) byClass.set(r.cls, (list = []));
        list.push(r.coords);
      }
      for (const cls of ROAD_ORDER) {
        const lines = byClass.get(cls);
        if (!lines) continue;
        const style = ROAD_STYLE[cls];
        groups.push({ lines: linesInDisc(lines, lon, lat, rLon, rLat), color: style.color, widthM: style.widthM });
      }
      const bounds = new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        THEATER_RADIUS_M * 1.1 + 10_000,
      );
      const built = buildRoadPrimitive(groups, map.heightAt, 12, bounds, ROAD_MIN_HALF_PX);
      if (built) {
        roadPrimitive = scene.primitives.add(built.primitive);
        setText('g-roads', `${built.segments} SEG · z${net.zoom} · ${net.tiles} TILES`);
      } else {
        setText('g-roads', '0 IN THEATER');
      }
    } else {
      setText('g-roads', 'UNAVAILABLE');
    }

    // Units need the baked terrain (to ride on) and the road graph (to route on) — both ready now.
    // Spawn them before the building extrude so they're live immediately; buildings fill in after.
    addUnits({ lon, lat }, map, net);

    setText(
      'g-terrain',
      `STATIC z${map.zoom} · ${map.tiles} TILES · ${(map.triangles / 1000).toFixed(0)}k TRI`,
    );

    // Buildings are generated PROCEDURALLY from the road density (see procBuildings.ts), not fetched
    // — real footprints were too sparse. Dense where roads converge, clear of the roadway, towers
    // downtown. The extrude then streams in as chunk primitives so the skyline fills in as you arrive.
    if (net) {
      const bset = generateBuildings(net, { lon, lat }, map.heightAt, {
        radiusM: BUILDING_GEN_RADIUS_M,
        maxBuildings: BUILDING_MAX,
        maxHeight: BUILDING_MAX_HEIGHT_M,
      });
      const bbounds = new Cesium.BoundingSphere(
        Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        BUILDING_GEN_RADIUS_M * 1.4 + 1000,
      );
      await buildBuildings(bset, map.heightAt, bbounds, BUILDING_SINK_M, () => tok !== theaterToken, (prim) => {
        if (tok === theaterToken) buildingPrimitives.push(scene.primitives.add(prim));
        else prim.destroy();
      });
    }
  } catch (e) {
    console.warn('[GORGON] theater map build failed:', e);
    setText('g-terrain', 'MAP BUILD FAILED');
  }
}

function exitTheater() {
  if (mode !== 'theater') return;
  mode = 'globe';
  theaterToken++;
  restoreGlobeControls();
  globe.show = true;
  setVoid(false);
  if (theaterMap) {
    scene.primitives.remove(theaterMap.primitive);
    scene.primitives.remove(theaterMap.water);
    // remove() destroys the primitives but not the materials we handed their appearances —
    // without this the shoreline textures leak on every theater exit.
    theaterMap.destroyMaterials();
    theaterMap = undefined;
  }
  hideTheaterLines();
  hideBokeh();
  removeObeliskPyramids();
  removeRoads();
  removeBuildings();
  removeUnits();
  hideUnitPanel();
  borderLines.show = true;
  grat.show = true;
  if (heatField) heatField.show = true;
  setText('g-obelisks', obelisks ? String(obelisks.count) : '—');
  clearUnits();
  setText('g-terrain', 'ORBIT · ELLIPSOID');
  setText('g-roads', '—');
  setText('g-buildings', '—');
  updateChrome();
  const c = theaterCenter ?? { lon: -30, lat: 25 };
  camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, 14_000_000), duration: 2.6 });
}

// ---- interaction ----
const latEl = el('g-lat');
const lonEl = el('g-lon');
const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
const pickLonLat = (p: Cesium.Cartesian2) => {
  const c = camera.pickEllipsoid(p, globe.ellipsoid);
  return c ? Cesium.Cartographic.fromCartesian(c) : undefined;
};
const fmt = (rad: number, pos: string, neg: string) => {
  const d = Cesium.Math.toDegrees(rad);
  return `${Math.abs(d).toFixed(3)}° ${d >= 0 ? pos : neg}`;
};

handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
  if (mode !== 'globe') return; // cursor readout is orbit-only
  const carto = pickLonLat(m.endPosition);
  if (carto) {
    cursor.position = new Cesium.ConstantPositionProperty(Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude));
    cursor.show = true;
    if (latEl) latEl.textContent = fmt(carto.latitude, 'N', 'S');
    if (lonEl) lonEl.textContent = fmt(carto.longitude, 'E', 'W');
  } else {
    cursor.show = false;
    if (latEl) latEl.textContent = '—';
    if (lonEl) lonEl.textContent = '—';
  }
}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

// LMB click: pick a theater in orbit, pick a single unit in a theater.
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (mode === 'globe') {
    const carto = pickLonLat(m.position);
    if (carto) enterTheater(carto);
    return;
  }
  if (unitField && unitField.pick(scene, m.position.x, m.position.y, SELECT_PX)) {
    updateUnitPanel();
  } else {
    unitField?.deselect();
    hideUnitPanel();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

el('g-exit')?.addEventListener('click', exitTheater);
el('up-close')?.addEventListener('click', () => {
  unitField?.deselect();
  hideUnitPanel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitTheater();
  // I cycles the infection: spread it to more units so the red state is easy to watch, then reset.
  if ((e.key === 'i' || e.key === 'I') && mode === 'theater' && unitField) {
    unitField.cycleInfection();
    updateUnitHud();
  }
});

// On-screen FPS — I can't measure framerate from my side, so surface it for real devices.
scene.debugShowFramesPerSecond = true;

// ---- start from space ----
camera.setView({ destination: Cesium.Cartesian3.fromDegrees(0, 20, 24_000_000) });
camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-40, 30, 16_000_000), duration: 2.6 });
updateChrome();

if (!token) {
  console.info('[GORGON] No Cesium Ion token — stylized globe only. Add VITE_CESIUM_ION_TOKEN to .env for terrain.');
}

// Dev-only inspection hook (stripped from production builds).
if (import.meta.env.DEV) {
  (window as unknown as { __gorgon: unknown }).__gorgon = {
    Cesium,
    viewer,
    enterTheater,
    exitTheater,
    spawnUnits,
    clearUnits,
    get unitField() {
      return unitField;
    },
    get obelisks() {
      return obelisks;
    },
    get units() {
      return units.length;
    },
    get mode() {
      return mode;
    },
  };
}
