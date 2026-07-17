import { LatLon } from '../core/types';

/** A stitched real-elevation grid for a region, sampleable by lat/lon (meters). */
export interface ElevationGrid {
  sample(lat: number, lon: number): number;
  readonly min: number;
  readonly max: number;
  readonly zoom: number;
  readonly tiles: number;
}

const TILE = 256;
const EARTH_CIRC = 40_075_016; // meters at equator

// Web Mercator, fractional tile coordinates.
const lon2tileX = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2tileY = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Terrarium PNG encoding: elevation(m) = R*256 + G + B/256 - 32768. */
const decode = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

/** Pick a zoom so the region spans ~4 tiles/side, clamped to a sane range. */
function chooseZoom(center: LatLon, diameterMeters: number): number {
  const targetTiles = 4;
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const z = Math.round(Math.log2((EARTH_CIRC * cos) / (diameterMeters / targetTiles)));
  return Math.max(9, Math.min(12, z));
}

async function fetchTile(z: number, x: number, y: number): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(`/tiles/terrarium/${z}/${x}/${y}.png`);
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

/** Fetch + stitch the elevation tiles covering a circular theater. Throws if nothing loads. */
export async function loadElevationGrid(center: LatLon, diameterMeters: number): Promise<ElevationGrid> {
  const z = chooseZoom(center, diameterMeters);
  const half = diameterMeters / 2;
  const dLat = half / 111_320;
  const dLon = half / (111_320 * Math.cos((center.lat * Math.PI) / 180));

  const xMin = Math.floor(lon2tileX(center.lon - dLon, z));
  const xMax = Math.floor(lon2tileX(center.lon + dLon, z));
  const yMin = Math.floor(lat2tileY(center.lat + dLat, z)); // north -> smaller y
  const yMax = Math.floor(lat2tileY(center.lat - dLat, z));

  const cols = xMax - xMin + 1;
  const rows = yMax - yMin + 1;

  const canvas = document.createElement('canvas');
  canvas.width = cols * TILE;
  canvas.height = rows * TILE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const jobs: Promise<void>[] = [];
  let loaded = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      jobs.push(
        fetchTile(z, xMin + i, yMin + j).then((bmp) => {
          if (bmp) {
            ctx.drawImage(bmp, i * TILE, j * TILE);
            bmp.close();
            loaded++;
          }
        }),
      );
    }
  }
  await Promise.all(jobs);
  if (loaded === 0) throw new Error('no elevation tiles loaded');

  const W = canvas.width;
  const H = canvas.height;
  const img = ctx.getImageData(0, 0, W, H).data;

  // Decode to a Float32 heightfield and record min/max.
  const grid = new Float32Array(W * H);
  let min = Infinity;
  let max = -Infinity;
  for (let p = 0, k = 0; p < grid.length; p++, k += 4) {
    const e = decode(img[k], img[k + 1], img[k + 2]);
    grid[p] = e;
    if (e < min) min = e;
    if (e > max) max = e;
  }

  const originPxX = xMin * TILE;
  const originPxY = yMin * TILE;

  const sample = (lat: number, lon: number): number => {
    // Clamp to the grid first so out-of-bounds points sample the edge instead of extrapolating.
    const gx = Math.max(0, Math.min(W - 1, lon2tileX(lon, z) * TILE - originPxX));
    const gy = Math.max(0, Math.min(H - 1, lat2tileY(lat, z) * TILE - originPxY));
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

  return { sample, min, max, zoom: z, tiles: loaded };
}
