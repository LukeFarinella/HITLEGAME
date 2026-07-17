import * as THREE from 'three';
import { loadRegion } from './world/RegionLoader';
import { RegionManifest } from './world/RegionManifest';
import { HeightField } from './world/HeightField';
import { createTileHeightField } from './world/TileHeightField';
import { createRTSCamera } from './render/RTSCamera';
import { EventBus } from './feeds/EventBus';
import { MockFeedSource } from './feeds/MockFeedSource';
import { SimWorld } from './sim/World';

/** Boot the SENTINEL C2 view for a theater. Fetches real elevation; falls back to procedural. */
export async function bootGame(manifest: RegionManifest): Promise<void> {
  const app = document.getElementById('app')!;
  const hud = document.getElementById('hud')!;
  const loading = showLoading(manifest);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor('#0B0C0E');
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog('#0B0C0E', manifest.diameterMeters * 0.4, manifest.diameterMeters * 1.6);

  const sun = new THREE.DirectionalLight('#fff4e6', 2.2);
  sun.position.set(-1, 1.4, -0.6).multiplyScalar(manifest.diameterMeters);
  scene.add(sun);
  scene.add(new THREE.HemisphereLight('#9fbfe6', '#20303f', 0.6));

  // Real elevation tiles, with graceful fallback to the procedural placeholder.
  let field: HeightField | undefined;
  let maxHeight: number | undefined;
  let src: string;
  try {
    const real = await createTileHeightField(manifest);
    field = real;
    maxHeight = real.max;
    src = `DEM · z${real.zoom} · ${real.tiles} tiles`;
    manifest.elevation = { min: Math.min(real.min, 0), max: real.max };
  } catch {
    src = 'PROCEDURAL (tiles unavailable)';
  }

  const region = loadRegion(manifest, field, maxHeight);
  scene.add(region.group);
  loading.remove();

  const { camera, controls } = createRTSCamera(renderer.domElement, manifest.diameterMeters);
  const sim = new SimWorld(region.group);

  const bus = new EventBus(manifest.center, manifest.diameterMeters / 2, region.geo, region.field, region.group);
  bus.add(new MockFeedSource(manifest.center, manifest.diameterMeters / 2));

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const clock = new THREE.Clock();
  function frame() {
    const dt = clock.getDelta();
    controls.update();
    sim.update(dt);
    renderer.render(scene, camera);

    const camKm = (camera.position.distanceTo(controls.target) / 1000).toFixed(0);
    hud.innerHTML =
      `<span class="co">G<b>O</b>RGON // SENTINEL</span>\n` +
      `<span class="k">THEATER</span> <span class="v">${manifest.name ?? '—'}</span>\n` +
      `<span class="k">SPAN</span> <span class="v">${(manifest.diameterMeters / 1000).toFixed(0)} KM</span> · <span class="k">CAM</span> <span class="v">${camKm} KM</span>\n` +
      `<span class="k">SRC</span> <span class="v">${src}</span>\n` +
      `<span class="k">FEED</span> <span class="v">MOCK</span> · AIR + SURFACE`;

    requestAnimationFrame(frame);
  }
  frame();
}

/** Brief branded loading overlay shown while elevation tiles fetch. */
function showLoading(manifest: RegionManifest): HTMLElement {
  const el = document.createElement('div');
  el.id = 'loading';
  el.innerHTML =
    `<div class="spin"></div>` +
    `<div class="ll">LOADING THEATER</div>` +
    `<div class="lc">${manifest.name ?? ''} · fetching elevation…</div>`;
  document.body.appendChild(el);
  return el;
}
