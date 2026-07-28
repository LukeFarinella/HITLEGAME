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
  SIEGE,
  INFECTED_FLEE,
  CONTAGION,
  INTERCEPT,
  type RtsStructTarget,
} from './units';
import { UNIT_KINDS, type UnitKind } from './unitModels';
import { SensorField } from './sensors';
import { progression, ASSETS, AIRDROP_COST } from '../game/progression';
import { PLATFORMS, GEAR, PLATFORM_BY_ID, BASE_SENSOR_M, type PlatformId } from '../game/platforms';
import { surveyTerritory, clusterCentres, type Territory } from '../game/territory';
import { missions, MISSIONS } from '../game/missions';
import { processActions } from '../game/processActions';
import { tolerance, caseStrength, toleranceLabel } from '../game/tolerance';
import { policy, policyLabel } from '../game/policy';
import {
  SANCTIONS,
  SANCTION_BY_ID,
  judge,
  type SanctionDef,
  type SanctionId,
  type Subject,
} from '../game/sanctions';
import { resistance } from '../game/resistance';
import { assessBand, BAND_LABEL, readRecord, type Record_ } from '../game/intel';
import { portraitFor } from '../game/portraits';
import { extraFields, infoUnlocked, searchAvailable } from '../game/dossier';
import { FACTION_BY_ID, type FactionId } from '../game/factions';
import { VIOLATION_TTL_S, VIOLATIONS } from '../game/violations';
import { Store } from '../ui/store';
import { icon } from '../ui/icons';
import { sound, bindInterfaceSounds } from '../ui/sound';
import { music } from '../ui/music';
import { MissionPanel, showMissionComplete, presentPendingForks } from '../ui/missions';
import { ProcessPanel } from '../ui/process';
import { showStartWindow } from '../ui/start';
import { showTitle, setTitleTerritory } from '../ui/title';
import { RtsGame } from '../game/rts/rtsGame';
import { RtsBuildLayer, type BuildSite } from './rtsBuild';
import { RtsCommandBar, type CommandContext } from '../ui/rtsCommand';
import {
  STRUCTURES, BUILDABLE, BUILD_RULES, ABILITY_BY_ID, NEXUS_LASER, ORBITAL, abilitiesFrom, metresBetween,
  type AbilityId, type StructureType, type Structure,
} from '../game/rts/structures';
import { RTS_UNITS, unitsFrom, producesUnits, type RtsUnitId } from '../game/rts/units';
import { RESEARCH, researchFrom, type ResearchId } from '../game/rts/research';
import { RTS_COMBAT, armamentOf } from '../game/rts/combat';
import { MILLSTONE_BY_KIND, MILLSTONE_UNIT_LIST } from '../game/rts/millstoneUnits';
import { MillstoneDirector, MILLSTONE } from '../game/rts/millstone';
import { unrestLabel } from '../game/rts/unrest';
import { newlyDone, type MatchFacts, type ObjectiveId } from '../game/rts/objectives';
import { inspectContact, fineBlockedBy, AUTHORITY_TIERS, type AuthorityLevel } from '../game/rts/inspect';
import { showInspectCard, closeInspectCard } from '../ui/rtsInspect';
import { mandateState } from '../game/rts/mandate';
import { RtsObjectivePanel } from '../ui/rtsObjectives';
import { RtsUnitCard, type RtsCardUnit, type RtsCardStructure } from '../ui/rtsUnitCard';
import { showLoading, setStage, hideLoading } from '../ui/loading';
import { setActiveSlot, migrateLegacySave } from '../game/saves';
import { LaserBeams } from './lasers';
import { ScanBeams, Blasts, Sparks, Impacts, Cuffs, ViolationPings, Rounds, CameraFlashes } from './effects';
import { Reactions } from './reactions';
import { ActionMarks, type ActionKind } from './actionMarks';
import { RouteLayer } from './routes';
import { AttackPulse } from './pulse';
import { SiegeDirector, type SiegeEvent } from './siege';
import { DropSites } from './dropSites';
import { IncidentDirector, INCIDENTS, type IncidentEvent, type IncidentKind } from './incidents';

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
/** Infected attacks against the obelisk net. Lives and dies with the theater. */
let siege: SiegeDirector | undefined;
/** Everything else the theater does on its own: riots, chases, brawls, assassinations. */
let incidents: IncidentDirector | undefined;
/** The crowd reacting to what the operator does. Lives and dies with the theater. */
let reactions: Reactions | undefined;
/** Action glyphs that pop where each order lands — a fine, an investigation, a kill. */
let actionMarks: ActionMarks | undefined;
/** The selected platform's commanded route, drawn on the ground. */
let routes: RouteLayer | undefined;
/** The distress ring over a site under attack. Screen-space, so it reads at any zoom. */
let pulse: AttackPulse | undefined;
/** Sensor links from whatever is watching to whoever is under investigation. */
let scans: ScanBeams | undefined;
/** Area-weapon detonations, drawn at their true lethal radius. */
let blasts: Blasts | undefined;
/** Cutting sparks where an attacker is working on a site. */
let sparks: Sparks | undefined;
/** Artillery and missiles in the air. Positions come from the combat sim, not from this layer. */
let rounds: Rounds | undefined;
/** Obelisk camera flashes — fires where a violation was recorded. RTS mode only. */
let flashes: CameraFlashes | undefined;
/**
 * Screen-space impact marks.
 *
 * Everything else here is geometry in metres, which is honest and invisible from orbit. These hold
 * their size in pixels, so an execution or a strike registers at whatever altitude the operator
 * happens to be watching from.
 */
let impacts: Impacts | undefined;
/** Restraint rounds — the visible half of a detainment. */
let cuffs: Cuffs | undefined;
/** Yellow markers over every contact the net has accused. The primary call to action. */
let pings: ViolationPings | undefined;
/**
 * Airdropped sites for THIS sortie.
 *
 * Never persisted, and torn down on the way out. That is a deliberate rule rather than an
 * unfinished feature: permanent coverage is what TERRITORY is for and what it is priced against,
 * so a 400-token site that survived the session would quietly undercut the entire economy. Renting
 * a view of somewhere for one sortie is a different purchase from owning the ground.
 */
let dropSites: DropSites | undefined;

/** Park the pulse on whichever site the siege is currently working on, or stand it down. */
function updateAttackPulse() {
  if (!pulse) return;
  const a = siege?.inbound();
  const apex = a && sensorField ? sensorField.apexAt(a.local) : undefined;
  if (apex) pulse.at(Cesium.Cartesian3.clone(apex));
  else pulse.clear();
}

/** Redraw the route for whatever platform is selected, or clear it when none is. */
function updateRouteLayer() {
  if (!routes) return;
  if (!unitField || !theaterMap || mode !== 'theater') return routes.clear();
  const sel = unitField.selectedPlatform();
  if (!sel) return routes.clear();
  const st = unitField.platformStatus(sel.index);
  const legs = unitField.routeOf(sel.index);
  if (!st || !legs.length) return routes.clear();
  routes.draw(
    { lon: st.lon, lat: st.lat },
    legs,
    unitField.routeActionOf(sel.index),
    unitField.routeLoops(sel.index),
    theaterMap.heightAt,
  );
}

/**
 * Play a reaction over the people standing where something happened.
 *
 * Approval and dismay go to BYSTANDERS — the street registering a call, right or wrong. The company
 * face goes to GORGON's own hardware instead, because the company being pleased is a different
 * event from the public being pleased, and showing them on the same faces would blur exactly the
 * distinction this game is about.
 */
const REACTION_RADIUS_M = 2600;
function reactAt(lon: number, lat: number, kind: 'approve' | 'dismay') {
  if (!reactions || !unitField) return;
  for (const p of unitField.bystandersNear(lon, lat, REACTION_RADIUS_M)) reactions.pop(p, kind);
}

/**
 * Pop an action glyph on the map where an order lands. Two ways in: a lon/lat (looked up against the
 * theater mesh for a ground height) or a world position already in hand, e.g. a beam's endpoint.
 */
function markAction(lon: number, lat: number, kind: ActionKind) {
  if (!actionMarks) return;
  const h = theaterMap ? theaterMap.heightAt(lon, lat) : 0;
  actionMarks.pop(Cesium.Cartesian3.fromDegrees(lon, lat, h + 6), kind);
}
function markAt(pos: Cesium.Cartesian3, kind: ActionKind) {
  actionMarks?.pop(pos, kind);
}

/** A win for GORGON: the company mark over its own assets and its own sites. */
function reactCompany() {
  if (!reactions || !unitField) return;
  for (const p of unitField.platformPositions()) reactions.pop(p, 'company');
  const f = sensorField;
  if (f) {
    // A handful of nearby sites rather than all 6,000 of them.
    for (let k = 0; k < 6; k++) {
      const site = f.randomSite();
      if (!site) break;
      const apex = f.apexAt(site.local);
      if (apex) reactions.pop(Cesium.Cartesian3.clone(apex), 'company');
    }
  }
}

/**
 * Resolve one siege event: a site coming down costs the net its coverage and counts against the
 * active tasking, and both of the ways to stop an attack report back here.
 */
function onSiegeEvent(e: SiegeEvent) {
  if (e.type === 'inbound') {
    sound.play('alert');
    toast('⚠ OBELISK UNDER THREAT · ATTACKER INBOUND');
    return;
  }
  if (e.type === 'stopped') {
    sound.play('stopped');
    reactCompany(); // the net defended itself — that is a company win, not a public one
    if (e.how === 'detained' && e.lon !== undefined && e.lat !== undefined) {
      throwCuffsAt(e.lon, e.lat);
    }
    toast(e.how === 'detained' ? 'ATTACKER DETAINED' : 'ATTACKER SERVICED');
    return;
  }
  // A site fell. Strike it out of the field, which shrinks coverage everywhere it reached, and
  // rebuild — the mask is what both the geometry and the sensor grid are derived from.
  if (e.targetIndex >= 0) fallenObelisks.add(e.targetIndex);
  const apex = siegeApex(e.targetLocal);
  if (theaterCenter && theaterMap) {
    addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
    // The sensor field was just replaced, so the director needs the new one.
    if (unitField) startSiege(unitField);
  }
  if (apex && siege) siege.markWreck(apex);
  sound.play('lost');

  // Losing the LAST site is a rout, not a setback: with no net there is nothing left to operate,
  // so the tasking fails and the theater is abandoned rather than left blind but running.
  if (!sensorField) {
    toast('◈ NETWORK DESTROYED · THEATER LOST');
    missions.failActive();
    window.setTimeout(() => {
      if (mode === 'theater') exitTheater();
    }, 2600);
    updateTaskingHud();
    return;
  }

  toast(`◈ OBELISK LOST · ${fallenObelisks.size} DOWN THIS THEATER`);
  missions.reportObeliskLost();
  updateTaskingHud();
}

/** Apex of a site local to the current theater, captured before the field is rebuilt without it. */
function siegeApex(local: number): Cesium.Cartesian3 | undefined {
  const f = sensorField;
  if (!f) return undefined;
  const a = f.apexAt(local);
  return a ? Cesium.Cartesian3.clone(a) : undefined;
}

/**
 * Give each fielded platform its own city to start in.
 *
 * Spawning them all on the theater centre stacked them into one unclickable pile. The theater's own
 * obelisk sites are a density map of where the cities are — that's exactly what the territory tiers
 * are built on — so clustering them gives real downtowns to post platforms to, biggest city first.
 * Falls back to the centre if a theater is too sparse to have distinguishable cities.
 */
function platformStations(center: { lon: number; lat: number }, map: TheaterMap) {
  // An RTS match ignores campaign ownership entirely: it opens with exactly one dog, stationed on
  // the Nexus, and everything else is built in-match. (Production spawns later units at their
  // facility — this only seeds the opening.)
  if (rtsGame && obelisks) {
    const i = rtsGame.nexusIndex;
    const mLon = 111_320 * Math.cos((obelisks.lat[i] * Math.PI) / 180);
    // Two skidsteer workers flanking the Nexus — enough to build with and still keep one on economy.
    return [
      { id: 'skid' as PlatformId, lon: obelisks.lon[i] + 220 / mLon, lat: obelisks.lat[i] },
      { id: 'skid' as PlatformId, lon: obelisks.lon[i] - 220 / mLon, lat: obelisks.lat[i] },
    ];
  }
  // One entry per fielded UNIT, so four arachnids get four different cities rather than one.
  const units = progression.fieldedUnits();
  const sites = theaterSiteLonLat;
  const cities = sites
    ? clusterCentres(sites, { minCount: 6, separationM: 18_000, max: Math.max(6, units.length) })
    : [];
  // Littoral drones can't be stationed downtown — they need water under them.
  const ports = units.includes('naval') ? findPorts(map) : [];
  let cityAt = 0;
  let portAt = 0;
  return units.map((id) => {
    if (id === 'naval' && ports.length) {
      const p = ports[portAt++ % ports.length];
      return { id, lon: p[0], lat: p[1] };
    }
    const c = cities.length ? cities[cityAt++ % cities.length] : center;
    return { id, lon: c.lon, lat: c.lat };
  });
}

/**
 * Ferry ports: water points just off the coast nearest each populated cluster.
 *
 * "Populated landmasses" is already something this theater knows — the obelisk clusters ARE the
 * cities. For each, walk outward until the shore field says open water, and if that lands within
 * a sensible distance it's a port. Cities well inland simply produce none.
 */
function findPorts(map: TheaterMap): [number, number][] {
  const sites = theaterSiteLonLat;
  if (!sites) return [];
  const cities = clusterCentres(sites, { minCount: 4, separationM: 25_000, max: 14 });
  const ports: [number, number][] = [];
  for (const c of cities) {
    // Search rings outward for water at least 250 m off the beach.
    let best: [number, number] | null = null;
    for (let r = 2_000; r <= 40_000 && !best; r += 2_000) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const p = destDeg(c.lat, c.lon, r, a);
        if (map.shoreDistance(p.lon, p.lat) < -250) {
          best = [p.lon, p.lat];
          break;
        }
      }
    }
    if (best) ports.push(best);
  }
  return ports;
}

function addUnits(center: { lon: number; lat: number }, map: TheaterMap, net: RoadNet | undefined) {
  removeUnits();
  // Pass obelisk coverage in: it seeds where infection concentrates and steers infected traffic
  // toward the unwatched gaps between cities.
  // Reads sensorField LIVE rather than capturing it: losing the last obelisk sets it to undefined,
  // and a closure that dereferenced it unconditionally threw on every frame from that point on.
  // No net means no coverage, which is also the honest answer.
  const covered = (lon: number, lat: number) => sensorField?.isCovered(lon, lat) ?? false;
  const counts = {
    ...UNIT_COUNTS,
    ports: findPorts(map),
    platforms: platformStations(center, map),
    // An RTS match builds a real army — and Millstone fields one out of the same per-kind batches —
    // so size the hero-platform batches for both sides at once.
    platformCap: rtsGame ? 96 : undefined,
  };
  const field = new UnitField(center, THEATER_RADIUS_M, map.heightAt, net, counts, covered, map.shoreDistance);
  for (const k of UNIT_KINDS) scene.primitives.add(field.batches[k]);
  scene.primitives.add(field.marksLayer); // investigate + execution markers
  scene.primitives.add(field.droneRing); // platform sensor footprints
  scene.primitives.add(field.platformIcons); // 24 px markers, shown when zoomed out
  // An RTS match runs none of the campaign's surveillance rules — no tolerance gate, no auto-patrol
  // forks, no infected pockets or starter target. Its enemy is Millstone, not the ambient
  // contagion, so the field is set to a clean, fully-orderable baseline.
  if (rtsGame) {
    field.toleranceOverride = true;
    field.autoPatrol = { ground: false, air: false };
    field.hvtDesignate = false;
  } else {
    field.toleranceOverride = progression.has('emergency-powers');
    field.autoPatrol = {
      ground: missions.hasChosen('dragnet', 'patrol-ground'),
      air: missions.hasChosen('dragnet', 'patrol-air'),
    };
    field.hvtDesignate = missions.hasChosen('defend', 'hvt');
    seedHiddenPockets(field);
    seedStarterTarget(field);
  }
  deliveryTimer = DELIVERY_INTERVAL_S;
  unitField = field;
  lasers = new LaserBeams();
  scene.primitives.add(lasers.collection);
  reactions = new Reactions();
  scene.primitives.add(reactions.collection);
  actionMarks = new ActionMarks();
  scene.primitives.add(actionMarks.collection);
  routes = new RouteLayer();
  scene.primitives.add(routes.lines);
  scene.primitives.add(routes.markers);
  pulse = new AttackPulse();
  scene.primitives.add(pulse.collection);
  scans = new ScanBeams();
  scene.primitives.add(scans.collection);
  blasts = new Blasts();
  scene.primitives.add(blasts.rings);
  scene.primitives.add(blasts.cores);
  sparks = new Sparks();
  scene.primitives.add(sparks.collection);
  rounds = new Rounds();
  scene.primitives.add(rounds.collection);
  flashes = new CameraFlashes();
  scene.primitives.add(flashes.collection);
  impacts = new Impacts();
  scene.primitives.add(impacts.collection);
  dropSites = new DropSites();
  scene.primitives.add(dropSites.collection);
  pings = new ViolationPings();
  scene.primitives.add(pings.collection);
  cuffs = new Cuffs();
  // The round landing is what puts the mark down, so the two read as one event.
  cuffs.onLand = (at) => impacts?.at(at, 110, 0.55, 14);
  scene.primitives.add(cuffs.collection);
  // The campaign's obelisk siege and incident directors don't run in an RTS match — Millstone is
  // the RTS threat, and it attacks on its own director (see runMillstone / runRtsCombat).
  if (!rtsGame) {
    startSiege(field);
    startIncidents(field);
  }
  updateUnitHud();
}

/**
 * What each incident costs when it is not answered.
 *
 * Priced so that ignoring trouble is a real decision rather than a rounding error, and so that the
 * two currencies it charges say different things: TOKENS are the company's money, and resistance is
 * the ground's memory. A riot costs money because property is what a contractor is paid to protect;
 * an assassination costs resistance because a protected asset dying in public is a failure everyone
 * can see.
 */
const STRUCTURE_LOSS_TOKENS = 900;
const ASSET_LOSS_TOKENS = 2500;
const CASUALTY_RESISTANCE = 0.03;
const ASSET_LOSS_RESISTANCE = 0.06;
const ESCAPE_RESISTANCE = 0.04;

function onIncidentEvent(e: IncidentEvent) {
  switch (e.type) {
    case 'opened':
      sound.play('alert');
      toast(`⚠ ${e.def.name} · ${e.def.brief}`);
      incidentFocus = { lon: e.lon, lat: e.lat };
      break;

    case 'structure':
      // A building comes down. There is no building geometry to remove — the skyline is procedural
      // and rebuilt per theater — so the loss is shown as a blast where it happened and billed.
      progression.spend(STRUCTURE_LOSS_TOKENS);
      resistance.aggravate(0.012);
      if (theaterMap) {
        const h = theaterMap.heightAt(e.lon, e.lat);
        blasts?.fire(e.lon, e.lat, h, 140);
        impacts?.at(Cesium.Cartesian3.fromDegrees(e.lon, e.lat, h), 200, 0.9, 20);
        sparks?.emit(Cesium.Cartesian3.fromDegrees(e.lon, e.lat, h + 6), 14);
      }
      sound.play('laser');
      reactAt(e.lon, e.lat, 'dismay');
      toast(`◈ STRUCTURE LOST · −${STRUCTURE_LOSS_TOKENS} TOKENS`);
      updateUnitHud();
      break;

    case 'casualty':
      if (e.protectedAsset) {
        progression.spend(ASSET_LOSS_TOKENS);
        resistance.aggravate(ASSET_LOSS_RESISTANCE);
        toast(`◈ PROTECTED ASSET KILLED · −${ASSET_LOSS_TOKENS} TOKENS`);
      } else {
        resistance.aggravate(CASUALTY_RESISTANCE);
        toast('◈ CONTACT KILLED · INTERVENTION TOO LATE');
      }
      reactAt(e.lon, e.lat, 'dismay');
      sound.play('denied');
      updateUnitHud();
      break;

    case 'escaped':
      resistance.aggravate(ESCAPE_RESISTANCE);
      toast('◈ PURSUIT LOST · VEHICLE CLEARED THE THEATER');
      sound.play('denied');
      break;

    case 'resolved':
      incidentFocus = undefined;
      if (e.clean) {
        reactCompany();
        toast(`◈ ${INCIDENTS[e.kind].name} RESOLVED`);
      }
      break;
  }
}

/**
 * Fire and age live violations, and bill whatever lapsed unanswered.
 *
 * Ignoring a jaywalker costs nothing but the fee — which is right, and is most of the stream. What
 * does cost is letting a SUSPICIOUS event lapse: that was the net telling you something and you
 * didn't look, and the ground reads the difference between a programme that watches and one that
 * only collects.
 */
const LAPSED_SUSPICIOUS_RESISTANCE = 0.006;
function runLiveViolations(dt: number) {
  if (!unitField || !sensorField || mode !== 'theater') return;
  const lapsed = unitField.stepViolations(dt, sensorField.obeliskCount, (lon, lat) =>
    sensorField?.servicingSite(lon, lat) ?? null,
  );
  for (const l of lapsed) {
    if (l.live.def.cls === 'suspicious') resistance.aggravate(LAPSED_SUSPICIOUS_RESISTANCE);
  }
}

/**
 * Draw a ping over every open accusation, and over the installation that raised it.
 *
 * Rebuilt each frame because the accused are walking: a marker that lagged its contact would send
 * the operator to click on whoever is standing where the accused used to be.
 */
function updatePings(dt: number) {
  if (!pings) return;
  pings.begin();
  if (unitField && theaterMap && mode === 'theater') {
    for (const v of unitField.liveViolations()) {
      const at = unitField.worldPositionOf(v.index);
      if (!at) continue;
      const site = Cesium.Cartesian3.fromDegrees(
        v.live.siteLon,
        v.live.siteLat,
        theaterMap.heightAt(v.live.siteLon, v.live.siteLat) + 180,
      );
      pings.add(at, site);
    }
  }
  pings.end(dt);
}

/**
 * Acting on a live violation.
 *
 * Two verbs, and the difference between them is the game.
 *
 * A FINE answers the EVENT. It is valid if the contact actually did the thing, which was decided
 * when the accusation fired and is never shown — so a 69% reading is right about seven times in ten
 * and there is no way to know which time you are in. It pays, immediately, and it is the operator's
 * income.
 *
 * An INVESTIGATION answers the PERSON. It ignores whether they ran the stop sign and asks whether
 * they are infected, which is a different question with a different answer. It pays nothing, risks
 * the public, and is the only route to the mission chain's serious business.
 *
 * Public tolerance is a PRICE on both, never a wall: ordering below the bar is always allowed and
 * always charges resistance in proportion to how far below it you went. That rule predates this
 * system and it would be wrong to break it here — being able to do the indefensible thing is the
 * whole reason the meter exists.
 */
const FINE_INVALID_RESISTANCE = 0.012;
const INVESTIGATE_FALSE_RESISTANCE = 0.02;

/** How far below the public bar this call sat, 0 when it cleared. */
function shortfallOf(certainty: number): number {
  return Math.max(0, tolerance.threshold - certainty);
}

function issueFine(index: number): boolean {
  if (!unitField) return false;
  const live = unitField.liveOf(index);
  if (!live) return false;
  // Suspicious-class events have no fine attached: there is no ticket for "we didn't like the look
  // of it", and being unable to monetise those is what pushes the operator toward investigating.
  if (live.def.fine <= 0) {
    sound.play('denied');
    toast('◈ NO CITATION APPLIES · INVESTIGATE OR STAND DOWN');
    return false;
  }

  const under = shortfallOf(live.certainty);
  if (under > 0) resistance.aggravate(Math.min(0.08, under * 0.14));

  unitField.clearLive(index);
  const pos = unitField.positionOf(index);
  if (pos) markAction(pos.lon, pos.lat, 'fine');
  if (live.truth) {
    progression.award(live.def.fine);
    missions.report('fine', true);
    sound.play('purchase');
    if (pos) reactAt(pos.lon, pos.lat, 'approve');
    toast(`◈ CITATION ISSUED · ${live.def.label} · +${live.def.fine} TOKENS`);
  } else {
    // Wrong. The money still arrives — the citation was issued and the contact still has to pay it,
    // which is precisely the problem with charging people on a machine's guess.
    progression.award(live.def.fine);
    missions.report('fine', false);
    resistance.aggravate(FINE_INVALID_RESISTANCE);
    sound.play('denied');
    if (pos) reactAt(pos.lon, pos.lat, 'dismay');
    toast(`◈ CITATION DISPUTED · ${live.def.label} · CONTACT WAS CLEAN`);
  }
  updateUnitHud();
  updateUnitPanel();
  return true;
}

function investigateLive(index: number): boolean {
  if (!unitField) return false;
  const live = unitField.liveOf(index);
  if (!live) return false;

  const under = shortfallOf(live.certainty);
  if (under > 0) resistance.aggravate(Math.min(0.1, under * 0.18));

  const infected = unitField.isInfected(index);
  unitField.clearLive(index);
  const pos = unitField.positionOf(index);
  if (pos) markAction(pos.lon, pos.lat, 'investigate');

  missions.report('investigate', infected);
  if (infected) {
    sound.play('commit');
    if (pos) reactAt(pos.lon, pos.lat, 'approve');
    toast(`◈ INVESTIGATION UPHELD · ${live.def.label} CONCEALED A THREAT`);
  } else {
    resistance.aggravate(INVESTIGATE_FALSE_RESISTANCE);
    sound.play('denied');
    if (pos) reactAt(pos.lon, pos.lat, 'dismay');
    toast('◈ INVESTIGATION CLEARED · NOTHING FOUND · PUBLIC NOTICED');
  }
  updateUnitHud();
  updateUnitPanel();
  return true;
}

/** Where the live incident is, so the alert can fly the camera to it. */
let incidentFocus: { lon: number; lat: number } | undefined;

/**
 * A point `minM`–`maxM` from somewhere that no obelisk watches and that isn't at sea.
 *
 * Shared by the siege and the incident director. Trouble comes out of ground the net doesn't watch,
 * which is also the ground where infection actually lives — so this is both a spawn rule and a
 * piece of fiction that holds up.
 */
function darkPointNear(
  lon: number,
  lat: number,
  minM: number,
  maxM: number,
): { lon: number; lat: number } | null {
  for (let tries = 0; tries < 80; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = minM + Math.random() * (maxM - minM);
    const p = destDeg(lat, lon, r, a);
    if (sensorField && sensorField.isCovered(p.lon, p.lat)) continue;
    if (theaterMap && theaterMap.heightAt(p.lon, p.lat) < 1) continue; // not out at sea
    // Inside the theater disc, or it would walk in from off the edge of the map.
    const c = theaterCenter;
    if (c) {
      const mLon = 111_320 * Math.cos((c.lat * Math.PI) / 180);
      const dx = (p.lon - c.lon) * mLon;
      const dy = (p.lat - c.lat) * 111_320;
      if (Math.hypot(dx, dy) > THEATER_RADIUS_M * 0.92) continue;
    }
    return p;
  }
  return null;
}

/**
 * A point `minM`–`maxM` away that is on land and inside the theater. Coverage is not considered.
 */
function landPointNear(
  lon: number,
  lat: number,
  minM: number,
  maxM: number,
): { lon: number; lat: number } | null {
  for (let tries = 0; tries < 60; tries++) {
    const a = Math.random() * Math.PI * 2;
    const r = minM + Math.random() * (maxM - minM);
    const p = destDeg(lat, lon, r, a);
    if (theaterMap && theaterMap.heightAt(p.lon, p.lat) < 1) continue;
    const c = theaterCenter;
    if (c) {
      const mLon = 111_320 * Math.cos((c.lat * Math.PI) / 180);
      if (Math.hypot((p.lon - c.lon) * mLon, (p.lat - c.lat) * 111_320) > THEATER_RADIUS_M * 0.92) continue;
    }
    return p;
  }
  return null;
}

