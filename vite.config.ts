import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  /**
   * Served from the domain root by default. A project-site host (GitHub Pages serves this repo at
   * `/HITLEGAME/`) sets VITE_BASE at build time instead of this being hard-coded, so the same
   * config builds for both a root host and a subpath one.
   */
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 5173,
    open: true,
    host: true,
    // allow access via a Cloudflare quick tunnel (random *.trycloudflare.com host)
    allowedHosts: ['.trycloudflare.com'],
    /**
     * No terrain proxy any more.
     *
     * This used to proxy `/tiles/terrarium/*` to the AWS bucket, because the bucket served no CORS
     * header and the app reads elevation back out of tile pixels. AWS has since enabled CORS on
     * `elevation-tiles-prod` (measured: `Access-Control-Allow-Origin: *`), so tiles are fetched
     * directly — see `terrariumTileUrl` in src/cesium/TerrariumTerrainProvider.ts. That is what
     * makes this a plain static bundle, hostable anywhere with no server-side component.
     */
  },
});
