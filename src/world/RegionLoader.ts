import * as THREE from 'three';
import { RegionManifest } from './RegionManifest';
import { createPlaceholderHeightField, HeightField } from './HeightField';
import { buildTerrain } from './Terrain';
import { GeoTransform } from '../core/geo';

export interface Region {
  manifest: RegionManifest;
  geo: GeoTransform;
  field: HeightField;
  group: THREE.Group; // terrain + water
}

/**
 * Builds a renderable + queryable region from a height field. Pass a real (tile-backed) field, or
 * omit it to use the procedural placeholder. `maxHeight` drives terrain coloring (snow line etc.).
 */
export function loadRegion(manifest: RegionManifest, field?: HeightField, maxHeight?: number): Region {
  const geo = new GeoTransform(manifest.center);
  const hf = field ?? createPlaceholderHeightField(manifest);
  const topH = maxHeight ?? manifest.elevation.max;

  const group = new THREE.Group();
  group.name = 'region';

  group.add(
    buildTerrain(hf, {
      extent: manifest.diameterMeters,
      chunks: 8,
      segments: 64,
      maxHeight: topH,
    }),
  );

  // Sea-level water disc clipped to the circular theater.
  const waterGeo = new THREE.CircleGeometry(manifest.diameterMeters / 2, 96);
  waterGeo.rotateX(-Math.PI / 2);
  const water = new THREE.Mesh(
    waterGeo,
    new THREE.MeshStandardMaterial({ color: '#1c3a5e', transparent: true, opacity: 0.72, roughness: 0.3, metalness: 0.1 }),
  );
  water.position.y = hf.seaLevel;
  water.name = 'water';
  group.add(water);

  return { manifest, geo, field: hf, group };
}