/**
 * Stand up the incident director. Shares the siege's spawn helper for finding unwatched ground.
 */
function startIncidents(field: UnitField) {
  stopIncidents();
  incidents = new IncidentDirector(field, {
    darkPointNear: (lon, lat, minM, maxM) => darkPointNear(lon, lat, minM, maxM),
    landPointNear: (lon, lat, minM, maxM) => landPointNear(lon, lat, minM, maxM),
    missionComplete: (id) => missions.isComplete(id),
    // Trouble starts where there are people to make it: a site is the cheapest proxy for that,
    // since the network was built where the population is.
    populatedPoint: () => {
      const site = sensorField?.randomSite();
      if (!site) return theaterCenter ?? null;
      // Offset so incidents don't all happen on top of an obelisk.
      const mLon = 111_320 * Math.cos((site.lat * Math.PI) / 180);
      const a = Math.random() * Math.PI * 2;
      const r = 200 + Math.random() * 900;
      return { lon: site.lon + (Math.cos(a) * r) / mLon, lat: site.lat + (Math.sin(a) * r) / 111_320 };
    },
    on: onIncidentEvent,
  });
}

/**
 * Stand up the siege director for this theater. Needs the sensor field (to pick targets) and the
 * unit field (to put an attacker on the board), so it's built with the units, after the obelisks.
 */
/**
 * Which tasking has to be cleared before the network starts getting attacked.
 *
 * The custody tasking's own briefing opens with "the network is under attack", so the attacks have
 * to have started by then — but not on day one, when the operator has one site, one quadruped and
 * no reason yet to think anyone objects to them.
 */
const SIEGE_REQUIRES = 'mandate';

function startSiege(field: UnitField) {
  stopSiege();
  if (!sensorField) return;
  // Nothing walks at the net until the programme is large enough to have provoked anyone.
  if (!missions.isComplete(SIEGE_REQUIRES)) return;
  const director = new SiegeDirector(field, sensorField, {
    globalIndex: (local) => theaterSiteIndex?.[local] ?? -1,
    detainers: () =>
      progression.ownedPlatforms().filter((id) => progression.platformHas(id, 'detain')),
    // The home base defends itself, once custody authority exists to allow it.
    homeGarrison: () =>
      theaterHome && missions.hasAuth('detain')
        ? { lon: theaterHome.lon, lat: theaterHome.lat, rangeM: GARRISON_DETAIN_M }
        : null,
    darkPointNear,
    on: onSiegeEvent,
  });
  scene.primitives.add(director.wrecks);
  siege = director;
}

function stopIncidents() {
  incidents?.cancel();
  incidents = undefined;
}

function stopSiege() {
  if (siege) {
    scene.primitives.remove(siege.wrecks); // remove() destroys the collection
    siege = undefined;
  }
}

function removeUnits() {
  if (unitField) {
    for (const k of UNIT_KINDS) scene.primitives.remove(unitField.batches[k]);
    scene.primitives.remove(unitField.marksLayer);
    scene.primitives.remove(unitField.droneRing);
    scene.primitives.remove(unitField.platformIcons);
    unitField = undefined;
  }
  if (lasers) {
    scene.primitives.remove(lasers.collection); // remove() destroys the collection
    lasers = undefined;
  }
  if (reactions) {
    scene.primitives.remove(reactions.collection);
    reactions = undefined;
  }
  if (actionMarks) {
    scene.primitives.remove(actionMarks.collection);
    actionMarks = undefined;
  }
  if (routes) {
    scene.primitives.remove(routes.lines);
    scene.primitives.remove(routes.markers);
    routes = undefined;
  }
  if (pulse) {
    scene.primitives.remove(pulse.collection);
    pulse = undefined;
  }
  if (scans) {
    scene.primitives.remove(scans.collection);
    scans = undefined;
  }
  if (blasts) {
    scene.primitives.remove(blasts.rings);
    scene.primitives.remove(blasts.cores);
    blasts = undefined;
  }
  if (sparks) {
    scene.primitives.remove(sparks.collection);
    sparks = undefined;
  }
  if (rounds) {
    scene.primitives.remove(rounds.collection);
    rounds = undefined;
  }
  if (flashes) {
    scene.primitives.remove(flashes.collection);
    flashes = undefined;
  }
  if (impacts) {
    scene.primitives.remove(impacts.collection);
    impacts = undefined;
  }
  if (cuffs) {
    scene.primitives.remove(cuffs.collection);
    cuffs = undefined;
  }
  if (pings) {
    scene.primitives.remove(pings.collection);
    pings = undefined;
  }
  if (dropSites) {
    scene.primitives.remove(dropSites.collection); // remove() destroys it, taking the drops with it
    dropSites = undefined;
  }
  stopSiege();
  stopIncidents();
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
    // Arrivals resolve in both modes — it's how a move (or, later, an attack) order completes.
    resolveArrivals(dt);

    if (rtsGame) {
      // RTS frame: the economy ticks and the selection/route UI tracks the units. NONE of the
      // surveillance subsystems (violations, marking, process actions, siege, incidents) run — an
      // RTS match is a different game that only borrows the scene.
      rtsGame.tick(dt, countLiveObelisks());
      // Advance production and roll finished units out to their rally points.
      const produced = rtsGame.tickProduction(dt);
      for (const c of produced) spawnProducedUnit(c.structureId, c.unit);
      // Advance any structures a worker is building on site.
      rtsConstructionTick(dt);
      for (const done of rtsGame.tickResearch(dt)) applyResearch(done.id, done.kinds);
      rtsGame.tickAbilities(dt);
      // Tethers are static geometry between builds; only the dash crawl runs every frame.
      if (rtsPowerSig !== rtsGame.structures.length) refreshPowerLines();
      rtsBuild?.update(dt);
      rtsGame.tickUnrest(dt);
      runRtsObjectives(dt);
      refreshUnrestRings();
      runMillstone(dt);
      runRtsCombat(dt);
      rtsGame.tickUnits(dt); // shield/energy regen
      // Traffic-incident economy: obelisks catch violations; auto-fine collects them, else they ping.
      runRtsViolations(dt);
      updateRtsHud();
      // The queue progress bar animates and an ability chip counts its cooldown down, so repaint the
      // card while the selected building has either running.
      if (
        rtsSelectedStructure &&
        (rtsGame.queueAt(rtsSelectedStructure.id).length || rtsGame.abilityBusy(rtsSelectedStructure.id))
      ) {
        rtsCmd?.render();
      }
      rebuildRoster();
      refreshRoster();
      updateRouteLayer();
      updateUnitPanel(); // in a match this renders the RTS unit card (see the guard inside)
    } else {
      // Campaign frame: the full surveillance loop.
      // Orders age first: an investigation that commits this frame goes on the ledger, and an
      // execution that commits becomes eligible for the laser pass immediately below.
      const committed = unitField.advanceOrders(dt);
      if (committed.length) sound.play('commit');
      for (const c of committed) {
        missions.report('investigate', c.valid);
        markAction(c.lon, c.lat, 'investigate');
        reactAt(c.lon, c.lat, c.valid ? 'approve' : 'dismay');
      }
      resolveExecutions();
      updateScanBeams(dt);
      updateSiegeSparks(dt);
      runLiveViolations(dt);
      updatePings(dt);
      runAutoMarking(dt);
      runProcessActions(dt);
      runDelivery(dt);
      runAssetGoodwill(dt);
      siege?.update(dt);
      incidents?.update(dt);
      updateSiegeHud();
      updateIncidentHud();
      updateAlertHud();
      rebuildRoster();
      refreshRoster();
      updateRouteLayer();
      updateUnitPanel(); // keep the selection panel + reticle tracking the live unit
    }
  }
  lasers?.update(dt);
  reactions?.update(dt);
  actionMarks?.update(dt);
  updateAttackPulse();
  pulse?.update(dt);
  blasts?.update(dt);
  sparks?.update(dt);
  flashes?.update(dt);
  cuffs?.update(dt);
  impacts?.update(dt);
  dropSites?.update(dt);
});

/**
 * Put an airdropped site on the ground.
 *
 * The drop is added to the LIVE sensor field rather than to any parallel structure, which is what
 * makes it a real obelisk: coverage, servicing and the alert glow all come from the field, so it
 * inherits every network upgrade the campaign owns with no code that knows it is temporary.
 */
function airdropAt(lon: number, lat: number): boolean {
  if (!dropSites || !sensorField || !theaterMap || mode !== 'theater') return false;
  if (!progression.has('airdrop')) return false;
  if (progression.tokens < AIRDROP_COST) {
    sound.play('denied');
    toast(`◈ INSUFFICIENT FUNDING · ${AIRDROP_COST} TOKENS PER SITE`);
    return false;
  }
  const ground = theaterMap.heightAt(lon, lat);
  if (ground < 1) {
    sound.play('denied');
    toast('◈ CANNOT DEPLOY AT SEA');
    return false;
  }

  const apex = dropSites.add(lon, lat, ground);
  if (sensorField.addSite(lon, lat, apex) < 0) {
    sound.play('denied');
    toast('◈ DEPLOYMENT LIMIT REACHED IN THIS THEATER');
    return false;
  }
  progression.spend(AIRDROP_COST);
  sound.play('purchase');
  // A drop lands: the same impact vocabulary as everything else that arrives from the air.
  impacts?.at(apex, 160, 0.8, 18);
  reactCompany();
  toast(`◈ SITE DEPLOYED · ${dropSites.count} ACTIVE · −${AIRDROP_COST} TOKENS`);
  updateUnitHud();
  return true;
}

/** Where the home garrison throws a restraint round from. */
function garrisonThrowPoint(): Cesium.Cartesian3 | undefined {
  if (!theaterHome || !theaterMap) return undefined;
  const apex = sensorField?.servicingApex(theaterHome.lon, theaterHome.lat);
  return apex
    ? Cesium.Cartesian3.clone(apex)
    : Cesium.Cartesian3.fromDegrees(
        theaterHome.lon,
        theaterHome.lat,
        theaterMap.heightAt(theaterHome.lon, theaterHome.lat) + 120,
      );
}

/** Close the ground menu, if one is up. */
function closeGroundMenu() {
  document.getElementById('g-ground-menu')?.remove();
}

/**
 * The ground menu.
 *
 * Right-clicking open ground used to be an immediate move order, and for a campaign with no airdrop
 * capability it still is — the menu only appears once there is more than one thing that a click on
 * empty ground could mean. That keeps the fast gesture fast for anyone who hasn't bought the
 * capability, and matches how right-clicking a CONTACT already works.
 */
function openGroundMenu(screenX: number, screenY: number, lon: number, lat: number, append: boolean) {
  closeGroundMenu();
  const sel = unitField?.selectedPlatform();
  const box = document.createElement('div');
  box.id = 'g-ground-menu';
  box.className = 'g-context';
  box.style.left = `${screenX}px`;
  box.style.top = `${screenY}px`;
  box.innerHTML = `<div class="gc-head">${lat.toFixed(4)}, ${lon.toFixed(4)}</div>`;

  if (sel) {
    const move = document.createElement('button');
    move.type = 'button';
    move.className = 'gc-item';
    move.innerHTML = `<span class="gc-label">${append ? 'QUEUE WAYPOINT' : 'MOVE HERE'}</span>`;
    move.addEventListener('click', () => {
      closeGroundMenu();
      if (unitField?.orderSelection(lon, lat, append)) {
        sound.play('move');
        updateUnitPanel();
      }
    });
    box.append(move);
  }

  const drop = document.createElement('button');
  drop.type = 'button';
  drop.className = 'gc-item';
  const short = progression.tokens < AIRDROP_COST;
  drop.disabled = short;
  drop.innerHTML =
    `<span class="gc-label">AIRDROP OBELISK · ${AIRDROP_COST}</span>` +
    (short ? `<span class="gc-why">INSUFFICIENT FUNDING</span>` : '');
  if (!short) {
    drop.addEventListener('click', () => {
      closeGroundMenu();
      airdropAt(lon, lat);
    });
  }
  box.append(drop);

  document.body.append(box);
  const dismiss = () => {
    closeGroundMenu();
    window.removeEventListener('pointerdown', dismiss, true);
  };
  window.setTimeout(() => window.addEventListener('pointerdown', dismiss, true), 0);
}

/** Close the Millstone spawn menu, if one is up. */
function closeMillstoneMenu() {
  document.getElementById('g-millstone-menu')?.remove();
}

/**
 * DEV ONLY — the Millstone spawn menu.
 *
 * Shift + right-click on theater ground lists Millstone's entire roster and drops whichever chassis
 * you pick on that spot, armed exactly as a wave would send it. It exists to answer "what does a
 * leviathan actually do to this line" without playing to wave six to find out, which is why it is
 * marked DEV ONLY in the header rather than dressed up as a game feature.
 *
 * The roster is read from MILLSTONE_UNIT_LIST rather than written out, so a new chassis appears here
 * the moment it exists.
 *
 * Shift already meant "queue this leg behind the current order", and that gesture is not thrown away
 * to make room: with a unit selected, QUEUE WAYPOINT is the first item in the menu. It costs one
 * click where it used to cost none, and nothing that worked before has become unreachable.
 */
function openMillstoneSpawnMenu(screenX: number, screenY: number, lon: number, lat: number) {
  closeMillstoneMenu();

  /**
   * Close for good: drop the menu AND stop listening.
   *
   * The click-away listener must ignore pointerdowns that land inside the menu, and this is not a
   * nicety — a capture-phase `pointerdown` that removes the box detaches the button before the
   * browser can deliver its `click`, so the item handler never runs and every pick reads as a dead
   * click. Measured in Chromium against this menu, not assumed.
   */
  function done() {
    closeMillstoneMenu();
    window.removeEventListener('pointerdown', dismiss, true);
  }
  function dismiss(e: PointerEvent) {
    if (!box.contains(e.target as Node)) done();
  }

  const box = document.createElement('div');
  box.id = 'g-millstone-menu';
  box.className = 'g-context g-spawn';
  box.innerHTML =
    `<div class="gc-head">DEV ONLY · FIELD MILLSTONE UNIT` +
    `<span class="gc-sub">${lat.toFixed(4)}, ${lon.toFixed(4)}</span></div>`;

  // The shift gesture's original meaning, kept reachable — for the whole selection, not just a
  // single machine, since shift + right-click is a move order like any other.
  const ordering = unitField?.selectedPlatformCount() ?? 0;
  if (ordering) {
    const queue = document.createElement('button');
    queue.type = 'button';
    queue.className = 'gc-item';
    queue.innerHTML = `<span class="gc-label">QUEUE WAYPOINT${ordering > 1 ? ` · ${ordering} UNITS` : ''}</span>`;
    queue.addEventListener('click', () => {
      done();
      if (unitField?.orderSelection(lon, lat, true)) {
        cancelConstructionsFor(unitField.selectedPlatforms());
        sound.play('move');
        updateUnitPanel();
      } else {
        sound.play('denied');
        toast('◈ NO ROUTE TO THAT GROUND');
      }
    });
    box.append(queue);
  }

  // Millstone's units are RTS-match units: there is no enemy army outside a skirmish for them to
  // belong to. Say that on the items rather than letting nine live-looking buttons each fail.
  const inMatch = !!rtsGame && !rtsEnded;

  for (const u of MILLSTONE_UNIT_LIST) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'gc-item lethal';
    b.disabled = !inMatch;
    b.innerHTML =
      `<span class="gc-label">${u.name} · ANSWERS ${u.counterpart}</span>` +
      (inMatch ? '' : `<span class="gc-why">NO ACTIVE SKIRMISH</span>`);
    b.title = u.blurb;
    if (inMatch) {
      b.addEventListener('click', () => {
        done();
        spawnMillstoneAt(u.meshKind, lon, lat);
      });
    }
    box.append(b);
  }

  // Ten items is tall enough to run off the bottom of the window from a click low on the map, so
  // this one menu is placed against the viewport instead of blindly at the cursor.
  box.style.left = `${screenX}px`;
  box.style.top = `${screenY}px`;
  document.body.append(box);
  const r = box.getBoundingClientRect();
  const pad = 8;
  if (r.bottom > window.innerHeight - pad) {
    box.style.top = `${Math.max(pad, window.innerHeight - pad - r.height)}px`;
  }
  if (r.right > window.innerWidth - pad) {
    box.style.left = `${Math.max(pad, window.innerWidth - pad - r.width)}px`;
  }

  window.setTimeout(() => window.addEventListener('pointerdown', dismiss, true), 0);
}

/**
 * Throw a restraint round at a point, from whatever plausibly threw it.
 *
 * The automatic detain sweep doesn't say which asset acted — it only reports that the attacker was
 * taken — so the source is reconstructed: the home garrison if the point is inside its reach,
 * otherwise the nearest platform that could have done it. Getting that wrong draws the round from
 * slightly the wrong machine, which is a far smaller problem than not drawing it at all.
 */
function throwCuffsAt(lon: number, lat: number) {
  if (!cuffs || !theaterMap || !unitField) return;
  const to = Cesium.Cartesian3.fromDegrees(lon, lat, theaterMap.heightAt(lon, lat) + 6);

  const mLon = 111_320 * Math.cos((lat * Math.PI) / 180);
  const rangeTo = (a: { lon: number; lat: number }) =>
    Math.hypot((a.lon - lon) * mLon, (a.lat - lat) * 111_320);

  if (theaterHome && rangeTo(theaterHome) <= GARRISON_DETAIN_M) {
    const apex = sensorField?.servicingApex(theaterHome.lon, theaterHome.lat);
    cuffs.fire(
      apex
        ? Cesium.Cartesian3.clone(apex)
        : Cesium.Cartesian3.fromDegrees(theaterHome.lon, theaterHome.lat, theaterMap.heightAt(theaterHome.lon, theaterHome.lat) + 120),
      to,
    );
    return;
  }

  let best: Cesium.Cartesian3 | null = null;
  let bestD = Infinity;
  for (const p of unitField.platformUnits()) {
    const st = unitField.platformStatus(p.index);
    if (!st) continue;
    const d = rangeTo(st);
    if (d < bestD) {
      bestD = d;
      best = unitField.worldPositionOf(p.index);
    }
  }
  if (best) cuffs.fire(best, to);
}

/**
 * Draw a sensor link to everyone currently under investigation.
 *
 * Rebuilt every frame rather than cached, because both ends move: the contact is walking and the
 * platform watching it may be flying a patrol. A link that lagged its endpoints would be worse than
 * no link at all — it would point at where the drone used to be.
 */
function updateScanBeams(dt: number) {
  if (!scans) return;
  scans.begin();
  if (unitField && mode === 'theater') {
    // Coverage, not armament: everything that can see contributes, armed or not.
    for (const b of unitField.scanBeams(
      sensorField ? (lon, lat) => sensorField?.servicingApex(lon, lat) : undefined,
      progression.ownedPlatforms(),
    )) {
      scans.add(b.from, b.to);
    }
  }
  scans.end(dt);
}

/**
 * Sparks off a site being cut into.
 *
 * Only once the attacker is actually IN CONTACT — while it is still walking there is nothing to
 * throw sparks off, and showing them during the approach would spend the one visual that says "the
 * clock is running" on the part where it isn't.
 */
const SPARK_RATE_HZ = 26;
let sparkDebt = 0;
function updateSiegeSparks(dt: number) {
  const a = siege?.inbound();
  if (!sparks || !unitField || !a || a.rangeM > 0) {
    sparkDebt = 0;
    return;
  }
  // Sparks come off the OBELISK, at its base — that is where the cutting is happening. Emitting
  // them from the attacker put the shower on a person standing next to a structure, which read as
  // the person being on fire rather than as the structure being taken apart.
  if (!theaterMap) return;
  const base = Cesium.Cartesian3.fromDegrees(a.tlon, a.tlat, theaterMap.heightAt(a.tlon, a.tlat) + 4);
  // Accumulate fractional emissions so the shower is frame-rate independent.
  sparkDebt += dt * SPARK_RATE_HZ;
  const n = Math.floor(sparkDebt);
  if (n <= 0) return;
  sparkDebt -= n;
  sparks.emit(base, Math.min(n, 6));
}

/**
 * What burning one company asset costs. Heavy on purpose: protected contacts carry the worst
 * charge sheets on the board and read as the most obviously guilty thing in the theater, so the
 * trap only works if springing it hurts.
 */
const ASSET_WRITE_OFF = 2500;

/**
 * The protected network quietly improves how the programme is seen, for as long as it's intact.
 *
 * This is never surfaced — no bar, no readout. The operator can only notice it by noticing that
 * tolerance climbs a little on its own, and that it stops climbing once they've spent a session
 * executing everyone with a severe record.
 */
const ASSET_TICK_S = 20;
const ASSET_TOLERANCE_PER_TICK = 0.0018;
let assetTimer = ASSET_TICK_S;
function runAssetGoodwill(dt: number) {
  if (!unitField) return;
  assetTimer -= dt;
  if (assetTimer > 0) return;
  assetTimer = ASSET_TICK_S;
  tolerance.advance(ASSET_TOLERANCE_PER_TICK * unitField.assetNetworkIntact());
}

/**
 * Every couple of minutes, walk one confirmed infected contact into the net.
 *
 * Infection concentrates in unwatched ground by design, which means a well-covered theater can go
 * quiet — nothing orderable inside the coverage the operator is standing in. This keeps a trickle
 * arriving so there is always something to work with, without removing the reason to go looking.
 */
const DELIVERY_INTERVAL_S = 120;
let deliveryTimer = DELIVERY_INTERVAL_S;
function runDelivery(dt: number) {
  if (!unitField || !sensorField) return;
  deliveryTimer -= dt;
  if (deliveryTimer > 0) return;
  deliveryTimer = DELIVERY_INTERVAL_S;
  const site = sensorField.randomSite();
  if (site) unitField.deliverInfected(site.lon, site.lat);
}

/**
 * Give a thin theater something to do on arrival.
 *
 * Only when coverage is genuinely sparse. A developed net already has plenty inside it, and
 * arranging a target there would be putting a thumb on a scale that doesn't need it.
 */
const STARTER_TARGET_MAX_SITES = 3;
function seedStarterTarget(field: UnitField) {
  if (!sensorField || sensorField.fixedCount > STARTER_TARGET_MAX_SITES) return;
  const site = theaterHome ?? sensorField.randomSite();
  if (!site) return;
  field.seedStarterTarget(site.lon, site.lat, sensorRangeM * 0.85);
}

/**
 * Hidden pockets of infected out in unwatched ground.
 *
 * Count scales inversely with how well the theater is covered: a fully proliferated state gets one
 * pocket, a downtown-tier state gets several, because a sparse theater is mostly dark and needs
 * more than one reason to be crossed.
 */
function seedHiddenPockets(field: UnitField) {
  if (!theaterCenter || !theaterMap) return;
  const sites = sensorField?.obeliskCount ?? 1;
  // Resistance multiplies what is hiding out there: a theater worked past consent grows cells.
  const base = Math.max(1, Math.min(6, Math.round(600 / Math.max(1, sites))));
  const pockets = Math.max(1, Math.min(10, Math.round(base * resistance.pressure)));
  let placed = 0;
  for (let p = 0; p < pockets; p++) {
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = (0.25 + Math.random() * 0.65) * THEATER_RADIUS_M;
      const pt = destDeg(theaterCenter.lat, theaterCenter.lon, r, a);
      if (sensorField?.isCovered(pt.lon, pt.lat)) continue; // must be hidden
      if (theaterMap.heightAt(pt.lon, pt.lat) < 1) continue; // not at sea
      const size = Math.round((14 + Math.floor(Math.random() * 12)) * resistance.pressure);
      field.spawnHiddenCluster(pt.lon, pt.lat, size, 900);
      placed++;
      break;
    }
  }
  setText('g-pockets', String(placed));
}

/**
 * Platforms arriving at what they were ordered to do.
 *
 * Every one of these started as a right-click on a contact and a choice from the menu — nothing
 * here decides anything on its own. Strikes are the only ones with a bill attached: collateral
 * hardens the ground exactly the way ordering past consent does, because from the street it is the
 * same event.
 */
const COLLATERAL_RESISTANCE = 0.02;
function resolveArrivals(dt: number) {
  if (!unitField) return;
  const { strikes, detainedAttacker, detainedIncidents, imprisoned, detainments } =
    unitField.resolveArrivals(dt);
  if (imprisoned > 0) {
    // Spoken about differently to custody on purpose. A detainment is an arrest; this is a sentence
    // decided by a contractor reading a probability score, and the card should not let that pass as
    // the same event.
    sound.play('order');
    toast(`◈ ${imprisoned} CONTACT${imprisoned > 1 ? 'S' : ''} SENTENCED · NO HEARING`);
    updateUnitHud();
  }
  // Every detainment throws, whether or not it was the siege attacker.
  for (const d of detainments) {
    cuffs?.fire(d.from, d.to);
    markAt(d.to, d.prison ? 'prison' : 'detain');
  }
  if (detainedAttacker) {
    // The director keeps the siege clock, so it has to be told this ended in custody.
    siege?.noteAttackerStruck();
    sound.play('order');
    reactCompany();
    toast('◈ ATTACKER DETAINED');
    updateUnitHud();
  }
  if (detainedIncidents > 0) {
    sound.play('order');
    reactCompany();
    toast(`◈ ${detainedIncidents} CONTACT${detainedIncidents > 1 ? 'S' : ''} DETAINED`);
    updateUnitHud();
  }
  for (const strike of strikes) {
    if (theaterMap) {
      const h = theaterMap.heightAt(strike.lon, strike.lat);
      // The munition falling, then the detonation it becomes. The ring stops at the weapon's real
      // lethal radius, so what the operator sees expanding is exactly the ground they just cleared.
      lasers?.fire(
        Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat, h + 2400),
        Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat, h),
      );
      blasts?.fire(strike.lon, strike.lat, h, INTERCEPT.blastM);
      // The world ring is the truth about the lethal radius; this is the part that survives zoom.
      impacts?.at(Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat, h), 300, 1.0, 24);
      // Debris off the seat of the blast, thrown much harder than a cutting torch throws sparks.
      sparks?.emit(Cesium.Cartesian3.fromDegrees(strike.lon, strike.lat, h + 6), 18);
    }
    markAction(strike.lon, strike.lat, 'execute');
    sound.play('laser');
    // Only a strike that actually caught the attacker ends the siege. This used to fire on every
    // strike, so blowing up an unrelated contact on the far side of the theater silently reset the
    // attack clock and bought the operator a free reprieve.
    if (strike.killedAttacker) siege?.noteAttackerStruck();

    if (strike.collateral > 0) {
      // Flat, not squared. This was routed through transgress(), whose shortfall curve turned six
      // dead bystanders into a 0.003 movement — the collateral was being counted and then thrown
      // away. An area weapon killing people who were not the target is not a borderline judgement
      // call and should not be priced like one.
      resistance.aggravate(Math.min(1, COLLATERAL_RESISTANCE * strike.collateral));
      reactAt(strike.lon, strike.lat, 'dismay');
      toast(
        `◈ STRIKE · ${strike.killed} DOWN · ${strike.collateral} BYSTANDER${strike.collateral > 1 ? 'S' : ''} LOST`,
      );
    } else {
      reactCompany();
      toast('◈ STRIKE · TARGET DOWN · NO COLLATERAL');
    }
  }
  if (strikes.length) updateUnitHud();
}

