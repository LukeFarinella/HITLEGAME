import * as Cesium from 'cesium';
import { InstancedModelBatch } from './instancedModels';
import { UNIT_MESHES, UNIT_SCALE, type UnitKind } from './unitModels';
import type { RoadNet, RoadClass } from './roads';
import type { SensorField } from './sensors';

/**
 * The live unit layer for a theater: land vehicles routed on the real road graph, ships drifting on
 * water, aircraft flying waypoints, and foot units milling near roads. Each unit is one instance in
 * a per-kind {@link InstancedModelBatch} (one draw call per kind), and the whole field is stepped
 * once per frame.
 *
 * State is orthogonal to kind — every unit is normal / protected / infected, shown white / yellow /
 * red. It's a per-instance colour today; a spreading contagion sim would layer on top of this field
 * without touching the rendering.
 */

export type UnitState = 'normal' | 'protected' | 'infected';

const STATE_COLOR: Record<UnitState, Cesium.Color> = {
  normal: Cesium.Color.fromCssColorString('#EDEFF2'),
  protected: Cesium.Color.fromCssColorString('#F2C13B'),
  infected: Cesium.Color.fromCssColorString('#E23A2E'),
};

/** Out-of-sensor-range units render faint (a stand-in for fog of war). */
const UNSEEN_ALPHA = 0.3;

/** Metres per second. Exaggerated over real life so motion reads when watching a theater. */
const SPEED: Record<UnitKind, number> = { land: 80, sea: 28, air: 210, foot: 12 };
/**
 * Height above the sampled ground, metres. Land/foot clear the road ribbon (draped at +12) so
 * vehicles sit ON the road rather than being drawn under it.
 */
const RIDE_HEIGHT: Record<UnitKind, number> = { land: 14, sea: 1, air: 0, foot: 14 };

const DEG = Math.PI / 180;
const mPerLat = 111_320;
const bearing = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const mLon = mPerLat * Math.cos(((lat1 + lat2) / 2) * DEG);
  return Math.atan2((lon2 - lon1) * mLon, (lat2 - lat1) * mPerLat); // radians CW from north
};

// --- road graph --------------------------------------------------------------------------------

interface Edge {
  pts: number[][]; // lon/lat
  cum: number[]; // cumulative metres to each point
  len: number;
  nodeA: number; // node index at pts[0]
  nodeB: number; // node index at last pt
  cls: RoadClass;
  rank: number; // higher = bigger road
}

