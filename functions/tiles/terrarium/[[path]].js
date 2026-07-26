/**
 * Terrain tile proxy — the production half of the Vite dev proxy.
 *
 * The theater's elevation comes from AWS Terrain Tiles (terrarium-encoded PNGs), and that bucket
 * answers 200 with NO `Access-Control-Allow-Origin`. A browser can fetch the bytes but cannot read
 * the pixels, and reading the pixels is the whole point — the heights are encoded in them. So in dev
 * `vite.config.ts` proxies `/tiles/terrarium/*` server-side, and this Function is the same proxy for
 * a deployed build. Both sides keep the identical URL shape, so nothing in `src/` knows or cares
 * which one is serving it (see TerrariumTerrainProvider and theaterMap's tile stitcher).
 *
 * Because this is served from the app's own origin, the response needs no CORS header at all — and
 * deliberately does not get one, so it stays a tile source for this deployment rather than a public
 * one anybody can hotlink.
 *
 * Cloudflare Pages Functions: the `[[path]]` catch-all maps this file to `/tiles/terrarium/*`.
 */

const UPSTREAM = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';

/**
 * `{z}/{x}/{y}.png` and nothing else.
 *
 * This is the difference between a tile proxy and an open relay pointed at S3: without it, any path
 * a caller invents gets forwarded and signed by our origin. Bounded digit counts because z maxes out
 * around 15 here and x/y are bounded by 2^z.
 */
const TILE = /^\d{1,2}\/\d{1,7}\/\d{1,7}\.png$/;

/** Tiles are immutable — the upstream objects were last modified in 2017. Cache them hard. */
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export const onRequestGet = async ({ params }) => {
  const path = Array.isArray(params.path) ? params.path.join('/') : String(params.path ?? '');
  if (!TILE.test(path)) {
    return new Response('expected {z}/{x}/{y}.png\n', {
      status: 400,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const upstream = await fetch(`${UPSTREAM}/${path}`, {
    // Let Cloudflare's edge hold the tile, so a busy theater doesn't re-fetch S3 per viewer.
    cf: { cacheEverything: true, cacheTtl: 86400 },
  });

  if (!upstream.ok) {
    // Off the edge of the coverage, or upstream having a bad day. Pass the status through so the
    // stitcher can treat a missing tile as flat ground rather than as a decode failure.
    return new Response(`tile unavailable (${upstream.status})\n`, {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const headers = new Headers();
  headers.set('content-type', 'image/png');
  headers.set('cache-control', CACHE_CONTROL);
  return new Response(upstream.body, { status: 200, headers });
};
