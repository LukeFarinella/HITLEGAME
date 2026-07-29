import { feature } from 'topojson-client';
import type { ObeliskField } from '../cesium/obelisks';

/**
 * The territory survey: which US state every obelisk sits in, and which subset of them is live at
 * each ownership tier.
 *
 * The game unlocks the map state by state, and each state then upgrades through three obelisk
 * densities — one downtown site, then one per city, then the full field. That needs two questions
 * answered fast and often:
 *
 *   "which state is this lon/lat in?"  -> theater entry has to refuse locked ground, per click.
 *   "which obelisks are live?"         -> a mask over all 115k, rebuilt on every purchase.
 *
 * Both come out of ONE pass. Point-in-polygon against 1:10m state rings is far too slow to run
 * 115k times (a big state's outer ring alone is thousands of points), so the states are scanline-
 * rasterised once into a coarse grid of state indices. After that, both questions are an array
 * index, and the raster is reusable for anything else that needs "what state is this".
 */

// ---- raster ------------------------------------------------------------------------------------

/**
 * Raster bounds. Deliberately NOT the whole US: the obelisk data spans lon [-159.6, -64.7], lat
 * [17.7, 48.9] — CONUS plus Hawaii and Puerto Rico, no Alaska — so covering more would be tens of
 * megabytes of empty cells. Anything outside these bounds simply reads as "no state".
 */
const LON0 = -160;
const LAT0 = 17;
const LON1 = -64;
const LAT1 = 50;
/** ~2.2 km cells. Fine enough that a border misassignment is a rounding error, not a visible one. */
const STEP = 0.02;
const W = Math.round((LON1 - LON0) / STEP);
const H = Math.round((LAT1 - LAT0) / STEP);

// ---- city clustering ---------------------------------------------------------------------------

/** Obelisks are bucketed into cells this big (~5.5 km) to estimate local density. */
const DENSITY_CELL = 0.05;
/** A cell needs at least this many obelisks to count as a city rather than a hamlet. */
const MIN_CITY_OBELISKS = 12;
/** City centres must be at least this far apart, so one metro yields one site, not twenty. */
const CITY_SEPARATION_M = 22_000;

const DEG = Math.PI / 180;
const mPerLat = 111_320;

export type Tier = 0 | 1 | 2 | 3;
export const TIER_LABEL: Record<Tier, string> = {
  0: 'LOCKED',
  1: 'DOWNTOWN',
  2: 'CITY NET',
  3: 'PROLIFERATION',
};

export interface StateTerritory {
  /** FIPS code — the stable key progression persists against. */
  id: string;
  name: string;
  /** Every obelisk index inside this state. */
  all: Int32Array;
  /** One obelisk per city cluster, densest city first. Always includes {@link downtown} first. */
  cityReps: Int32Array;
  /** The single downtown site a freshly-unlocked state gets. */
  downtown: number;
  /** Mean of the state's obelisks — where the globe flies when the state is picked in the store. */
  center: { lon: number; lat: number };
  /** 1–10 for the headline economies, which are sold individually. Undefined for the rest. */
  gdpRank?: number;
  /** Funding-token costs per tier. Flat — see {@link TIER_COSTS}. */
  costs: { unlock: number; city: number; full: number };
}

/**
 * States are taken in blocks, not one at a time.
 *
 * Fifty individual unlocks is a lot of clicking for a decision that is really only interesting a
 * handful of times, so the map is grouped: the ten biggest prizes on their own, and everything else
 * split by where it is. A block is bought as a unit and upgrades as a unit.
 */
/**
 * What each tier of a state costs.
 *
 * Flat, not scaled by site count. Pricing off how much a state could eventually field meant
 * California cost forty times what Wyoming did, which sounds principled and played badly: the
 * interesting decision is WHERE to operate, and attaching a punitive price to the places worth
 * operating in just pushed everyone to the cheap empty ones. A block of states still multiplies —
 * taking twelve states at once costs twelve times one — so scale is still paid for, by breadth
 * rather than by quality.
 */
export const TIER_COSTS = { unlock: 250, city: 500, full: 1000 } as const;

export interface Region {
  id: string;
  name: string;
  blurb: string;
  states: StateTerritory[];
  /** Total sites the block can eventually field. */
  obelisks: number;
  cities: number;
}

