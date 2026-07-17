import { defineConfig } from 'vite';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [cesium()],
  server: {
    port: 5173,
    open: true,
    host: true,
    // allow access via a Cloudflare quick tunnel (random *.trycloudflare.com host)
    allowedHosts: ['.trycloudflare.com'],
    // AWS Terrain Tiles (terrarium: topo + ETOPO/GEBCO bathymetry). The bucket sends no CORS
    // header, so proxy it server-side and the browser can decode the elevation pixels.
    proxy: {
      '/tiles/terrarium': {
        target: 'https://elevation-tiles-prod.s3.amazonaws.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/tiles/, ''),
      },
    },
  },
});
