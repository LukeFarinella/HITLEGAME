import * as THREE from 'three';
import { HeightField } from './HeightField';

const GRASS = new THREE.Color('#3f5d34');
const ROCK = new THREE.Color('#5c5347');
const SNOW = new THREE.Color('#dfe6ea');
const SAND = new THREE.Color('#b7a77c');

function colorFor(height: number, slope: number, seaLevel: number, maxH: number): THREE.Color {
  if (height < seaLevel + 15) return SAND.clone();
  const snowLine = maxH * 0.62;
  if (height > snowLine) return SNOW.clone();
  const c = GRASS.clone().lerp(ROCK, THREE.MathUtils.clamp(slope * 2.2, 0, 1));
  if (height > snowLine * 0.8) c.lerp(SNOW, (height - snowLine * 0.8) / (snowLine * 0.2));
  return c;
}

export interface TerrainOptions {
  extent: number; // full width in meters (diameter)
  chunks: number; // chunks per side
  segments: number; // segments per chunk
  maxHeight: number;
}

/**
 * Chunked, vertex-colored displaced terrain. A single LOD for now — the chunk grid is the seam
 * where quadtree/clipmap streaming plugs in later.
 */
export function buildTerrain(field: HeightField, opts: TerrainOptions): THREE.Group {
  const group = new THREE.Group();
  group.name = 'terrain';
  const chunkSize = opts.extent / opts.chunks;
  const half = opts.extent / 2;

  for (let cz = 0; cz < opts.chunks; cz++) {
    for (let cx = 0; cx < opts.chunks; cx++) {
      const geo = new THREE.PlaneGeometry(chunkSize, chunkSize, opts.segments, opts.segments);
      geo.rotateX(-Math.PI / 2); // lay flat on XZ, y up
      const ox = -half + (cx + 0.5) * chunkSize;
      const oz = -half + (cz + 0.5) * chunkSize;

      const pos = geo.attributes.position as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      const eps = chunkSize / opts.segments;

      for (let i = 0; i < pos.count; i++) {
        const wx = ox + pos.getX(i);
        const wz = oz + pos.getZ(i);
        const h = field.heightAt(wx, wz);
        pos.setY(i, h);

        const hx = field.heightAt(wx + eps, wz) - field.heightAt(wx - eps, wz);
        const hz = field.heightAt(wx, wz + eps) - field.heightAt(wx, wz - eps);
        const slope = Math.sqrt(hx * hx + hz * hz) / (2 * eps);
        const col = colorFor(h, slope, field.seaLevel, opts.maxHeight);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;
      }

      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.computeVertexNormals();

      const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, 0, oz);
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
  return group;
}
