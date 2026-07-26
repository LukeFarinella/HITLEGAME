import * as Cesium from 'cesium';

/**
 * Cesium terrain from AWS Terrain Tiles (terrarium-encoded PNGs).
 *
 * Why: Cesium World Terrain is land-only (oceans flattened to 0). This dataset is SRTM/GMTED for
 * land PLUS ETOPO1/GEBCO bathymetry for the seafloor, in one global source — so we get relief
 * above AND below water with no Ion asset.
 *
 * Tiles are fetched STRAIGHT FROM S3. That was not always possible: this provider used to go
 * through a Vite dev proxy because the bucket served no CORS header, and we read pixels back off a
 * canvas, so a tainted response was useless. AWS has since enabled CORS on `elevation-tiles-prod`
 * — measured: `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET` — so the proxy
 * is gone and the app is a plain static bundle again, hostable anywhere.
 *
 * If that ever regresses, the symptom is every tile failing at the fetch (not the decode), and the
 * fix is to reinstate a `/tiles/terrarium/*` proxy and point {@link terrariumTileUrl} back at it.
 *
 * Encoding: elevation(m) = R*256 + G + B/256 - 32768
 *
 * IMPORTANT — measured behaviour of this dataset:
 *   land  has real data to z14+.
 *   ocean has real data only to z10; DEEPER OCEAN TILES EXIST BUT ARE ALL ZEROS (not 404s).
 * Naively trusting them makes the seabed rise to sea level as you zoom in. So an all-zero tile
 * above DATA_FLOOR_LEVEL is treated as "no data here" and resampled from the deepest ancestor
 * that does have data. Land is unaffected (its tiles are never all-zero).
 */
const TILE_PX = 256;
const DATA_FLOOR_LEVEL = 10; // deepest zoom where bathymetry still carries real values

/** Land is lifted to at least this (≈3 ft) so it never sinks under the water plane. */
const LAND_LIFT_M = 1.0;
/** Water is pushed to at most this, so noisy sea pixels never poke through the water plane. */
const WATER_FLOOR_M = -0.5;

/**
 * Vector land polygons (lon/lat), pre-clipped to the area of interest.
 * MultiPolygon: [polygon][ring][point][lon, lat]; ring 0 is the outer ring, the rest are holes.
 */
export interface LandMask {
  polys: number[][][][];
  /** [west, south, east, north] in degrees — used to skip tiles that can't be affected. */
  bbox: [number, number, number, number];
}

export interface TerrariumOptions {
  /** Per-tile mesh resolution. Lower = fewer vertices per tile (mobile). */
  samples?: number;
  /** Deepest zoom to request. Terrarium land has data to ~15. */
  maxLevel?: number;
  /**
   * Snap the waterline to the vector coastline instead of trusting the heightmap.
   * Terrarium jitters a few metres around zero along shores, which makes land flood and sea
   * poke through. Inside the mask we lift to LAND_LIFT_M, outside we clamp to WATER_FLOOR_M —
   * mountains and seafloor are untouched.
   */
  landMask?: LandMask;
}

// One scratch canvas reused for every tile decode.
const scratch = document.createElement('canvas');
scratch.width = TILE_PX;
scratch.height = TILE_PX;
const scratchCtx = scratch.getContext('2d', { willReadFrequently: true })!;

// A second small canvas used to rasterise the land mask per tile.
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true })!;

/**
 * One terrarium tile's URL. The single place either consumer builds one — this provider for
 * Cesium's terrain, and theaterMap's stitcher for the baked elevation grid — so switching source
 * (or reinstating a proxy) is a one-line change rather than a hunt.
 */
export const terrariumTileUrl = (z: number, x: number, y: number) =>
  `https://elevation-tiles-prod.s3.amazonaws.com/terrarium/${z}/${x}/${y}.png`;

const tileUrl = terrariumTileUrl;

export class TerrariumTerrainProvider {
  private readonly _tilingScheme = new Cesium.WebMercatorTilingScheme();
  private readonly _errorEvent = new Cesium.Event();
  private readonly _credit = new Cesium.Credit('Terrain: AWS Terrain Tiles (SRTM, GMTED, ETOPO1/GEBCO)');
  private readonly _levelZeroError: number;
  private readonly _samples: number;
  private readonly _maxLevel: number;
  private readonly _landMask?: LandMask;
  private readonly _availability: Cesium.TileAvailability;
  /** Decoded full-res ancestor tiles, reused by the many children that overzoom from them. */
  private readonly _ancestors = new Map<string, Promise<Float32Array | null>>();

