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
import {
  UnitField,
  KIND_LABEL,
  KIND_SPEED,
  PLATFORM_SENSOR,
  ORDER_DELAY,
  INFECTED_FLEE,
  CONTAGION,
} from './units';
import { UNIT_KINDS, type UnitKind } from './unitModels';
import { SensorField } from './sensors';
import { progression, ASSETS } from '../game/progression';
import { PLATFORMS, GEAR, PLATFORM_BY_ID, type PlatformId } from '../game/platforms';
import { surveyTerritory, type Territory } from '../game/territory';
import { missions, MISSIONS } from '../game/missions';
import { assessBand, BAND_LABEL, readRecord } from '../game/intel';
import { Store } from '../ui/store';
import { MissionPanel } from '../ui/missions';
import { LaserBeams } from './lasers';

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
const BUILDING_SINK_M = 2;

// Live dev-tunable settings, adjustable from the header ⚙ panel. Defaults reproduce the shipped look.
const devSettings = {
  buildingPopulation: 0.65, // scales attempted building density (0.25–2)
  roadGap: 19, // metres buildings sit off the road edge
  maxHeight: 270, // tallest tower, metres
  strictRoadClearance: true, // also keep footprints out of crossing streets at intersections
};

// Buildings arrive as a stream of chunk primitives, so the city fills in progressively.
let buildingPrimitives: Cesium.Primitive[] = [];
let lastBuildingCount = 0; // footprints from the most recent generation (dev-panel readout/tests)
// Bumped on every (re)generation so a stream in flight can tell it's been superseded (e.g. the user
// nudged a dev slider mid-build, or exited the theater).
let buildingsToken = 0;

function removeBuildings() {
  for (const p of buildingPrimitives) scene.primitives.remove(p);
  buildingPrimitives = [];
}

/**
 * Generate + stream the procedural skyline for the current theater using the live {@link devSettings}.
 * Shared by the initial theater build and the dev-panel "regenerate". Reuses the already-fetched road
 * graph (no refetch). Aborts cleanly if the theater changes or a newer generation starts.
 */
async function streamBuildings(
  lon: number,
  lat: number,
  map: TheaterMap,
  net: RoadNet,
  tok: number,
) {
  const bTok = ++buildingsToken;
  removeBuildings();
  const bset = generateBuildings(net, { lon, lat }, map.heightAt, {
    radiusM: BUILDING_GEN_RADIUS_M,
    maxBuildings: BUILDING_MAX,
    maxHeight: devSettings.maxHeight,
    roadGap: devSettings.roadGap,
    populationScale: devSettings.buildingPopulation,
    strictRoadClearance: devSettings.strictRoadClearance,
  });
  lastBuildingCount = bset.polys.length;
  setText('g-buildings', String(bset.polys.length));
  const bbounds = new Cesium.BoundingSphere(
    Cesium.Cartesian3.fromDegrees(lon, lat, 0),
    BUILDING_GEN_RADIUS_M * 1.4 + 1000,
  );
  const stale = () => tok !== theaterToken || bTok !== buildingsToken;
  await buildBuildings(bset, map.heightAt, bbounds, BUILDING_SINK_M, stale, (prim) => {
    if (!stale()) buildingPrimitives.push(scene.primitives.add(prim));
    else prim.destroy();
  });
}

/** Rebuild the skyline in-place with the current dev settings. No-op outside a live theater. */
function regenerateBuildings() {
  if (mode !== 'theater' || !theaterMap || !theaterNet || !theaterCenter) return;
  void streamBuildings(theaterCenter.lon, theaterCenter.lat, theaterMap, theaterNet, theaterToken);
}

// ---- live units ----
// Land vehicles route on the real road graph, ships wander water, aircraft fly, foot units mill.
// Each kind is one GPU-instanced batch (one draw call) stepped every frame; states show as colour.
// Platforms are purchases, not givens — a fresh campaign fields none of them, so the theater opens
// with the obelisk net as its only sensor.
const UNIT_COUNTS = IS_MOBILE
  ? { land: 4200, sea: 160, air: 140, foot: 4200 }
  : { land: 13_000, sea: 450, air: 380, foot: 10_000 };

let unitField: UnitField | undefined;
/** Directed-energy beams for the current theater. Built with the units, torn down with them. */
let lasers: LaserBeams | undefined;

