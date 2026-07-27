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
    // AWS Terrain Tiles (terrarium: topo + ETOPO/GEBCO bathymetry), proxied server-side so the
    // browser can decode the elevation pixels. The bucket now sends CORS headers and a BUILT bundle
    // reads it directly (see `terrariumTileUrl`) — but local dev keeps going through here, because
    // this is the path that has always worked and the dev loop shouldn't depend on someone else's
    // CORS policy staying put.
    proxy: {
      '/tiles/terrarium': {
        target: 'https://elevation-tiles-prod.s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tiles/, ''),
      },
    },
  },
});