  constructor(options: TerrariumOptions = {}) {
    this._samples = options.samples ?? 65;
    this._maxLevel = options.maxLevel ?? 14;
    this._landMask = options.landMask;
    this._levelZeroError = Cesium.TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
      this._tilingScheme.ellipsoid,
      this._samples,
      this._tilingScheme.getNumberOfXTilesAtLevel(0),
    );

    // Terrarium covers the whole world at every level (ocean gaps are filled by overzoom below),
    // so declare one full range per level. Availability lets Cesium cap subdivision correctly and
    // makes sampleTerrainMostDetailed work.
    this._availability = new Cesium.TileAvailability(this._tilingScheme, this._maxLevel);
    for (let level = 0; level <= this._maxLevel; level++) {
      this._availability.addAvailableTileRange(
        level,
        0,
        0,
        this._tilingScheme.getNumberOfXTilesAtLevel(level) - 1,
        this._tilingScheme.getNumberOfYTilesAtLevel(level) - 1,
      );
    }
  }

  get tilingScheme() {
    return this._tilingScheme;
  }
  get errorEvent() {
    return this._errorEvent;
  }
  get credit() {
    return this._credit;
  }
  get hasWaterMask() {
    return false;
  }
  get hasVertexNormals() {
    return false;
  }
  get availability() {
    return this._availability;
  }

  getLevelMaximumGeometricError(level: number): number {
    return this._levelZeroError / (1 << level);
  }

  getTileDataAvailable(_x: number, _y: number, level: number): boolean {
    return level <= this._maxLevel;
  }

  loadTileDataAvailability(): undefined {
    return undefined;
  }

  requestTileGeometry(x: number, y: number, level: number, request?: Cesium.Request) {
    // `request` rides on the Resource so Cesium's scheduler can throttle/cancel tile loads.
    const resource = new Cesium.Resource({ url: tileUrl(level, x, y), request });
    const promise = resource.fetchImage({ preferImageBitmap: true });
    if (!promise) return undefined; // Cesium's scheduler throttled us; it will retry

    return promise
      .then(async (image: unknown) => {
        const full = decodeFull(image as CanvasImageSource);
        // Real data -> use it. All zeros above the data floor means the dataset has no bathymetry
        // at this zoom, so rebuild from the deepest ancestor that does.
        let heights: Float32Array | null = null;
        if (isAllZero(full) && level > DATA_FLOOR_LEVEL) {
          heights = await this._overzoom(x, y, level);
        }
        heights ??= downsample(full, this._samples);
        this._snapToShore(heights, x, y, level);
        return this._heightmap(heights, level);
      })
      .catch(() => this._heightmap(new Float32Array(this._samples * this._samples), level));
  }

  /** Rebuild this tile's heights from its DATA_FLOOR_LEVEL ancestor (bilinear). */
  private async _overzoom(x: number, y: number, level: number): Promise<Float32Array | null> {
    const d = level - DATA_FLOOR_LEVEL;
    const ax = x >>> d;
    const ay = y >>> d;
    const full = await this._ancestor(ax, ay);
    if (!full) return null;

    const S = this._samples;
    const scale = 1 << d;
    const subW = TILE_PX / scale; // ancestor pixels covered by this tile
    const ox = (x - (ax << d)) * subW;
    const oy = (y - (ay << d)) * subW;

    const out = new Float32Array(S * S);
    for (let j = 0; j < S; j++) {
      const sy = oy + (j / (S - 1)) * (subW - 1);
      for (let i = 0; i < S; i++) {
        const sx = ox + (i / (S - 1)) * (subW - 1);
        out[j * S + i] = bilinear(full, sx, sy);
      }
    }
    return out;
  }

  private _ancestor(ax: number, ay: number): Promise<Float32Array | null> {
    const key = `${ax}/${ay}`;
    let p = this._ancestors.get(key);
    if (!p) {
      p = new Cesium.Resource({ url: tileUrl(DATA_FLOOR_LEVEL, ax, ay) })
        .fetchImage({ preferImageBitmap: true })!
        .then((img: unknown) => decodeFull(img as CanvasImageSource))
        .catch(() => null);
      if (this._ancestors.size > 64) this._ancestors.clear(); // cheap bound
      this._ancestors.set(key, p);
    }
    return p;
  }

  /**
   * Make the vector coastline authoritative: lift anything inside the land polygons above the
   * water plane, push anything outside below it. Only touches the ±few metres of noise at the
   * waterline — real relief is preserved by the max/min.
   */
  private _snapToShore(heights: Float32Array, x: number, y: number, level: number): void {
    const mask = this._landMask;
    if (!mask) return;

    // Skip tiles the mask can't touch.
    const geo = this._tilingScheme.tileXYToRectangle(x, y, level);
    const w = Cesium.Math.toDegrees(geo.west);
    const e = Cesium.Math.toDegrees(geo.east);
    const s = Cesium.Math.toDegrees(geo.south);
    const n = Cesium.Math.toDegrees(geo.north);
    if (e < mask.bbox[0] || w > mask.bbox[2] || n < mask.bbox[1] || s > mask.bbox[3]) return;

    const S = this._samples;
    const native = this._tilingScheme.tileXYToNativeRectangle(x, y, level);
    const proj = this._tilingScheme.projection;
    const carto = new Cesium.Cartographic();
    const spanX = native.east - native.west;
    const spanY = native.north - native.south;

    maskCanvas.width = S;
    maskCanvas.height = S;
    maskCtx.clearRect(0, 0, S, S);
    maskCtx.fillStyle = '#fff';
    maskCtx.beginPath();
    for (const poly of mask.polys) {
      for (const ring of poly) {
        for (let i = 0; i < ring.length; i++) {
          carto.longitude = Cesium.Math.toRadians(ring[i][0]);
          carto.latitude = Cesium.Math.toRadians(ring[i][1]);
          carto.height = 0;
          const p = proj.project(carto);
          const px = ((p.x - native.west) / spanX) * (S - 1);
          const py = ((native.north - p.y) / spanY) * (S - 1);
          if (i === 0) maskCtx.moveTo(px, py);
          else maskCtx.lineTo(px, py);
        }
        maskCtx.closePath();
      }
    }
    maskCtx.fill('evenodd'); // even-odd so inner rings (lakes) punch holes

    const px = maskCtx.getImageData(0, 0, S, S).data;
    for (let i = 0; i < S * S; i++) {
      const isLand = px[i * 4 + 3] > 127;
      heights[i] = isLand ? Math.max(heights[i], LAND_LIFT_M) : Math.min(heights[i], WATER_FLOOR_M);
    }
  }

  private _heightmap(heights: Float32Array, level: number): Cesium.HeightmapTerrainData {
    const S = this._samples;
    return new Cesium.HeightmapTerrainData({
      buffer: heights,
      width: S,
      height: S,
      childTileMask: level < this._maxLevel ? 15 : 0,
    });
  }
}

