import * as THREE from 'three';
import { Contact } from './Contact';

const MATS: Record<string, THREE.Material> = {
  aircraft: new THREE.MeshStandardMaterial({ color: '#e2e8f0', emissive: '#93c5fd', emissiveIntensity: 0.3 }),
  ship: new THREE.MeshStandardMaterial({ color: '#fca5a5', emissive: '#7f1d1d', emissiveIntensity: 0.2 }),
  default: new THREE.MeshStandardMaterial({ color: '#fcd34d' }),
};

/**
 * The decoupling layer: maps feed data -> game representation. Retune gameplay here (unit type,
 * faction, model) without touching the feed adapters. Markers are deliberately oversized so a
 * single contact is visible on a 320 km map.
 */
export function applySpawnRules(c: Contact): THREE.Object3D {
  const mat = MATS[c.type] ?? MATS.default;
  const geo =
    c.type === 'ship'
      ? new THREE.BoxGeometry(1200, 300, 400)
      : new THREE.ConeGeometry(600, 1800, 4);
  const mesh = new THREE.Mesh(geo, mat);
  if (c.type !== 'ship') mesh.rotation.x = Math.PI / 2; // point the cone along heading
  return mesh;
}