/**
 * Marking automation, once it's been commissioned.
 *
 * Rate-limited hard on purpose: the unit field could hand back a hundred qualifying contacts in a
 * frame, and an automation that emptied the field into the ledger before the operator could look at
 * it would be a different feature — and would blow the invalid ceiling on one bad threshold.
 */
const AUTO_INTERVAL_S = 2.5;
let autoTimer = 0;
function runAutoMarking(dt: number) {
  if (!unitField) return;
  const wantsExec = progression.has('auto-execute') && missions.hasAuth('execute');
  const wantsInv = progression.has('auto-investigate');
  if (!wantsExec && !wantsInv) return;

  autoTimer -= dt;
  if (autoTimer > 0) return;
  autoTimer = AUTO_INTERVAL_S;

  // Lethal automation takes precedence when both are running and a tasking calls for it.
  const kind = wantsExec && missions.markKind() === 'execute' ? 'execute' : 'investigate';
  if (kind === 'investigate' && !wantsInv) return;
  if (unitField.autoMark(kind, progression.autoThreshold(kind))) {
    sound.play(kind === 'execute' ? 'orderLethal' : 'order');
  }
}

/**
 * Process Actions — the operator's own standing rules (game/processActions.ts).
 *
 * Rate-limited like the flagging automation, and for the same reason: a rule that emptied the field
 * into the ledger in one frame would be a different, worse feature. One match per armed rule per
 * tick, carried out through the same fine / mark / dispatch paths a hand order uses — so a
 * rule-driven execution is scored, reacts and hardens exactly as if the operator had made the call.
 */
const PROCESS_INTERVAL_S = 2.0;
let processTimer = 0;
function runProcessActions(dt: number) {
  if (!unitField) return;
  const active = processActions.activeRules();
  if (!active.length) return;
  processTimer -= dt;
  if (processTimer > 0) return;
  processTimer = PROCESS_INTERVAL_S;
  for (const { rule } of active) {
    // Detain and execute rules only fire once the chain has granted the standing authority for them.
    if (rule.action === 'execute' && !missions.hasAuth('execute')) continue;
    if ((rule.action === 'detain' || rule.action === 'prison') && !missions.hasAuth('detain')) continue;
    const idx = unitField.matchForRule(rule);
    if (idx >= 0) applyProcessAction(idx, rule.action);
  }
}

/** Carry a Process Action out on one contact, reusing the same paths a hand order takes. */
function applyProcessAction(index: number, action: SanctionId) {
  if (!unitField) return;
  if (action === 'fine') {
    issueFine(index);
    return;
  }
  if (action === 'investigate') {
    if (unitField.liveOf(index)) investigateLive(index);
    else {
      unitField.markContact(index, 'investigate');
      sound.play('order');
    }
    return;
  }
  // Execution is serviced by the armed obelisk net or a laser platform that covers the contact — so
  // a standing kill rule MARKS the contact and the execution pass fires the beam, exactly like
  // AUTOMATED SANCTION does. The old path dispatched one laser PLATFORM per tick, so a rule set to
  // EXECUTE did nothing at all unless a laser drone happened to be fielded — the obelisk directed-
  // energy net, which is the whole reason a kill-on-sight rule is interesting, never got a look in.
  if (action === 'execute') {
    if (!hasExecuteEmitter()) return; // nothing can carry it out — don't leave a stale crosshair up
    if (unitField.markContact(index, 'execute')) sound.play('orderLethal');
    return;
  }
  // detain / prison still send a platform — somebody has to physically carry the contact off.
  const s = SANCTION_BY_ID.get(action);
  if (!s) return;
  if (unitField.dispatch(index, action, carriersFor(s, index))) sound.play('order');
}

/**
 * Whether anything can currently service an execution: the armed obelisk net (OBELISK DIRECTED
 * ENERGY over held ground), or a platform with a laser fitted. This is the same test the execution
 * pass makes before it fires a single beam, hoisted so a standing rule doesn't mark a contact it can
 * never carry out — and so the Process editor can warn when a lethal rule has no weapon behind it.
 */
function hasExecuteEmitter(): boolean {
  return (
    (progression.has('obelisk-laser') && !!sensorField) ||
    progression.ownedPlatforms().some((id) => progression.platformHas(id, 'laser'))
  );
}

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
    obeliskArmed ? (lon, lat) => sensorField?.servicingApex(lon, lat) : undefined,
    armed,
    (id) => progression.platformAreaM(id),
  );
  if (shots.length) sound.play('laser');
  for (const s of shots) {
    lasers.fire(s.from, s.to);
    // A crosshair lands wherever a beam does, target or bystander — the operator sees every kill.
    markAt(s.to, 'execute');
    if (s.collateral) {
      // Not an ordered mark, so it isn't scored — but an area weapon that kills a clean bystander
      // hardens the ground, and that is the price of using one where it shouldn't be used.
      if (!s.valid) {
        resistance.aggravate(AREA_COLLATERAL_RESISTANCE);
        reactAt(s.lon, s.lat, 'dismay');
      }
      continue;
    }
    // The beam is a half-second flash along a line; from theater altitude that line can be a few
    // pixels of a very big picture. The mark is what says WHERE it landed.
    impacts?.at(s.to, 120, 0.7);
    missions.report('execute', s.valid);
    reactAt(s.lon, s.lat, s.valid ? 'approve' : 'dismay');
  }
  if (shots.length) updateUnitHud();
}
/** How much a clean bystander caught in an area strike hardens the ground. Valid collateral is free. */
const AREA_COLLATERAL_RESISTANCE = 0.015;

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
/** The state's home site: a T-frame plus the ring that marks it as the base. */
let homeFrame: Cesium.Primitive | undefined;
let homeRing: Cesium.PolylineCollection | undefined;
/** Tiny red site dots, shown once the obelisk geometry has gone sub-pixel. */
let obeliskDots: Cesium.PointPrimitiveCollection | undefined;
/** Home-base rings on the orbit globe, one per held state. */
let orbitHomeRings: Cesium.PolylineCollection | undefined;

/** Camera distance past which the site dots take over from the geometry. Matches the platform icons. */
const SITE_DOT_FROM_M = 9000;

/** A small circle of positions around a point, for the home-base rings. */
function ringPositions(lon: number, lat: number, radiusM: number, height: number, segments = 48) {
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.15, Math.cos((lat * Math.PI) / 180)));
  const pts: Cesium.Cartesian3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(Cesium.Cartesian3.fromDegrees(lon + dLon * Math.cos(a), lat + dLat * Math.sin(a), height));
  }
  return pts;
}

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
let sensorRangeM = BASE_SENSOR_M;
// Platforms share this base (see BASE_SENSOR_M) — a bare platform watches the same disc a fixed
// site does, and gear is what extends it.
const SENSOR_RANGE_BASE = BASE_SENSOR_M;
const SENSOR_RANGE_UPRATED = 1200;

let sensorField: SensorField | undefined;

/**
 * What the scene is currently built for. Rebuilding a theater's obelisks and its 23k units is only
 * correct when OWNERSHIP moved — and mission events fire constantly (every single mark reports),
 * so without this guard a routine progress event would regenerate the whole field and silently wipe
 * the operator's standing marks mid-mission. Funding tokens deliberately aren't in the signature: earning
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
  if (unitField) {
    unitField.toleranceOverride = progression.has('emergency-powers');
    unitField.autoPatrol = {
      ground: missions.hasChosen('dragnet', 'patrol-ground'),
      air: missions.hasChosen('dragnet', 'patrol-air'),
    };
    unitField.hvtDesignate = missions.hasChosen('defend', 'hvt');
  }

  if (obelisks && territory) obeliskMask = progression.obeliskMask(territory, obelisks.count);

  const sig = ownershipSignature();
  const changed = sig !== appliedOwnership;
  appliedOwnership = sig;
  if (!rebuildScene || !changed) return;

  rebuildHeatField();
  rebuildOrbitHomeRings();
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

/**
 * A campaign with no home state hasn't started yet — put the founding window up. Also called after
 * a dev reset, which drops the campaign back to having chosen nothing.
 */
function maybeOfferStart() {
  if (!territory || progression.homeState) return;
  showStartWindow(territory, {
    onChosen: (s) => {
      applyOwnership(true);
      sound.play('purchase');
      toast(`FOUNDED IN ${s.name.toUpperCase()} · DOWNTOWN SITE ACTIVE`);
      camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(s.center.lon, s.center.lat, 2_400_000),
        duration: 2.2,
      });
    },
  });
}

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

/**
 * The world data every campaign shares: 115k obelisk sites, and the survey that turns them into
 * ownable territory.
 *
 * Kicked off at module load rather than when a slot is opened, so it warms while the operator is
 * still reading the title screen — by the time they've picked a campaign this has usually already
 * landed, and the map loading screen is a formality. It is campaign-INDEPENDENT, which is what
 * makes that safe: nothing here depends on which save is open.
 */
const worldReady: Promise<void> = loadObelisks()
  .then(async (field) => {
    obelisks = field;
    setText('g-obelisks', String(field.count));

    // The survey is what turns 115k anonymous points into ownable territory, so the heat field
    // waits for it — drawing every site first and then blanking most of them would flash the whole
    // map as "owned". It also warms the states-10m module a theater build needs later.
    territory = await surveyTerritory(field);
    setTitleTerritory(territory);
    store?.setTerritory(territory);
  })
  .catch((e) => {
    console.warn('[GORGON] obelisks failed to load:', e);
    setText('g-obelisks', 'ERR');
  });

/**
 * Bring a campaign up: open the slot, wait for the world, then reveal the map.
 *
 * Ownership can only be applied AFTER both halves are in — the survey (what territory exists) and
 * the slot (what of it is owned) — so this is the one place both are known to be ready. Doing it
 * any earlier is what used to flash the whole map as owned for a frame.
 */
async function openCampaign(slot: number): Promise<void> {
  setActiveSlot(slot);
  showLoading({ title: 'LOADING MAP', subtitle: `CAMPAIGN SLOT ${slot}` });
  setStage('READING CAMPAIGN RECORD');

  await worldReady;
  setStage('APPLYING TERRITORY OWNERSHIP');
  applyOwnership(true); // the store re-renders off progression.onChange, which the slot swap fired
  // Let the browser paint the revealed globe before the overlay lifts, so the fade reveals a drawn
  // map rather than a blank canvas that fills in a frame later.
  await nextFrame();
  setStage('READY');
  hideLoading();
  maybeOfferStart();
  // A campaign reopened mid-fork (quit before choosing) still owes that decision — surface it. The
  // founding window and a pending fork never coincide: a fork needs a cleared mission, which needs a
  // home, so this only fires once maybeOfferStart has nothing to show.
  presentPendingForks();
}

// ---- RTS skirmish ------------------------------------------------------------------------------
//
// A separate game that reuses the theater scene. It does not touch the campaign singletons — no slot
// is opened, progression/missions are left where they sit — so an RTS match and a campaign never
// bleed into each other. Everything RTS-specific hangs off the `rtsGame` flag.

/** Washington's FIPS. The skirmish always deploys here, the way the design sheet asks. */
const RTS_HOME_FIPS = '53';

/**
 * Start (or restart) an RTS skirmish over Washington.
 *
 * Resolves Washington's downtown obelisk as the Nexus, masks the theater down to that single site,
 * and enters the theater. buildTheater then stands up the mesh, the lone obelisk and the opening dog
 * (see platformStations / addUnits, which branch on `rtsGame`), and the economy tick begins.
 */
async function startRtsMatch(): Promise<void> {
  showLoading({ title: 'RTS SKIRMISH', subtitle: 'DEPLOYING TO WASHINGTON' });
  setStage('SURVEYING GROUND');
  await worldReady;
  const wa = territory?.byId.get(RTS_HOME_FIPS);
  if (!obelisks || !wa) {
    hideLoading();
    toast('◈ WASHINGTON SURVEY UNAVAILABLE');
    bootTitle();
    return;
  }
  const nexusIndex = wa.downtown;
  rtsGame = new RtsGame(nexusIndex, obelisks.lon[nexusIndex], obelisks.lat[nexusIndex]);

  // The match opens with the Nexus alone live; every other obelisk site in the theater is a build
  // slot the player fills later. Setting the mask directly bypasses the campaign ownership model
  // entirely — there is no progression behind an RTS game.
  obeliskMask = new Uint8Array(obelisks.count);
  obeliskMask[nexusIndex] = 1;
  fallenObelisks = new Set();
  sensorRangeM = SENSOR_RANGE_BASE;
  for (const p of PLATFORMS) PLATFORM_SENSOR[p.id] = PLATFORM_BY_ID.get(p.id)?.sensorM ?? BASE_SENSOR_M;
  // The skidsteer worker has no catalog entry; give it a modest disc so it has some vision of its own.
  PLATFORM_SENSOR['skid'] = BASE_SENSOR_M;

  el('g-rts')?.removeAttribute('hidden');
  updateRtsHud();

  // enterTheater sets mode='theater', flies the camera and kicks buildTheater (which owns its own
  // loading screen), so hand the overlay off to it.
  hideLoading();
  enterTheater(Cesium.Cartographic.fromDegrees(obelisks.lon[nexusIndex], obelisks.lat[nexusIndex]));
}

/** End the current RTS match and return to the title screen. */
function endRtsMatch(): void {
  if (!rtsGame) return;
  // Tear the build layer down first (it owns primitives exitTheater doesn't know about), then the
  // theater the normal way, then clear RTS state and re-show the menu.
  teardownRtsBuild();
  if (mode === 'theater') exitTheater();
  rtsGame = null;
  obeliskMask = undefined;
  el('g-rts')?.setAttribute('hidden', '');
  // exitTheater flew the camera to the world map; pull straight back to the title instead.
  hideUnitPanel();
  bootTitle();
}

/** Push the RTS economy numbers into the match HUD. Cheap; called on every economy change. */
function updateRtsHud(): void {
  if (!rtsGame) return;
  const obeliskCount = territory ? countLiveObelisks() : 1;
  setText('grts-money', rtsGame.money.toLocaleString('en-US'));
  setText('grts-cap', `/ ${rtsGame.cap(obeliskCount).toLocaleString('en-US')}`);
  setText('grts-obelisks', String(obeliskCount));
  setText('grts-supply', `${rtsGame.supplyUsed} / ${rtsGame.supplyCap()}`);
  // Public unrest, and what it is costing. Shown whenever a data center stands OR the ground is
  // still cooling off, so the number appears the moment the player does the thing that causes it and
  // then visibly stays after they stop.
  const dc = rtsGame.dataCenterCount();
  const unrest = rtsGame.unrest;
  const auth = rtsAuthority();
  setText('grts-auth', auth > 0 ? `AUTH ${auth} · ${AUTHORITY_TIERS[auth].name}` : 'NO ENFORCEMENT AUTHORITY');
  setText(
    'grts-unrest',
    dc || unrest > 0.01
      ? `PUBLIC ${unrestLabel(unrest)} · ${Math.round(unrest * 100)}% · ${dc} DATA CENTER${dc === 1 ? '' : 'S'}`
      : '',
  );
  // The threat line: how much of Millstone stands, and how long until it knocks again.
  if (millstone) {
    const pct = Math.round((millstone.hp / millstone.maxHp) * 100);
    const fast = rtsGame.unrestPressure;
    setText(
      'grts-threat',
      millstone.destroyed
        ? 'MILLSTONE RAZED'
        : `MILLSTONE ${pct}% · NEXT WAVE ${Math.ceil(millstone.nextWaveS(fast))}S` +
          (fast > 1.02 ? ` · ${fast.toFixed(2)}× (UNREST)` : ''),
    );
  } else {
    // Say so rather than showing an empty line: a blank threat readout reads as broken, and "no
    // opposition" is a deliberate state while the build order is being tuned.
    setText('grts-threat', millstoneEnabled ? '' : 'PEACEFUL · NO OPPOSITION');
  }
}

/** How many obelisks the match currently fields — the mask minus anything fallen. */
function countLiveObelisks(): number {
  const mask = liveObeliskMask();
  if (!mask) return 0;
  let n = 0;
  for (let i = 0; i < mask.length; i++) n += mask[i];
  return n;
}

// ---- RTS build system --------------------------------------------------------------------------
//
// The base-building loop. Obelisks ride the existing obelisk/sensor rebuild (a built one is a real
// network site with coverage); facilities are a separate marker layer with their own placement
// rules — near a road, and inside the power radius of an obelisk. Everything routes through the
// rtsGame money and the rtsBuild render layer.
//
// Note what is NOT here any more: a facility used to have to sit within reach of the Nexus or of
// another facility, and a `isFacility` helper existed to answer "does this count as an anchor". The
// obelisk power rule replaced that outright — buildings anchor to obelisks now, and to nothing else,
// so the anchor concept and its helper are gone rather than left lying around half-used.

/** Stand up the build layer + command bar for a fresh match. Called once, from buildTheater. */
function setupRtsBuild(map: TheaterMap, net: RoadNet | undefined): void {
  if (!rtsGame || !obelisks || !theaterCenter) return;
  rtsSites = computeRtsSites();
  rtsBuiltSites.clear();
  rtsBuiltSites.add(rtsGame.nexusIndex);

  rtsBuild = new RtsBuildLayer(net, theaterCenter, map.heightAt);
  scene.primitives.add(rtsBuild.siteDots);
  scene.primitives.add(rtsBuild.rings);
  scene.primitives.add(rtsBuild.icons);
  scene.primitives.add(rtsBuild.ghost);
  scene.primitives.add(rtsBuild.rallyDots);
  scene.primitives.add(rtsBuild.construction);
  scene.primitives.add(rtsBuild.power);
  scene.primitives.add(rtsBuild.unrest);
  for (const b of rtsBuild.meshBatches) scene.primitives.add(b); // 3D building models
  rtsSitesAllOpen = false;
  rtsConstruction = [];
  rtsBuild.setSites(rtsSites, rtsBuiltSites);

  // The opening workers were spawned by the UnitField constructor — register them into the RTS unit
  // roster (which sets health/shield/energy and charges their supply), so they read as builders and
  // carry a unit card like anything produced later.
  rtsGame.unitStates.clear();
  if (unitField) {
    for (const u of unitField.platformUnits()) {
      if (u.kind === 'skid') rtsGame.registerUnit(u.index, 'worker');
      // Everything the player opens with is a combatant from the first frame — and now that means
      // ALL of them: the worker swings a bucket rather than standing there being dismantled.
      if (RTS_COMBAT[u.kind]) {
        unitField.armRtsCombat(u.index, 0, armamentOf(u.kind, rtsGame.researched));
      }
    }
  }

  // Millstone stands its base up across the map: a Nexus on a surveyed site at raiding distance,
  // a garrison around it, and the wave clock starts running.
  //
  // HELD OFF BY DEFAULT while the economy and tech tree are being tuned — an attacker arriving at
  // 150 s makes it impossible to judge whether the BUILD ORDER feels good, which is the question on
  // the table. The whole enemy is intact behind this flag; flip it to bring the fight back.
  rtsEnded = false;
  millstone = null;
  if (millstoneEnabled) {
    millstone = pickMillstoneBase();
    if (millstone) {
      rtsBuild.setEnemyNexus(millstone.lon, millstone.lat);
      if (unitField) {
        for (const g of millstone.garrison()) {
          unitField.spawnRtsEnemy(g.kind, g.lon, g.lat, armamentOf(g.kind), true);
        }
      }
    }
  }

  rtsCmd = new RtsCommandBar({
    money: () => rtsGame?.money ?? 0,
    context: rtsCommandContext,
    placing: () => rtsPlacing,
    onBuild: (type) => beginPlacement(type),
    onProduce: (unit) => enqueueUnit(unit),
    queueOf: (sid) => rtsGame?.queueAt(sid) ?? [],
    buildBlocker: (type) => rtsGame?.structureBlocker(type) ?? null,
    produceBlocker: (unit) => {
      const def = RTS_UNITS[unit];
      return def.requiresStructure && !rtsGame?.hasStructure(def.requiresStructure)
        ? `NEEDS ${STRUCTURES[def.requiresStructure].name}`
        : null;
    },
    onResearch: (id) => startResearchAt(id),
    researchBlocker: (id) => rtsGame?.researchBlocker(id) ?? null,
    researchProgress: (sid) => {
      const r = rtsGame?.researchAt(sid);
      return r ? { id: r.id, pct: Math.round((1 - r.remainingS / r.totalS) * 100) } : null;
    },
    onAbility: (id) => beginAbility(id),
    abilityBlocker: (sid, id) => rtsGame?.abilityBlocker(sid, id) ?? null,
    aiming: () => rtsAiming?.id ?? null,
  });
  rtsCmd.show();
  rtsObjectivesDone.clear();
  rtsOrbitalFired = false;
  rtsObjClock = 0;
  rtsObjectives = new RtsObjectivePanel();
  rtsObjectives.show();
  rtsObjectives.render(rtsObjectivesDone);
  // The command card greys chips by affordability and shows queue progress, so it repaints on every
  // economy/production change (and per-frame while a queue runs — see the RTS update branch).
  rtsGame.onChange(() => rtsCmd?.render());

  // Your own machines get a unit card instead of the surveillance contact dossier.
  rtsUnitCard = new RtsUnitCard({
    units: rtsSelectedCardUnits,
    structure: rtsSelectedCardStructure,
    onPick: (index) => {
      unitField?.selectIndexPublic(index);
      rtsUnitCard?.render();
      rtsCmd?.render();
    },
  });
}

/** Tear the build layer + command bar down at the end of a match. */
function teardownRtsBuild(): void {
  rtsPlacing = null;
  rtsAiming = null;
  rtsSelectedStructure = null;
  rtsUnitCard?.hide();
  rtsUnitCard = null;
  if (rtsBuild) {
    scene.primitives.remove(rtsBuild.siteDots);
    scene.primitives.remove(rtsBuild.rings);
    scene.primitives.remove(rtsBuild.icons);
    scene.primitives.remove(rtsBuild.ghost);
    scene.primitives.remove(rtsBuild.rallyDots);
    scene.primitives.remove(rtsBuild.construction);
    scene.primitives.remove(rtsBuild.power);
    scene.primitives.remove(rtsBuild.unrest);
    for (const b of rtsBuild.meshBatches) scene.primitives.remove(b);
    rtsBuild = null;
  }
  rtsConstruction = [];
  // Shells outlive the frame that fired them, so a match that ends mid-barrage would otherwise
  // rain the last volley onto whatever is standing there next.
  unitField?.clearMunitions();
  rounds?.show([]);
  rtsCmd?.hide();
  rtsCmd = null;
  rtsObjectives?.hide();
  rtsObjectives = null;
  rtsObjectivesDone.clear();
  rtsOrbitalFired = false;
  rtsSites = [];
  rtsBuiltSites.clear();
  rtsPowerSig = -1;
  rtsSeenViolations.clear();
  millstone = null;
  rtsEnded = false;
  document.getElementById('c2-rts-end')?.remove();
}

// ---- RTS selection + production ----------------------------------------------------------------

/** The command card's context, from the current selection: a producing building, a worker, or nothing. */
function rtsCommandContext(): CommandContext {
  if (
    rtsSelectedStructure &&
    (producesUnits(rtsSelectedStructure.type) ||
      researchFrom(rtsSelectedStructure.type).length > 0 ||
      abilitiesFrom(rtsSelectedStructure.type).length > 0)
  ) {
    return { kind: 'produce', structureId: rtsSelectedStructure.id, structureType: rtsSelectedStructure.type };
  }
  // The worker's BUILD menu wins over its loadout card: a worker's job is building, and burying
  // that behind a weapons screen would be the wrong default for the unit you click most.
  if (selectedIsWorker()) return { kind: 'build' };
  // A selected unit shows nothing here. It used to open a hardpoint-fitting card; upgrades are
  // researched at a laboratory now, and the unit panel on the left already carries what the machine
  // is and what it is carrying.
  return { kind: 'none' };
}

/**
 * Drop one Millstone unit on the ground, armed exactly as a wave unit would be.
 *
 * It marches rather than holding: the point of dropping a leviathan next to your base is to find
 * out what it does to you, and a unit that stands still answers a different question. Everything
 * else about it — hull, weapons, factory-fitted mounts — comes from {@link armamentOf}, so what you
 * spawn is what wave 6 sends.
 */
function spawnMillstoneAt(kind: UnitKind, lon: number, lat: number): void {
  if (!rtsGame || !unitField || rtsEnded) {
    sound.play('denied');
    toast('◈ START A SKIRMISH FIRST');
    return;
  }
  const def = MILLSTONE_BY_KIND.get(kind);
  // A hull spawned on land can never move, so send it to water the way a wave does — and say so
  // rather than dropping it silently, since here the click WAS the instruction.
  if (kind === 'hulk') {
    const water = waterNear(lon, lat);
    if (!water) {
      sound.play('denied');
      toast('◈ NO NAVIGABLE WATER IN RANGE · HULL NOT LAUNCHED');
      return;
    }
    lon = water.lon;
    lat = water.lat;
  }
  unitField.spawnRtsEnemy(kind, lon, lat, armamentOf(kind), false);
  sound.play('alert');
  toast(`◈ ${def?.name ?? kind.toUpperCase()} FIELDED`);
}

/**
 * Open the inspection card on a member of the public.
 *
 * Everything about WHAT is legible is decided in game/rts/inspect from the company's authority; this
 * only finds who was clicked and puts the sheet on screen.
 */
function openInspect(screenX: number, screenY: number, index: number): void {
  if (!rtsGame || !unitField) return;
  const facts = unitField.contactIntel(index);
  if (!facts) return;
  const auth = rtsAuthority();
  const res = inspectContact(facts, auth);
  const title = facts.violation ? `CONTACT ${facts.id} · ACCUSED` : `CONTACT ${facts.id}`;
  showInspectCard(screenX, screenY, title, res, auth);
  sound.play(res.refused ? 'denied' : 'click');
}

/** The company's authority level, 0–5. */
function rtsAuthority(): AuthorityLevel {
  return Math.min(5, Math.max(0, Math.round(rtsGame?.economy.authority ?? 0))) as AuthorityLevel;
}

/** Whether the currently selected unit is a worker drone — the only unit that opens the build menu. */
function selectedIsWorker(): boolean {
  const sel = unitField?.selectedPlatform();
  return !!sel && rtsGame?.unitIdOf(sel.index) === 'worker';
}