/** Decode a terrarium PNG to full-resolution heights. */
function decodeFull(image: CanvasImageSource): Float32Array {
  scratchCtx.drawImage(image, 0, 0, TILE_PX, TILE_PX);
  const d = scratchCtx.getImageData(0, 0, TILE_PX, TILE_PX).data;
  const out = new Float32Array(TILE_PX * TILE_PX);
  for (let p = 0, k = 0; p < out.length; p++, k += 4) {
    out[p] = d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
  }
  return out;
}

/** An entirely-zero tile means "no data at this zoom", not "flat ground at sea level". */
function isAllZero(full: Float32Array): boolean {
  for (let i = 0; i < full.length; i++) if (full[i] !== 0) return false;
  return true;
}

/** Full-res -> S×S, sampling rows/cols 0..255 inclusive so neighbouring tiles share edges. */
function downsample(full: Float32Array, S: number): Float32Array {
  const out = new Float32Array(S * S);
  for (let j = 0; j < S; j++) {
    const sy = Math.round((j * (TILE_PX - 1)) / (S - 1));
    for (let i = 0; i < S; i++) {
      const sx = Math.round((i * (TILE_PX - 1)) / (S - 1));
      out[j * S + i] = full[sy * TILE_PX + sx];
    }
  }
  return out;
}

function bilinear(full: Float32Array, x: number, y: number): number {
  const x0 = Math.max(0, Math.min(TILE_PX - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(TILE_PX - 1, Math.floor(y)));
  const x1 = Math.min(TILE_PX - 1, x0 + 1);
  const y1 = Math.min(TILE_PX - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = full[y0 * TILE_PX + x0];
  const b = full[y0 * TILE_PX + x1];
  const c = full[y1 * TILE_PX + x0];
  const e = full[y1 * TILE_PX + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
}
