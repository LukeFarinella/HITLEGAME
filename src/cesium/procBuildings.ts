import type { RoadNet, RoadClass } from './roads';
import type { BuildingSet } from './buildings';

/**
 * Procedurally generate a city from the real road network.
 *
 * Real OSM footprints are sparse and geographically uneven (a downtown of 5k highrises, nothing in
 * between). Road density, on the other hand, is an excellent proxy for "where the city is" — and we
 * already have the full real road graph across the theater. So: rasterise road length into a grid,
 * and scatter buildings into cells in proportion to that density, keeping them clear of the roads
 * (so traffic runs between them) and rising to towers where density peaks. The result is a full,
 * dense skyline that's road-accurate in where it's dense.
 *
 * Output is the same {@link BuildingSet} the real path produced, so the extruder/renderer are reused
 * unchanged.
 */

const DEG = Math.PI / 180;
const mPerLat = 111_320;

/** Which classes count toward "urban density". Freeways run between cities, so they count less. */
const CLASS_WEIGHT: Record<RoadClass, number> = {
  motorway: 0.35,
  trunk: 0.5,
  primary: 1,
  secondary: 1,
  tertiary: 1,
};

/** Half-width per class, metres — mirrors ROAD_STYLE widths so buildings clear the drawn ribbon. */
const CLASS_HALF: Record<RoadClass, number> = {
  motorway: 16,
  trunk: 12,
  primary: 8,
  secondary: 5.5,
  tertiary: 4,
};

/** Extra gap between a building's near edge and the road edge, metres. */
const ROAD_GAP = 8;

export interface ProcOptions {
  /** How far from centre to generate (metres). Density self-limits the countryside within this. */
  radiusM: number;
  /** Hard cap on building count (densest areas are filled first). */
  maxBuildings: number;
  /** Tallest tower, metres. */
  maxHeight: number;
}

const CELL = 300; // density / spatial grid, metres
const OVERLAP_CELL = 18; // building anti-overlap hash, metres

// deterministic-ish RNG so a theatre looks the same each visit
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

interface Seg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  hw: number; // road half-width (metres), so buildings can clear the ribbon
}

