/**
 * Builds `public/obelisks.bin` — the GORGON obelisk sites.
 *
 * Source is a Google Sheet exported as CSV: an OpenStreetMap surveillance-camera dump
 * (`@lat,@lon,camera:direction`), ~126k rows worldwide. We keep only the points that fall inside
 * the US **nation polygon** (us-atlas), not a bounding box — a lat/lon box over the lower 48 also
 * swallows Vancouver, southern Ontario and northern Mexico.
 *
 *   node tools/build-obelisks.mjs
 *
 * Output is a flat binary, because JSON of this many records is ~3 MB of parse on the main thread:
 *
 *   magic   'GOBL'            4 bytes
 *   count   uint32 LE         4 bytes
 *   records count * 12 bytes  float32 lon, float32 lat, int16 heading, int16 flags
 *
 * `heading` is degrees clockwise from north, or -1 when the source didn't give a usable one
 * (that's ~96% of them — the runtime assigns those a stable pseudo-random facing).
 * `flags` bit 0 = the heading is real source data rather than invented.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, '..', 'public', 'obelisks.bin');

const SHEET =
  'https://docs.google.com/spreadsheets/d/1EBG4eDyEBWgrmthqLei-tdPemBU3T6ql0HgXQbo3Wd0/export?format=csv';

// --- heading normalisation ---------------------------------------------------------------------
// The source column is free text. Observed: degrees, compass letters, "NB"/"EB" (bound), ranges
// like "0-360" and "0;180", plus junk ("Down", "Flock Raven"). Anything ambiguous becomes unknown
// rather than a guess — a wrong facing is worse than an honest one.
const COMPASS = {
  N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
  E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
  S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
  W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
};

function parseHeading(raw) {
  if (!raw) return -1;
  const s = String(raw).trim().toUpperCase();
  if (!s) return -1;
  // ranges / multi-values are ambiguous ("0-360" means it spins, "0;180" means two)
  if (/[;,]/.test(s) || /\d\s*-\s*\d/.test(s)) return -1;

  const num = Number(s);
  if (Number.isFinite(num)) return ((Math.round(num) % 360) + 360) % 360;

  // "NB" / "EB" / "SB" / "WB" are north/east/south/west-bound
  const bound = s.match(/^([NESW])B$/);
  if (bound) return COMPASS[bound[1]];

  if (s in COMPASS) return Math.round(COMPASS[s]);
  return -1;
}

// --- point in polygon --------------------------------------------------------------------------
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Polygons with a precomputed bbox, so the common case is four comparisons. */
function prepare(polys) {
  return polys.map((rings) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of rings[0]) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    return { rings, w, s, e, n };
  });
}

function contains(prepared, x, y) {
  for (const p of prepared) {
    if (x < p.w || x > p.e || y < p.s || y > p.n) continue;
    if (!ringContains(p.rings[0], x, y)) continue;
    let hole = false;
    for (let i = 1; i < p.rings.length; i++) {
      if (ringContains(p.rings[i], x, y)) { hole = true; break; }
    }
    if (!hole) return true;
  }
  return false;
}

// --- main ------------------------------------------------------------------------------------
const topo = require('us-atlas/states-10m.json');
const nation = feature(topo, topo.objects.nation);
const geom = nation.features?.[0]?.geometry ?? nation.geometry;
const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
const usa = prepare(polys);
console.log(`[obelisks] US nation polygon: ${usa.length} rings`);

console.log('[obelisks] fetching sheet…');
const res = await fetch(SHEET);
if (!res.ok) throw new Error(`sheet fetch failed: ${res.status} ${res.statusText}`);
const csv = await res.text();

const lines = csv.split(/\r?\n/);
const header = lines[0].split(',');
const iLat = header.indexOf('@lat');
const iLon = header.indexOf('@lon');
const iDir = header.indexOf('camera:direction');
if (iLat < 0 || iLon < 0) throw new Error(`unexpected columns: ${header.join(',')}`);

const recs = [];
let skippedBadCoord = 0;
let outsideUS = 0;
let realHeading = 0;
const seen = new Set();
let dupes = 0;

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const c = line.split(',');
  const lat = Number(c[iLat]);
  const lon = Number(c[iLon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) { skippedBadCoord++; continue; }
  if (!contains(usa, lon, lat)) { outsideUS++; continue; }

  // Exact duplicate sites exist in the source; one obelisk per spot.
  const key = `${lat},${lon}`;
  if (seen.has(key)) { dupes++; continue; }
  seen.add(key);

  const heading = parseHeading(iDir >= 0 ? c[iDir] : '');
  if (heading >= 0) realHeading++;
  recs.push({ lon, lat, heading });
}

const buf = Buffer.alloc(8 + recs.length * 12);
buf.write('GOBL', 0, 'ascii');
buf.writeUInt32LE(recs.length, 4);
recs.forEach((r, i) => {
  const o = 8 + i * 12;
  buf.writeFloatLE(r.lon, o);
  buf.writeFloatLE(r.lat, o + 4);
  buf.writeInt16LE(r.heading, o + 8);
  buf.writeInt16LE(r.heading >= 0 ? 1 : 0, o + 10);
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, buf);

console.log(`[obelisks] kept ${recs.length}`);
console.log(`[obelisks]   outside US polygon : ${outsideUS}`);
console.log(`[obelisks]   duplicate sites    : ${dupes}`);
console.log(`[obelisks]   unusable coords    : ${skippedBadCoord}`);
console.log(`[obelisks]   real heading       : ${realHeading} (${((100 * realHeading) / recs.length).toFixed(1)}%)`);
console.log(`[obelisks] wrote ${OUT} (${(buf.length / 1e6).toFixed(2)} MB)`);