function addUnits(center: { lon: number; lat: number }, map: TheaterMap, net: RoadNet | undefined) {
  removeUnits();
  // Pass obelisk coverage in: it seeds where infection concentrates and steers infected traffic
  // toward the unwatched gaps between cities.
  const covered = sensorField ? (lon: number, lat: number) => sensorField!.isCovered(lon, lat) : undefined;
  const counts = { ...UNIT_COUNTS, platforms: progression.ownedPlatforms() };
  const field = new UnitField(center, THEATER_RADIUS_M, map.heightAt, net, counts, covered);
  for (const k of UNIT_KINDS) scene.primitives.add(field.batches[k]);
  scene.primitives.add(field.marksLayer); // investigate + execution markers
  scene.primitives.add(field.droneRing); // platform sensor footprints
  unitField = field;
  lasers = new LaserBeams();
  scene.primitives.add(lasers.collection);
  updateUnitHud();
}

function removeUnits() {
  if (unitField) {
    for (const k of UNIT_KINDS) scene.primitives.remove(unitField.batches[k]);
    scene.primitives.remove(unitField.marksLayer);
    scene.primitives.remove(unitField.droneRing);
    unitField = undefined;
  }
  if (lasers) {
    scene.primitives.remove(lasers.collection); // remove() destroys the collection
    lasers = undefined;
  }
}

function updateUnitHud() {
  if (!unitField) {
    setText('g-units', '0');
    return;
  }
  const s = unitField.stateCounts();
  setText('g-units', `${unitField.liveCount} · ${s.normal}N ${s.protected}P ${s.infected}I`);
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
    // Orders age first: an investigation that commits this frame goes on the ledger, and an
    // execution that commits becomes eligible for the laser pass immediately below.
    for (const valid of unitField.advanceOrders(dt)) missions.report('investigate', valid);
    resolveExecutions();
    updateUnitPanel(); // keep the selection panel + reticle tracking the live unit
  }
  lasers?.update(dt);
});

/**
 * Service any execution-marked contact an armed platform can currently see.
 *
 * Runs AFTER render() because the beam endpoints come from the world positions render() just
 * cached. Each shot is scored the moment it lands — the unit's true state may have moved since the
 * order was given, and the shot is what the operator answers for.
 */
function resolveExecutions() {
  if (!unitField || !lasers) return;
  const obeliskArmed = progression.has('obelisk-laser') && sensorField;
  // Any platform carrying a directed-energy emitter on a hardpoint can service contacts.
  const armed = progression.ownedPlatforms().filter((id) => progression.platformHas(id, 'laser'));
  if (!obeliskArmed && !armed.length) return;

  const shots = unitField.resolveExecutions(
    obeliskArmed ? (lon, lat) => sensorField!.servicingApex(lon, lat) : undefined,
    armed,
  );
  for (const s of shots) {
    lasers.fire(s.from, s.to);
    missions.report('execute', s.valid);
  }
  if (shots.length) updateUnitHud();
}

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

// ---- campaign ownership ----
// The obelisk field is 115k sites, but the player only fields the ones inside territory they hold,
// at the density they've built out to. `obeliskMask` is that filter (1 = live), and BOTH renderings
// of the field read it — so orbit and a theater can never disagree about what's owned.
let territory: Territory | undefined;
let obeliskMask: Uint8Array | undefined;
let store: Store | undefined;

/**
 * Each obelisk watches a disc of this radius. Dense in cities, so metro units read as "seen" and
 * units out in the country render faint. Mutable: OBELISK SENSOR UPRATE buys the wider figure.
 */
let sensorRangeM = 750;
const SENSOR_RANGE_BASE = 750;
const SENSOR_RANGE_UPRATED = 1200;

let sensorField: SensorField | undefined;

/**
 * What the scene is currently built for. Rebuilding a theater's obelisks and its 23k units is only
 * correct when OWNERSHIP moved — and mission events fire constantly (every single mark reports),
 * so without this guard a routine progress event would regenerate the whole field and silently wipe
 * the operator's standing marks mid-mission. Officers deliberately aren't in the signature: earning
 * or spending them changes nothing the scene renders.
 */