/** Pick the structure nearest a screen point, or null. Structures aren't units, so this projects each. */
function pickStructure(x: number, y: number): Structure | null {
  if (!rtsGame || !theaterMap) return null;
  let best: Structure | null = null;
  let bestD = STRUCTURE_PICK_PX;
  for (const s of rtsGame.structures) {
    const world = Cesium.Cartesian3.fromDegrees(s.lon, s.lat, theaterMap.heightAt(s.lon, s.lat) + 80);
    const win = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
    if (!win) continue;
    const d = Math.hypot(win.x - x, win.y - y);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}

/** Select a structure: clear any unit selection, show its command card + rally. */
function selectStructure(s: Structure): void {
  rtsSelectedStructure = s;
  unitField?.deselect();
  hideUnitPanel();
  const rally = rtsGame?.rally.get(s.id);
  if (rally && producesUnits(s.type)) rtsBuild?.setRally(rally.lon, rally.lat);
  else rtsBuild?.clearRally();
  rtsCmd?.render();
  sound.play('click');
}

/** Drop structure selection (a unit was picked, or empty ground clicked). */
function clearStructureSelection(): void {
  if (!rtsSelectedStructure) return;
  rtsSelectedStructure = null;
  rtsBuild?.clearRally();
  rtsCmd?.render();
}

/** Queue a unit at the selected building. */
function enqueueUnit(unit: RtsUnitId): void {
  if (!rtsGame || !rtsSelectedStructure) return;
  const blocker = rtsGame.enqueueBlocker(unit);
  if (blocker) {
    sound.play('denied');
    toast(`◈ ${blocker}`);
    return;
  }
  rtsGame.enqueue(rtsSelectedStructure.id, unit);
  sound.play('purchase');
  rtsCmd?.render();
}

/**
 * A research project has finished — make it real on the units already standing.
 *
 * Re-arms every live unit of the affected chassis. That re-arm is the whole feature: an upgrade that
 * applied only to units built afterwards would be a trap, because the army you already paid for is
 * the army in front of you, and nobody would ever research anything mid-fight. `armRtsCombat` keeps
 * a unit's current damage while swapping the weapons in, so a hull upgrade raises the ceiling
 * without healing the hole — being improved is not being repaired.
 */
function applyResearch(id: ResearchId, kinds: UnitKind[]): void {
  if (!rtsGame || !unitField) return;
  const def = RESEARCH[id];

  // A COMPANY programme lands on the world rather than on a chassis, and lands NOW: a full survey
  // you paid for should open the map on completion, not the next time something else happens to
  // check, and hardened masts should thicken the obelisks already standing.
  if (def.effects) {
    if (def.effects.opensAllSites) maybeOpenAllSites();
    if (def.effects.obeliskHpMult) {
      const mult = def.effects.obeliskHpMult;
      for (const st of rtsGame.structures) {
        if (st.type !== 'obelisk' && st.type !== 'nexus') continue;
        // Raise the ceiling and give the same proportion of health with it. A structural retrofit is
        // not a repair, but it is not a wound either: a mast at full health stays at full health.
        const ratio = st.hp / st.maxHp;
        st.maxHp = Math.round(st.maxHp * mult);
        st.hp = Math.round(st.maxHp * ratio);
      }
    }
    if (def.effects.powerRadiusM) refreshPowerLines();
    updateRtsHud();
  }

  let n = 0;
  if (kinds.length) {
    const touched = new Set<UnitKind>(kinds);
    for (const u of unitField.platformUnits()) {
      if (!touched.has(u.kind) || !unitField.isAlive(u.index)) continue;
      unitField.armRtsCombat(u.index, 0, armamentOf(u.kind, rtsGame.researched));
      n++;
    }
  }
  sound.play('success');
  toast(n ? `◈ ${def.name} · REFITTED ${n} IN THE FIELD` : `◈ ${def.name} COMPLETE`);
  rtsCmd?.render();
  updateUnitHud();
}

/**
 * Advance the objective chain: sample the match, clear anything now satisfied, pay the bounty.
 *
 * Sampled on a clock rather than every frame — every condition here is a building being finished or
 * a unit rolling out, none of which can happen twice in half a second, and the unit tally walks the
 * fielded roster. A completion pays immediately whichever order things were done in, so a player who
 * built the tech facility before the data center gets both the moment the second one lands.
 */
function runRtsObjectives(dt: number): void {
  if (!rtsGame || !unitField || !rtsObjectives) return;
  rtsObjClock -= dt;
  if (rtsObjClock > 0) return;
  rtsObjClock = OBJECTIVE_CHECK_S;

  // One pass over the fielded roster, tallied by chassis, rather than a scan per objective.
  const byKind = new Map<UnitKind, number>();
  for (const u of unitField.platformUnits()) {
    if (!unitField.isAlive(u.index)) continue;
    byKind.set(u.kind, (byKind.get(u.kind) ?? 0) + 1);
  }
  const facts: MatchFacts = {
    obelisks: countLiveObelisks(),
    has: (t) => rtsGame!.hasStructure(t),
    units: (k) => byKind.get(k) ?? 0,
    researchDone: rtsGame.researched.size,
    orbitalFired: rtsOrbitalFired,
    millstoneRazed: !!millstone?.destroyed,
  };

  const done = newlyDone(facts, rtsObjectivesDone);
  if (!done.length) return;
  for (const o of done) {
    rtsObjectivesDone.add(o.id);
    if (o.bounty > 0) rtsGame.award(o.bounty);
    toast(o.bounty > 0 ? `◈ OBJECTIVE · ${o.name} · +${o.bounty}` : `◈ OBJECTIVE · ${o.name}`);
  }
  sound.play('success');
  rtsObjectives.render(rtsObjectivesDone);
  updateRtsHud();
}

/** Seconds between objective checks. */
const OBJECTIVE_CHECK_S = 0.75;

/** Begin a research project at the selected building. */
function startResearchAt(id: ResearchId): void {
  if (!rtsGame || !rtsSelectedStructure) return;
  const blocker = rtsGame.researchBlocker(id);
  if (blocker) {
    sound.play('denied');
    toast(blocker === 'DONE' ? `◈ ${RESEARCH[id].name} ALREADY RESEARCHED` : `◈ ${blocker}`);
    return;
  }
  rtsGame.startResearch(rtsSelectedStructure.id, id);
  sound.play('purchase');
  toast(`◈ RESEARCHING ${RESEARCH[id].name}`);
  rtsCmd?.render();
}

// ---- RTS traffic incidents (economy) -----------------------------------------------------------
//
// Obelisks catch traffic violations on the contacts under their coverage. Each is an alert on the
// map (a ping) you click to decide: FINE it for money, or release it. AUTO-FINE (researched at the
// Tech facility) collects them for you — passive income, no alerts to answer. Reuses the campaign's
// violation director wholesale; only the resolution is RTS-specific.

/**
 * Fire the camera flash at an installation, with its shutter.
 *
 * `siteLon/siteLat` on a violation is the obelisk that recorded it, so this lands on the mast rather
 * than on the contact — the point being that you can see WHERE you are being watched from.
 */
function flashAtSite(lon: number, lat: number): void {
  flashes?.fire(lon, lat, (theaterMap?.heightAt(lon, lat) ?? 0) + FLASH_MAST_M);
  sound.play('camera');
}

/**
 * Violations open this frame, keyed by contact index.
 *
 * Kept so a NEWLY recorded accusation can be told from one that has merely been sitting there for
 * three seconds — the flash is an event, not a state. Diffed here rather than reported out of
 * `stepViolations` deliberately: the campaign shares that method and this is an RTS-only flourish,
 * so the whole feature stays on this side of the fence. The open set is capped at a handful, so the
 * diff is a few comparisons a frame.
 */
const rtsSeenViolations = new Set<number>();

function runRtsViolations(dt: number): void {
  if (!unitField || !sensorField || !rtsGame) return;
  unitField.stepViolations(dt, sensorField.obeliskCount, (lon, lat) => sensorField?.servicingSite(lon, lat) ?? null);

  // Anything accused that wasn't accused last frame is a fresh recording: the obelisk that made it
  // takes its picture. Capped at a couple per frame so a burst can't strobe the screen.
  const open = unitField.liveViolations();
  let fired = 0;
  const stillOpen = new Set<number>();
  for (const v of open) {
    stillOpen.add(v.index);
    if (rtsSeenViolations.has(v.index)) continue;
    if (fired++ < 2) flashAtSite(v.live.siteLon, v.live.siteLat);
  }
  rtsSeenViolations.clear();
  for (const i of stillOpen) rtsSeenViolations.add(i);

  if (rtsGame.economy.autoFine) {
    // Sweep every open fineable violation into money — the whole point of the upgrade. Paid at the
    // company's authority rate, and bound by the same authority rule a hand-collected one is: an
    // automatic system does not get to charge people the company may not lawfully look at.
    const auth = rtsAuthority();
    for (const v of open) {
      if (v.live.def.fine <= 0) continue;
      if (fineBlockedBy(unitField.contactIntel(v.index)?.kind ?? 'land', auth)) continue;
      rtsGame.collectFine(v.live.def.fine);
      unitField.clearLive(v.index);
    }
  }
  updatePings(dt); // draw the alert markers over whatever is still open
}

/** How far up an obelisk the camera sits — where the flash goes off. */
const FLASH_MAST_M = 170;

/**
 * Redraw the power tethers from the current base.
 *
 * One line per building, back to the obelisk feeding it. Buildings out of any obelisk's range draw
 * nothing, which is the honest picture: an obelisk that falls leaves its cluster visibly unwired
 * (they keep working — losing power retroactively would delete a base you already paid for — but you
 * can see at a glance that nothing more can be built there until you put an obelisk back).
 */
function refreshPowerLines(): void {
  if (!rtsGame || !rtsBuild) return;
  const links: { flon: number; flat: number; tlon: number; tlat: number }[] = [];
  for (const s of rtsGame.structures) {
    if (isObelisk(s.type)) continue;
    const src = poweringObelisk(s.lon, s.lat);
    if (src) links.push({ flon: src.lon, flat: src.lat, tlon: s.lon, tlat: s.lat });
  }
  rtsBuild.setPower(links);
  refreshUnrestSites();
  rtsPowerSig = rtsGame.structures.length;
}

/** Structure count the tethers were last drawn for — a cheap "did the base change shape" test. */
let rtsPowerSig = -1;

/**
 * Keep the unrest rings on the data centers, and the level they are drawn at current.
 *
 * The ring SET only changes when a data center is built or falls, which the same structure-count
 * signature already catches; the LEVEL moves every frame and is a single number, so it is pushed
 * unconditionally.
 */
function refreshUnrestRings(): void {
  if (!rtsGame || !rtsBuild) return;
  rtsBuild.setUnrestLevel(rtsGame.unrest);
}

/** Rebuild the ring geometry from the data centers currently standing. */
function refreshUnrestSites(): void {
  if (!rtsGame || !rtsBuild) return;
  rtsBuild.setUnrestSites(rtsGame.structuresOfType('supply').map((s) => ({ lon: s.lon, lat: s.lat })));
}

/** The decide-fate popup for a caught violator: fine it for money, or let it go. */
function openViolationMenu(screenX: number, screenY: number, index: number): void {
  if (!rtsGame || !unitField) return;
  const live = unitField.liveOf(index);
  if (!live) return;
  closeContactMenu();
  closeGroundMenu();
  const box = document.createElement('div');
  box.id = 'g-context';
  box.style.left = `${screenX}px`;
  box.style.top = `${screenY}px`;
  box.innerHTML = `<div class="gc-head">${live.def.label} · ${Math.round(live.certainty * 100)}%</div>`;

  const fine = live.def.fine;
  const fineBtn = document.createElement('button');
  fineBtn.type = 'button';
  fineBtn.className = 'gc-item';
  fineBtn.disabled = fine <= 0;
  fineBtn.innerHTML =
    `<span class="gc-label">FINE</span>` +
    (fine > 0 ? `<span class="gc-why" style="color:var(--warn)">+${fine}</span>` : `<span class="gc-why">NO FINE VALUE</span>`);
  // Close for good: drop the menu AND stop listening, so picking an item doesn't leave a live
  // click-away handler behind for the next one to trip over.
  const done = () => {
    closeContactMenu();
    window.removeEventListener('pointerdown', dismiss, true);
  };
  if (fine > 0) {
    fineBtn.addEventListener('click', () => {
      done();
      if (!unitField || !rtsGame) return;
      const paid = rtsGame.collectFine(fine);
      unitField.clearLive(index);
      sound.play('purchase');
      reactAt(live.siteLon, live.siteLat, 'approve');
      // The flash again, at the moment of collection: the obelisk that caught it is also the thing
      // that gets paid, and that pairing is the entire economy of this mode in one gesture.
      flashAtSite(live.siteLon, live.siteLat);
      toast(`◈ FINED · ${live.def.label} · +${paid}${paid > fine ? ' (AUTHORITY)' : ''}`);
      updateRtsHud();
    });
  }
  box.append(fineBtn);

  const release = document.createElement('button');
  release.type = 'button';
  release.className = 'gc-item';
  release.innerHTML = `<span class="gc-label">RELEASE</span>`;
  release.addEventListener('click', () => {
    done();
    unitField?.clearLive(index);
    sound.play('click');
  });
  box.append(release);

  document.body.append(box);
  // The click-away listener MUST ignore pointerdowns inside the menu. A capture-phase `pointerdown`
  // that removes the box detaches the button before the browser can deliver its `click`, so the
  // handler never runs — which is exactly why FINE appeared to do nothing and no money ever arrived.
  // Same defect, same fix as the Millstone spawn menu; see the note there.
  function dismiss(e: PointerEvent) {
    if (!box.contains(e.target as Node)) done();
  }
  window.setTimeout(() => window.addEventListener('pointerdown', dismiss, true), 0);
}

/**
 * What a unit is doing this second, for its card.
 *
 * Order of precedence is what the operator cares about: a construction assignment outranks "moving",
 * because a worker driving to a site is doing a job, not commuting.
 */
function rtsUnitAction(index: number): string {
  const cs = rtsConstruction.find((c) => c.workerIndex === index);
  if (cs) {
    const st = unitField?.platformStatus(index);
    const onSite = !!st && metresBetween(st.lon, st.lat, cs.lon, cs.lat) <= BUILD_CONTACT_M;
    const name = STRUCTURES[cs.type].name.replace(' FACILITY', '');
    if (!onSite) return `MOVING TO ${name} SITE`;
    return `BUILDING ${name} · ${Math.ceil(cs.remainingS)}s`;
  }
  // The field taking a unit to a fight is said out loud. A unit that walks off on its own without
  // the card explaining why reads as a bug, and the operator needs to be able to tell an order they
  // gave from one the field gave.
  if (unitField?.isAssisting(index)) {
    return unitField.platformStatus(index)?.moving ? 'RESPONDING' : 'DEFENDING';
  }
  if (!unitField?.platformStatus(index)?.moving) return 'HOLDING';
  // An attack-moving unit still reads as "moving" while it is stopped mid-route shooting something,
  // which is exactly right: the order is still running.
  return unitField.attackMovingOf(index) ? 'ATTACK MOVE' : 'MOVING';
}

/** Portrait glyph + accent per structure type, mirroring the build layer's map markers. */
const STRUCT_GLYPH: Record<StructureType, string> = {
  nexus: '◈',
  obelisk: '▲',
  robotics: 'R',
  acquisitions: 'A',
  harbor: 'H',
  skyhook: 'K',
  aviation: 'V',
  tech: 'T',
  supply: 'D',
  special: 'S',
};
const STRUCT_ACCENT: Record<StructureType, string> = {
  nexus: '#E23A2E',
  obelisk: '#E23A2E',
  robotics: '#E7A13B',
  acquisitions: '#D9C24A',
  harbor: '#3F8FA0',
  skyhook: '#8FD8F0',
  aviation: '#3FA0E0',
  tech: '#8B6FE0',
  supply: '#3FBF6F',
  special: '#E0553F',
};

/**
 * The selected structure, shaped for the card.
 *
 * Health is the reason this exists: Millstone grinds buildings down, and without a readout your base
 * degrades invisibly until something explodes. The command bar says what a building can MAKE; this
 * says what shape it is in and what it is doing.
 */
function rtsSelectedCardStructure(): RtsCardStructure | null {
  if (!rtsGame || !rtsSelectedStructure) return null;
  // Read the live structure back out of the match — the selection holds a reference that a rebuild
  // (or a destruction) could have replaced.
  const s = rtsGame.structures.find((x) => x.id === rtsSelectedStructure!.id);
  if (!s) return null;
  const def = STRUCTURES[s.type];

  let action = 'STANDING BY';
  const q = rtsGame.queueAt(s.id);
  const r = rtsGame.researchAt(s.id);
  if (q.length) {
    action = `PRODUCING ${RTS_UNITS[q[0].unit].name} · ${Math.ceil(q[0].remainingS)}s${q.length > 1 ? ` (+${q.length - 1})` : ''}`;
  } else if (r) {
    action = `RESEARCHING ${RESEARCH[r.id].name} · ${Math.ceil(r.remainingS)}s`;
  }

  return {
    name: def.name,
    blurb: def.blurb,
    hp: s.hp,
    maxHp: s.maxHp,
    action,
    // The company's own standing rides on the Nexus card, because the Nexus is the company's seat.
    // Every other building is a building.
    mandate: s.type === 'nexus' ? mandateState(rtsGame.unrest, rtsAuthority()) : undefined,
    glyph: STRUCT_GLYPH[s.type],
    accent: STRUCT_ACCENT[s.type],
    critical: s.type === 'nexus',
  };
}

/** The selected units, shaped for the unit card. Only YOUR registered RTS units appear. */
function rtsSelectedCardUnits(): RtsCardUnit[] {
  if (!rtsGame || !unitField) return [];
  const out: RtsCardUnit[] = [];
  for (const { index, id, kind } of unitField.platformUnits()) {
    if (!unitField.isSelected(index)) continue;
    const st = rtsGame.unitStateOf(index);
    if (!st) continue; // not one of ours (or not registered) — no card for it
    // Health comes from the COMBAT state on the field, not the roster: that's the number Millstone
    // is actually shooting at, so the bar can never drift from the fight.
    const hp = unitField.rtsHpOf(index) ?? { hp: 0, maxHp: 0 };
    out.push({
      index,
      unit: st.unit,
      callsign: id,
      hp: hp.hp,
      maxHp: hp.maxHp,
      shield: st.shield,
      energy: st.energy,
      action: rtsUnitAction(index),
      speedMs: KIND_SPEED[kind],
      sensorKm: (PLATFORM_SENSOR[kind] ?? 0) / 1000,
    });
  }
  return out;
}

/**
 * The nearest navigable water to a point, or null if there is none in reach.
 *
 * Rings outward on the theater's shoreline distance field, the same way ferry ports are found — a
 * hull needs to start far enough off the beach that its own movement test (shore < −60 m) passes.
 */
function waterNear(lon: number, lat: number, maxM = 30_000): { lon: number; lat: number } | null {
  if (!theaterMap) return null;
  for (let r = 800; r <= maxM; r += 800) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const p = destDeg(lat, lon, r, a);
      if (theaterMap.shoreDistance(p.lon, p.lat) < -180) return { lon: p.lon, lat: p.lat };
    }
  }
  return null;
}

/**
 * Chassis that can only exist on water. Anything here has to be launched from a navigable point
 * rather than from its producer's doorstep, and is refunded if the theater is landlocked.
 */
const WATER_KINDS = new Set<UnitKind>(['naval', 'usv']);

/** Roll a finished unit out of its building and send it to the rally point (or just clear of the building). */
function spawnProducedUnit(structureId: number, unit: RtsUnitId): void {
  if (!rtsGame || !unitField) return;
  const s = rtsGame.structures.find((x) => x.id === structureId);
  if (!s) return;
  const def = RTS_UNITS[unit];
  const mLon = 111_320 * Math.cos((s.lat * Math.PI) / 180);
  let spawnLon = s.lon + (STRUCTURES[s.type].footprintM + 60) / mLon;
  let spawnLat = s.lat;
  // A hull rolled out onto the forecourt is a hull that can never move: naval orders refuse any
  // point that isn't water. Launch it from the nearest sea instead. Covers every water chassis, not
  // just the littoral — the USV picket has exactly the same problem.
  if (WATER_KINDS.has(def.meshKind)) {
    const water = waterNear(s.lon, s.lat);
    if (!water) {
      sound.play('denied');
      toast('◈ NO NAVIGABLE WATER IN RANGE · HULL NOT LAUNCHED');
      // The supply was reserved at queue time; hand it back rather than leaking a phantom unit.
      rtsGame.refundQueued(unit);
      return;
    }
    spawnLon = water.lon;
    spawnLat = water.lat;
  }
  const idx = unitField.spawnRtsUnit(def.meshKind, spawnLon, spawnLat);
  // Supply was already reserved when this was queued, so don't charge it twice.
  rtsGame.registerUnit(idx, unit, false);
  // Rolls out already carrying everything the company has researched — a factory that shipped the
  // pre-upgrade version of a machine you paid to improve would just be a bug with a story.
  unitField.armRtsCombat(idx, 0, armamentOf(def.meshKind, rtsGame.researched));
  const rally = rtsGame.rally.get(structureId);
  if (rally) unitField.moveUnitTo(idx, rally.lon, rally.lat);
  updateUnitHud();
}

/**
 * The theater's obelisk sites, curated down to a sparse set of expansion nodes.
 *
 * The raw obelisk field is one site per city block — thousands, far too many to read as "where can I
 * expand". Clustering it into ~40 well-separated nodes and snapping each back to a real obelisk index
 * gives a handful of meaningful expansion sites that still render + gain coverage when built on.
 */
/** Every surveyed obelisk position inside the theater disc — the full field, uncurated. */
function inTheaterObeliskSites(): BuildSite[] {
  if (!obelisks || !theaterCenter) return [];
  const rLat = (THEATER_RADIUS_M * RIM_FADE_START) / 111_320;
  const rLon = rLat / Math.max(0.15, Math.cos((theaterCenter.lat * Math.PI) / 180));
  const out: BuildSite[] = [];
  for (let i = 0; i < obelisks.count; i++) {
    const dLon = obelisks.lon[i] - theaterCenter.lon;
    if (dLon < -rLon || dLon > rLon) continue;
    const dLat = obelisks.lat[i] - theaterCenter.lat;
    if (dLat < -rLat || dLat > rLat) continue;
    if ((dLon / rLon) ** 2 + (dLat / rLat) ** 2 > 1) continue;
    out.push({ index: i, lon: obelisks.lon[i], lat: obelisks.lat[i] });
  }
  return out;
}

function computeRtsSites(): BuildSite[] {
  if (!rtsGame) return [];
  const inTheater = inTheaterObeliskSites();
  if (!inTheater.length) return [];
  const coords: number[] = [];
  for (const s of inTheater) coords.push(s.lon, s.lat);

  const centres = clusterCentres(new Float64Array(coords), { separationM: 6500, max: 40, minCount: 1 });
  const sites: BuildSite[] = [];
  const used = new Set<number>();
  for (const c of centres) {
    let best = -1;
    let bestD = Infinity;
    for (let k = 0; k < inTheater.length; k++) {
      const d = metresBetween(c.lon, c.lat, inTheater[k].lon, inTheater[k].lat);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0 && !used.has(inTheater[best].index)) {
      used.add(inTheater[best].index);
      sites.push(inTheater[best]);
    }
  }
  // The Nexus site must be in the list even if clustering placed a node elsewhere in its block.
  if (!used.has(rtsGame.nexusIndex)) {
    const n = inTheater.find((s) => s.index === rtsGame!.nexusIndex);
    if (n) sites.push(n);
  }
  return sites;
}

// ---- structure abilities (orbital strike) -------------------------------------------------------
//
// An ability is aimed the way a building is placed: the chip arms a cursor, the cursor shows what the
// order would do, and the next left click commits it. Sharing that shape with placement is deliberate
// — the player already knows this interaction, and an area weapon is exactly the kind of order that
// should have a visible footprint and a way out of it before you commit.

/** Arm the targeting cursor for an ability, if the building can fire it. */
function beginAbility(id: AbilityId): void {
  if (!rtsGame || !rtsSelectedStructure) return;
  const def = ABILITY_BY_ID.get(id);
  if (!def) return;
  const blocked = rtsGame.abilityBlocker(rtsSelectedStructure.id, id);
  if (blocked) {
    sound.play('denied');
    toast(blocked === 'INSUFFICIENT FUNDS' ? `◈ NEED ${def.cost} · HAVE ${rtsGame.money}` : `◈ ${blocked}`);
    return;
  }
  cancelPlacement(); // one armed cursor at a time
  rtsAiming = { id, structureId: rtsSelectedStructure.id };
  sound.play('click');
  toast(`◈ ${def.name} · PICK GROUND · RMB CANCELS`);
  rtsCmd?.render();
}

/** Drop the targeting cursor without firing. */
function cancelAiming(): void {
  if (!rtsAiming) return;
  rtsAiming = null;
  rtsBuild?.hideGhost();
  rtsCmd?.render();
}

/**
 * Show what the armed ability would hit under the cursor — the splash ring, at its true radius.
 *
 * Drawn with the placement ghost on purpose: this weapon's whole character is that the ring is what
 * matters and the ring does not care whose units are in it, so the player should be looking at the
 * ring over their own army before they click, not reading a number off a chip.
 */
function updateAimGhost(screen: Cesium.Cartesian2): void {
  if (!rtsAiming || !rtsBuild) return;
  const g = groundAt(screen);
  if (!g) {
    rtsBuild.hideGhost();
    return;
  }
  rtsBuild.showGhost(g.lon, g.lat, ORBITAL.splashM, true);
}

/** Commit the armed ability at a click: charge for it, and put the round in the air. */
function fireAbilityAt(screen: Cesium.Cartesian2): void {
  if (!rtsAiming || !rtsGame || !unitField) return;
  const { id, structureId } = rtsAiming;
  const def = ABILITY_BY_ID.get(id)!;
  const g = groundAt(screen);
  if (!g) {
    sound.play('denied');
    toast('◈ NO GROUND UNDER CURSOR');
    return;
  }
  // Re-checked at the click, not just when the chip was pressed: the tether can have fallen, or the
  // money been spent elsewhere, in the seconds you spent choosing where to put it.
  const blocked = rtsGame.abilityBlocker(structureId, id);
  if (blocked) {
    sound.play('denied');
    toast(`◈ ${blocked === 'NO BUILDING' ? `${STRUCTURES[def.from].name} GONE` : blocked}`);
    cancelAiming();
    return;
  }
  if (!rtsGame.fireAbility(structureId, id)) return;
  unitField.callOrbitalStrike(g.lon, g.lat, ORBITAL);
  rtsOrbitalFired = true;
  sound.play('orderLethal');
  const fall = Math.round(ORBITAL.dropFromM / ORBITAL.speedMps);
  toast(`◈ ROUND AWAY · IMPACT IN ${fall}s · CLEAR THE RING`);
  cancelAiming();
  updateRtsHud();
}

/** Arm placement for a structure type, if it can be afforded. */
function beginPlacement(type: StructureType): void {
  if (!rtsGame || !rtsBuild) return;
  cancelAiming(); // one armed cursor at a time
  // Tech-tree gate first: "you can't build this yet" outranks "you can't afford it".
  const gate = rtsGame.structureBlocker(type);
  if (gate) {
    sound.play('denied');
    toast(`◈ ${gate}`);
    return;
  }
  const def = STRUCTURES[type];
  if (rtsGame.money < def.cost) {
    sound.play('denied');
    toast(`◈ NEED ${def.cost} · HAVE ${rtsGame.money}`);
    return;
  }
  rtsPlacing = type;
  sound.play('click');
  rtsCmd?.render();
}

/** Cancel placement and clear the ghost. */
function cancelPlacement(): void {
  if (!rtsPlacing) return;
  rtsPlacing = null;
  rtsBuild?.hideGhost();
  rtsCmd?.render();
}

interface PlacementResolve {
  lon: number;
  lat: number;
  radiusM: number;
  valid: boolean;
  reason: string | null;
  siteIndex?: number;
  /** Power radius to preview, for a structure that projects one. Obelisks only. */
  powerM?: number;
}

/** Resolve where the current placement would land under the cursor, and whether it's legal. */
function resolvePlacement(screen: Cesium.Cartesian2): PlacementResolve | null {
  if (!rtsPlacing || !rtsGame || !rtsBuild) return null;
  const def = STRUCTURES[rtsPlacing];
  const g = groundAt(screen);
  if (!g) return null;

  if (def.placement === 'site') {
    // Snap to the nearest UNBUILT surveyed site near the cursor.
    let best: BuildSite | null = null;
    let bestD = Infinity;
    for (const s of rtsSites) {
      if (rtsBuiltSites.has(s.index)) continue;
      const d = metresBetween(g.lon, g.lat, s.lon, s.lat);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) return { lon: g.lon, lat: g.lat, radiusM: def.footprintM, valid: false, reason: 'NO OPEN SITE' };
    if (bestD > BUILD_RULES.OBELISK_SNAP_M) {
      return {
        lon: best.lon, lat: best.lat, radiusM: def.footprintM,
        valid: false, reason: 'MOVE ONTO A SITE', siteIndex: best.index,
        powerM: obeliskPowerRadiusM(),
      };
    }
    const reason = validateObelisk(best);
    return {
      lon: best.lon, lat: best.lat, radiusM: def.footprintM,
      valid: reason === null, reason, siteIndex: best.index,
      powerM: obeliskPowerRadiusM(),
    };
  }

  const reason = validateFacility(g.lon, g.lat, rtsPlacing);
  return { lon: g.lon, lat: g.lat, radiusM: def.footprintM, valid: reason === null, reason };
}

