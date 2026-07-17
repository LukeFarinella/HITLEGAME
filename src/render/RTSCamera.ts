import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';

/** RTS/strategic camera: drag to pan, right-drag to orbit, wheel to zoom between strategic and tactical range. */
export function createRTSCamera(dom: HTMLElement, extent: number) {
  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 10, extent * 4);
  camera.position.set(0, extent * 0.5, extent * 0.5);

  const controls = new MapControls(camera, dom);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49; // don't dip under the ground
  controls.minDistance = 500;
  controls.maxDistance = extent * 1.5;
  controls.screenSpacePanning = false;
  // Match the globe scheme: RMB-hold / middle-drag pan, wheel zoom, LMB free for marquee select.
  controls.enableRotate = false;
  controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN } as never;

  return { camera, controls };
}
