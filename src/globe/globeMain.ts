import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildGlobe } from './Globe';
import { GLOBE_R, kmToWorldRadius, vec3ToLonLat, MILE_KM } from './geo3d';
import { bootGame } from '../main';
import { RegionManifest } from '../world/RegionManifest';

const SELECT_RADIUS_MI = 20; // cursor ring radius
const THEATER_DIAMETER_MI = SELECT_RADIUS_MI * 2; // loaded map span

const app = document.getElementById('app')!;
const ui = document.getElementById('globe-ui')!;
const latEl = document.getElementById('g-lat')!;
const lonEl = document.getElementById('g-lon')!;

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor('#0B0C0E');
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 1, GLOBE_R * 20);
camera.position.set(GLOBE_R * 0.4, GLOBE_R * 0.9, GLOBE_R * 2.4);

scene.add(new THREE.HemisphereLight('#c8d4e0', '#10151c', 0.9));
const key = new THREE.DirectionalLight('#fff4e6', 1.4);
key.position.set(-1, 0.6, 1).multiplyScalar(GLOBE_R);
scene.add(key);

const { group: globe, sphere } = buildGlobe();
scene.add(globe);

// ---- cursor ring: true-scale 20-mile circle laid on the surface ----
const ringRadius = kmToWorldRadius(SELECT_RADIUS_MI * MILE_KM);
const cursor = new THREE.Group();
cursor.visible = false;
{
  const seg = 64;
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * ringRadius, Math.sin(a) * ringRadius, 0));
  }
  const ring = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: '#E23A2E' }),
  );
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(ringRadius * 0.09, 12, 12),
    new THREE.MeshBasicMaterial({ color: '#E23A2E' }),
  );
  cursor.add(ring, dot);
}
scene.add(cursor);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = false;
controls.minDistance = GLOBE_R * 1.04;
controls.maxDistance = GLOBE_R * 4;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.9;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.18;
// LMB free for selection; RMB-hold and middle-drag pan (rotate); wheel zooms.
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.ROTATE } as never;

// ---- picking ----
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hit: THREE.Vector3 | null = null;

function pick(clientX: number, clientY: number): THREE.Vector3 | null {
  ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(sphere, false);
  return hits.length ? hits[0].point.clone() : null;
}

const up = new THREE.Vector3(0, 0, 1);
const q = new THREE.Quaternion();

renderer.domElement.addEventListener('pointermove', (e) => {
  hit = pick(e.clientX, e.clientY);
  if (hit) {
    const n = hit.clone().normalize();
    q.setFromUnitVectors(up, n);
    cursor.quaternion.copy(q);
    cursor.position.copy(n.multiplyScalar(GLOBE_R * 1.003));
    cursor.visible = true;
    const ll = vec3ToLonLat(hit);
    latEl.textContent = fmt(ll.lat, 'N', 'S');
    lonEl.textContent = fmt(ll.lon, 'E', 'W');
  } else {
    cursor.visible = false;
    latEl.textContent = '—';
    lonEl.textContent = '—';
  }
});

// LMB click (not drag) selects & loads.
let downX = 0;
let downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 0) { downX = e.clientX; downY = e.clientY; }
  controls.autoRotate = false;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // was a drag
  const p = pick(e.clientX, e.clientY);
  if (p) deploy(vec3ToLonLat(p));
});

function fmt(v: number, pos: string, neg: string): string {
  return `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`;
}

// ---- transition to the in-game theater ----
let running = true;
function deploy(center: { lat: number; lon: number }): void {
  running = false;
  const manifest: RegionManifest = {
    name: `${fmt(center.lat, 'N', 'S')} ${fmt(center.lon, 'E', 'W')}`,
    center,
    diameterMeters: Math.round(THEATER_DIAMETER_MI * MILE_KM * 1000),
    elevation: { min: -500, max: 4000 },
    heightmap: null,
    resolution: 512,
  };
  ui.classList.add('dismiss');
  // tear down the globe renderer before the game mounts its own
  renderer.domElement.remove();
  renderer.dispose();
  setTimeout(() => ui.remove(), 500);
  bootGame(manifest);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function frame() {
  if (!running) return;
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