/** Why an obelisk can't stand on this site, or null. */
function validateObelisk(site: BuildSite): string | null {
  if (!rtsGame) return 'NO MATCH';
  if (rtsBuiltSites.has(site.index)) return 'ALREADY BUILT';
  if (theaterMap && theaterMap.heightAt(site.lon, site.lat) < 1) return 'AT SEA';
  // Millstone's home site is not a build slot while Millstone is still standing on it.
  if (millstone && !millstone.destroyed && site.index === millstone.siteIndex) return 'MILLSTONE HOLDS THIS SITE';
  // And that is the whole rule. An obelisk may stand on ANY surveyed site, however far from anything
  // you already own — see the note on validateFacility.
  return null;
}

/**
 * Why an obelisk can't stand on this site, or null.
 *
 * NOTE ON REACH. There is deliberately no distance rule here any more. An obelisk used to have to sit
 * within 14 km of one you already owned, which meant expansion crept outward in a chain and the
 * commonest thing a new player did — click a distant dot — answered OUT OF REACH OF YOUR NETWORK.
 * The obelisk is a PYLON: it is the thing that projects the right to build, so gating where it may go
 * on where you have already built made it the one structure that could not open new ground. Any
 * surveyed site, anywhere, is legal. What it costs you is the 250, the worker's walk, and the fact
 * that a forward obelisk is undefended ground with your name on it.
 */

/** Whether a structure is an obelisk — the Nexus is one. Power comes from these and only these. */
const isObelisk = (t: StructureType): boolean => t === 'obelisk' || t === 'nexus';

/** How far one obelisk currently projects the right to build, including WIDE APERTURE. */
function obeliskPowerRadiusM(): number {
  return BUILD_RULES.POWER_RADIUS_M + (rtsGame?.economy.powerRadiusM ?? 0);
}

/**
 * The obelisk powering a point, or null. Nearest wins, so a building in two obelisks' range draws its
 * tether from the closer one — which is also the one that looks right on screen.
 */
function poweringObelisk(lon: number, lat: number): Structure | null {
  if (!rtsGame) return null;
  let best: Structure | null = null;
  let bd = obeliskPowerRadiusM();
  for (const s of rtsGame.structures) {
    if (!isObelisk(s.type)) continue;
    const d = metresBetween(lon, lat, s.lon, s.lat);
    if (d <= bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** Why a facility can't stand here, or null. */
function validateFacility(lon: number, lat: number, type: StructureType = 'robotics'): string | null {
  if (!rtsGame || !rtsBuild) return 'NO MATCH';
  if (theaterMap && theaterMap.heightAt(lon, lat) < 1) return 'AT SEA';
  // Power first — it's now the primary placement concept, so a far click should read "you need an
  // obelisk out here" rather than incidentally "not near a road". A building draws from an obelisk;
  // nothing else in your base grants the right to build.
  if (!poweringObelisk(lon, lat)) return 'NO OBELISK POWER';

  if (STRUCTURES[type].placement === 'shore') {
    // A quay is defined by the water it reaches, so it answers to the coastline instead of the road
    // network. `shoreDistance` is the theater's signed field — positive on land — so this is
    // "standing on land, but with the sea within reach".
    const shore = theaterMap?.shoreDistance(lon, lat);
    if (shore === undefined) return 'NO TERRAIN';
    if (shore > BUILD_RULES.SHORE_DIST_M) return 'NOT ON THE COAST';
  } else if (!rtsBuild.nearRoad(lon, lat)) {
    return 'NOT NEAR A ROAD';
  }

  // Spacing applies between FACILITIES only. An obelisk is what its cluster gathers around, so
  // building right against one — or straight on top of a surveyed site — is allowed and intended.
  const tooClose = rtsGame.structures.some(
    (s) => !isObelisk(s.type) && metresBetween(lon, lat, s.lon, s.lat) < BUILD_RULES.MIN_SPACING_M,
  );
  if (tooClose) return 'TOO CLOSE TO A BUILDING';
  return null;
}

/** Update the placement ghost to the cursor. Called from the mouse-move handler while placing. */
function updatePlacementGhost(screen: Cesium.Cartesian2): void {
  const r = resolvePlacement(screen);
  if (!r || !rtsBuild) {
    rtsBuild?.hideGhost();
    return;
  }
  rtsBuild.showGhost(r.lon, r.lat, r.radiusM, r.valid, r.powerM ?? 0);
}

/**
 * Commit a placement at a click: dispatch the selected worker to the spot and start a construction
 * site. The structure isn't real until the worker arrives and finishes building it — see
 * rtsConstructionTick. Money is spent up front (the commit), the way an RTS charges on placement.
 */
function tryPlaceAt(screen: Cesium.Cartesian2): void {
  if (!rtsPlacing || !rtsGame || !unitField) return;
  const type = rtsPlacing;
  const def = STRUCTURES[type];
  const r = resolvePlacement(screen);
  if (!r || !r.valid) {
    sound.play('denied');
    toast(`◈ CANNOT BUILD · ${r?.reason ?? 'INVALID SPOT'}`);
    return;
  }
  // A structure is built BY a worker — you must have one selected, and it's the one dispatched.
  const worker = unitField.selectedPlatform();
  if (!worker || rtsGame.unitIdOf(worker.index) !== 'worker') {
    sound.play('denied');
    toast('◈ SELECT A WORKER TO BUILD');
    return;
  }
  if (!rtsGame.spend(def.cost)) {
    sound.play('denied');
    toast('◈ INSUFFICIENT FUNDS');
    return;
  }
  // A worker can only build one thing at a time: pointing it at a new site cancels the old one,
  // refund and all, instead of orphaning a site whose builder has walked away.
  cancelConstructionsFor([worker.index]);
  // Reserve an obelisk site immediately so a second worker can't be sent to the same one.
  if (r.siteIndex !== undefined) {
    rtsBuiltSites.add(r.siteIndex);
    rtsBuild?.setSites(rtsSites, rtsBuiltSites);
  }
  const cs: ConstructionSite = {
    id: rtsConstructionId++,
    type,
    lon: r.lon,
    lat: r.lat,
    siteIndex: r.siteIndex,
    remainingS: def.buildTimeS,
    totalS: def.buildTimeS,
    workerIndex: worker.index,
  };
  rtsConstruction.push(cs);
  rtsBuild?.addConstruction(cs.id, r.lon, r.lat, def.footprintM);
  unitField.moveUnitTo(worker.index, r.lon, r.lat); // send the builder to the site
  sound.play('purchase');
  toast(`◈ ${def.name} · WORKER DISPATCHED · −${def.cost}`);
  cancelPlacement();
  updateRtsHud();
}

/**
 * Advance construction. A site only builds while its assigned worker is standing on it — the worker
 * drives over, then works the clock down. When it's done the structure becomes real.
 */
function rtsConstructionTick(dt: number): void {
  if (!rtsGame || !unitField || !rtsConstruction.length) return;
  const still: ConstructionSite[] = [];
  for (const cs of rtsConstruction) {
    // A destroyed builder finishes nothing. Without this the site — and its ring — outlive the match
    // that started it, and worse, a worker killed standing on its own footprint kept the clock
    // running, because "is the builder here" was a position test that a corpse passes. No refund:
    // losing the worker mid-build is a loss, not a change of mind.
    if (!unitField.isAlive(cs.workerIndex)) {
      teardownConstruction(cs, false, 'LOST · BUILDER DESTROYED');
      continue;
    }
    const st = unitField.platformStatus(cs.workerIndex);
    const onSite = !!st && metresBetween(st.lon, st.lat, cs.lon, cs.lat) <= BUILD_CONTACT_M;
    if (onSite) cs.remainingS -= dt;
    if (cs.remainingS <= 0) finishConstruction(cs);
    else still.push(cs);
  }
  rtsConstruction = still;
}

/**
 * Tear down an unfinished construction site: ring off the map, obelisk reservation released, and the
 * money back if this was the operator's choice rather than a loss.
 *
 * Does NOT remove the site from `rtsConstruction` — the caller owns that list and is mid-iteration
 * over it often enough that quietly splicing underneath it would be a bug waiting to happen.
 */
function teardownConstruction(cs: ConstructionSite, refund: boolean, why: string): void {
  rtsBuild?.clearConstruction(cs.id);
  // The reservation that stopped a second worker being sent to the same obelisk site goes back.
  if (cs.siteIndex !== undefined) {
    rtsBuiltSites.delete(cs.siteIndex);
    rtsBuild?.setSites(rtsSites, rtsBuiltSites);
  }
  const def = STRUCTURES[cs.type];
  if (refund) rtsGame?.award(def.cost);
  sound.play('denied');
  toast(`◈ ${def.name} ${why}${refund ? ` · +${def.cost}` : ''}`);
  updateRtsHud();
}

/**
 * Re-tasking a builder cancels what it was building, completely.
 *
 * A construction site is nothing but a clock and a ring until its worker stands on it, so a worker
 * sent somewhere else leaves behind a building that can never finish and a ring that never goes
 * away. Ordering the worker elsewhere IS the cancel — there is no separate "abandon" button to find,
 * and the cost comes back because nothing was built.
 */
function cancelConstructionsFor(workers: Iterable<number>): void {
  const set = new Set(workers);
  const hit = rtsConstruction.filter((c) => set.has(c.workerIndex));
  if (!hit.length) return;
  rtsConstruction = rtsConstruction.filter((c) => !set.has(c.workerIndex));
  for (const cs of hit) teardownConstruction(cs, true, 'CANCELLED · BUILDER RE-TASKED');
}

/** Turn a finished construction site into a real structure. */
function finishConstruction(cs: ConstructionSite): void {
  if (!rtsGame) return;
  rtsBuild?.clearConstruction(cs.id);
  if (STRUCTURES[cs.type].placement === 'site' && cs.siteIndex !== undefined) {
    buildObeliskAt(cs.siteIndex, cs.lon, cs.lat);
    maybeOpenAllSites();
  } else {
    const s = rtsGame.addStructure(cs.type, cs.lon, cs.lat);
    rtsBuild?.addFacility(s);
  }
  sound.play('success');
  toast(`◈ ${STRUCTURES[cs.type].name} COMPLETE`);
  refreshPowerLines();
  rtsCmd?.render();
  updateRtsHud();
}

/**
 * Throw the whole surveyed field open as build sites.
 *
 * Two ways to get there, and they are the same unlock by different routes: EARN it by standing
 * RTS_ALL_SITES_AT obelisks, or BUY it at acquisitions with FULL SURVEY. Buying it is the point of
 * the programme — it is what turns a slow expansion into an immediate one for money you could have
 * spent on an army instead.
 */
function maybeOpenAllSites(): void {
  if (rtsSitesAllOpen || !rtsGame) return;
  const bought = rtsGame.economy.opensAllSites;
  if (!bought && rtsGame.structuresOfType('obelisk').length < RTS_ALL_SITES_AT) return;
  rtsSitesAllOpen = true;
  rtsSites = inTheaterObeliskSites();
  rtsBuild?.setSites(rtsSites, rtsBuiltSites);
  toast('◈ FULL SURVEY UNLOCKED · EVERY SITE IS NOW BUILDABLE');
}

/**
 * Build an obelisk on a surveyed site: flip the mask bit and rebuild the obelisk geometry + sensor
 * field from it. The new site is a real network node from that instant — coverage, servicing and the
 * income it raises all fall out of the mask, exactly as the airdrop did in the campaign.
 */
function buildObeliskAt(siteIndex: number, lon: number, lat: number): void {
  if (!rtsGame || !obeliskMask || !theaterCenter || !theaterMap) return;
  obeliskMask[siteIndex] = 1;
  rtsBuiltSites.add(siteIndex);
  rtsGame.addStructure('obelisk', lon, lat, siteIndex);
  addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
  rtsBuild?.setSites(rtsSites, rtsBuiltSites);
}

// ---- RTS combat: Millstone ----------------------------------------------------------------------
//
// The enemy. Millstone's match state (Nexus health, wave clock) lives in game/rts/millstone.ts; its
// army lives in the unit field as hostile combatants; and this section is the scene glue — where the
// base is seeded, waves are fielded, combat events become beams/blasts/damage, and a Nexus falling
// on either side ends the match.

/**
 * Seed Millstone's base: the surveyed site nearest to raiding distance from the player's Nexus
 * that isn't at sea. Distance-targeted rather than "farthest" deliberately — the enemy should be a
 * march away, not a pilgrimage across a 300 km theater.
 */
function pickMillstoneBase(): MillstoneDirector | null {
  if (!rtsGame || !theaterMap) return null;
  const nexus = rtsGame.nexus;
  if (!nexus) return null;
  let best: BuildSite | null = null;
  let bestScore = Infinity;
  for (const s of inTheaterObeliskSites()) {
    if (s.index === rtsGame.nexusIndex) continue;
    if (theaterMap.heightAt(s.lon, s.lat) < 1) continue;
    const score = Math.abs(metresBetween(s.lon, s.lat, nexus.lon, nexus.lat) - MILLSTONE.BASE_RANGE_M);
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best ? new MillstoneDirector(best) : null;
}

/** Advance Millstone's wave clock and field anything it sends. */
function runMillstone(dt: number): void {
  if (!millstone || !unitField || rtsEnded) return;
  // Unrest runs Millstone's clock fast — the public's anger at your data centers is why the next
  // wave is early. See game/rts/unrest.ts.
  const wave = millstone.tick(dt, rtsGame?.unrestPressure ?? 1);
  if (!wave) return;
  let fielded = 0;
  for (const w of wave) {
    let lon = w.lon;
    let lat = w.lat;
    if (w.naval) {
      // Same problem the player's littoral has, and the same answer: a hull spawned on land can
      // never move, so launch it from the nearest sea. Unlike the player's, a hull with nowhere to
      // launch is simply dropped — Millstone paid nothing for it, so there's nothing to refund and
      // no reason to tell the player about a unit that never existed.
      const water = waterNear(w.lon, w.lat);
      if (!water) continue;
      lon = water.lon;
      lat = water.lat;
    }
    unitField.spawnRtsEnemy(w.kind, lon, lat, armamentOf(w.kind), w.hold);
    fielded++;
  }
  if (!fielded) return;
  sound.play('alert');
  toast(`◈ MILLSTONE WAVE ${millstone.waveN} INBOUND · ${fielded} UNITS`);
}

/** Every structure combat can march on or shoot at, both sides, rebuilt each tick. */
function rtsStructTargets(): RtsStructTarget[] {
  const out: RtsStructTarget[] = [];
  if (rtsGame) {
    for (const s of rtsGame.structures) {
      out.push({
        id: s.id,
        side: 0,
        lon: s.lon,
        lat: s.lat,
        radiusM: STRUCTURES[s.type].footprintM,
        // The Nexus is the one building that shoots back. See NEXUS_LASER for what it is sized to do.
        weapon: s.type === 'nexus' ? NEXUS_LASER : undefined,
      });
    }
  }
  if (millstone && !millstone.destroyed) {
    out.push({ id: ENEMY_NEXUS_ID, side: 1, lon: millstone.lon, lat: millstone.lat, radiusM: STRUCTURES.nexus.footprintM });
  }
  return out;
}

/** Run one frame of combat and render/score what it did. */
function runRtsCombat(dt: number): void {
  if (!rtsGame || !unitField || rtsEnded) return;
  const ev = unitField.rtsCombatTick(dt, rtsStructTargets());

  // Each attack kind gets its own vocabulary, so what is happening to you reads without reading
  // the numbers: a BEAM means damage has already landed, a round in the air means it hasn't yet,
  // and a flurry of sparks at contact means something is being taken apart by hand.
  for (const s of ev.shots) {
    const from = Cesium.Cartesian3.fromDegrees(s.flon, s.flat, s.falt);
    const to = Cesium.Cartesian3.fromDegrees(s.tlon, s.tlat, s.talt);
    const color = s.side === 1 ? MILLSTONE_BEAM : undefined;
    if (s.kind === 'ranged') {
      lasers?.fire(from, to, color);
    } else if (s.kind === 'melee') {
      // No beam: there is no shot to draw. Sparks at the point of contact instead — the same
      // vocabulary a siege attacker cutting into an obelisk uses, because it is the same act.
      sparks?.emit(to, 3);
    } else {
      // The muzzle event only. The round itself is drawn from ev.rounds until it arrives, which is
      // the whole point of a projectile: for a second or two it is a thing in the world.
      sparks?.emit(from, 1);
    }
  }
  // The round list is authoritative and rebuilt every frame, so this is a straight redraw.
  rounds?.show(ev.rounds);
  for (const im of ev.impacts) {
    blasts?.fire(im.lon, im.lat, theaterMap?.heightAt(im.lon, im.lat) ?? 0, im.radiusM);
  }
  // One report per frame, however thick the volley — per-shot playback stacks into a screech.
  if (ev.shots.some((s) => s.kind === 'ranged')) sound.play('laser');
  if (ev.impacts.length) sound.play('commit');

  for (const k of ev.kills) {
    const h = theaterMap?.heightAt(k.lon, k.lat) ?? 0;
    blasts?.fire(k.lon, k.lat, h, 90);
    if (k.side === 0) {
      // One of ours. Dropping it from the roster releases its supply too; the field already took it
      // off the board.
      const role = rtsGame.unitIdOf(k.index);
      rtsGame.removeUnit(k.index);
      toast(role ? `◈ ${RTS_UNITS[role].name} LOST` : '◈ UNIT LOST');
    }
  }

  for (const hit of ev.hits) {
    // A structure under fire throws sparks — the "your base is being hit" signal that reads from
    // any altitude even before the health loss shows.
    if (sparks && Math.random() < 0.5) {
      const h = theaterMap?.heightAt(hit.lon, hit.lat) ?? 0;
      sparks.emit(Cesium.Cartesian3.fromDegrees(hit.lon, hit.lat, h + 50), 2);
    }
    applyStructureHit(hit);
  }
}

/** Land one hit on a structure — the player's or Millstone's Nexus — and handle its fall. */
function applyStructureHit(hit: { id: number; dmg: number }): void {
  if (hit.id === ENEMY_NEXUS_ID) {
    if (millstone && millstone.damage(hit.dmg)) onMillstoneRazed();
    return;
  }
  const s = rtsGame?.structures.find((x) => x.id === hit.id);
  if (!s) return;
  s.hp -= hit.dmg;
  if (s.hp <= 0) destroyPlayerStructure(s);
}

/** A player structure has fallen: blast, teardown, and whatever the loss means. */
function destroyPlayerStructure(s: Structure): void {
  if (!rtsGame) return;
  blasts?.fire(s.lon, s.lat, theaterMap?.heightAt(s.lon, s.lat) ?? 0, STRUCTURES[s.type].footprintM);
  sound.play('lost');
  rtsGame.removeStructure(s.id);
  if (rtsSelectedStructure?.id === s.id) clearStructureSelection();

  if (s.type === 'nexus') {
    // The match. Everything else is cleanup for a game that just ended.
    endRtsWith(false);
    return;
  }
  if (s.type === 'obelisk' && s.siteIndex !== undefined) {
    // An obelisk is a network site: clear its mask bit and rebuild pyramids + sensors from what's
    // left — the exact inverse of buildObeliskAt. The site frees for a rebuild.
    if (obeliskMask) obeliskMask[s.siteIndex] = 0;
    rtsBuiltSites.delete(s.siteIndex);
    if (theaterCenter && theaterMap) addObeliskPyramids(theaterCenter.lon, theaterCenter.lat, theaterMap);
    rtsBuild?.setSites(rtsSites, rtsBuiltSites);
  } else {
    rtsBuild?.removeFacility(s);
  }
  toast(`◈ ${STRUCTURES[s.type].name} DESTROYED`);
  refreshPowerLines();
  rtsCmd?.render();
  updateRtsHud();
}

/** Millstone's Nexus is down — the win. */
function onMillstoneRazed(): void {
  if (!millstone) return;
  blasts?.fire(millstone.lon, millstone.lat, theaterMap?.heightAt(millstone.lon, millstone.lat) ?? 0, 500);
  rtsBuild?.clearEnemyNexus();
  endRtsWith(true);
}

/** Decide the match, once. The world keeps rendering behind the modal; the directors stop. */
function endRtsWith(victory: boolean): void {
  if (rtsEnded) return;
  rtsEnded = true;
  sound.play(victory ? 'success' : 'lost');
  showRtsEnd(victory);
}

/** The end-of-match modal: one line on what happened, one button back to the title. */
function showRtsEnd(victory: boolean): void {
  if (document.getElementById('c2-rts-end')) return;
  const back = document.createElement('div');
  back.className = 'c2-modal-back';
  back.id = 'c2-rts-end';

  const box = document.createElement('div');
  box.className = 'c2-modal' + (victory ? ' c2-complete' : '');
  box.innerHTML =
    `<div class="c2-modal-head">` +
    `<span class="c2-name">${victory ? 'MILLSTONE RAZED' : 'NEXUS LOST'}</span>` +
    `<span class="c2-order ${victory ? 'order-investigate' : 'order-execute'}">${victory ? 'VICTORY' : 'DEFEAT'}</span>` +
    `</div>` +
    `<p class="c2-modal-p">${
      victory
        ? 'Their Nexus is rubble and the waves have stopped. The theater is yours — such as it is.'
        : 'Your Nexus is down. A network with no heart is scrap with good sightlines; Millstone will strip the rest at its leisure.'
    }</p>`;

  const actions = document.createElement('div');
  actions.className = 'c2-modal-actions';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'c2-buy';
  btn.textContent = 'RETURN TO TITLE';
  btn.addEventListener('click', () => {
    back.remove();
    endRtsMatch();
  });
  actions.append(btn);
  box.append(actions);
  back.append(box);
  document.body.append(back);
}

/**
 * Resolve after the next paint — or after a short timeout, whichever lands first.
 *
 * The timeout is not belt-and-braces, it is the whole point. requestAnimationFrame does not fire in
 * a backgrounded tab, so waiting on it unconditionally means a player who alt-tabs during a load
 * comes back to a loading screen that will never lift. Nothing downstream of this actually needs
 * the frame; it only makes the reveal prettier when the tab is visible.
 */
function nextFrame(timeoutMs = 400): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(finish));
    window.setTimeout(finish, timeoutMs);
  });
}

/**
 * Back to the title screen.
 *
 * Everything is already persisted continuously, so there is nothing to flush — this just tears the
 * sortie down, closes the slot (after which no module will write anything), and puts the menu up.
 */
function exitToTitle(): void {
  if (mode === 'theater') exitTheater();
  hideLoading();
  hideUnitPanel();
  setActiveSlot(null);
  applyOwnership(true); // nothing owned at the menu — clear the orbit heat
  bootTitle();
}

function bootTitle(): void {
  // The score belongs to the menus and the world map — bring it up as the title goes on. (The first
  // fadeIn before any click is blocked by autoplay policy; music.ts starts it on the first gesture.)
  music.fadeIn();
  showTitle({
    onPlay: (slot) => void openCampaign(slot),
    onPlayRts: () => void startRtsMatch(),
  });
}

migrateLegacySave();
bootTitle();

/**
 * Sites pulled down by the siege in the CURRENT theater. Global obelisk indices.
 *
 * Deliberately not persisted and cleared on every theater entry: the net is rebuilt whenever a
 * theater is chosen, so losses are a pressure to manage within a sortie rather than permanent
 * damage to the campaign's territory.
 */
let fallenObelisks = new Set<number>();
/** Global obelisk index for each site in the current theater, indexed as the sensor field sees them. */
let theaterSiteIndex: Int32Array | undefined;
/** Flat [lon,lat,...] of this theater's sites — the density map platforms are stationed from. */
let theaterSiteLonLat: Float64Array | undefined;
/** The home base in this theater, if the state's first site falls inside it. */
let theaterHome: { lon: number; lat: number } | undefined;

/**
 * How far the home garrison reaches to take an attacker. Deliberately wider than an obelisk's
 * sensor disc — the T-frame is a garrison, and being able to defend itself is the point of it.
 */
const GARRISON_DETAIN_M = 2200;

/**
 * How many live sites a theater centred here would contain. Same bbox-then-radius test the obelisk
 * builder uses, so the answer can't disagree with what actually gets built.
 */
function liveSitesNear(lon: number, lat: number): number {
  if (!obelisks) return 0;
  const mask = liveObeliskMask();
  const rLat = (THEATER_RADIUS_M * RIM_FADE_START) / 111_320;
  const rLon = rLat / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
  let n = 0;
  for (let i = 0; i < obelisks.count; i++) {
    if (mask && !mask[i]) continue;
    const dLon = obelisks.lon[i] - lon;
    if (dLon < -rLon || dLon > rLon) continue;
    const dLat = obelisks.lat[i] - lat;
    if (dLat < -rLat || dLat > rLat) continue;
    const x = dLon / rLon;
    const y = dLat / rLat;
    if (x * x + y * y <= 1) n++;
  }
  return n;
}

/** Ownership mask minus anything the siege has already destroyed here. */
function liveObeliskMask(): Uint8Array | undefined {
  if (!obelisks) return undefined;
  const base = obeliskMask;
  if (!fallenObelisks.size) return base;
  const mask = base ? base.slice() : new Uint8Array(obelisks.count).fill(1);
  for (const i of fallenObelisks) mask[i] = 0;
  return mask;
}

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
    liveObeliskMask(),
    // The state this theater sits in decides which site is the base.
    theaterCenter ? territory?.stateAt(theaterCenter.lon, theaterCenter.lat)?.downtown : undefined,
  );
  if (!built) {
    setText('g-obelisks', '0 IN THEATER');
    theaterSiteIndex = undefined;
    theaterSiteLonLat = undefined;
    theaterHome = undefined;
    return;
  }
  obeliskPyramids = scene.primitives.add(built.primitive);
  obeliskFlare = scene.primitives.add(built.flare);
  theaterSiteIndex = built.indices;
  theaterSiteLonLat = built.lonLat;

  theaterHome = built.home ? { lon: built.home.lon, lat: built.home.lat } : undefined;
  if (built.home) {
    homeFrame = scene.primitives.add(built.home.primitive);
    // A ring on the ground marks which site is the base, since the T-frame reads as shape and this
    // reads as position — you can find it from across the theater.
    const ring = scene.primitives.add(new Cesium.PolylineCollection()) as Cesium.PolylineCollection;
    homeRing = ring;
    for (const r of [900, 1400]) {
      ring.add({
        positions: ringPositions(built.home.lon, built.home.lat, r, map.heightAt(built.home.lon, built.home.lat) + 30),
        width: 2,
        material: Cesium.Material.fromType('Color', { color: RED.withAlpha(r === 900 ? 0.85 : 0.4) }),
      });
    }
  }

  // Tiny site dots for when the obelisks themselves have gone sub-pixel.
  const dots = new Cesium.PointPrimitiveCollection();
  const cond = new Cesium.DistanceDisplayCondition(SITE_DOT_FROM_M, Number.MAX_VALUE);
  for (let i = 0; i < built.count; i++) {
    dots.add({
      position: new Cesium.Cartesian3(built.apex[i * 3], built.apex[i * 3 + 1], built.apex[i * 3 + 2]),
      color: RED,
      pixelSize: 3,
      distanceDisplayCondition: cond,
      disableDepthTestDistance: 1e12,
    });
  }
  obeliskDots = scene.primitives.add(dots);
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
  if (homeFrame) {
    scene.primitives.remove(homeFrame);
    homeFrame = undefined;
  }
  if (homeRing) {
    scene.primitives.remove(homeRing);
    homeRing = undefined;
  }
  if (obeliskDots) {
    scene.primitives.remove(obeliskDots);
    obeliskDots = undefined;
  }
}