export interface Territory {
  /** States holding at least one obelisk, alphabetical. */
  states: StateTerritory[];
  byId: Map<string, StateTerritory>;
  /** The ten largest economies, in rank order. Sold one at a time. */
  headline: StateTerritory[];
  /** The purchasable blocks holding everything else, in the order they're offered. */
  regions: Region[];
  /** Which block a state belongs to. */
  regionOf(stateId: string): Region | undefined;
  /** Which state a ground point falls in, or undefined for water / outside the survey. */
  stateAt(lon: number, lat: number): StateTerritory | undefined;
  /** The obelisk indices live at a given tier. */
  atTier(s: StateTerritory, tier: Tier): ArrayLike<number>;
  /** Total obelisks in the survey, for the HUD. */
  totalObelisks: number;
}


/**
 * The ten largest state economies, by FIPS, in rank order — the headline territories.
 *
 * These are sold INDIVIDUALLY rather than in a block: they're the decisions worth making one at a
 * time, and between them they carry most of the national network. Everything else is grouped, so
 * the list stays about ten interesting choices instead of fifty repetitive ones.
 *
 * Ranking is by state GDP and is approximate — the bottom of this list (Washington, New Jersey,
 * Georgia) reorders year to year, and it's a game-balance input rather than a cited figure.
 */
const GDP_TOP: { fips: string; rank: number }[] = [
  { fips: '06', rank: 1 }, // California
  { fips: '48', rank: 2 }, // Texas
  { fips: '36', rank: 3 }, // New York
  { fips: '12', rank: 4 }, // Florida
  { fips: '17', rank: 5 }, // Illinois
  { fips: '42', rank: 6 }, // Pennsylvania
  { fips: '39', rank: 7 }, // Ohio
  { fips: '13', rank: 8 }, // Georgia
  { fips: '53', rank: 9 }, // Washington
];
// New Jersey (34) is deliberately NOT here. It ranks on GDP but it is small, coastal and wedged
// against New York, which made it the one headline state that played like a block member — so it
// sits in the northern block with its neighbours and the headline list is nine.
const GDP_RANK = new Map(GDP_TOP.map((g) => [g.fips, g.rank]));

/**
 * Where the remainder splits. Both lines are drawn from the states' own centroids rather than a
 * hardcoded roster, so the grouping survives the survey finding a different set of states.
 * -100° is the conventional east/west divide; 37°N is roughly the Mason–Dixon extension.
 */
const WEST_OF = -100;
const SOUTH_OF = 37;

/**
 * Group everything that ISN'T a headline state, by where it sits. The headline ten are sold one by
 * one, so they never appear in a block.
 */
function buildRegions(states: StateTerritory[]): Region[] {
  const buckets: Record<string, StateTerritory[]> = { west: [], south: [], north: [] };
  for (const s of states) {
    if (GDP_RANK.has(s.id)) continue; // sold individually
    if (s.center.lon < WEST_OF) buckets.west.push(s);
    else if (s.center.lat < SOUTH_OF) buckets.south.push(s);
    else buckets.north.push(s);
  }

  const meta: { id: string; name: string; blurb: string }[] = [
    {
      id: 'west',
      name: 'WESTERN BLOCK',
      blurb: 'Remaining states west of the 100th meridian. Sparse, cheap, and mostly dark between cities.',
    },
    { id: 'south', name: 'SOUTHERN BLOCK', blurb: 'Remaining southern states and territories.' },
    { id: 'north', name: 'NORTHERN BLOCK', blurb: 'Remaining northern and northeastern states.' },
  ];

  return meta
    .map((m) => {
      const members = buckets[m.id].sort((a, b) => a.name.localeCompare(b.name));
      return {
        id: m.id,
        name: m.name,
        blurb: m.blurb,
        states: members,
        obelisks: members.reduce((n, s) => n + s.all.length, 0),
        cities: members.reduce((n, s) => n + s.cityReps.length, 0),
      };
    })
    .filter((r) => r.states.length > 0);
}

interface Ring {
  x: number[];
  y: number[];
}

/**
 * Scanline-fill one polygon (outer ring plus holes) into the grid.
 *
 * Even-odd across every ring of the polygon at once, which handles holes for free: a lake's ring
 * contributes two more crossings on the rows it spans, so the fill pairs up around it.
 */