export function generateBuildings(
  net: RoadNet,
  center: { lon: number; lat: number },
  heightAt: (lon: number, lat: number) => number,
  opts: ProcOptions,
): BuildingSet {
  const R = opts.radiusM;
  const mPerLon = mPerLat * Math.max(0.15, Math.cos(center.lat * DEG));
  const toX = (lon: number) => (lon - center.lon) * mPerLon;
  const toY = (lat: number) => (lat - center.lat) * mPerLat;
  const toLon = (x: number) => center.lon + x / mPerLon;
  const toLat = (y: number) => center.lat + y / mPerLat;

  const gridN = Math.max(1, Math.ceil((2 * R) / CELL));
  const cellOf = (x: number, y: number) => {
    const ix = Math.floor((x + R) / CELL);
    const iy = Math.floor((y + R) / CELL);
    if (ix < 0 || iy < 0 || ix >= gridN || iy >= gridN) return -1;
    return iy * gridN + ix;
  };

  const density = new Float32Array(gridN * gridN);
  const segCells = new Map<number, Seg[]>();
  const addSeg = (cell: number, seg: Seg) => {
    if (cell < 0) return;
    let a = segCells.get(cell);
    if (!a) segCells.set(cell, (a = []));
    a.push(seg);
  };

  // --- rasterise roads into the density grid + a segment index for clearance tests
  for (const road of net.roads) {
    const w = CLASS_WEIGHT[road.cls];
    const hw = CLASS_HALF[road.cls];
    const pts = road.coords;
    for (let i = 1; i < pts.length; i++) {
      const ax = toX(pts[i - 1][0]);
      const ay = toY(pts[i - 1][1]);
      const bx = toX(pts[i][0]);
      const by = toY(pts[i][1]);
      // skip segments fully outside the generation disc (cheap bbox test)
      if (Math.min(ax, bx) > R || Math.max(ax, bx) < -R || Math.min(ay, by) > R || Math.max(ay, by) < -R) continue;
      const len = Math.hypot(bx - ax, by - ay);
      if (len === 0) continue;
      const seg: Seg = { ax, ay, bx, by, hw };
      // index by both endpoint cells (segments are short after Chaikin, so this covers proximity)
      addSeg(cellOf(ax, ay), seg);
      const ec = cellOf(bx, by);
      if (ec !== cellOf(ax, ay)) addSeg(ec, seg);
      // deposit weighted length along the segment
      const steps = Math.max(1, Math.ceil(len / (CELL / 2)));
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const c = cellOf(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (c >= 0) density[c] += (len / steps) * w;
      }
    }
  }

  let maxD = 0;
  for (const d of density) if (d > maxD) maxD = d;
  if (maxD === 0) return { polys: [], tiles: 0, points: 0, skipped: 0 };

  // --- cells to fill, densest first (so the core is built before the cap)
  const order: number[] = [];
  for (let c = 0; c < density.length; c++) if (density[c] > 0) order.push(c);
  order.sort((a, b) => density[b] - density[a]);

  const rand = mulberry32(Math.round(center.lon * 1000) ^ (Math.round(center.lat * 1000) << 8));

  // nearest road segment to (x,y) within the 3x3 cell neighbourhood; returns the closest point on
  // it (nx,ny) + the segment direction, so a building can be snapped to front that street.
  const nearestRoad = (x: number, y: number) => {
    let best = Infinity;
    let dirx = 1;
    let diry = 0;
    let nx = x;
    let ny = y;
    let hw = 4;
    const ix = Math.floor((x + R) / CELL);
    const iy = Math.floor((y + R) / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = ix + dx;
        const gy = iy + dy;
        if (gx < 0 || gy < 0 || gx >= gridN || gy >= gridN) continue;
        const segs = segCells.get(gy * gridN + gx);
        if (!segs) continue;
        for (const s of segs) {
          const vx = s.bx - s.ax;
          const vy = s.by - s.ay;
          const l2 = vx * vx + vy * vy;
          let t = l2 > 0 ? ((x - s.ax) * vx + (y - s.ay) * vy) / l2 : 0;
          t = Math.max(0, Math.min(1, t));
          const px = s.ax + vx * t;
          const py = s.ay + vy * t;
          const d = Math.hypot(x - px, y - py);
          if (d < best) {
            best = d;
            nx = px;
            ny = py;
            hw = s.hw;
            const il = 1 / (Math.sqrt(l2) || 1);
            dirx = vx * il;
            diry = vy * il;
          }
        }
      }
    }
    return { dist: best, dirx, diry, nx, ny, hw };
  };

  const placed = new Map<number, number[]>(); // overlap hash: cell -> [x,y,...]
  const overlaps = (x: number, y: number, minDist: number): boolean => {
    const ix = Math.floor((x + R) / OVERLAP_CELL);
    const iy = Math.floor((y + R) / OVERLAP_CELL);
    const md2 = minDist * minDist;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = placed.get((iy + dy) * 100000 + (ix + dx));
        if (!arr) continue;
        for (let k = 0; k < arr.length; k += 2) {
          const ddx = arr[k] - x;
          const ddy = arr[k + 1] - y;
          if (ddx * ddx + ddy * ddy < md2) return true;
        }
      }
    }
    return false;
  };
  const remember = (x: number, y: number) => {
    const ix = Math.floor((x + R) / OVERLAP_CELL);
    const iy = Math.floor((y + R) / OVERLAP_CELL);
    const key = iy * 100000 + ix;
    let arr = placed.get(key);
    if (!arr) placed.set(key, (arr = []));
    arr.push(x, y);
  };

  const polys: BuildingSet['polys'] = [];
  let points = 0;

  const DMIN = 0.02; // below this fraction of peak density → countryside, stop
  const MAX_PER_CELL = 60;

  outer: for (const c of order) {
    // sqrt broadens a peaky road-density field so whole districts read as urban, not just one cell
    const d = Math.sqrt(density[c] / maxD);
    if (d * d < DMIN) break; // sorted, so everything after is sparser
    const cx = ((c % gridN) + 0.5) * CELL - R;
    const cy = (Math.floor(c / gridN) + 0.5) * CELL - R;

    const count = Math.round((0.2 + 0.8 * d) * MAX_PER_CELL);
    for (let k = 0; k < count; k++) {
      if (polys.length >= opts.maxBuildings) break outer;
      // seed a random spot, then snap the building to FRONT the nearest street: near edge just off
      // the pavement, footprint extending into the block. This lines every road and keeps the
      // roadway clear (so traffic shows) instead of scattering boxes onto it.
      const sx = cx + (rand() - 0.5) * CELL;
      const sy = cy + (rand() - 0.5) * CELL;
      const near = nearestRoad(sx, sy);
      if (near.dist > 55) continue; // deep block interior / no nearby road → leave empty

      const wid = lerp(20, 60, d) * (0.75 + rand() * 0.6); // along the street
      const dep = lerp(16, 42, d) * (0.75 + rand() * 0.6); // into the block

      // side of the street the seed fell on (perpendicular away from the road)
      let ax = sx - near.nx;
      let ay = sy - near.ny;
      const al = Math.hypot(ax, ay);
      if (al < 1) {
        ax = -near.diry;
        ay = near.dirx;
        if (rand() < 0.5) {
          ax = -ax;
          ay = -ay;
        }
      } else {
        ax /= al;
        ay /= al;
      }
      // near edge clears the drawn ribbon (its half-width) plus a gap, so buildings sit OFF the road
      const setback = near.hw + ROAD_GAP + dep / 2;
      const x = near.nx + ax * setback;
      const y = near.ny + ay * setback;
      if (heightAt(toLon(x), toLat(y)) < 0.5) continue; // keep off water
      if (overlaps(x, y, Math.max(wid, dep) * 0.5)) continue;

      const ux = near.dirx; // long axis along the street
      const uy = near.diry;
      const px = -uy;
      const py = ux;
      const hw = wid / 2;
      const hd = dep / 2;
      const corner = (cs: number, cd: number): number[] => {
        const wx = x + ux * hw * cs + px * hd * cd;
        const wy = y + uy * hw * cs + py * hd * cd;
        return [toLon(wx), toLat(wy)];
      };
      const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];

      let h = lerp(14, 85, d) * (0.7 + rand() * 0.7);
      if (d > 0.45 && rand() < 0.35 * d) h *= 2 + rand() * 2.4; // towers downtown
      h = Math.min(h, opts.maxHeight);

      polys.push({ rings: [ring], height: h, minHeight: 0 });
      points += 4;
      remember(x, y);
    }
  }

  return { polys, tiles: 0, points, skipped: 0 };
}