/**
 * Home-base rings on the orbit globe — one at each held state's first site.
 *
 * The downtown obelisk a state is unlocked with IS its base, so marking it in the select view makes
 * the campaign map read as a set of footholds rather than an undifferentiated heat smear.
 */
function rebuildOrbitHomeRings() {
  if (orbitHomeRings) {
    scene.primitives.remove(orbitHomeRings);
    orbitHomeRings = undefined;
  }
  if (!territory || !obelisks) return;
  const col = new Cesium.PolylineCollection();
  for (const st of territory.states) {
    if (!progression.isUnlocked(st)) continue;
    const i = st.downtown;
    col.add({
      positions: ringPositions(obelisks.lon[i], obelisks.lat[i], 45_000, 2000, 40),
      width: 2,
      material: Cesium.Material.fromType('Color', { color: RED.withAlpha(0.9) }),
    });
  }
  col.show = mode === 'globe';
  orbitHomeRings = scene.primitives.add(col);
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

// The panel's copy of the field palette used to live here, hand-duplicated from units.ts and free to
// drift from it. It doesn't any more: the card asks the field what colour a unit is (`single.tint`),
// which is the same call the renderer makes. See TINT_HEX in cesium/units.ts.
const KIND_ABBR: Record<UnitKind, string> = {
  land: 'CV', sea: 'SV', air: 'AV', foot: 'FT',
  drone: 'DISC', dog: 'K9', quad: 'KITE', spider: 'ARC', biped: 'MAR', walker: 'COL',
  naval: 'LIT', interceptor: 'RAP', skid: 'WRK', usv: 'USV',
  drudge: 'DRD', ripper: 'RIP', flenser: 'FLN', bulwark: 'BLW', mote: 'MOT',
  shrike: 'SHR', hulk: 'HLK', censer: 'CNS', leviathan: 'LEV',
};
const BAND_ABBR: Record<string, string> = { clear: 'CLR', suspect: 'SUS', threat: 'THR' };
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const MARK_HEX = '#F2A83B';

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
 * The live accusation block.
 *
 * Shows the net's confidence against the public bar side by side, because that comparison IS the
 * decision — everything else on the card is context for it. The note underneath says plainly what
 * acting below the bar will cost, since the whole design depends on the operator choosing to do it
 * anyway sometimes rather than being surprised by the bill.
 */
/**
 * Paint one evidence track: the fill is what we have, the two ticks are what each authority wants
 * before it stops objecting. Both tracks on the card are drawn by this, so the contact's standing
 * case and the live event are never accidentally shown on two different scales.
 */
function paintTrack(id: string, evidence: number, pub: number, pol: number, clears: boolean) {
  const track = el(id) as HTMLElement | null;
  if (!track) return;
  track.classList.toggle('clear', clears);
  track.classList.toggle('short', !clears);
  const fill = track.querySelector('i') as HTMLElement | null;
  const tickPol = track.querySelector('u.tick-policy') as HTMLElement | null;
  const tickPub = track.querySelector('u.tick-public') as HTMLElement | null;
  if (fill) fill.style.width = `${Math.round(evidence * 100)}%`;
  if (tickPol) tickPol.style.left = `${Math.round(pol * 100)}%`;
  if (tickPub) tickPub.style.left = `${Math.round(pub * 100)}%`;
}

/**
 * The live accusation block.
 *
 * No buttons of its own any more. It reports the event and its evidence figure, and the ladder
 * underneath acts on it — because FINE and EXECUTE are answers to the same question and putting two
 * of them here and three of them somewhere else was the old design telling a lie about that.
 */
function renderLive(index: number, s: SanctionDef, subj: Subject) {
  const box = el('up-live') as HTMLElement | null;
  if (!box) return;
  const live = index >= 0 ? (unitField?.liveOf(index) ?? null) : null;
  if (!live) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const v = judge(s, live.certainty, subj, unitField?.toleranceOverride ?? false);
  box.classList.toggle('below', !v.clearsPublic);

  setText('ul-what', live.def.label);
  setText('ul-age', `${Math.max(0, Math.round(VIOLATION_TTL_S - live.ageS))}s`);
  setText('ul-cert-v', `${Math.round(live.certainty * 100)}%`);
  // These rows read as TOLERANCE, so they show 1 − bar, not the raw threshold. A high evidence bar
  // means the audience is barely tolerant (it needs a lot before it accepts), so the tolerance shown
  // is its inverse. On an ordinary contact the public is the LESS tolerant of the two — the street is
  // the harder audience — while the chain (policy) is more willing to act; a protected asset flips it.
  setText('ul-tol-v', `${Math.round((1 - v.publicBar) * 100)}%`);
  setText('ul-pol-v', `${Math.round((1 - v.policyBar) * 100)}%`);
  paintTrack('ul-track', live.certainty, v.publicBar, v.policyBar, v.clearsPublic && v.clearsPolicy);
}

/**
 * Draw the selected unit's charge sheet, worst offence first. `record < 0` means the row doesn't
 * apply at all (the drone), which is different from a clean record and reads differently.
 */
function renderCharges(record: Record_ | null) {
  const wrap = el('up-record');
  const list = el('up-charges');
  if (!wrap || !list) return;
  if (record === null) {
    (wrap as HTMLElement).hidden = true;
    return;
  }
  (wrap as HTMLElement).hidden = false;
  // PAST INFRACTIONS are an unlock in their own right (DRAGNET). Until then the record is sealed —
  // Act I runs on the live event alone, which is exactly what a citation is judged on anyway.
  if (!infoUnlocked('past-record')) {
    const li = document.createElement('li');
    li.className = 'sealed';
    li.textContent = '◹ RECORD SEALED · NO AUTHORITY';
    list.replaceChildren(li);
    return;
  }
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

/** Charged for pulling a dossier field AHEAD of the authority that would release it — overreach. */
const DOSSIER_PULL_RESISTANCE = 0.02;
const DOSSIER_PULL_POLICY = 0.012;
/** Contacts whose sealed fields the operator has pulled this session, keyed `${callsign}:${fieldId}`. */
const dossierPulled = new Set<string>();

/**
 * The dossier block: the five fields past face / identity / record.
 *
 * Each row is in one of three states. OPEN — the tasking that unlocks it is cleared and it isn't a
 * behind-a-click field. SEALED but PULLABLE — SEARCH is released, so the operator can pull it: free
 * for a field already earned, or as OVERREACH for one pulled ahead of its authority, which hardens
 * the ground. SEALED and locked — SEARCH isn't released yet, so the row just names what it waits on.
 */
function renderDossier(callsign: string) {
  const wrap = el('up-dossier') as HTMLElement | null;
  if (!wrap) return;
  wrap.hidden = false;
  wrap.replaceChildren();
  const canSearch = searchAvailable();

  for (const f of extraFields(callsign)) {
    const unlocked = infoUnlocked(f.id);
    const pulledKey = `${callsign}:${f.id}`;
    const visible = (unlocked && !f.sealed) || dossierPulled.has(pulledKey);

    const row = document.createElement('div');
    row.className = 'up-drow';
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = f.label;
    row.append(k);

    if (visible) {
      const v = document.createElement('span');
      v.className = 'v';
      v.textContent = f.value;
      if (f.note) {
        const note = document.createElement('em');
        note.className = 'dnote';
        note.textContent = f.note;
        v.append(' ', note);
      }
      row.append(v);
    } else if (canSearch) {
      const overreach = !unlocked;
      row.classList.add('sealed', 'pullable');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `up-pull${overreach ? ' overreach' : ''}`;
      btn.textContent = overreach ? '◹ SEARCH · PULL AHEAD OF AUTHORITY' : '◹ SEARCH · ON FILE';
      btn.addEventListener('click', () => {
        dossierPulled.add(pulledKey);
        if (overreach) {
          resistance.aggravate(DOSSIER_PULL_RESISTANCE);
          policy.tighten(DOSSIER_PULL_POLICY);
          toast('◈ FILE PULLED AHEAD OF AUTHORITY · THE CHAIN WILL NOTE IT');
        }
        sound.play('order');
        renderDossier(callsign);
      });
      row.append(btn);
    } else {
      row.classList.add('sealed');
      const v = document.createElement('span');
      v.className = 'v sealed-v';
      v.textContent = '◹ SEALED · NO AUTHORITY';
      row.append(v);
    }
    wrap.append(row);
  }
}

/**
 * The capture plate at the top of the card.
 *
 * A contact gets a face, generated from its callsign so it's the same face every time. A PLATFORM
 * gets its glyph instead — machines don't have mug shots, and swapping the slot's contents rather
 * than hiding it keeps the card from jumping when the selection moves between the two.
 */
let mugShownFor = '';
function renderMug(id: string, platform: PlatformId | null) {
  const slot = el('up-mug');
  if (!slot) return;
  // The LIVE CAMERA is itself an unlock (CIVIL MANDATE). Before it, a contact has no capture plate —
  // the card is working blind, which is the whole early game. Hardware always shows its glyph.
  const camera = platform !== null || infoUnlocked('live-camera');
  const key = `${id}|${platform ?? 'c'}|${camera ? 1 : 0}`;
  if (mugShownFor === key) return;
  mugShownFor = key;
  slot.classList.toggle('hardware', platform !== null);
  slot.classList.toggle('nocam', platform === null && !camera);
  if (platform) {
    slot.innerHTML = icon(platform);
    return;
  }
  if (!camera) {
    slot.innerHTML = '<span class="up-nocam">◹ NO CAMERA<br>UPLINK</span>';
    return;
  }
  slot.replaceChildren(portraitFor(id));
}

/**
 * The header tag: what this contact IS, when it is something.
 *
 * Only ever shown for the two things that change how a contact should be handled — company
 * protection, and a live role in an incident — and it carries the same colour the unit renders in
 * the field, so the tag and the dot and the model on the map are one statement rather than three.
 * An ordinary contact gets nothing, because a tag on everybody is a tag on nobody.
 */
const ROLE_TAG: Record<string, string> = {
  attacker: 'ATTACKING A SITE',
  assassin: 'TARGETED KILLING',
  insurgent: 'INSURGENT ATTACK',
  rioter: 'CIVIL DISORDER',
  brawler: 'ALTERCATION',
  runner: 'IN PURSUIT',
};
function renderTag(one: {
  protectedAsset: boolean;
  role?: string;
  tint: string;
  faction?: FactionId;
  hostile?: boolean;
}) {
  const tag = el('up-tag') as HTMLElement | null;
  if (!tag) return;
  const fac = one.faction ? FACTION_BY_ID.get(one.faction) : undefined;
  // Precedence: what somebody is DOING this second (a live incident role) outranks what they ARE on
  // file (a backer's asset, or a rival's man). Protection names the backer; hostility names the
  // rival — the fork choice made visible on the one contact it touches.
  let label: string | null = null;
  let tint = one.tint;
  if (one.role) {
    label = ROLE_TAG[one.role];
  } else if (one.protectedAsset) {
    label = fac ? `PROTECTED · ${fac.name}` : 'PROTECTED ASSET';
    if (fac) tint = fac.tint;
  } else if (one.hostile && fac) {
    label = `HOSTILE · ${fac.name}`;
    tint = fac.tint;
  }
  tag.hidden = !label;
  if (!label) return;
  tag.textContent = label;
  tag.style.color = tint;
  tag.style.borderColor = tint;
}

// ---- the decision ------------------------------------------------------------------------------

/**
 * Which rung the operator is currently ASKING about. Not an order — selecting a sanction only
 * re-reads the card against it, and nothing happens until ACTIVATE DECISION.
 *
 * It resets to INVESTIGATE whenever the selection moves to a different contact. A pending EXECUTE
 * must never survive a click onto somebody else: the cheapest possible bug in this design is the
 * operator arming a killing for one person and committing it against another.
 */
let sanctionId: SanctionId = 'investigate';
let sanctionFor = -1;

function currentSanction(): SanctionDef {
  return SANCTION_BY_ID.get(sanctionId)!;
}

/**
 * Which platform types could carry a sanction — the pool auto-dispatch picks from.
 *
 * A sanction needing no hardware needs no platform at all: a citation is issued from C2 and an
 * investigation is opened on a file. Only the three that end with somebody being physically taken
 * or shot need something in the theater to do it.
 */
function carriersFor(s: SanctionDef, index: number): PlatformId[] {
  if (!s.capability) return [];
  const owned = progression.ownedPlatforms();
  const fitted = owned.filter((id) => progression.platformHas(id, s.capability!));
  // Self-defence: a quadruped can take somebody off a site bare-handed, with no rig and no custody
  // authority, but ONLY against something actively causing trouble. It is the campaign's only
  // answer to an attack for the first three missions, so it has to reach the ladder too — the card
  // replacing the context menu must not quietly delete the opening game's one defence.
  if (s.id === 'detain' && (unitField?.isThreatActor(index) ?? false)) {
    for (const id of owned) {
      if (PLATFORM_BY_ID.get(id)?.selfDefence?.includes('detain') && !fitted.includes(id)) fitted.push(id);
    }
  }
  return fitted;
}

/**
 * Whether the chain has released this rung yet, and what would release it.
 *
 * Distinct from {@link blockerFor} on purpose, and checked first. "You do not have this power" and
 * "you have it but nothing here can carry it out" are different sentences, and an operator who
 * reads the second when the first is true will go and buy hardware that changes nothing.
 */
function lockFor(s: SanctionDef, index: number): string | null {
  if (!s.requiresMission || missions.isComplete(s.requiresMission)) return null;
  // Self-defence outranks the lock, and only ever against something actively causing trouble.
  // Taking hold of somebody pulling a site down is defence of company property, not custody, and it
  // has never needed the chain's permission. The campaign runs three missions on one quadruped
  // before custody is granted — without this exemption, the whole of that stretch has no answer to
  // a siege or a killing in progress except to watch it happen.
  if (s.id === 'detain' && carriersFor(s, index).length && (unitField?.isThreatActor(index) ?? false)) {
    return null;
  }
  const m = MISSIONS.find((x) => x.id === s.requiresMission);
  return `LOCKED · GRANTED ON CLEARING ${m?.name ?? s.requiresMission.toUpperCase()}`;
}

/** What stands between the operator and carrying this out, or null when nothing does. */
function blockerFor(s: SanctionDef, index: number): string | null {
  const locked = lockFor(s, index);
  if (locked) return locked;
  if (!s.dispatch) return null;
  const carriers = carriersFor(s, index);
  if (!carriers.length) {
    return s.capability === 'laser'
      ? 'NO EMITTER FITTED ON ANY PLATFORM'
      : 'NO DETAINMENT RIG FITTED ON ANY PLATFORM';
  }
  if (!unitField?.anyFielded(carriers)) return 'NO CAPABLE PLATFORM IN THIS THEATER';
  return null;
}

/**
 * The ladder, the verdict, and the commit.
 *
 * The verdict line is the whole redesign in one sentence: it names both bars separately, always,
 * even when the answer is "no objection expected". An operator should never have to infer which
 * authority they are about to upset.
 */
let ladderBuilt = false;
function renderDecision(one: {
  index: number;
  kind: string;
  assess: number;
  record: Record_;
  protectedAsset: boolean;
}) {
  const wrap = el('up-decide') as HTMLElement | null;
  if (!wrap) return;
  wrap.hidden = false;

  if (!ladderBuilt) {
    const rail = el('up-ladder');
    if (rail) {
      rail.replaceChildren(
        ...SANCTIONS.map((s) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = `up-rung${s.id === 'execute' ? ' lethal' : ''}`;
          b.dataset.sanction = s.id;
          b.textContent = s.label;
          b.title = s.blurb;
          b.addEventListener('click', () => {
            sanctionId = s.id;
            sound.play('click');
            updateUnitPanel();
          });
          return b;
        }),
      );
      ladderBuilt = true;
    }
  }

  const s = currentSanction();
  const live = unitField?.liveOf(one.index) ?? null;
  // WHICH figure the sanction is read against, and the rule is worth stating plainly: with a live
  // event up you are answering the EVENT, so it is judged on that event's evidence. With no event
  // up you are answering the PERSON, so it is judged on their standing case. The card labels the
  // figure either way, so the operator always knows which question they just answered.
  const evidence = live ? live.certainty : caseStrength(one.assess, one.record);
  const v = judge(s, evidence, { protectedAsset: one.protectedAsset }, unitField?.toleranceOverride ?? false);
  const blocked = blockerFor(s, one.index);

  for (const b of Array.from(el('up-ladder')?.children ?? []) as HTMLButtonElement[]) {
    const def = SANCTION_BY_ID.get(b.dataset.sanction as SanctionId)!;
    const locked = !!lockFor(def, one.index);
    b.classList.toggle('on', def.id === sanctionId);
    // A rung the chain hasn't released reads differently to one that's merely undeliverable: the
    // first is a thing you don't have yet, the second is a thing you left at home.
    b.classList.toggle('locked', locked);
    b.classList.toggle('unavailable', !locked && !!blockerFor(def, one.index));
  }

  const verdict = el('up-verdict') as HTMLElement | null;
  if (verdict) {
    verdict.textContent = v.headline;
    verdict.className = `up-verdict ${
      v.clearsPublic && v.clearsPolicy
        ? 'clear'
        : !v.clearsPublic && !v.clearsPolicy
          ? 'both-short'
          : v.clearsPublic
            ? 'policy-short'
            : 'public-short'
    }`;
  }

  // The consequence line is costed in the operator's own units — points below each bar — rather
  // than in the raw resistance figures, which mean nothing to anybody outside this file.
  const parts: string[] = [];
  if (blocked) parts.push(blocked);
  if (!v.clearsPublic) parts.push(`${Math.round(v.publicShort * 100)} points under the public bar — the ground will harden.`);
  if (!v.clearsPolicy) parts.push(`${Math.round(v.policyShort * 100)} points outside the licence — the chain will narrow it.`);
  if (!parts.length) parts.push(s.blurb);
  setText('up-consequence', parts.join(' '));

  const go = el('up-activate') as HTMLButtonElement | null;
  if (go) {
    const tracked = unitField?.isTrackedPublic(one.index) ?? false;
    go.disabled = !!blocked || !tracked;
    go.classList.toggle('lethal', s.id === 'execute');
    // A protected asset is off limits by contract, so touching one is never a reflex: the button
    // turns into a HOLD, and the order only commits after the bar fills. `data-hold` drives the
    // pointer handler; the class drives the fill styling. Both are re-set every render, which is
    // safe — the in-progress `.holding` state and its `--hold` fill live outside this function.
    const hold = one.protectedAsset && !go.disabled && !lockFor(s, one.index);
    go.dataset.hold = hold ? '1' : '';
    go.classList.toggle('hold', hold);
    if (!hold) go.classList.remove('holding');
    go.textContent = !tracked
      ? 'NO SENSOR CONTACT'
      : lockFor(s, one.index)
        ? 'NOT YET AUTHORIZED'
        : blocked
          ? 'CANNOT BE CARRIED OUT'
          : hold
            ? `HOLD TO OVERRIDE · ${s.label}`
            : `ACTIVATE DECISION · ${s.label}`;
  }
}

/**
 * Commit the selected sanction against the selected contact.
 *
 * Both bills are charged HERE, at the moment of the decision, not when the platform arrives. The
 * operator is answerable for the order, not for how it turns out — which is the same rule the mark
 * button has always used and the one the whole resistance model is built on.
 */
function activateDecision(index: number): void {
  if (!unitField) return;
  const s = currentSanction();
  if (blockerFor(s, index)) return;
  const live = unitField.liveOf(index);
  const one = unitField.contactSummary(index);
  if (!one) return;
  const evidence = live ? live.certainty : caseStrength(one.assess, one.record);
  const v = judge(s, evidence, { protectedAsset: one.protectedAsset }, unitField.toleranceOverride);

  if (v.resistance > 0) resistance.aggravate(v.resistance);
  if (v.policyCost > 0) policy.tighten(v.policyCost);
  const pos = unitField.positionOf(index);
  if (pos && (!v.clearsPublic || !v.clearsPolicy)) reactAt(pos.lon, pos.lat, 'dismay');

  switch (s.id) {
    case 'fine':
      issueFine(index);
      break;
    case 'investigate':
      // With no live event there is nothing to close, so this becomes a standing order on the
      // person instead — the same investigation the mark button issues, on its rescind timer.
      if (live) investigateLive(index);
      else {
        unitField.markContact(index, 'investigate');
        sound.play('order');
        toast('◈ INVESTIGATION ORDERED');
      }
      break;
    default: {
      const sent = unitField.dispatch(index, s.id, carriersFor(s, index));
      if (!sent) {
        sound.play('denied');
        toast('◈ NO PLATFORM CAN REACH THIS CONTACT');
        return;
      }
      sound.play(s.id === 'execute' ? 'orderLethal' : 'order');
      toast(
        `◈ ${s.label} · ${KIND_LABEL[sent.kind] ?? sent.kind} DISPATCHED${sent.reassigned ? ' · PULLED OFF STATION' : ''}`,
      );
      // Acting on a live event answers it, whichever rung was used: a contact carried away is not
      // still standing there jaywalking. Leaving it up let the operator detain somebody and then
      // fine the corpse for the same event.
      if (live) unitField.clearLive(index);
    }
  }

  if (!v.clearsPublic || !v.clearsPolicy) {
    toast(
      !v.clearsPublic && !v.clearsPolicy
        ? '◈ ORDERED PAST CONSENT AND OUTSIDE THE LICENCE'
        : !v.clearsPublic
          ? '◈ ORDERED PAST CONSENT · RESISTANCE RISING'
          : '◈ OUTSIDE THE LICENCE · THE CHAIN WILL NARROW IT',
    );
  }
  updateUnitHud();
  updateUnitPanel();
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
  // In an RTS match the selection panel IS the unit card: a dossier on your own machine (assessment,
  // charge sheet, sanction ladder) is meaningless. Routing it here rather than guarding a dozen call
  // sites means every path that used to raise the contact panel now raises the right one.
  if (rtsGame) {
    hideUnitPanel();
    rtsUnitCard?.render();
    return;
  }
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
    const isPlatform = PLATFORM_BY_ID.has(one.kind as PlatformId);
    // FACIAL RECOGNITION (STOP AND SEARCH) is what resolves a contact to an identity. Before it, the
    // callsign is withheld and the contact reads as unresolved. Hardware is always named.
    setText('up-id', isPlatform || infoUnlocked('facial-rec') ? one.id : 'UNRESOLVED CONTACT');
    setText('up-type', KIND_LABEL[one.kind]);
    renderTag(one);
    const band = assessBand(one.assess);
    const pct = Math.round(one.assess * 100);
    const stEl = el('up-status');
    if (stEl) {
      // Never the true state — an assessed likelihood. The drone is friendly hardware and has no
      // assessment at all; its row stays a transit status.
      stEl.textContent = isPlatform ? (one.order ?? 'ON STATION') : `${BAND_LABEL[band]} · ${pct}%`;
      stEl.className = isPlatform ? 'v sensor-tracked' : `v band-${band}`;
    }
    // A different contact clears whatever rung was being considered for the last one.
    if (one.index !== sanctionFor) {
      sanctionFor = one.index;
      sanctionId = 'investigate';
    }
    const s = currentSanction();
    const subj: Subject = { protectedAsset: one.protectedAsset };
    const evidence = isPlatform ? 0 : caseStrength(one.assess, one.record);
    const v = judge(s, evidence, subj, unitField.toleranceOverride);

    // The standing-case rows: the contact's own confidence against the rung's two bars. Hidden
    // wholesale for a platform, which is friendly hardware and has no case to answer.
    for (const id of ['up-conf', 'up-pub', 'up-pol']) {
      const row = el(id)?.parentElement as HTMLElement | null;
      if (row) row.hidden = isPlatform;
    }
    const track = el('up-conf-track') as HTMLElement | null;
    if (track) track.hidden = isPlatform;
    if (!isPlatform) {
      setText('up-conf', `${Math.round(evidence * 100)}%`);
      // Shown as tolerance (1 − bar), same as the live rows: a high threshold means low tolerance.
      setText('up-pub', `${Math.round((1 - v.publicBar) * 100)}%`);
      setText('up-pol', `${Math.round((1 - v.policyBar) * 100)}%`);
      paintTrack('up-conf-track', evidence, v.publicBar, v.policyBar, v.clearsPublic && v.clearsPolicy);
    }

    renderMug(one.id, isPlatform ? (one.kind as PlatformId) : null);
    renderCharges(isPlatform ? null : one.record);
    // The extended dossier is for contacts; a platform is friendly hardware with no file.
    if (isPlatform) {
      const dossierEl = el('up-dossier') as HTMLElement | null;
      if (dossierEl) dossierEl.hidden = true;
    } else {
      renderDossier(one.id);
    }
    renderLive(isPlatform ? -1 : one.index, s, subj);
    renderOrder(one.mark, one.markTimer);
    // The ladder is for contacts. Selecting your own drone offers no sanctions, because there is
    // nobody there to sanction.
    const decide = el('up-decide') as HTMLElement | null;
    if (isPlatform) {
      if (decide) decide.hidden = true;
    } else {
      renderDecision(one);
    }
    // The dot takes the unit's own field colour, so the card and the map always agree about what
    // is being looked at — including the two channels the band never knew about.
    if (dot) (dot as HTMLElement).style.color = one.tint;
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
        const st = unitField.platformStatus(one.index);
        const km = ((st?.rangeM ?? 0) / 1000).toFixed(1);
        senEl.textContent = st ? `${km} KM · ${st.seen} SEEN · ${st.infected} INF` : `${km} KM`;
        senEl.className = 'v sensor-tracked';
      } else {
        const covered =
          (!sensorField || sensorField.isCovered(one.lon, one.lat)) ||
          unitField.platformCovers(one.lon, one.lat);
        // Once a contact leaves coverage it stays actionable for a grace window; show it counting
        // down so the operator knows how long they have to act before it goes dark.
        const grace = covered ? 0 : unitField.graceRemaining(one.index);
        if (covered) {
          senEl.textContent = 'TRACKED';
          senEl.className = 'v sensor-tracked';
        } else if (grace > 0) {
          senEl.textContent = `LAST SEEN · ${Math.ceil(grace)}s`;
          senEl.className = 'v sensor-grace';
        } else {
          senEl.textContent = 'OUT OF RANGE';
          senEl.className = 'v sensor-dark';
        }
      }
    }
    renderLoadout(isPlatform ? (one.kind as PlatformId) : null);
  } else {
    setText('up-id', `${sel.count} UNITS`);
    const tag = el('up-tag') as HTMLElement | null;
    if (tag) tag.hidden = true;
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
  // One contact gets the ladder; a marquee full of them gets the mass order, which is a blunter
  // instrument by design and stays that way. Only one of the two is ever on screen.
  if (mk) mk.hidden = !!one;
  if (mk && !one) {
    const decide = el('up-decide') as HTMLElement | null;
    if (decide) decide.hidden = true;
    const st = unitField.markState();
    // Sensor contact is the only hard gate. Falling below public tolerance no longer refuses the
    // order — it warns, and the operator pays for it in resistance afterwards.
    const canAct = sel.orderableCount > 0;
    const overriding = sel.belowToleranceCount > 0 && sel.markedCount === 0;
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
      : overriding && !pending && st !== 'all'
        ? exec
          ? '◈ OVERRIDE · EXECUTE'
          : '◈ OVERRIDE · INVESTIGATE'
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
    mk.classList.toggle('override', canAct && overriding && !pending && st !== 'all');
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

/**
 * The active RTS match, or null in the surveillance campaign. An RTS game runs UNDER `mode='theater'`
 * so it inherits every theater input, movement and render path for free — this flag is what the
 * handful of RULE differences branch on (Nexus-only obelisks, an economy tick, no siege/incident
 * director, an RTS money HUD instead of the mission chrome). See src/game/rts/rtsGame.ts.
 */
let rtsGame: RtsGame | null = null;
/** The Millstone director — the RTS opponent's base, wave clock and Nexus health. Null outside a match. */
let millstone: MillstoneDirector | null = null;
/** Set once a match has been decided, so the end modal fires exactly once. */
let rtsEnded = false;
/** Millstone's beams fire in its own green, so a firefight reads as two sides at a glance. */
const MILLSTONE_BEAM = Cesium.Color.fromCssColorString('#3FBF6F');
/** The structure id the combat pass knows Millstone's Nexus by — no player id is ever negative. */
const ENEMY_NEXUS_ID = -1;
/** The RTS build layer (facility markers, site dots, placement ghost), or null outside a match. */
let rtsBuild: RtsBuildLayer | null = null;
/** The RTS build command bar, or null outside a match. */
let rtsCmd: RtsCommandBar | null = null;
/** The objective chain panel, or null outside a match. */
let rtsObjectives: RtsObjectivePanel | null = null;
/** Objectives cleared this match. */
const rtsObjectivesDone = new Set<ObjectiveId>();
/** Whether an orbital strike has been fired this match — an objective nothing else records. */
let rtsOrbitalFired = false;
/** Seconds until the next objective check. Conditions move slowly; sixty checks a second is waste. */
let rtsObjClock = 0;
/**
 * Whether I is being held — the INSPECT modifier.
 *
 * A held modifier rather than a mode, for the same reason shift+right-click spawns a Millstone unit:
 * inspecting is something you do to one person on the way past, not a state you enter and have to
 * remember to leave.
 */
let inspectHeld = false;
/** The theater's surveyed obelisk sites — where obelisks may be built. */
let rtsSites: BuildSite[] = [];
/** Global obelisk indices already carrying an obelisk (the Nexus, then anything built). */
const rtsBuiltSites = new Set<number>();
/** The structure currently being placed, or null. When set, clicks place instead of selecting. */
let rtsPlacing: StructureType | null = null;
/**
 * The ability currently being AIMED, and the building that will fire it.
 *
 * Shaped exactly like {@link rtsPlacing} — an armed cursor that owns the next left click — because it
 * is the same interaction: pick ground, commit, or right-click out of it. Carrying the structure id
 * means the strike is answerable to the tether that ordered it even if you click somewhere else in
 * between and lose the selection.
 */
let rtsAiming: { id: AbilityId; structureId: number } | null = null;
/** The selected structure (its command card is shown), or null. */
let rtsSelectedStructure: Structure | null = null;
/** The RTS unit card — portrait/HP/shield/energy for your own machines. Null outside a match. */
let rtsUnitCard: RtsUnitCard | null = null;

/**
 * Whether Millstone fights this match.
 *
 * Off while the economy and tech tree are being tuned: waves landing at 150 s make it impossible to
 * judge whether the build order itself feels good. Nothing about the enemy is deleted — the base
 * simply isn't seeded and the wave clock never runs. Toggle in the dev panel (RTS ▸ MILLSTONE) or
 * via `__gorgon.setMillstoneEnabled(true)`; it takes effect on the NEXT match.
 */
let millstoneEnabled = false;
/** Screen-space radius for clicking a structure. */
const STRUCTURE_PICK_PX = 30;

/** A structure a worker is currently building on site. */
interface ConstructionSite {
  id: number;
  type: StructureType;
  lon: number;
  lat: number;
  siteIndex?: number;
  remainingS: number;
  totalS: number;
  workerIndex: number;
}
let rtsConstruction: ConstructionSite[] = [];
let rtsConstructionId = 1;
/** How close a worker must be to its site to be actively building it. */
const BUILD_CONTACT_M = 300;
/** Once this many obelisks stand, EVERY surveyed site opens for building, not just the cluster nodes. */
const RTS_ALL_SITES_AT = 20;
let rtsSitesAllOpen = false;
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
  setText('gt-lost', `${run.obelisksLost} / ${def.maxObelisksLost}`);
  const vb = el('gt-valid-bar');
  if (vb) (vb as HTMLElement).style.width = `${Math.min(100, (run.valid / def.target) * 100)}%`;
  // Both failure bars fill against ceiling+1, since it's the one PAST the ceiling that fails.
  const ib = el('gt-invalid-bar');
  if (ib) (ib as HTMLElement).style.width = `${Math.min(100, (run.invalid / (def.maxInvalid + 1)) * 100)}%`;
  const lb = el('gt-lost-bar');
  if (lb) {
    (lb as HTMLElement).style.width =
      `${Math.min(100, (run.obelisksLost / (def.maxObelisksLost + 1)) * 100)}%`;
  }
}

/**
 * The siege alert. Driven every frame while an attacker is on the board, because the two numbers
 * that matter — how far out it still is, and how long the site has left — both move continuously.
 */
let siegeFocus: { lon: number; lat: number } | null = null;
/**
 * The incident alert.
 *
 * Its bar runs DOWN — it is time remaining, not progress made. A siege bar filling toward a site
 * falling and an incident bar draining toward someone dying are different feelings, and the one
 * that matters more should be the one that looks like it is running out.
 */
function updateIncidentHud() {
  const box = el('g-incident');
  if (!box) return;
  const a = incidents?.active();
  if (mode !== 'theater' || !a) {
    // No live incident — but the PREDICTIVE EVENT ALGORITHM (HOLD THE NET fork) forecasts the next.
    const f =
      mode === 'theater' && missions.hasChosen('defend', 'predictive-events') ? incidents?.forecast() : null;
    if (f) {
      (box as HTMLElement).hidden = false;
      box.classList.add('forecast');
      box.classList.remove('contact');
      setText('gi-title', `FORECAST · ${f.name}`);
      setText('gi-brief', 'PREDICTIVE ALGORITHM · INCOMING');
      setText('gi-count', `~${Math.ceil(f.etaS)}s`);
      const bar = el('gi-bar');
      if (bar) (bar as HTMLElement).style.width = '100%';
      incidentFocus = undefined; // no location to snap to until it lands
    } else {
      (box as HTMLElement).hidden = true;
      box.classList.remove('forecast');
    }
    return;
  }
  (box as HTMLElement).hidden = false;
  box.classList.remove('forecast');
  incidentFocus = { lon: a.lon, lat: a.lat };
  setText('gi-title', a.def.name);
  setText('gi-brief', a.def.brief);
  setText('gi-count', `${a.members} INVOLVED`);
  const urgent = a.remaining <= a.def.fuseS * 0.34;
  box.classList.toggle('contact', urgent);
  const bar = el('gi-bar');
  if (bar) (bar as HTMLElement).style.width = `${Math.max(0, (a.remaining / a.def.fuseS) * 100)}%`;
}

/**
 * The live-violation alert, shown only when the STOP AND SEARCH fork's alerting tech is chosen.
 *
 * SUSPICIOUS-ACTIVITY ALERTS narrow to the class an investigation is for and snap to the freshest;
 * LIVE INFRACTION ALERTS count the whole stream. Either way it's a heads-up and a jump-to — the net
 * flags what it sees; the operator decides whether to look.
 */
let alertFocus: { lon: number; lat: number } | undefined;
function updateAlertHud() {
  const box = el('g-alert') as HTMLElement | null;
  if (!box) return;
  const suspicious = missions.hasChosen('stopsearch', 'alert-suspicious');
  const infraction = missions.hasChosen('stopsearch', 'alert-infraction');
  if (mode !== 'theater' || !unitField || (!suspicious && !infraction)) {
    box.hidden = true;
    return;
  }
  const a = unitField.liveAlerts(suspicious);
  if (a.count === 0 || a.lon === undefined || a.lat === undefined) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  alertFocus = { lon: a.lon, lat: a.lat };
  setText('ga-label', suspicious ? 'SUSPICIOUS' : 'LIVE EVENTS');
  setText('ga-count', String(a.count));
}

function updateSiegeHud() {
  const box = el('g-siege');
  if (!box) return;
  const a = siege?.inbound();
  if (mode !== 'theater' || !a) {
    (box as HTMLElement).hidden = true;
    siegeFocus = null;
    return;
  }
  (box as HTMLElement).hidden = false;
  siegeFocus = { lon: a.lon, lat: a.lat };
  const inContact = a.rangeM <= 0;
  setText('gs-title', inContact ? 'SITE UNDER ASSAULT' : 'ATTACKER INBOUND');
  box.classList.toggle('contact', inContact);
  // Until something acquires it the attacker is a rumour, which is the point of spawning it dark.
  setText('gs-contact', a.tracked ? a.id : 'UNTRACKED');
  setText('gs-range', inContact ? 'IN CONTACT' : `${(a.rangeM / 1000).toFixed(1)} KM`);
  const bar = el('gs-bar');
  if (bar) {
    (bar as HTMLElement).style.width = `${Math.min(100, (a.assaultS / SIEGE.assaultS) * 100)}%`;
  }
}

// Every mission event can move the reminder, and mode changes decide whether it shows at all.
missions.onChange(() => updateTaskingHud());

/**
 * Swing the theater camera onto a ground point, keeping the current viewing angle.
 *
 * flyToBoundingSphere aims AT the point rather than to a fixed altitude, which is what makes it
 * robust to terrain — the same reason theater entry uses it.
 */
function focusOn(lon: number, lat: number, rangeM = 4500) {
  if (mode !== 'theater') return;
  camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, 0), 300), {
    offset: new Cesium.HeadingPitchRange(camera.heading, Cesium.Math.toRadians(-42), rangeM),
    duration: 1.2,
  });
}