function fillPolygon(grid: Uint8Array, rings: Ring[], value: number): void {
  let south = Infinity;
  let north = -Infinity;
  for (const r of rings) {
    for (const y of r.y) {
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  const y0 = Math.max(0, Math.floor((south - LAT0) / STEP));
  const y1 = Math.min(H - 1, Math.ceil((north - LAT0) / STEP));
  const xs: number[] = [];

  for (let gy = y0; gy <= y1; gy++) {
    const lat = LAT0 + (gy + 0.5) * STEP; // sample at the cell centre
    xs.length = 0;
    for (const r of rings) {
      const n = r.x.length;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ay = r.y[j];
        const by = r.y[i];
        // Half-open on lat so a vertex exactly on the scanline is counted once, not twice.
        if (ay <= lat === by <= lat) continue;
        const t = (lat - ay) / (by - ay);
        xs.push(r.x[j] + t * (r.x[i] - r.x[j]));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const row = gy * W;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const from = Math.max(0, Math.ceil((xs[k] - LON0) / STEP - 0.5));
      const to = Math.min(W - 1, Math.floor((xs[k + 1] - LON0) / STEP - 0.5));
      for (let gx = from; gx <= to; gx++) grid[row + gx] = value;
    }
  }
}

/** Cheap metric distance between two lon/lats — fine at city separations. */
function metres(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const mLon = mPerLat * Math.cos(((lat1 + lat2) / 2) * DEG);
  return Math.hypot((lon2 - lon1) * mLon, (lat2 - lat1) * mPerLat);
}

/**
 * Pick the city sites for one state: greedily take the densest unclaimed neighbourhood, then
 * exclude everything within {@link CITY_SEPARATION_M} of it so a single metro yields one site.
 * Returns representatives densest-first, so element 0 is the state's downtown.
 */
function pickCities(indices: number[], lon: Float32Array, lat: Float32Array): number[] {
  // bucket into density cells
  const cells = new Map<string, number[]>();
  for (const i of indices) {
    const key = `${Math.floor(lon[i] / DENSITY_CELL)},${Math.floor(lat[i] / DENSITY_CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push(i);
  }

  const ranked = [...cells.values()].sort((a, b) => b.length - a.length);
  const reps: number[] = [];
  const repLon: number[] = [];
  const repLat: number[] = [];

  for (const cell of ranked) {
    // The first (densest) cell always becomes the downtown, even in a state too rural to clear the
    // city threshold — every unlocked state must get exactly one site to start with.
    if (cell.length < MIN_CITY_OBELISKS && reps.length > 0) break;

    let cLon = 0;
    let cLat = 0;
    for (const i of cell) {
      cLon += lon[i];
      cLat += lat[i];
    }
    cLon /= cell.length;
    cLat /= cell.length;

    let tooClose = false;
    for (let k = 0; k < reps.length; k++) {
      if (metres(cLon, cLat, repLon[k], repLat[k]) < CITY_SEPARATION_M) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Representative = the obelisk nearest the cluster's centre of mass, so the site lands in the
    // thick of the city rather than on its ragged edge.
    let best = cell[0];
    let bestD = Infinity;
    for (const i of cell) {
      const d = metres(lon[i], lat[i], cLon, cLat);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    reps.push(best);
    repLon.push(cLon);
    repLat.push(cLat);
  }
  return reps;
}

/**
 * City centres from a loose bag of sites, densest first.
 *
 * The same greedy density-then-separation idea {@link pickCities} uses, but over arbitrary lon/lat
 * pairs rather than the global obelisk field — so a theater can ask "where are the cities in here?"
 * from the sites it actually built, and spread the player's platforms across them.
 */
export function clusterCentres(
  lonLat: Float64Array,
  opts: { cellDeg?: number; minCount?: number; separationM?: number; max?: number } = {},
): { lon: number; lat: number }[] {
  const cellDeg = opts.cellDeg ?? DENSITY_CELL;
  const minCount = opts.minCount ?? 1;
  const separationM = opts.separationM ?? CITY_SEPARATION_M;
  const max = opts.max ?? 8;

  const cells = new Map<string, { lon: number; lat: number; n: number }>();
  for (let i = 0; i < lonLat.length; i += 2) {
    const lon = lonLat[i];
    const lat = lonLat[i + 1];
    const key = `${Math.floor(lon / cellDeg)},${Math.floor(lat / cellDeg)}`;
    const c = cells.get(key);
    if (c) {
      c.lon += lon;
      c.lat += lat;
      c.n++;
    } else {
      cells.set(key, { lon, lat, n: 1 });
    }
  }

  const ranked = [...cells.values()].sort((a, b) => b.n - a.n);
  const out: { lon: number; lat: number }[] = [];
  for (const c of ranked) {
    if (out.length >= max) break;
    if (c.n < minCount && out.length > 0) break;
    const p = { lon: c.lon / c.n, lat: c.lat / c.n };
    if (out.some((q) => metres(p.lon, p.lat, q.lon, q.lat) < separationM)) continue;
    out.push(p);
  }
  return out;
}

let surveyPromise: Promise<Territory> | null = null;

/**
 * Run the survey once and cache it. The states-10m download is several MB, so this is fired in the
 * background after the obelisks land — and it warms the same module the theater build needs, so
 * entering a theater afterwards is free.
 */
export function surveyTerritory(field: ObeliskField): Promise<Territory> {
  surveyPromise ??= (async () => {
    const topo = (await import('us-atlas/states-10m.json')).default as unknown as {
      objects: { states: unknown };
    };
    const fc = feature(topo as never, topo.objects.states as never) as unknown as {
      features: {
        id: string;
        properties: { name: string };
        geometry: { type: string; coordinates: number[][][] | number[][][][] };
      }[];
    };

    const grid = new Uint8Array(W * H);
    const meta: { id: string; name: string }[] = [];

    for (const f of fc.features) {
      // 0 means "no state", so raster values are index + 1. 56 states fits a Uint8 comfortably.
      const value = meta.push({ id: f.id, name: f.properties.name });
      const polys =
        f.geometry.type === 'Polygon'
          ? [f.geometry.coordinates as number[][][]]
          : (f.geometry.coordinates as number[][][][]);
      for (const poly of polys) {
        const rings: Ring[] = poly.map((ring) => ({
          x: ring.map((p) => p[0]),
          y: ring.map((p) => p[1]),
        }));
        fillPolygon(grid, rings, value);
      }
    }

    const cellAt = (lon: number, lat: number): number => {
      const gx = Math.floor((lon - LON0) / STEP);
      const gy = Math.floor((lat - LAT0) / STEP);
      if (gx < 0 || gy < 0 || gx >= W || gy >= H) return 0;
      return grid[gy * W + gx];
    };

    // Assign every obelisk to a state.
    const buckets: number[][] = meta.map(() => []);
    // realCount, not count: anything past it is a synthesised overseas site, which is not US
    // territory and must never end up inside a state's roster. (The raster would reject them on
    // bounds anyway — this states the intent rather than relying on that.)
    for (let i = 0; i < field.realCount; i++) {
      const v = cellAt(field.lon[i], field.lat[i]);
      if (v > 0) buckets[v - 1].push(i);
    }

    const states: StateTerritory[] = [];
    const byId = new Map<string, StateTerritory>();
    let totalObelisks = 0;
    for (let s = 0; s < meta.length; s++) {
      const indices = buckets[s];
      if (!indices.length) continue; // a state the obelisk data never reaches isn't territory yet
      const reps = pickCities(indices, field.lon, field.lat);
      const n = indices.length;
      let cLon = 0;
      let cLat = 0;
      for (const i of indices) {
        cLon += field.lon[i];
        cLat += field.lat[i];
      }
      const st: StateTerritory = {
        id: meta[s].id,
        name: meta[s].name,
        all: Int32Array.from(indices),
        cityReps: Int32Array.from(reps),
        downtown: reps[0],
        center: { lon: cLon / n, lat: cLat / n },
        gdpRank: GDP_RANK.get(meta[s].id),
        costs: { ...TIER_COSTS },
      };
      totalObelisks += n;
      states.push(st);
      byId.set(st.id, st);
    }
    states.sort((a, b) => a.name.localeCompare(b.name));
    const headline = states
      .filter((s) => s.gdpRank !== undefined)
      .sort((a, b) => a.gdpRank! - b.gdpRank!);
    const regions = buildRegions(states);
    const regionByState = new Map<string, Region>();
    for (const r of regions) for (const s of r.states) regionByState.set(s.id, r);

    return {
      states,
      byId,
      headline,
      regions,
      regionOf: (stateId) => regionByState.get(stateId),
      totalObelisks,
      stateAt(lon, lat) {
        const v = cellAt(lon, lat);
        return v > 0 ? byId.get(meta[v - 1].id) : undefined;
      },
      atTier(s, tier) {
        if (tier <= 0) return [];
        if (tier === 1) return [s.downtown];
        return tier === 2 ? s.cityReps : s.all;
      },
    };
  })();
  return surveyPromise;
}
