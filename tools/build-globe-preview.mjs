// Builds a self-contained tactical-globe preview by injecting real coastline data
// (world-atlas land-110m) into tools/globe-preview.template.html.
// Output: brand/globe-preview.html (publishable as an Artifact).
import { readFileSync, writeFileSync } from 'node:fs';
import { feature } from 'topojson-client';
import topo from 'world-atlas/land-110m.json' with { type: 'json' };

const land = feature(topo, topo.objects.land);

// Flatten every polygon ring to a rounded [lon,lat] polyline (1 decimal ≈ 11 km — plenty for a globe).
const rings = [];
const addRing = (ring) => {
  const out = [];
  let prev = null;
  for (const [lon, lat] of ring) {
    const p = [Math.round(lon * 10) / 10, Math.round(lat * 10) / 10];
    if (!prev || p[0] !== prev[0] || p[1] !== prev[1]) { out.push(p); prev = p; }
  }
  if (out.length > 1) rings.push(out);
};
for (const f of land.features) {
  const g = f.geometry;
  if (g.type === 'Polygon') g.coordinates.forEach(addRing);
  else if (g.type === 'MultiPolygon') g.coordinates.forEach((poly) => poly.forEach(addRing));
}

const data = JSON.stringify(rings);
const template = readFileSync('tools/globe-preview.template.html', 'utf8');
const html = template.replace(/\/\*__COAST__\*\/[\s\S]*?\/\*__COAST__\*\//, data);

writeFileSync('brand/globe-preview.html', html);
const points = rings.reduce((n, r) => n + r.length, 0);
console.log(`Wrote brand/globe-preview.html — ${rings.length} rings, ${points} points, ${(html.length / 1024).toFixed(0)} KB`);