/** Higher roads are preferred at junctions so freeway traffic flows through instead of exiting. */
const CLASS_RANK: Record<RoadClass, number> = { motorway: 5, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
const FREEWAY = new Set<RoadClass>(['motorway', 'trunk']);

/**
 * Turn the fetched road polylines into a graph a unit can traverse. Endpoints within ~1 m are the
 * same node — OSM splits ways at intersections, so shared endpoints are how roads actually connect.
 */
class RoadGraph {
  edges: Edge[] = [];
  private nodes = new Map<string, number>();
  /** edges incident on each node. */
  adj: number[][] = [];
  /** Cumulative edge length for length-weighted spawning (all edges), and the freeway subset. */
  private cumAll: number[] = [];
  totalLen = 0;
  private freeway: number[] = [];
  private cumFreeway: number[] = [];
  private totalFreeway = 0;

  constructor(net: RoadNet) {
    for (const road of net.roads) {
      const pts = road.coords;
      if (pts.length < 2) continue;
      const cum = [0];
      let len = 0;
      for (let i = 1; i < pts.length; i++) {
        const mLon = mPerLat * Math.cos(pts[i][1] * DEG);
        len += Math.hypot((pts[i][0] - pts[i - 1][0]) * mLon, (pts[i][1] - pts[i - 1][1]) * mPerLat);
        cum.push(len);
      }
      if (len < 5) continue;
      const a = this.node(pts[0]);
      const b = this.node(pts[pts.length - 1]);
      const e: Edge = { pts, cum, len, nodeA: a, nodeB: b, cls: road.cls, rank: CLASS_RANK[road.cls] };
      const ei = this.edges.push(e) - 1;
      this.adj[a].push(ei);
      this.adj[b].push(ei);
      this.totalLen += len;
      this.cumAll.push(this.totalLen);
      if (FREEWAY.has(road.cls)) {
        this.freeway.push(ei);
        this.totalFreeway += len;
        this.cumFreeway.push(this.totalFreeway);
      }
    }
  }

  private node(p: number[]): number {
    const key = `${Math.round(p[0] * 1e5)},${Math.round(p[1] * 1e5)}`;
    let n = this.nodes.get(key);
    if (n === undefined) {
      n = this.adj.length;
      this.nodes.set(key, n);
      this.adj.push([]);
    }
    return n;
  }

  private pick(cum: number[], total: number, indexOf?: number[]): number {
    if (!cum.length) return -1;
    const r = Math.random() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return indexOf ? indexOf[lo] : lo;
  }

  /** A random edge, weighted by length, so long roads carry proportionally more traffic. */
  randomEdge(): number {
    return this.pick(this.cumAll, this.totalLen);
  }

  /** A random freeway edge (motorway/trunk), length-weighted. -1 if the theater has none. */
  randomFreeway(): number {
    return this.freeway.length ? this.pick(this.cumFreeway, this.totalFreeway, this.freeway) : -1;
  }

  /** Bearing leaving `node` into edge `ei` (the direction a unit would travel entering there). */
  outBearing(ei: number, node: number): number {
    const e = this.edges[ei];
    if (e.nodeA === node) return bearing(e.pts[0][0], e.pts[0][1], e.pts[1][0], e.pts[1][1]);
    const n = e.pts.length;
    return bearing(e.pts[n - 1][0], e.pts[n - 1][1], e.pts[n - 2][0], e.pts[n - 2][1]);
  }

  /** Interpolate a point + heading at distance `d` along edge `e` (measured from pts[0]). */
  sample(e: Edge, d: number): { lon: number; lat: number; heading: number } {
    const cum = e.cum;
    let i = 1;
    while (i < cum.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
    const a = e.pts[i - 1];
    const b = e.pts[i];
    return {
      lon: a[0] + (b[0] - a[0]) * t,
      lat: a[1] + (b[1] - a[1]) * t,
      heading: bearing(a[0], a[1], b[0], b[1]),
    };
  }
}

// --- units -------------------------------------------------------------------------------------

interface Unit {
  id: string; // callsign, shown in the selection panel
  kind: UnitKind;
  state: UnitState;
  lon: number;
  lat: number;
  heading: number;
  mark: boolean; // C2 "investigate" flag — persists, shown as a field marker
  // land/foot: graph traversal
  edge?: number;
  dist?: number;
  dir?: 1 | -1;
  // sea/air: free wander
  turn?: number; // radians/sec bias
}

/** Callsign prefix per kind. */
const CALLSIGN: Record<UnitKind, string> = { land: 'CV', sea: 'SV', air: 'AV', foot: 'FT' };
/** Human label per kind, for the panel. */
export const KIND_LABEL: Record<UnitKind, string> = {
  land: 'GROUND VEHICLE',
  sea: 'SEA VESSEL',
  air: 'AIRCRAFT',
  foot: 'FOOT UNIT',
};

/** Metres/second per kind (mirrors SPEED) surfaced for the panel. */
export const KIND_SPEED = SPEED;

/** What the panel renders for the current selection (one unit, or a summary of many). */
export interface SelectionInfo {
  count: number;
  byKind: Record<UnitKind, number>;
  byState: Record<UnitState, number>;
  markedCount: number;
  /** Present only when exactly one unit is selected. */
  single?: {
    id: string;
    kind: UnitKind;
    state: UnitState;
    lon: number;
    lat: number;
    heading: number;
    mark: boolean;
  };
}

/** "Investigate" marker colour (amber = attention). */
const MARK_COLOR = '#F2A83B';

/** A diamond-outline texture drawn once, used for every investigate marker. */
function makeMarkTexture(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = 48;
  c.height = 48;
  const g = c.getContext('2d')!;
  g.translate(24, 24);
  g.strokeStyle = MARK_COLOR;
  g.lineWidth = 4;
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(0, -18);
  g.lineTo(18, 0);
  g.lineTo(0, 18);
  g.lineTo(-18, 0);
  g.closePath();
  g.stroke();
  return c;
}

export interface UnitFieldOptions {
  land: number;
  sea: number;
  air: number;
  foot: number;
}

export class UnitField {
  readonly batches: Record<UnitKind, InstancedModelBatch>;
  private units: Unit[] = [];
  private graph?: RoadGraph;
  private center: { lon: number; lat: number };
  private radiusM: number;
  private heightAt: (lon: number, lat: number) => number;
  private scratch = new Cesium.Cartesian3();
  private nextId: Record<UnitKind, number> = { land: 0, sea: 0, air: 0, foot: 0 };
  /** Per-unit world position from the last render(), for screen-space picking. */
  private ecef = new Float64Array(0);
  private selection = new Set<number>();
  /** Investigate-marked unit indices, and the billboards that flag them. */
  private markedIdx: number[] = [];
  private markTexture = makeMarkTexture();
  readonly marksLayer = new Cesium.BillboardCollection();
  private markScratch = new Cesium.Cartesian3();

  private mkId(kind: UnitKind): string {
    return `${CALLSIGN[kind]}-${String(++this.nextId[kind]).padStart(3, '0')}`;
  }

  constructor(
    center: { lon: number; lat: number },
    radiusM: number,
    heightAt: (lon: number, lat: number) => number,
    net: RoadNet | undefined,
    counts: UnitFieldOptions,
  ) {
    this.center = center;
    this.radiusM = radiusM;
    this.heightAt = heightAt;
    if (net && net.roads.length) this.graph = new RoadGraph(net);

    const bounds = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(center.lon, center.lat, 0), radiusM * 1.3);
    const cap: Record<UnitKind, number> = { land: counts.land, sea: counts.sea, air: counts.air, foot: counts.foot };
    // blend on: out-of-range units draw at 30% opacity.
    this.batches = {
      land: new InstancedModelBatch(UNIT_MESHES.land, cap.land, bounds, true),
      sea: new InstancedModelBatch(UNIT_MESHES.sea, cap.sea, bounds, true),
      air: new InstancedModelBatch(UNIT_MESHES.air, cap.air, bounds, true),
      foot: new InstancedModelBatch(UNIT_MESHES.foot, cap.foot, bounds, true),
    };

    // Vehicles favour freeways heavily (constant motorway flow); pedestrians stay on surface streets.
    this.spawnRoadUnits('land', counts.land, 0.45);
    this.spawnRoadUnits('foot', counts.foot, 0);
    this.spawnWaterUnits(counts.sea);
    this.spawnAirUnits(counts.air);
    this.ecef = new Float64Array(this.units.length * 3);
  }

  get count(): number {
    return this.units.length;
  }

  /** Seed a state: the vast majority normal, ~5% protected, ~5% infected. */
  private rollState(): UnitState {
    const r = Math.random();
    return r < 0.05 ? 'infected' : r < 0.1 ? 'protected' : 'normal';
  }

  /**
   * Spawn on the road graph. `freewayFraction` of them start on motorways/trunks so there's a
   * constant stream on the freeways; the rest are length-weighted across all roads (which also
   * stops units piling onto tiny stub edges — the old uniform-by-edge pick oversampled those).
   */
  private spawnRoadUnits(kind: UnitKind, n: number, freewayFraction: number): void {
    const g = this.graph;
    if (!g || !g.edges.length) return;
    for (let i = 0; i < n; i++) {
      let edge = Math.random() < freewayFraction ? g.randomFreeway() : -1;
      if (edge < 0) edge = g.randomEdge();
      const e = g.edges[edge];
      const dist = Math.random() * e.len;
      const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const p = g.sample(e, dist);
      this.units.push({ id: this.mkId(kind), kind, state: this.rollState(), lon: p.lon, lat: p.lat, heading: p.heading, mark: false, edge, dist, dir });
    }
  }

  /** Random lon/lat inside the theater disc. */
  private randomInDisc(): { lon: number; lat: number } {
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * this.radiusM;
    return {
      lon: this.center.lon + (r * Math.cos(a)) / (mPerLat * Math.cos(this.center.lat * DEG)),
      lat: this.center.lat + (r * Math.sin(a)) / mPerLat,
    };
  }

  private spawnWaterUnits(n: number): void {
    let tries = 0;
    for (let i = 0; i < n && tries < n * 40; tries++) {
      const p = this.randomInDisc();
      if (this.heightAt(p.lon, p.lat) > -3) continue; // must be water
      this.units.push({
        id: this.mkId('sea'),
        kind: 'sea',
        state: this.rollState(),
        lon: p.lon,
        lat: p.lat,
        heading: Math.random() * Math.PI * 2,
        mark: false,
        turn: 0,
      });
      i++;
    }
  }

  private spawnAirUnits(n: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.randomInDisc();
      this.units.push({
        id: this.mkId('air'),
        kind: 'air',
        state: this.rollState(),
        lon: p.lon,
        lat: p.lat,
        heading: Math.random() * Math.PI * 2,
        mark: false,
        turn: (Math.random() - 0.5) * 0.05,
      });
    }
  }

  /** Advance the sim by `dt` seconds. */
  tick(dt: number): void {
    const d = Math.min(dt, 0.1); // clamp so a stalled tab doesn't teleport everything
    for (const u of this.units) {
      if (u.kind === 'land' || u.kind === 'foot') this.stepRoad(u, d);
      else this.stepFree(u, d);
    }
  }

  private stepRoad(u: Unit, dt: number): void {
    const g = this.graph;
    if (!g || u.edge === undefined) return;
    let ei = u.edge;
    let e = g.edges[ei];
    let dist = (u.dist ?? 0) + (u.dir ?? 1) * SPEED[u.kind] * dt;
    let dir = u.dir ?? 1;

    // Cross a node: choose the edge that best continues the current heading (with a bias toward
    // bigger roads), so units flow through junctions instead of picking random turns and
    // backtracking. That both removes the "stuck"/ping-pong look and keeps freeway traffic on the
    // freeway.
    let guard = 0;
    while ((dist > e.len || dist < 0) && guard++ < 4) {
      const atEnd = dist > e.len;
      const node = atEnd ? e.nodeB : e.nodeA;
      const overshoot = atEnd ? dist - e.len : -dist;
      const velBearing = g.outBearing(ei, node) + Math.PI; // direction we're travelling INTO the node
      const options = g.adj[node].filter((x) => x !== ei);
      const next = options.length ? this.chooseEdge(g, options, node, velBearing) : ei;
      const ne = g.edges[next];
      // enter the new edge from whichever end touches this node
      if (ne.nodeA === node) {
        dir = 1;
        dist = overshoot;
      } else {
        dir = -1;
        dist = ne.len - overshoot;
      }
      ei = next;
      e = ne;
    }
    dist = Math.max(0, Math.min(e.len, dist));
    const p = g.sample(e, dist);
    u.edge = ei;
    u.dist = dist;
    u.dir = dir;
    u.lon = p.lon;
    u.lat = p.lat;
    u.heading = dir === 1 ? p.heading : p.heading + Math.PI;
  }

  /**
   * Weighted pick among the edges leaving a node: straighter continuations and bigger roads score
   * higher, but it's randomised so units still turn off and populate side streets.
   */
  private chooseEdge(g: RoadGraph, options: number[], node: number, velBearing: number): number {
    let best = options[0];
    let bestScore = -1;
    for (const c of options) {
      const straight = Math.cos(g.outBearing(c, node) - velBearing); // 1 = dead straight, -1 = U-turn
      // straightness × road-size bias × per-pick jitter, so it mostly goes straight but still turns off
      const score = Math.max(0.02, (straight + 1) * 0.5) * (1 + 0.6 * g.edges[c].rank) * (0.7 + Math.random() * 0.6);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    return best;
  }

  private stepFree(u: Unit, dt: number): void {
    // wander with a slowly drifting heading; bounce off the theater edge (and, for ships, off land)
    u.turn = (u.turn ?? 0) + (Math.random() - 0.5) * 0.02;
    u.turn = Math.max(-0.15, Math.min(0.15, u.turn));
    u.heading += u.turn * dt * 10;
    const step = SPEED[u.kind] * dt;
    const mLon = mPerLat * Math.cos(u.lat * DEG);
    let nlon = u.lon + (step * Math.sin(u.heading)) / mLon;
    let nlat = u.lat + (step * Math.cos(u.heading)) / mPerLat;

    const dx = (nlon - this.center.lon) * mLon;
    const dy = (nlat - this.center.lat) * mPerLat;
    const outOfDisc = Math.hypot(dx, dy) > this.radiusM * 0.98;
    const ontoLand = u.kind === 'sea' && this.heightAt(nlon, nlat) > -1;
    if (outOfDisc || ontoLand) {
      u.heading += Math.PI * (0.5 + Math.random() * 0.5); // turn away
      u.turn = -(u.turn ?? 0);
      nlon = u.lon;
      nlat = u.lat;
    }
    u.lon = nlon;
    u.lat = nlat;
  }

  private scratchColor = new Cesium.Color();

  /**
   * Fill the instance buffers for this frame. Call after tick(). If `sensor` is given, units
   * outside every obelisk's range draw faint. Also caches each unit's world position for picking,
   * and draws the selected unit larger + at full opacity.
   */
  render(sensor?: SensorField): void {
    for (const k of ['land', 'sea', 'air', 'foot'] as UnitKind[]) this.batches[k].beginFrame();
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const ground = this.heightAt(u.lon, u.lat);
      const alt = u.kind === 'air' ? Math.max(300, ground + 600) : ground + RIDE_HEIGHT[u.kind];
      Cesium.Cartesian3.fromDegrees(u.lon, u.lat, alt, undefined, this.scratch);
      this.ecef[i * 3] = this.scratch.x;
      this.ecef[i * 3 + 1] = this.scratch.y;
      this.ecef[i * 3 + 2] = this.scratch.z;

      const selected = this.selection.has(i);
      const base = STATE_COLOR[u.state];
      const seen = !sensor || sensor.isCovered(u.lon, u.lat);
      const color = seen || selected ? base : Cesium.Color.fromAlpha(base, UNSEEN_ALPHA, this.scratchColor);
      const scale = UNIT_SCALE[u.kind] * (selected ? 1.7 : 1);
      this.batches[u.kind].setInstance(this.scratch, u.heading, scale, color);
    }
    for (const k of ['land', 'sea', 'air', 'foot'] as UnitKind[]) this.batches[k].endFrame();

    // move each investigate marker onto its (moving) unit
    for (let m = 0; m < this.markedIdx.length; m++) {
      const i = this.markedIdx[m];
      this.markScratch.x = this.ecef[i * 3];
      this.markScratch.y = this.ecef[i * 3 + 1];
      this.markScratch.z = this.ecef[i * 3 + 2];
      this.marksLayer.get(m).position = this.markScratch;
    }
  }

  // --- selection ------------------------------------------------------------------------------

  private toWin(): ((s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined) | undefined {
    const ST = Cesium.SceneTransforms as unknown as {
      worldToWindowCoordinates?: (s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined;
      wgs84ToWindowCoordinates?: (s: Cesium.Scene, p: Cesium.Cartesian3, r?: Cesium.Cartesian2) => Cesium.Cartesian2 | undefined;
    };
    return ST.worldToWindowCoordinates ?? ST.wgs84ToWindowCoordinates;
  }

  private pickScratchC = new Cesium.Cartesian3();
  private pickScratchW = new Cesium.Cartesian2();

  /**
   * Select the single unit nearest a window point (within `maxPx`); returns whether one was picked.
   * Projects the cached world positions, so call after at least one render().
   */
  pick(scene: Cesium.Scene, x: number, y: number, maxPx: number): boolean {
    const toWin = this.toWin();
    if (!toWin) return false;
    const c = this.pickScratchC;
    const w = this.pickScratchW;
    let best = -1;
    let bestD = maxPx * maxPx;
    for (let i = 0; i < this.units.length; i++) {
      c.x = this.ecef[i * 3];
      c.y = this.ecef[i * 3 + 1];
      c.z = this.ecef[i * 3 + 2];
      const win = toWin(scene, c, w);
      if (!win) continue;
      const dx = win.x - x;
      const dy = win.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    this.selection.clear();
    if (best >= 0) this.selection.add(best);
    return best >= 0;
  }

  /** Select every unit whose screen position falls inside a drag box. Returns the count. */
  pickBox(scene: Cesium.Scene, x0: number, y0: number, x1: number, y1: number): number {
    const toWin = this.toWin();
    this.selection.clear();
    if (!toWin) return 0;
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    const c = this.pickScratchC;
    const w = this.pickScratchW;
    for (let i = 0; i < this.units.length; i++) {
      c.x = this.ecef[i * 3];
      c.y = this.ecef[i * 3 + 1];
      c.z = this.ecef[i * 3 + 2];
      const win = toWin(scene, c, w);
      if (!win) continue;
      if (win.x >= lx && win.x <= hx && win.y >= ly && win.y <= hy) this.selection.add(i);
    }
    return this.selection.size;
  }

  deselect(): void {
    this.selection.clear();
  }

  /** Live info for the selection: one unit's full stats, or a summary of many. */
  selected(): SelectionInfo | null {
    if (this.selection.size === 0) return null;
    const byKind: Record<UnitKind, number> = { land: 0, sea: 0, air: 0, foot: 0 };
    const byState: Record<UnitState, number> = { normal: 0, protected: 0, infected: 0 };
    let markedCount = 0;
    let one: Unit | undefined;
    for (const i of this.selection) {
      const u = this.units[i];
      byKind[u.kind]++;
      byState[u.state]++;
      if (u.mark) markedCount++;
      one = u;
    }
    const info: SelectionInfo = { count: this.selection.size, byKind, byState, markedCount };
    if (this.selection.size === 1 && one) {
      info.single = { id: one.id, kind: one.kind, state: one.state, lon: one.lon, lat: one.lat, heading: one.heading, mark: one.mark };
    }
    return info;
  }

  /** Whether the current selection is 'none', 'some', or 'all' investigate-marked. */
  markState(): 'none' | 'some' | 'all' {
    if (this.selection.size === 0) return 'none';
    let m = 0;
    for (const i of this.selection) if (this.units[i].mark) m++;
    return m === 0 ? 'none' : m === this.selection.size ? 'all' : 'some';
  }

  /** Flag (or clear) the current selection as investigate, and rebuild the field markers. */
  markSelected(on: boolean): void {
    for (const i of this.selection) this.units[i].mark = on;
    this.rebuildMarks();
  }

  private rebuildMarks(): void {
    this.markedIdx = [];
    for (let i = 0; i < this.units.length; i++) if (this.units[i].mark) this.markedIdx.push(i);
    this.marksLayer.removeAll();
    for (let m = 0; m < this.markedIdx.length; m++) {
      const b = this.marksLayer.add({
        position: Cesium.Cartesian3.ZERO, // set each frame in render()
        image: this.markTexture,
        width: 26,
        height: 26,
        pixelOffset: new Cesium.Cartesian2(0, -20),
      });
      // A C2 marker stays visible even when its unit is behind a building. NOTE: Cesium billboards
      // coerce `Infinity` here to null (which does NOT disable the test) — a large finite value
      // (well past any theater distance) is what actually keeps the marker on top.
      b.disableDepthTestDistance = 1e12;
    }
  }

  /** Window position of the single selected unit, for the reticle. Call after render(). */
  selectedScreen(scene: Cesium.Scene, result: Cesium.Cartesian2): Cesium.Cartesian2 | undefined {
    if (this.selection.size !== 1) return undefined;
    const toWin = this.toWin();
    const i = this.selection.values().next().value as number;
    const c = new Cesium.Cartesian3(this.ecef[i * 3], this.ecef[i * 3 + 1], this.ecef[i * 3 + 2]);
    return toWin?.(scene, c, result);
  }

  /** Flat [lon,lat,...] of infected units, for the sensor threat pass. Reused each frame. */
  private infectedBuf = new Float64Array(0);
  infectedPositions(): { buf: Float64Array; count: number } {
    let n = 0;
    for (const u of this.units) if (u.state === 'infected') n++;
    if (this.infectedBuf.length < n * 2) this.infectedBuf = new Float64Array(n * 2);
    let j = 0;
    for (const u of this.units) {
      if (u.state !== 'infected') continue;
      this.infectedBuf[j * 2] = u.lon;
      this.infectedBuf[j * 2 + 1] = u.lat;
      j++;
    }
    return { buf: this.infectedBuf, count: n };
  }

  /**
   * Demo hook (no contagion sim yet): each call flips a slice of non-infected units to infected;
   * once most are infected, reset to the seed mix. Lets you watch the red state sweep the field.
   */
  cycleInfection(): void {
    const infected = this.units.filter((u) => u.state === 'infected').length;
    if (infected > this.units.length * 0.75) {
      for (const u of this.units) u.state = this.rollState();
      return;
    }
    for (const u of this.units) {
      if (u.state !== 'infected' && Math.random() < 0.25) u.state = 'infected';
    }
  }

  /** Tally by state, for the HUD. */
  stateCounts(): Record<UnitState, number> {
    const c = { normal: 0, protected: 0, infected: 0 };
    for (const u of this.units) c[u.state]++;
    return c;
  }

  destroy(): void {
    for (const k of ['land', 'sea', 'air', 'foot'] as UnitKind[]) this.batches[k].destroy();
  }
}