let appliedOwnership = '';
function ownershipSignature(): string {
  const s = progression.snapshot();
  return `${s.assets.slice().sort().join(',')}|${JSON.stringify(s.tiers)}`;
}

/** Push every purchased effect into the live scene. Safe to call at any time, in either mode. */
function applyOwnership(rebuildScene: boolean): void {
  sensorRangeM = progression.has('obelisk-uprate') ? SENSOR_RANGE_UPRATED : SENSOR_RANGE_BASE;
  // Each platform's live sensor radius comes from its catalog entry plus whatever is on its
  // hardpoints, so fitting a wide-aperture pod widens the disc the sim actually tests against.
  for (const p of PLATFORMS) PLATFORM_SENSOR[p.id] = progression.sensorRangeOf(p.id);

  if (obelisks && territory) obeliskMask = progression.obeliskMask(territory, obelisks.count);

  const sig = ownershipSignature();
  const changed = sig !== appliedOwnership;
  appliedOwnership = sig;
  if (!rebuildScene || !changed) return;

  rebuildHeatField();
  // A live theater has to re-lay its obelisks, and the sensor net + units are derived from them.
  if (mode === 'theater' && theaterMap && theaterCenter) {
    addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
    if (unitField) addUnits(theaterCenter, theaterMap, theaterNet);
  }
}

// Ownership can move from several directions — a store purchase, a mission reward, a failed
// mission rolling the campaign back. Subscribing here rather than calling applyOwnership from each
// of those call sites means none of them can forget to, and the signature guard above makes the
// no-op case free.
progression.onChange(() => applyOwnership(true));

/** Rebuild the orbit heat splats from the current mask. */
function rebuildHeatField(): void {
  if (!obelisks) return;
  if (heatField) {
    scene.primitives.remove(heatField); // remove() destroys it
    heatField = undefined;
  }
  const heat = createHeatField(obelisks, HEAT_POINT_PX, HEAT_INTENSITY, HEAT_DOT, obeliskMask);
  if (!heat) return; // nothing owned — orbit is simply dark
  heat.show = mode === 'globe';
  scene.primitives.add(heat);
  heatField = heat;
  setText('g-obelisks', territory ? String(progression.activeObelisks(territory)) : String(obelisks.count));
}

void loadObelisks()
  .then(async (field) => {
    obelisks = field;
    setText('g-obelisks', String(field.count));

    // The survey is what turns 115k anonymous points into ownable territory, so the heat field
    // waits for it — drawing every site first and then blanking most of them would flash the whole
    // map as "owned". It also warms the states-10m module a theater build needs later.
    territory = await surveyTerritory(field);
    applyOwnership(true);
    store?.setTerritory(territory);

    // A theater entered before the data landed still wants its obelisks.
    if (mode === 'theater' && theaterMap && theaterCenter) {
      addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
    }
  })
  .catch((e) => {
    console.warn('[GORGON] obelisks failed to load:', e);
    setText('g-obelisks', 'ERR');
  });

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
    obeliskMask,
  );
  if (!built) {
    setText('g-obelisks', '0 IN THEATER');
    return;
  }
  obeliskPyramids = scene.primitives.add(built.primitive);
  obeliskFlare = scene.primitives.add(built.flare);
  setText('g-obelisks', `${built.count} IN THEATER`);

  // Sensor network: range rings + coverage/threat grids driving unit opacity and the red alert glow.
  sensorField = new SensorField(built.lonLat, built.apex, sensorRangeM, map.bbox, map.heightAt);
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

// Marquee drag-box (theater, desktop LMB) for multi-select.
const marqueeEl = document.createElement('div');
marqueeEl.id = 'marquee';
document.body.appendChild(marqueeEl);
let marqueeStart: Cesium.Cartesian2 | null = null;
let marqueeActive = false; // dragged past the threshold, so it's a box not a click
const MARQUEE_MIN = 6;

function drawMarquee(a: Cesium.Cartesian2, b: Cesium.Cartesian2) {
  marqueeEl.style.display = 'block';
  marqueeEl.style.left = `${Math.min(a.x, b.x)}px`;
  marqueeEl.style.top = `${Math.min(a.y, b.y)}px`;
  marqueeEl.style.width = `${Math.abs(a.x - b.x)}px`;
  marqueeEl.style.height = `${Math.abs(a.y - b.y)}px`;
}
function endMarquee() {
  marqueeEl.style.display = 'none';
  marqueeStart = null;
  marqueeActive = false;
}