/**
 * The platform roster: one small card per fielded unit, top left, theater only.
 *
 * Platforms are stationed in different cities and are sub-pixel from altitude, so hunting for one
 * on the map to click it is the wrong interaction. The roster is the handle — icon, callsign, and
 * whether it's moving — and clicking a card selects that machine.
 *
 * Rebuilt only when the fleet changes; the per-frame refresh just repaints state.
 */
let rosterSignature = '';
function rebuildRoster() {
  const box = el('g-roster');
  if (!box) return;
  if (mode !== 'theater' || !unitField) {
    (box as HTMLElement).hidden = true;
    rosterSignature = '';
    return;
  }
  const units = unitField.platformUnits();
  const sig = units.map((u) => u.id).join(',');
  if (sig === rosterSignature) return;
  rosterSignature = sig;
  (box as HTMLElement).hidden = units.length === 0;

  box.replaceChildren(
    ...units.map((u, i) => {
      // A short handle per unit — A, B, C … — so the roster is a row of chips across the top rather
      // than a column of cards down the side obscuring the data panel. The callsign is on hover.
      const letter = String.fromCharCode(65 + (i % 26));
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'gr-chip';
      chip.dataset.index = String(u.index);
      chip.title = u.id;
      chip.innerHTML =
        `<span class="gr-icon">${icon(u.kind)}</span>` +
        `<span class="gr-letter">${letter}</span>` +
        `<span class="gr-dot"></span>`;
      chip.addEventListener('click', () => {
        unitField?.selectIndexPublic(u.index);
        updateUnitPanel();
      });
      // Single click selects, double click goes there — the platforms are in different cities, so
      // selecting one is often only half of what you wanted.
      chip.addEventListener('dblclick', () => {
        const st = unitField?.platformStatus(u.index);
        if (st) focusOn(st.lon, st.lat);
      });
      return chip;
    }),
  );
}

/** Repaint the roster's live bits — selection (any unit in the marquee) and whether each is moving. */
function refreshRoster() {
  const box = el('g-roster');
  if (!box || (box as HTMLElement).hidden || !unitField) return;
  for (const chip of box.querySelectorAll<HTMLElement>('.gr-chip')) {
    const idx = Number(chip.dataset.index);
    chip.classList.toggle('selected', unitField.isSelected(idx));
    const st = unitField.platformStatus(idx);
    chip.classList.toggle('moving', !!st?.moving);
  }
}

function updateChrome() {
  setText('g-mode', mode === 'globe' ? 'ORBITAL · SELECT THEATER' : 'THEATER · C2 ACTIVE');
  const title = el('g-title');
  if (title) title.style.display = mode === 'globe' ? '' : 'none';
  const exit = el('g-exit');
  if (exit) (exit as HTMLButtonElement).hidden = mode !== 'theater';
  el('globe-ui')?.classList.toggle('in-theater', mode === 'theater');
  updateTaskingHud();
  updateSiegeHud();
  rebuildRoster();
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
    sound.play('denied');
    toast('TERRITORY SURVEY IN PROGRESS · STAND BY');
    return;
  }
  const st = territory.stateAt(lon, lat);
  if (!st) {
    sound.play('denied');
    toast('OUTSIDE GORGON JURISDICTION');
    return;
  }
  if (!progression.isUnlocked(st)) {
    sound.play('denied');
    toast(`${st.name.toUpperCase()} NOT HELD · UNLOCK UNDER TERRITORY`);
    return;
  }
  // Holding the STATE isn't the same as holding ground here: at downtown tier a state's single
  // site can easily sit outside a 200-mile disc drawn elsewhere in it, and a theater with no
  // network is one with nothing to see, defend or lose.
  if (liveSitesNear(lon, lat) === 0) {
    sound.play('denied');
    toast('NO NETWORK IN RANGE · PICK GROUND YOUR SITES COVER');
    return;
  }
  sound.play('enter');
  enterTheater(carto);
}

function enterTheater(carto: Cesium.Cartographic) {
  const lon = Cesium.Math.toDegrees(carto.longitude);
  const lat = Cesium.Math.toDegrees(carto.latitude);
  mode = 'theater';
  // The score rests inside a theater — the synthesized C2 cues carry the tension there. It fades
  // back in on exit.
  music.fadeOut();
  theaterCenter = { lon, lat };
  // The net is rebuilt whenever a theater is chosen, so sites lost to the last siege stand back up.
  fallenObelisks = new Set();
  cursor.show = false;
  borderLines.show = false;
  grat.show = false;
  if (heatField) heatField.show = false; // the theater draws real obelisks instead
  if (orbitHomeRings) orbitHomeRings.show = false;
  setVoid(true);
  updateChrome();
  // Apply immediately, NOT on flyTo completion: a flight that's interrupted (user grabs the
  // camera mid-flight) would otherwise never hand over the C2 scheme.
  applyC2Controls();
  // Arrive able to see the WHOLE theater.
  //
  // This used to land at 7.5 km, framed on downtown for the skyline. It made a good screenshot and
  // a bad opening move: the operator arrived inside a city with no idea where the rest of their
  // 200-mile disc was, and the first thing they did every time was pull the camera back out. Now
  // the disc fits the frame and they descend into whichever part of it they choose.
  //
  // 2.2x the radius clears the disc at this pitch with margin for the oblique.
  camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat, 0), THEATER_RADIUS_M), {
    offset: new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-52), THEATER_RADIUS_M * 2.2),
    duration: 3.0,
  });
  void buildTheater(lon, lat, ++theaterToken);
}

/** Name the theater being entered, for the loading screen. Falls back to coordinates. */
function theaterLabel(lon: number, lat: number): string {
  const st = territory?.stateAt(lon, lat);
  const coords = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`;
  return st ? `${st.name.toUpperCase()} · ${coords}` : coords;
}

/** Fetch once, build one mesh, drape the overlays on it. Nothing streams after this. */
async function buildTheater(lon: number, lat: number, tok: number) {
  setText('g-terrain', 'LOADING MAP…');
  // Everything the operator can interact with is built behind this: the mesh, the road graph, the
  // sensor net and all ~24k contacts. Buildings deliberately stay outside the gate — they are
  // scenery, they stream as chunk primitives, and holding a dense metro's entire skyline would add
  // ten seconds to every entry for something the player is not waiting on.
  showLoading({ title: 'LOADING SCENARIO', subtitle: theaterLabel(lon, lat) });
  setStage('FETCHING BORDERS');
  try {
    const detail = await loadDetail();
    if (tok !== theaterToken) return hideLoading();

    const bbox = theaterBbox(lon, lat);
    const land = landInBox(detail.landPolys, bbox);
    // Roads and terrain are independent fetches — overlap them rather than paying for both in
    // series. A road failure must not cost the theater, hence the catch.
    const roadsPromise = fetchRoads(bbox, ROAD_ZOOM).catch((e) => {
      console.warn('[GORGON] roads failed to load:', e);
      return undefined;
    });
    setStage('BAKING TERRAIN MESH');
    const map = await buildTheaterMap({ lon, lat }, THEATER_RADIUS_M, land, {
      samples: THEATER_SAMPLES,
      shoreRes: SHORE_RES,
    });
    if (tok !== theaterToken) return hideLoading();

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
    setStage('DRAWING ROAD NETWORK');
    const net = await roadsPromise;
    if (tok !== theaterToken) return hideLoading();
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
      // 4 m, down from 12. The lift only exists to beat z-fighting against the terrain mesh, and
      // 12 m of it was visible as a hover once the ribbon became a real ground-plane surface —
      // roads looked like they were floating a storey above the land they were drawn on.
      const built = buildRoadPrimitive(groups, map.heightAt, 4, bounds, ROAD_MIN_HALF_PX);
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
    setStage('POPULATING THEATER');
    addUnits({ lon, lat }, map, net);
    // An RTS match stands its build layer up here — it needs the road net (placement rules) and the
    // baked mesh (grounding), both ready now.
    if (rtsGame) setupRtsBuild(map, net);

    setText(
      'g-terrain',
      `STATIC z${map.zoom} · ${map.tiles} TILES · ${(map.triangles / 1000).toFixed(0)}k TRI`,
    );

    // Everything playable is in. Paint one frame of the finished theater, then lift the overlay so
    // the reveal is of a drawn scene rather than a canvas that fills in immediately after.
    setStage('READY');
    await nextFrame();
    if (tok !== theaterToken) return hideLoading();
    hideLoading();

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
    // Never leave the operator staring at a loading screen that will not resolve.
    hideLoading();
    toast('◈ THEATER BUILD FAILED · RETURNING TO ORBIT');
  }
}

function exitTheater() {
  if (mode !== 'theater') return;
  sound.play('exit');
  // Back to the world map — the score comes back up.
  music.fadeIn();
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
  if (orbitHomeRings) orbitHomeRings.show = true;
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
  // RTS placement: the ghost tracks the cursor and recolours on legality. Owns the pointer entirely.
  if (rtsPlacing) {
    updatePlacementGhost(m.endPosition);
    return;
  }
  // Same for an armed ability: the ring tracks the cursor at the radius the strike will actually have.
  if (rtsAiming) {
    updateAimGhost(m.endPosition);
    return;
  }
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
  if (rtsPlacing || rtsAiming) return; // an armed cursor owns the click: it places or fires, never marquees
  if (mode !== 'theater' || IS_MOBILE) return;
  marqueeStart = Cesium.Cartesian2.clone(m.position);
  marqueeActive = false;
}, Cesium.ScreenSpaceEventType.LEFT_DOWN);

// LMB up: finish a marquee box (multi-select). A non-drag falls through to LEFT_CLICK (single pick).
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (marqueeStart && marqueeActive) {
    // In an RTS match a marquee grabs ONLY your own units — never civilians on foot or in vehicles.
    if (unitField && unitField.pickBox(scene, marqueeStart.x, marqueeStart.y, m.position.x, m.position.y, !!rtsGame) > 0) {
      if (rtsGame) clearStructureSelection();
      updateUnitPanel();
      rtsCmd?.render();
    } else {
      unitField?.deselect();
      hideUnitPanel();
      rtsCmd?.render();
    }
  }
  endMarquee();
}, Cesium.ScreenSpaceEventType.LEFT_UP);

// LMB click (no drag): pick a theater in orbit, a single unit in a theater, or place a structure.
handler.setInputAction((m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  if (rtsPlacing) {
    tryPlaceAt(m.position);
    return;
  }
  if (rtsAiming) {
    fireAbilityAt(m.position);
    return;
  }
  if (mode === 'globe') {
    const carto = pickLonLat(m.position);
    if (carto) tryEnterTheater(carto);
    return;
  }
  // RTS: a click on a caught violator opens the decide-fate popup; a structure shows its command
  // card. Both take priority over selecting your own units.
  if (rtsGame && unitField) {
    // I + left-click INSPECTS whoever is under the pointer, ahead of everything else — including a
    // live violation, because "who is this" is a different question from "what do I do about them".
    if (inspectHeld) {
      const who = unitField.contactAt(scene, m.position.x, m.position.y, SELECT_PX);
      if (who) {
        openInspect(m.position.x, m.position.y, who.index);
        return;
      }
    }
    const contact = unitField.contactAt(scene, m.position.x, m.position.y, SELECT_PX);
    if (contact && unitField.liveOf(contact.index)) {
      openViolationMenu(m.position.x, m.position.y, contact.index);
      return;
    }
    const st = pickStructure(m.position.x, m.position.y);
    if (st) {
      selectStructure(st);
      return;
    }
    clearStructureSelection();
  }
  if (unitField && unitField.pick(scene, m.position.x, m.position.y, SELECT_PX, !!rtsGame)) {
    updateUnitPanel();
    rtsCmd?.render(); // a worker selection opens the BUILD card
  } else {
    unitField?.deselect();
    hideUnitPanel();
    rtsCmd?.render();
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

const onRightDown = (m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  // Right-click cancels a placement in progress, the way an RTS drops the build cursor. An armed
  // ability drops the same way — a 300-credit strike must be abandonable without firing it.
  if (rtsPlacing || rtsAiming) {
    cancelPlacement();
    cancelAiming();
    rightDownAt = null;
    return;
  }
  rightDownAt = mode === 'theater' ? Cesium.Cartesian2.clone(m.position) : null;
};
handler.setInputAction(onRightDown, Cesium.ScreenSpaceEventType.RIGHT_DOWN);

/**
 * The two things a right-click on a contact can still offer.
 *
 * Everything a contact can be SANCTIONED with now lives on the card's ladder, where both bars are
 * visible and C2 assigns the platform. Leaving duplicates here would have meant two routes to a
 * killing with different information attached to each, and the one reached by right-clicking showed
 * neither bar. What remains is the pair that genuinely aren't per-person sanctions:
 *
 *   HOME GARRISON  — self-defence of the site, resolved on the spot with no platform involved.
 *   AREA STRIKE    — an area weapon aimed at ground, which happens to have somebody standing on it.
 */
interface ContactOption {
  action: 'detain' | 'strike';
  label: string;
  blocked: string | null;
  /**
   * Resolved on the spot rather than by sending a platform.
   *
   * The home site's garrison already reaches the ground around it — there is nothing to dispatch,
   * so choosing this takes the attacker immediately instead of drawing a route.
   */
  immediate?: boolean;
}

/**
 * What can be done to this contact right now.
 *
 * `kind` is the selected platform, or null when nothing is selected — which is a real case, because
 * the home garrison can act on an attacker with no platform involved at all.
 */
function contactOptions(
  kind: PlatformId | null,
  opts_: { threat: boolean; garrisonInRange: boolean } = { threat: false, garrisonInRange: false },
): ContactOption[] {
  const opts: ContactOption[] = [];

  // The home site can take an attacker off its own doorstep. Self-defence of the network, so it
  // needs no custody authority and no hardware — but only ever against something attacking it.
  if (opts_.threat && opts_.garrisonInRange) {
    opts.push({ action: 'detain', label: 'DETAIN · HOME GARRISON', blocked: null, immediate: true });
  }

  if (!kind) return opts;

  // The area strike is the airframe, not a hardpoint — only the wing has it.
  if (kind === 'interceptor') {
    opts.push({
      action: 'strike',
      label: 'AREA STRIKE',
      blocked: !missions.hasAuth('execute') ? 'NO LETHAL AUTHORITY' : null,
    });
  }
  return opts;
}

/** Close the contact menu, if one is up. */
function closeContactMenu() {
  document.getElementById('g-context')?.remove();
}

/**
 * The contact menu: right-clicking a unit asks what to do about it rather than guessing.
 *
 * Guessing was the previous design and it was wrong in both directions — it silently picked detain
 * when both were fitted, and it gave no way to flag a contact from a platform that happened to be
 * armed. Any contact can be picked, including one the operator has no business picking, which is
 * the point.
 */
function openContactMenu(
  screenX: number,
  screenY: number,
  kind: PlatformId | null,
  contact: { index: number; lon: number; lat: number; id: string },
  append: boolean,
): boolean {
  closeContactMenu();

  // Anything actively causing trouble — an obelisk attacker, a rioter, a brawler, an assassin.
  const threat = unitField?.isThreatActor(contact.index) ?? false;
  const isSiegeAttacker = unitField?.isAttacker(contact.index) ?? false;
  const garrisonInRange =
    !!theaterHome &&
    Math.hypot(
      (contact.lon - theaterHome.lon) * 111_320 * Math.cos((theaterHome.lat * Math.PI) / 180),
      (contact.lat - theaterHome.lat) * 111_320,
    ) <= GARRISON_DETAIN_M;

  // The decisive fix for "right-click does nothing": a city is wall-to-wall ambient contacts, so a
  // 26 px pick almost always lands ON someone. If that someone offers no action — an ordinary
  // civilian, which is nearly all of them — we must NOT eat the click with an empty menu. Return
  // false and let the caller treat it as a ground order (move, or the airdrop menu). Sanctions live
  // on the card now; the only things that reach this menu are the home garrison and the area strike.
  const options = contactOptions(kind, { threat, garrisonInRange });
  if (!options.length) return false;

  const box = document.createElement('div');
  box.id = 'g-context';
  box.style.left = `${screenX}px`;
  box.style.top = `${screenY}px`;
  box.innerHTML = `<div class="gc-head">${contact.id}</div>`;

  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gc-item${opt.action === 'strike' ? ' lethal' : ''}`;
    b.disabled = opt.blocked !== null;
    b.innerHTML =
      `<span class="gc-label">${opt.label}</span>` +
      (opt.blocked ? `<span class="gc-why">${opt.blocked}</span>` : '');
    if (!opt.blocked) {
      b.addEventListener('click', () => {
        closeContactMenu();
        if (!unitField) return;
        // The garrison doesn't travel — it acts, now.
        if (opt.immediate) {
          // A siege attacker goes through the siege director, which owns the attack clock;
          // anything else is an incident participant and is simply taken.
          const from = garrisonThrowPoint();
          const to = unitField.worldPositionOf(contact.index);
          const took = isSiegeAttacker
            ? !!siege?.detain()
            : unitField.detainThreatActor(contact.index) !== null;
          if (took) {
            // The siege path throws its own round from the event; this one has to throw its own.
            if (!isSiegeAttacker && from && to) cuffs?.fire(from, to);
            sound.play('order');
            reactCompany();
            toast('◈ CONTACT DETAINED · HOME GARRISON');
            updateUnitHud();
          }
          return;
        }
        if (!kind) return;
        if (unitField.orderSelected(contact.lon, contact.lat, append, opt.action, contact.index)) {
          // Sent after a contact instead of standing on a footprint: same re-tasking, same cancel.
          cancelConstructionsFor(unitField.selectedPlatforms());
          sound.play(opt.action === 'strike' ? 'orderLethal' : 'order');
          updateUnitPanel();
        }
      });
    }
    box.append(b);
  }

  document.body.append(box);
  // Any click elsewhere dismisses it, including the next right-click.
  const dismiss = () => {
    closeContactMenu();
    window.removeEventListener('pointerdown', dismiss, true);
  };
  window.setTimeout(() => window.addEventListener('pointerdown', dismiss, true), 0);
  return true;
}

