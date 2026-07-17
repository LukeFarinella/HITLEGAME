#!/usr/bin/env node
// Offline region baker (STUB).
//
// Real version (see README.md): fetch Copernicus GLO-30 DEM + GEBCO bathymetry for the bbox,
// reproject to a local ENU plane with GDAL, clip to the circle, downsample, and emit
// heightmap.png (16-bit) + manifest.json. For now it just writes a manifest with placeholder
// elevation, and the runtime falls back to procedural terrain.
//
// Usage:  node pipeline/build-region.mjs --center 46.5,8.2 --diameter 320 --name "Alps"

import { writeFileSync, mkdirSync } from 'node:fs';
import { argv } from 'node:process';

function arg(name, def) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}

const [latS, lonS] = arg('center', '46.5,8.2').split(',');
const diameterKm = Number(arg('diameter', '320'));
const name = arg('name', 'Untitled Theater');

const manifest = {
  name,
  center: { lat: Number(latS), lon: Number(lonS) },
  diameterMeters: diameterKm * 1000,
  elevation: { min: -200, max: 3800 }, // TODO: derive from the DEM
  heightmap: null,                     // TODO: 'regions/<slug>.png' once baked
  resolution: 512,
};

mkdirSync('public/regions', { recursive: true });
const slug = name.toLowerCase().replace(/\W+/g, '-');
const out = `public/regions/${slug}.json`;
writeFileSync(out, JSON.stringify(manifest, null, 2));

console.log(`Wrote ${out}`);
console.log('NOTE: stub — terrain stays procedural until the DEM/GDAL step is implemented (see pipeline/README.md).');