const BAND_HEX: Record<string, string> = { clear: '#EDEFF2', suspect: '#F2C13B', threat: '#E23A2E' };
const KIND_ABBR: Record<UnitKind, string> = {
  land: 'CV', sea: 'SV', air: 'AV', foot: 'FT',
  drone: 'DISC', spider: 'ARC', biped: 'MAR', walker: 'COL',
};
const BAND_ABBR: Record<string, string> = { clear: 'CLR', suspect: 'SUS', threat: 'THR' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const MARK_HEX = '#F2A83B';
const DRONE_HEX = '#6FD3E8';

function hideUnitPanel() {
  if (panelEl) (panelEl as HTMLElement).hidden = true;
  if (reticleEl) (reticleEl as HTMLElement).hidden = true;
}

const tally = <K extends string>(counts: Record<K, number>, abbr: Record<K, string>) =>
  (Object.keys(counts) as K[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${abbr[k]} ${counts[k]}`)
    .join(' · ') || '—';

/**
 * Draw the selected unit's charge sheet, worst offence first. `record < 0` means the row doesn't
 * apply at all (the drone), which is different from a clean record and reads differently.
 */
function renderCharges(record: number) {
  const wrap = el('up-record');
  const list = el('up-charges');
  if (!wrap || !list) return;
  if (record < 0) {
    (wrap as HTMLElement).hidden = true;
    return;
  }
  (wrap as HTMLElement).hidden = false;
  const charges = readRecord(record);
  list.replaceChildren(
    ...(charges.length
      ? charges.map((c) => {
          const li = document.createElement('li');
          li.className = `sev-${c.severity}`;
          li.textContent = c.label;
          return li;
        })
      : [
          (() => {
            const li = document.createElement('li');
            li.className = 'clean';
            li.textContent = 'NO RECORD';
            return li;
          })(),
        ]),
  );
}

/**
 * The selected platform's hardpoints, one line per mount. Fitting happens in the store on the
 * select screen; this is the in-theater readout of what the platform is actually carrying.
 */
function renderLoadout(id: PlatformId | null) {
  const wrap = el('up-loadout');
  const list = el('up-hardpoints');
  if (!wrap || !list) return;
  if (!id) {
    (wrap as HTMLElement).hidden = true;
    return;
  }
  (wrap as HTMLElement).hidden = false;
  const loadout = progression.loadoutOf(id);
  list.replaceChildren(
    ...loadout.map((gearId, slot) => {
      const li = document.createElement('li');
      const gear = gearId ? GEAR.find((g) => g.id === gearId) : undefined;
      li.className = gear ? 'fitted' : 'empty';
      li.textContent = `HP${slot + 1} · ${gear ? gear.name : 'EMPTY'}`;
      return li;
    }),
  );
}

/**
 * The standing-order row: what's been ordered on this contact and, while the rescind window is
 * open, how long is left to take it back. Hidden entirely when there's no order.
 */
function renderOrder(mark: string | null, timer: number | undefined) {
  const row = el('up-order');
  if (!row) return;
  if (!mark) {
    (row as HTMLElement).hidden = true;
    return;
  }
  (row as HTMLElement).hidden = false;
  const pending = timer !== undefined;
  const kindLabel = mark === 'execute' ? 'EXECUTION' : 'INVESTIGATE';
  const vEl = el('up-order-v');
  if (vEl) {
    vEl.textContent = pending
      ? `${kindLabel} · ${Math.max(0, timer).toFixed(1)}S`
      : mark === 'execute'
        ? 'EXECUTION ARMED'
        : 'INVESTIGATION LOGGED';
    vEl.className = `v ${pending ? 'order-pending' : mark === 'execute' ? 'order-armed' : 'order-logged'}`;
  }
  // The bar drains left-to-right as the window closes, so the countdown reads without the number.
  const bar = el('up-order-bar');
  if (bar) {
    (bar as HTMLElement).hidden = !pending;
    const fill = bar.firstElementChild as HTMLElement | null;
    if (fill && pending) {
      const total = ORDER_DELAY[mark === 'execute' ? 'execute' : 'investigate'];
      fill.style.width = `${Math.max(0, Math.min(100, (timer / total) * 100))}%`;
    }
    bar.className = `up-assess order-bar ${mark === 'execute' ? 'exec' : 'inv'}`;
  }
}

/** Refresh the panel + reticle from the current selection. Called each frame. */
function updateUnitPanel() {
  if (!unitField) return hideUnitPanel();
  const sel = unitField.selected();
  if (!sel || !panelEl) return hideUnitPanel();
  (panelEl as HTMLElement).hidden = false;

  const one = sel.single;
  const singleEl = el('up-single');
  const multiEl = el('up-multi');
  if (singleEl) (singleEl as HTMLElement).hidden = !one;
  if (multiEl) (multiEl as HTMLElement).hidden = !!one;
  const dot = el('up-dot');

  if (one) {
    setText('up-id', one.id);
    setText('up-type', KIND_LABEL[one.kind]);
    const isPlatform = PLATFORM_BY_ID.has(one.kind as PlatformId);
    const band = assessBand(one.assess);
    const pct = Math.round(one.assess * 100);
    const stEl = el('up-status');
    if (stEl) {
      // Never the true state — an assessed likelihood. The drone is friendly hardware and has no
      // assessment at all; its row stays a transit status.
      stEl.textContent = isPlatform ? (one.order ?? 'ON STATION') : `${BAND_LABEL[band]} · ${pct}%`;
      stEl.className = isPlatform ? 'v sensor-tracked' : `v band-${band}`;
    }
    const bar = el('up-assess-bar');
    if (bar) {
      (bar as HTMLElement).hidden = isPlatform;
      bar.className = `up-assess band-${band}`;
      const fill = bar.firstElementChild as HTMLElement | null;
      if (fill) fill.style.width = `${pct}%`;
    }
    renderCharges(isPlatform ? -1 : one.record);
    renderOrder(one.mark, one.markTimer);
    if (dot) (dot as HTMLElement).style.color = isPlatform ? DRONE_HEX : BAND_HEX[band];
    setText(
      'up-pos',
      `${Math.abs(one.lat).toFixed(3)}°${one.lat >= 0 ? 'N' : 'S'} ${Math.abs(one.lon).toFixed(3)}°${one.lon >= 0 ? 'E' : 'W'}`,
    );
    const deg = (Cesium.Math.toDegrees(one.heading) + 360) % 360;
    setText('up-hdg', `${Math.round(deg)}° ${COMPASS[Math.round(deg / 45) % 8]} · ${KIND_SPEED[one.kind]} M/S`);
    const senEl = el('up-sensor');
    if (senEl) {
      if (isPlatform) {
        // For a platform the sensor row is its own envelope and what's currently inside it.
        const st = unitField.platformStatus(one.kind as PlatformId);
        const km = ((st?.rangeM ?? 0) / 1000).toFixed(1);
        senEl.textContent = st ? `${km} KM · ${st.seen} SEEN · ${st.infected} INF` : `${km} KM`;
        senEl.className = 'v sensor-tracked';
      } else {
        const seen =
          (!sensorField || sensorField.isCovered(one.lon, one.lat)) ||
          unitField.platformCovers(one.lon, one.lat);
        senEl.textContent = seen ? 'TRACKED' : 'OUT OF RANGE';
        senEl.className = `v ${seen ? 'sensor-tracked' : 'sensor-dark'}`;
      }
    }
    renderLoadout(isPlatform ? (one.kind as PlatformId) : null);
  } else {
    setText('up-id', `${sel.count} UNITS`);
    if (dot) (dot as HTMLElement).style.color = sel.markedCount > 0 ? MARK_HEX : '#B7BDC5';
    setText('up-kinds', tally(sel.byKind, KIND_ABBR));
    setText('up-states', tally(sel.byBand, BAND_ABBR));
    setText(
      'up-marked',
      sel.pendingCount > 0
        ? `${sel.markedCount} / ${sel.count} · ${sel.pendingCount} PENDING`
        : `${sel.markedCount} / ${sel.count}`,
    );
    const trEl = el('up-tracked');
    if (trEl) {
      trEl.textContent = `${sel.trackedCount} / ${sel.count}`;
      trEl.className = `v ${sel.trackedCount > 0 ? 'sensor-tracked' : 'sensor-dark'}`;
    }
  }

  // Investigate is a sensor-gated order: with nothing in the selection inside coverage there is
  // nothing C2 can task, so the button says so rather than silently doing nothing.
  const mk = el('up-mark') as HTMLButtonElement | null;
  if (mk) {
    const st = unitField.markState();
    const canAct = sel.trackedCount > 0;
    // Which order the button issues follows the ACTIVE tasking — lethal authority isn't left
    // switched on between missions just because it's been granted.
    const kind = missions.markKind();
    // Rescinding acts on the order that's actually standing, which is not always the one this
    // tasking would issue — a kill order outlives the mission that authorized it.
    const shown = st === 'all' ? (sel.markedKind ?? kind) : kind;
    const exec = shown === 'execute';
    // While an order is counting down the button is the abort — it says so, and it counts.
    const pending = sel.pendingCount > 0;
    const secs = Math.max(0, sel.pendingSeconds).toFixed(1);
    mk.disabled = !canAct;
    mk.textContent = !canAct
      ? '◈ NO SENSOR CONTACT'
      : pending
        ? `◈ RESCIND · ${secs}S`
        : st === 'all'
          ? exec
            ? '◈ RESCIND EXECUTION'
            : '◈ CLEAR INVESTIGATE'
          : exec
            ? '◈ MARK FOR EXECUTION'
            : '◈ MARK INVESTIGATE';
    mk.classList.toggle('active', canAct && !pending && st !== 'none');
    mk.classList.toggle('pending', canAct && pending);
    mk.classList.toggle('exec', exec);
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
/**
 * The theater's tasking reminder. Driven from the same mission state as the select-screen panel,
 * and only shown where that panel isn't: in a theater, with something active.
 */
function updateTaskingHud() {
  const hud = el('g-tasking');
  if (!hud) return;
  const def = missions.activeDef();
  const run = missions.activeRun();
  if (mode !== 'theater' || !def || !run) {
    (hud as HTMLElement).hidden = true;
    return;
  }
  (hud as HTMLElement).hidden = false;
  setText('gt-name', def.name);
  const order = el('gt-order');
  if (order) {
    order.textContent = def.mark === 'execute' ? 'LETHAL' : 'SURVEIL';
    order.className = `gt-order order-${def.mark}`;
  }
  setText('gt-valid', `${run.valid} / ${def.target}`);
  setText('gt-invalid', `${run.invalid} / ${def.maxInvalid}`);
  const vb = el('gt-valid-bar');
  if (vb) (vb as HTMLElement).style.width = `${Math.min(100, (run.valid / def.target) * 100)}%`;
  const ib = el('gt-invalid-bar');
  // Against maxInvalid+1, since it's the one PAST the ceiling that fails the tasking.
  if (ib) (ib as HTMLElement).style.width = `${Math.min(100, (run.invalid / (def.maxInvalid + 1)) * 100)}%`;
}

// Every mission event can move the reminder, and mode changes decide whether it shows at all.
missions.onChange(() => updateTaskingHud());

function updateChrome() {
  setText('g-mode', mode === 'globe' ? 'ORBITAL · SELECT THEATER' : 'THEATER · C2 ACTIVE');
  const title = el('g-title');
  if (title) title.style.display = mode === 'globe' ? '' : 'none';
  const exit = el('g-exit');
  if (exit) (exit as HTMLButtonElement).hidden = mode !== 'theater';
  el('globe-ui')?.classList.toggle('in-theater', mode === 'theater');
  updateTaskingHud();
}

let theaterMap: TheaterMap | undefined;
/** The current theater's road graph, kept so the dev panel can regenerate buildings without refetching. */
let theaterNet: RoadNet | undefined;
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

// ---- transient notices ----
let toastTimer = 0;
function toast(msg: string) {
  const t = el('g-toast');
  if (!t) return;
  t.textContent = msg;
  (t as HTMLElement).hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ((t as HTMLElement).hidden = true), 2600);
}

/**
 * A theater pick is only honoured on ground the campaign holds. Refusing here (rather than letting
 * the player in and showing an empty sensor net) is what makes the TERRITORY tab the way forward.
 */
function tryEnterTheater(carto: Cesium.Cartographic) {
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  if (!territory) {
    toast('TERRITORY SURVEY IN PROGRESS · STAND BY');
    return;
  }
  const st = territory.stateAt(lon, lat);
  if (!st) {
    toast('OUTSIDE GORGON JURISDICTION');
    return;
  }
  if (!progression.isUnlocked(st)) {
    toast(`${st.name.toUpperCase()} NOT HELD · UNLOCK UNDER TERRITORY`);
    return;
  }
  enterTheater(carto);
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
      theaterNet = net; // keep for dev-panel regeneration
      await streamBuildings(lon, lat, map, net, tok);
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
  theaterNet = undefined;
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
  setText('g-obelisks', territory ? String(progression.activeObelisks(territory)) : '—');
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
  // theater: draw the marquee box while dragging
  if (marqueeStart) {
    if (Cesium.Cartesian2.distance(marqueeStart, m.endPosition) > MARQUEE_MIN) marqueeActive = true;
    if (marqueeActive) drawMarquee(marqueeStart, m.endPosition);
    return;
  }
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

// LMB down: begin a possible marquee (theater, desktop — mobile LMB pans the map).
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (mode !== 'theater' || IS_MOBILE) return;
  marqueeStart = Cesium.Cartesian2.clone(m.position);
  marqueeActive = false;
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

// LMB up: finish a marquee box (multi-select). A non-drag falls through to LEFT_CLICK (single pick).
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (marqueeStart && marqueeActive) {
    if (unitField && unitField.pickBox(scene, marqueeStart.x, marqueeStart.y, m.position.x, m.position.y) > 0) {
      updateUnitPanel();
    } else {
      unitField?.deselect();
      hideUnitPanel();
    }
  }
  endMarquee();
}, Cesium.ScreenSpaceEventType.LEFT_UP);

// LMB click (no drag): pick a theater in orbit, a single unit in a theater.
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (mode === 'globe') {
    const carto = pickLonLat(m.position);
    if (carto) tryEnterTheater(carto);
    return;
  }
  if (unitField && unitField.pick(scene, m.position.x, m.position.y, SELECT_PX)) {
    updateUnitPanel();
  } else {
    unitField?.deselect();
    hideUnitPanel();
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// RMB in a theater: a *click* (no drag) orders the selected drone to that ground point; a *drag*
// is left alone so it still tilts the camera. Cesium gives us no "right click without drag", so
// track the down position and only treat it as an order if the pointer barely moved.
let rightDownAt: Cesium.Cartesian2 | null = null;
const ORDER_SLOP_PX = 6;

/** Ground lon/lat under a window point, using the baked theater mesh depth. */
function groundAt(p: Cesium.Cartesian2): { lon: number; lat: number } | undefined {
  let world: Cesium.Cartesian3 | undefined;
  if (scene.pickPositionSupported) world = scene.pickPosition(p);
  if (!world) world = camera.pickEllipsoid(p, globe.ellipsoid);
  if (!world) return undefined;
  const c = Cesium.Cartographic.fromCartesian(world);
  if (!c) return undefined;
  return { lon: Cesium.Math.toDegrees(c.longitude), lat: Cesium.Math.toDegrees(c.latitude) };
}

handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  rightDownAt = mode === 'theater' ? Cesium.Cartesian2.clone(m.position) : null;
}, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  const down = rightDownAt;
  rightDownAt = null;
  if (!down || mode !== 'theater' || !unitField) return;
  if (Cesium.Cartesian2.distance(down, m.position) > ORDER_SLOP_PX) return; // that was a tilt drag
  if (!unitField.selectedPlatform()) return; // orders only apply to a selected platform
  const g = groundAt(m.position);
  if (g && unitField.orderSelected(g.lon, g.lat)) updateUnitPanel();
}, Cesium.ScreenSpaceEventType.RIGHT_UP);

el('g-exit')?.addEventListener('click', exitTheater);

// ---- command store ----
// Lives on the theater-select screen (CSS hides it in a theater). Purchases land in `progression`;
// everything the scene derives from ownership is re-applied here in one place.
store = new Store({
  // Ownership itself is re-applied by the progression subscription above; the store only needs to
  // move the camera onto whatever the player just bought.
  onPurchase: () => {},
  onFocusState: (s) => {
    if (mode !== 'globe') return;
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(s.center.lon, s.center.lat, 2_400_000),
      duration: 1.6,
    });
  },
});

// ---- tasking panel ----
// Mission rewards and failure rollbacks both go through progression, which the subscription above
// already watches — so this only has to surface the notice.
new MissionPanel({
  onChange: () => {},
  notify: (msg) => toast(msg),
});

// ---- dev settings panel (⚙) ----
// A small header panel for live-tuning the procedural city. Sliders write into `devSettings`; the
// two that change geometry (population, road gap) regenerate the skyline on release.
{
  const gear = el('dev-toggle');
  const panel = el('dev-panel');
  gear?.addEventListener('click', () => {
    if (!panel) return;
    panel.hidden = !panel.hidden;
    gear.classList.toggle('active', !panel.hidden);
  });
  el('dev-close')?.addEventListener('click', () => {
    if (panel) panel.hidden = true;
    gear?.classList.remove('active');
  });

  // wire one slider: reflect its value into a label live, and run `commit` when released
  const bindSlider = (
    id: string,
    fmt: (v: number) => string,
    apply: (v: number) => void,
    commit: () => void,
  ) => {
    const input = el(id) as HTMLInputElement | null;
    const out = el(`${id}-val`);
    if (!input) return;
    const show = () => {
      if (out) out.textContent = fmt(parseFloat(input.value));
    };
    show();
    input.addEventListener('input', () => {
      apply(parseFloat(input.value));
      show();
    });
    input.addEventListener('change', commit);
  };

  bindSlider(
    'dev-population',
    (v) => `${v.toFixed(2)}×`,
    (v) => (devSettings.buildingPopulation = v),
    regenerateBuildings,
  );
  bindSlider(
    'dev-roadgap',
    (v) => `${v.toFixed(0)} m`,
    (v) => (devSettings.roadGap = v),
    regenerateBuildings,
  );
  bindSlider(
    'dev-maxheight',
    (v) => `${v.toFixed(0)} m`,
    (v) => (devSettings.maxHeight = v),
    regenerateBuildings,
  );

  const strict = el('dev-strict') as HTMLInputElement | null;
  if (strict) {
    strict.checked = devSettings.strictRoadClearance;
    strict.addEventListener('change', () => {
      devSettings.strictRoadClearance = strict.checked;
      regenerateBuildings();
    });
  }

  el('dev-regen')?.addEventListener('click', regenerateBuildings);
  el('dev-reset')?.addEventListener('click', () => {
    progression.reset();
    missions.reset();
    applyOwnership(true);
    toast('CAMPAIGN RESET · WASHINGTON DOWNTOWN');
  });
}
el('up-close')?.addEventListener('click', () => {
  unitField?.deselect();
  hideUnitPanel();
});
el('up-mark')?.addEventListener('click', () => {
  if (!unitField) return;
  const kind = missions.markKind();
  const on = unitField.markState() !== 'all'; // toggle: order all, or rescind if all are ordered
  // Nothing is logged here — every order starts on a rescind countdown and commits in the frame
  // loop once that window closes.
  unitField.markSelected(kind, on);
  updateUnitPanel();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') exitTheater();
  // I cycles the infection: spread it to more units so the red state is easy to watch, then reset.
  if ((e.key === 'i' || e.key === 'I') && mode === 'theater' && unitField) {
    unitField.cycleInfection();
    updateUnitHud();
  }
  // G cycles through the fielded platforms, so they're reachable without hunting on screen.
  if ((e.key === 'g' || e.key === 'G') && mode === 'theater' && unitField) {
    if (unitField.cyclePlatform()) updateUnitPanel();
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
    tryEnterTheater,
    exitTheater,
    spawnUnits,
    clearUnits,
    devSettings,
    regenerateBuildings,
    get buildingCount() {
      return lastBuildingCount;
    },
    get unitField() {
      return unitField;
    },
    get obelisks() {
      return obelisks;
    },
    get sensorField() {
      return sensorField;
    },
    get lasers() {
      return lasers;
    },
    progression,
    missions,
    ASSETS,
    MISSIONS,
    get territory() {
      return territory;
    },
    get obeliskMask() {
      return obeliskMask;
    },
    INFECTED_FLEE,
    CONTAGION,
    get units() {
      return units.length;
    },
    get mode() {
      return mode;
    },
  };
}