const onRightUp = (m: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
  const down = rightDownAt;
  rightDownAt = null;
  if (!down || mode !== 'theater' || !unitField) return;
  if (Cesium.Cartesian2.distance(down, m.position) > ORDER_SLOP_PX) return; // that was a tilt drag

  // DEV ONLY — shift + right-click on the map opens Millstone's roster and fields the chassis you
  // pick on the ground you clicked. It used to require arming a chassis in the dev panel first,
  // which meant the gesture did nothing at all unless you already knew the picker existed; the menu
  // is the discoverable version, and it carries the shift-queue order as its first item so the
  // gesture's original meaning is still one click away.
  //
  // A click that hits no ground (the sky, off the horizon) falls through to ordinary handling.
  if (shiftHeld) {
    const g = groundAt(m.position);
    if (g) {
      closeContactMenu();
      closeGroundMenu();
      openMillstoneSpawnMenu(m.position.x, m.position.y, g.lon, g.lat);
      return;
    }
  }

  // RTS: with a producing building selected, a right-click on the ground sets its RALLY POINT — where
  // its units head as they roll out — rather than moving anything.
  if (rtsGame && rtsSelectedStructure && producesUnits(rtsSelectedStructure.type)) {
    const g = groundAt(m.position);
    if (g) {
      rtsGame.setRally(rtsSelectedStructure.id, g.lon, g.lat);
      rtsBuild?.setRally(g.lon, g.lat);
      sound.play('move');
    }
    return;
  }

  const sel = unitField.selectedPlatform();
  // What the right-click can actually move. NOT `sel`, which is deliberately null for a multi-select
  // (fitting and contact orders are single-unit decisions) — a marquee of six machines has to answer
  // a move order, and reading the count separately is what lets it.
  const ordering = unitField.selectedPlatformCount();

  // Shift queues the leg behind whatever is already commanded instead of replacing it.
  const append = shiftHeld;

  // ATTACK MOVE: A + right-click. Goes in before the contact menu on purpose — an A-click is aimed
  // at GROUND, and in a city the pick lands on a passer-by more often than not, so letting the
  // contact menu take it would make the gesture unusable exactly where a fight happens.
  if (aHeld && ordering) {
    const g = groundAt(m.position);
    if (!g) return;
    closeContactMenu();
    closeGroundMenu();
    closeMillstoneMenu();
    if (unitField.orderSelection(g.lon, g.lat, append, null, undefined, true)) {
      cancelConstructionsFor(unitField.selectedPlatforms());
      sound.play('orderLethal');
      toast(ordering > 1 ? `◈ ATTACK MOVE · ${ordering} UNITS` : '◈ ATTACK MOVE');
      updateUnitPanel();
    } else {
      sound.play('denied');
      toast('◈ NO ROUTE TO THAT GROUND');
    }
    return;
  }

  // Right-clicking a CONTACT that offers a real action — an attacker the garrison can take, or an
  // area strike — opens its menu. But a pick in a crowded city lands on an ordinary civilian far
  // more often than not, and those offer nothing: openContactMenu returns false for them and we fall
  // straight through to the ground order, so a right-click reads as "move here" the way an RTS does
  // rather than snagging on whoever happened to be standing under the cursor.
  const contact = unitField.contactAt(scene, m.position.x, m.position.y, SELECT_PX);
  if (contact && openContactMenu(m.position.x, m.position.y, sel?.kind ?? null, contact, append)) return;

  closeContactMenu();
  closeGroundMenu();
  closeMillstoneMenu();
  const g = groundAt(m.position);
  if (!g) return;

  // A selected platform makes a ground right-click unambiguous: move there, now, with no menu in the
  // way — the way an RTS does it. The airdrop question moves OFF the right-click while a unit is held
  // (it used to pop a MOVE/AIRDROP chooser on every single click, which is the friction that made
  // repositioning feel broken); it's still one right-click away with nothing selected, below.
  //
  // One unit or twenty: `orderSelection` spreads a group into a formation around the point, so the
  // whole marquee moves off one click.
  if (ordering) {
    if (unitField.orderSelection(g.lon, g.lat, append)) {
      // Sending a builder somewhere else abandons its site — say so and give the money back, rather
      // than leaving a ring on the map over a building nobody is ever coming back to. Queuing a leg
      // counts too: a worker that drives on the moment it arrives never stands still long enough to
      // build anything.
      cancelConstructionsFor(unitField.selectedPlatforms());
      sound.play('move');
      updateUnitPanel();
    } else {
      // Selected but couldn't take the point — a road-bound quadruped with no street to it, a
      // littoral hull sent inland. Say so rather than dying silently, which reads as a dead click.
      sound.play('denied');
      toast('◈ NO ROUTE TO THAT GROUND');
    }
    return;
  }

  // Nothing selected: the only thing a ground right-click can mean is dropping a site, once that's
  // been commissioned. Deselect (left-click empty ground) and right-click to place one.
  if (progression.has('airdrop')) openGroundMenu(m.position.x, m.position.y, g.lon, g.lat, append);
};

/**
 * Right-click is registered TWICE: once unmodified, once for SHIFT.
 *
 * Cesium's ScreenSpaceEventHandler keys actions by (type, modifier) and does NOT fall back to the
 * unmodified handler when a modifier is held — a shift + right-click looks up the (RIGHT_UP, SHIFT)
 * slot, finds nothing, and the event is dropped on the floor. Which is why shift-queued move legs
 * silently never worked: `append = shiftHeld` below was reachable only when shift was NOT held.
 *
 * Both slots therefore get the same callback, and the modifier is still read from `shiftHeld`
 * rather than from the event, because that is the one thing Cesium's PositionedEvent does not carry.
 */
handler.setInputAction(onRightUp, Cesium.ScreenSpaceEventType.RIGHT_UP);
handler.setInputAction(onRightUp, Cesium.ScreenSpaceEventType.RIGHT_UP, Cesium.KeyboardEventModifier.SHIFT);
handler.setInputAction(onRightDown, Cesium.ScreenSpaceEventType.RIGHT_DOWN, Cesium.KeyboardEventModifier.SHIFT);

/**
 * Shift state, tracked globally.
 *
 * Cesium's own modified-event types cover LEFT_DOWN and friends but not RIGHT_UP, so the modifier
 * has to be read from the keyboard rather than from the pick event.
 */
let shiftHeld = false;
/**
 * A-held, for the attack move.
 *
 * Held rather than a sticky "attack cursor" mode, because holding is the gesture an RTS player
 * already has in their hands and a mode you can forget you are in is how a repositioning click
 * becomes an advance into a gun line. Tracked here for the same reason as shift: Cesium's pick
 * events don't carry the keyboard.
 *
 * It does not collide with A = build ARACHNID: that hotkey only fires with a PRODUCING STRUCTURE
 * selected, and an attack move only fires with UNITS selected.
 */
let aHeld = false;
window.addEventListener('keydown', (e) => {
  if (e.key === 'Shift') shiftHeld = true;
  if (e.key === 'a' || e.key === 'A') aHeld = true;
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') shiftHeld = false;
  if (e.key === 'a' || e.key === 'A') aHeld = false;
});
window.addEventListener('blur', () => {
  shiftHeld = false;
  aHeld = false;
});

// In a campaign this is "back to the world map"; in an RTS match there is no world map, so it ends
// the skirmish and returns to the title.
el('g-exit')?.addEventListener('click', () => (rtsGame ? endRtsMatch() : exitTheater()));

// The siege alert is a jump-to: an attack you can't see is one you can't do anything about.
el('g-incident')?.addEventListener('click', () => {
  if (incidentFocus) focusOn(incidentFocus.lon, incidentFocus.lat);
});
el('g-alert')?.addEventListener('click', () => {
  if (alertFocus) focusOn(alertFocus.lon, alertFocus.lat);
});
el('g-siege')?.addEventListener('click', () => {
  if (siegeFocus) focusOn(siegeFocus.lon, siegeFocus.lat, 6000);
});

// ---- command store ----
// Lives on the theater-select screen (CSS hides it in a theater). Purchases land in `progression`;
// everything the scene derives from ownership is re-applied here in one place.
store = new Store({
  // Ownership itself is re-applied by the progression subscription above; the store only needs to
  // confirm the transaction and move the camera onto whatever the player just bought.
  onPurchase: () => sound.play('purchase'),
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
  // A clearance raises the completion window and pays the reward; good press cools the ground a little.
  onComplete: (mission) => {
    sound.play('success');
    resistance.relieve();
    reactCompany();
    showMissionComplete(mission, {
      // Whichever way the operator leaves the completion window, any decision that clearance opened
      // is put to them as a halting modal before they can carry on — the choice can't scroll past.
      onContinue: () => presentPendingForks(),
      onReturn: () => {
        if (mode === 'theater') exitTheater();
        presentPendingForks();
      },
    });
  },
  // notify now only carries failures — a completion is the window above, not a toast.
  notify: (msg) => {
    sound.play('failure');
    toast(msg);
  },
});

// The Process Actions editor — the operator's standing rules. Renders itself when a slot is released.
new ProcessPanel();

// Hover and click cues for every button in the app, by delegation — see ui/sound.ts.
bindInterfaceSounds();
// The ♪ button opens the player-facing AUDIO panel: music volume and the SFX toggle. The button's
// own glyph reflects whether ANYTHING is audible, so a muted mix reads at a glance from the corner.
{
  const btn = el('snd-toggle');
  const panel = el('audio-panel');
  const musicSlider = el('aud-music') as HTMLInputElement | null;
  const musicVal = el('aud-music-val');
  const sfx = el('aud-sfx') as HTMLInputElement | null;

  const paintBtn = () => {
    if (!btn) return;
    // Silent when SFX are off AND the music is at zero — otherwise something is playing.
    const silent = !sound.enabled && music.volume <= 0;
    btn.textContent = silent ? '♪̸' : '♪';
    btn.classList.toggle('muted', silent);
  };

  const paintMusic = () => {
    if (musicSlider) musicSlider.value = String(Math.round(music.volume * 100));
    if (musicVal) musicVal.textContent = `${Math.round(music.volume * 100)}%`;
  };

  let open = false;
  const setOpen = (v: boolean) => {
    open = v;
    if (panel) panel.hidden = !open;
    btn?.setAttribute('aria-expanded', String(open));
    if (open) {
      paintMusic();
      if (sfx) sfx.checked = sound.enabled;
    }
  };

  btn?.addEventListener('click', () => setOpen(!open));
  el('audio-close')?.addEventListener('click', () => setOpen(false));

  musicSlider?.addEventListener('input', () => {
    music.setVolume((musicSlider.valueAsNumber || 0) / 100);
    paintMusic();
    paintBtn();
  });

  sfx?.addEventListener('change', () => {
    sound.setEnabled(!!sfx.checked);
    paintBtn();
  });

  // Click-away closes the panel, so it behaves like the lightweight popover it is.
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    const t = e.target as Node | null;
    if (panel?.contains(t) || btn?.contains(t)) return;
    setOpen(false);
  });

  paintBtn();
}

// ---- dev settings panel (⚙) ----
// A small header panel for live-tuning the procedural city. Sliders write into `devSettings`; the
// two that change geometry (population, road gap) regenerate the skyline on release.
{
  const gear = el('dev-toggle');
  const panel = el('dev-panel');
  /**
   * The settings panel shares the right rail with the tasking panel, so opening it stands the
   * tasking panel down rather than covering it.
   *
   * The alternative was to offset one of them, which works at 1280 and falls apart below about
   * 1100 where the two rails plus a third column no longer fit. Only ever having one panel in a
   * rail is the version that holds at every width.
   */
  const setDev = (open: boolean) => {
    if (!panel) return;
    panel.hidden = !open;
    gear?.classList.toggle('active', open);
    document.body.classList.toggle('dev-open', open);
  };
  gear?.addEventListener('click', () => setDev(!!panel?.hidden));
  el('dev-close')?.addEventListener('click', () => setDev(false));

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

  // Millstone on/off. Applies to the NEXT match — an enemy base can't be conjured into a theater
  // that was built without one, and a half-seeded opponent is worse than none.
  //
  // The spawn picker that used to live here is gone: shift + right-click on the map now opens the
  // roster where the unit is going, which is both fewer steps and findable without reading this
  // panel first.
  const mill = el('dev-millstone') as HTMLInputElement | null;
  if (mill) {
    mill.checked = millstoneEnabled;
    mill.addEventListener('change', () => {
      millstoneEnabled = mill.checked;
      toast(mill.checked ? '◈ MILLSTONE ENABLED · STARTS NEXT MATCH' : '◈ MILLSTONE DISABLED · NEXT MATCH');
    });
  }

  el('dev-regen')?.addEventListener('click', regenerateBuildings);

  // ---- sandbox ----
  // Everything here writes real campaign state rather than previewing it, so a jumped-to campaign
  // behaves exactly like a played one — which is the only way it's useful for finding problems.
  const pct = (id: string, get: () => number, set: (v: number) => void, fmtv: (v: number) => string) => {
    const input = el(id) as HTMLInputElement | null;
    const out = el(`${id}-val`);
    if (!input) return () => {};
    const paint = () => {
      if (out) out.textContent = fmtv(get());
      input.value = String(Math.round(get() * (id === 'dev-tokens' ? 1 : 100)));
    };
    input.addEventListener('input', () => {
      const raw = parseFloat(input.value);
      set(id === 'dev-tokens' ? raw : raw / 100);
      if (out) out.textContent = fmtv(get());
    });
    paint();
    return paint;
  };

  const paintTolerance = pct('dev-tolerance', () => tolerance.level, (v) => tolerance.setLevel(v),
    () => `${Math.round(tolerance.level * 100)}% ${toleranceLabel(tolerance.level)}`);
  const paintPolicy = pct('dev-policy', () => policy.level, (v) => policy.setLevel(v),
    () => `${Math.round(policy.level * 100)}% ${policyLabel(policy.level)}`);
  const paintResistance = pct('dev-resistance', () => resistance.level, (v) => resistance.setLevel(v),
    () => `${Math.round(resistance.level * 100)}%`);
  const paintTokens = pct('dev-tokens', () => progression.tokens, (v) => progression.setTokens(v),
    () => progression.tokens.toLocaleString('en-US'));

  // Grant buttons. The slider tops out at a million and steps in hundreds, which is fine for
  // setting a figure and useless for topping up mid-theater — these add to whatever is there.
  for (const [id, amount] of [
    ['dev-funds-500', 500],
    ['dev-funds-5k', 5_000],
    ['dev-funds-50k', 50_000],
    ['dev-funds-500k', 500_000],
  ] as [string, number][]) {
    el(id)?.addEventListener('click', () => {
      progression.award(amount);
      paintTokens();
      sound.play('purchase');
      toast(`◈ +${amount.toLocaleString('en-US')} TOKENS GRANTED`);
      updateUnitHud();
    });
  }

  // Mission chain: one button per stage, plus a "nothing cleared" reset at the top.
  const chain = el('dev-chain');
  const paintChain = () => {
    if (!chain) return;
    chain.replaceChildren();
    const row = (label: string, id: string | null) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dev-mini';
      b.textContent = label;
      const cleared = id === null
        ? MISSIONS.every((m) => missions.statusOf(m) !== 'complete')
        : missions.statusOf(MISSIONS.find((m) => m.id === id)!) === 'complete' &&
          (MISSIONS[MISSIONS.findIndex((m) => m.id === id) + 1] === undefined ||
            missions.statusOf(MISSIONS[MISSIONS.findIndex((m) => m.id === id) + 1]) !== 'complete');
      if (cleared) b.classList.add('on');
      b.addEventListener('click', () => {
        missions.devCompleteThrough(id);
        paintAll();
        // A jump can leave several forks owed at once; work through them as blocking modals so a
        // skipped-to campaign is in the same decided state a played one would be.
        presentPendingForks();
      });
      chain.append(b);
    };
    row('— NOTHING CLEARED —', null);
    for (const m of MISSIONS) row(m.name, m.id);
  };

  const paintGrants = () => {
    const t = territory;
    const allTerr = !!t && progression.allTerritoryHeld(t);
    el('dev-grant-territory')?.classList.toggle('done', allTerr);
    el('dev-grant-platforms')?.classList.toggle(
      'done',
      PLATFORMS.every((p) => progression.countOf(p.id) >= p.maxCount),
    );
    el('dev-grant-gear')?.classList.toggle(
      'done',
      PLATFORMS.every((p) => !progression.loadoutOf(p.id).includes(null)),
    );
    el('dev-grant-network')?.classList.toggle(
      'done',
      ASSETS.filter((a) => !a.pending).every((a) => progression.has(a.id)),
    );
  };

  const paintAll = () => {
    paintTolerance();
    paintPolicy();
    paintResistance();
    paintTokens();
    paintChain();
    paintGrants();
  };

  el('dev-grant-territory')?.addEventListener('click', () => {
    if (!territory) return;
    // 156 purchases, batched into one save and one scene rebuild — see Progression.batch.
    progression.batch(() => {
      progression.setTokens(progression.tokens + 100_000_000);
      for (const st of territory!.states) {
        for (let k = progression.tierOf(st); k < 3; k++) progression.buyNextTier(st);
      }
    });
    paintAll();
  });
  el('dev-grant-platforms')?.addEventListener('click', () => {
    progression.batch(() => {
      progression.setTokens(progression.tokens + 1_000_000);
      for (const p of PLATFORMS) {
        if (!progression.hasPlatform(p.id)) progression.buyPlatform(p);
        if (p.expansion) progression.buyExpansion(p);
      }
    });
    paintAll();
  });
  el('dev-grant-gear')?.addEventListener('click', () => {
    progression.batch(() => {
      progression.setTokens(progression.tokens + 1_000_000);
      for (const p of PLATFORMS) {
        if (!progression.hasPlatform(p.id)) continue;
        for (const gear of GEAR) {
          // Fills every free hardpoint with whatever fits; blockers still apply.
          while (!progression.gearBlocker(gear, p.id)) progression.fitGear(gear, p.id);
        }
      }
    });
    paintAll();
  });
  el('dev-grant-network')?.addEventListener('click', () => {
    progression.batch(() => {
      progression.setTokens(progression.tokens + 1_000_000);
      for (const a of ASSETS) if (!a.pending) progression.buyAsset(a);
    });
    paintAll();
  });

  // Anything that moves campaign state repaints the sandbox, so it never shows a stale picture.
  progression.onChange(paintAll);
  missions.onChange(paintAll);
  tolerance.onChange(paintAll);
  resistance.onChange(paintAll);
  paintAll();
  el('dev-reset')?.addEventListener('click', () => {
    progression.reset();
    missions.reset();
    resistance.reset();
    applyOwnership(true);
    maybeOfferStart();
    toast('CAMPAIGN RESET · WASHINGTON DOWNTOWN');
  });

  // Incident triggers. These fire the real thing, not a preview — same spawn, same consequences.
  for (const kind of ['riot', 'chase', 'altercation', 'assassination'] as IncidentKind[]) {
    el(`dev-inc-${kind}`)?.addEventListener('click', () => {
      if (mode !== 'theater' || !incidents) {
        sound.play('denied');
        toast('◈ ENTER A THEATER FIRST');
        return;
      }
      if (!incidents.open(kind)) {
        sound.play('denied');
        // Either something is already running, or the theater couldn't supply what it needs — an
        // assassination with no protected asset on the board, for instance.
        toast('◈ CANNOT OPEN INCIDENT · ONE MAY ALREADY BE RUNNING');
      }
    });
  }

  el('dev-exit-title')?.addEventListener('click', () => {
    el('dev-panel')?.setAttribute('hidden', '');
    exitToTitle();
  });
}
/*
 * ACTIVATE has two modes, set per-render by `data-hold` on the button:
 *
 *   normal contact   — a single click commits, same as it always has.
 *   protected asset   — a HOLD. The operator must press and keep pressing for HOLD_MS while a bar
 *                       fills; releasing early cancels and commits nothing. Overriding company
 *                       protection is meant to be a sustained, conscious act, not a twitch.
 */
{
  const btn = el('up-activate') as HTMLButtonElement | null;
  if (btn) {
    const HOLD_MS = 1000;
    let raf = 0;
    let startedAt = 0;

    const contact = () => {
      const one = unitField?.selected()?.single;
      return one && !PLATFORM_BY_ID.has(one.kind as PlatformId) ? one : null;
    };

    const stopHold = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      btn.classList.remove('holding');
      btn.style.removeProperty('--hold');
    };

    const commit = () => {
      const one = contact();
      stopHold();
      if (one) activateDecision(one.index);
    };

    btn.addEventListener('pointerdown', (e) => {
      // Only protected assets hold; everything else falls through to the click handler below.
      if (btn.disabled || btn.dataset.hold !== '1' || !contact()) return;
      e.preventDefault();
      try { btn.setPointerCapture(e.pointerId); } catch {}
      sound.play('click');
      btn.classList.add('holding');
      startedAt = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - startedAt) / HOLD_MS);
        btn.style.setProperty('--hold', String(p));
        if (p >= 1) { raf = 0; commit(); return; }
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });

    const release = () => { if (raf) stopHold(); };
    btn.addEventListener('pointerup', release);
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', release);

    btn.addEventListener('click', () => {
      // Protected assets are committed by the hold, never the click that ends it.
      if (btn.dataset.hold === '1') return;
      const one = contact();
      if (one) activateDecision(one.index);
    });
  }
}
el('up-close')?.addEventListener('click', () => {
  unitField?.deselect();
  hideUnitPanel();
});
el('up-mark')?.addEventListener('click', () => {
  if (!unitField) return;
  const kind = missions.markKind();
  const on = unitField.markState() !== 'all'; // toggle: order all, or rescind if all are ordered
  // Nothing is LOGGED here — every order starts on a rescind countdown and commits in the frame
  // loop once that window closes. Resistance, though, is charged the moment the order is given:
  // it's the act of ordering past consent that hardens the ground, not how the order turns out.
  const { n, shortfalls, assets } = unitField.markSelected(kind, on);
  for (const under of shortfalls) resistance.transgress(under);
  // Ordering against a PROTECTED contact burns a company asset. The operator is never told that is
  // what happened — they are told what it cost, and can work the rest out.
  if (assets > 0) {
    progression.setTokens(progression.tokens - ASSET_WRITE_OFF * assets);
    toast(`◈ ASSET WRITE-OFF · −${(ASSET_WRITE_OFF * assets).toLocaleString('en-US')} FUNDING TOKENS`);
    sound.play('denied');
  } else if (shortfalls.length) {
    sound.play('denied');
    toast(
      `◈ ORDERED PAST CONSENT · ${shortfalls.length} CONTACT${shortfalls.length > 1 ? 'S' : ''} · RESISTANCE RISING`,
    );
  } else if (n) {
    sound.play(!on ? 'rescind' : kind === 'execute' ? 'orderLethal' : 'order');
  }
  updateUnitPanel();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'i' || e.key === 'I') inspectHeld = false;
});
window.addEventListener('blur', () => {
  inspectHeld = false;
});

window.addEventListener('keydown', (e) => {
  // INSPECT is a held modifier and must be tracked before the hotkey table gets the key, or the RTS
  // branch's per-context lookup would swallow the I in some contexts and not others.
  if (rtsGame && (e.key === 'i' || e.key === 'I')) inspectHeld = true;
  // RTS build hotkeys + placement cancel take the key before anything else in a match.
  if (rtsGame) {
    if (e.key === 'Escape') {
      closeInspectCard();
      // Back out of an armed cursor first. Escape only ends the match when there is nothing else to
      // escape from — otherwise aiming a strike and changing your mind would quit the game.
      if (rtsPlacing) cancelPlacement();
      else if (rtsAiming) cancelAiming();
      else endRtsMatch();
      return;
    }
    if (!e.repeat) {
      const k = e.key.toUpperCase();
      const ctx = rtsCommandContext();
      if (ctx.kind === 'produce') {
        const u = unitsFrom(ctx.structureType).find((x) => x.hotkey === k);
        if (u) {
          enqueueUnit(u.id);
          return;
        }
        const r = researchFrom(ctx.structureType).find((x) => x.hotkey === k);
        if (r) {
          startResearchAt(r.id);
          return;
        }
        const a = abilitiesFrom(ctx.structureType).find((x) => x.hotkey === k);
        if (a) {
          beginAbility(a.id);
          return;
        }
      } else if (ctx.kind === 'build') {
        const hit = BUILDABLE.find((t) => STRUCTURES[t].hotkey === k);
        if (hit) {
          beginPlacement(hit);
          return;
        }
      }
    }
  }
  if (e.key === 'Escape') exitTheater();
  // I cycles the infection: spread it to more units so the red state is easy to watch, then reset.
  // Campaign only — in a match I is the INSPECT modifier, and a debug shortcut that scrambled the
  // sim every time you looked at somebody would be a genuinely baffling bug to hit.
  if ((e.key === 'i' || e.key === 'I') && mode === 'theater' && unitField && !rtsGame) {
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
    startRtsMatch,
    endRtsMatch,
    get rtsGame() {
      return rtsGame;
    },
    get rtsSites() {
      return rtsSites;
    },
    get rtsBuild() {
      return rtsBuild;
    },
    get theaterMap() {
      return theaterMap;
    },
    waterNear,
    buildObeliskAt,
    validateObelisk,
    updatePlacementGhost,
    cancelPlacement,
    beginPlacement,
    validateFacility,
    enqueueUnit,
    spawnProducedUnit,
    selectStructure,
    rtsCommandContext,
    rtsConstructionTick,
    finishConstruction,
    maybeOpenAllSites,
    runRtsViolations,
    get millstone() {
      return millstone;
    },
    runMillstone,
    runRtsCombat,
    rtsStructTargets,
    applyStructureHit,
    showRtsEnd,
    RTS_COMBAT,
    startResearchAt,
    refreshPowerLines,
    openInspect,
    inspectContact,
    fineBlockedBy,
    rtsAuthority,
    flashAtSite,
    beginAbility,
    fireAbilityAt,
    cancelAiming,
    get rtsAiming() {
      return rtsAiming;
    },
    openViolationMenu,
    inTheaterObeliskSites,
    get rtsConstruction() {
      return rtsConstruction;
    },
    get rtsSitesList() {
      return rtsSites;
    },
    get rtsSelectedStructure() {
      return rtsSelectedStructure;
    },
    get rtsUnitStates() {
      return rtsGame?.unitStates;
    },
    rtsSelectedCardUnits,
    rtsSelectedCardStructure,
    rtsUnitAction,
    updateUnitPanel,
    armamentOf,
    spawnMillstoneAt,
    groundAt,
    openMillstoneSpawnMenu,
    setMillstoneEnabled: (on: boolean) => {
      millstoneEnabled = on;
    },
    get millstoneEnabled() {
      return millstoneEnabled;
    },
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
    get siege() {
      return siege;
    },
    get reactions() {
      return reactions;
    },
    get actionMarks() {
      return actionMarks;
    },
    markAction,
    get routes() {
      return routes;
    },
    get pulse() {
      return pulse;
    },
    get scans() {
      return scans;
    },
    get blasts() {
      return blasts;
    },
    get sparks() {
      return sparks;
    },
    get impacts() {
      return impacts;
    },
    get cuffs() {
      return cuffs;
    },
    get pings() {
      return pings;
    },
    get dropSites() {
      return dropSites;
    },
    airdropAt,
    openGroundMenu,
    issueFine,
    investigateLive,
    VIOLATIONS,
    get incidents() {
      return incidents;
    },
    INCIDENTS,
    AIRDROP_COST,
    throwCuffsAt,
    openContactMenu,
    contactOptions,
    get fallenObelisks() {
      return fallenObelisks;
    },
    SIEGE,
    progression,
    missions,
    tolerance,
    resistance,
    caseStrength,
    toleranceLabel,
    ASSETS,
    MISSIONS,
    PLATFORMS,
    GEAR,
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
