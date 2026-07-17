import * as THREE from 'three';
import { feature } from 'topojson-client';
import land110m from 'world-atlas/land-110m.json';
import { GLOBE_R, lonLatToVec3 } from './geo3d';

const RED = '#E23A2E';
const GUN = '#2B313A';

/** Builds the tactical globe: dark sphere, gunmetal graticule, real red coastlines, faint atmosphere. */
export function buildGlobe(): { group: THREE.Group; sphere: THREE.Mesh } {
  const group = new THREE.Group();
  group.name = 'globe';

  // Solid sphere — the pickable surface and the dark ground.
  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_R, 96, 96),
    new THREE.MeshStandardMaterial({ color: '#0D1013', roughness: 1, metalness: 0 }),
  );
  sphere.name = 'globe-surface';
  group.add(sphere);

  // Faint red atmosphere halo (back-side shell).
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(GLOBE_R * 1.04, 64, 64),
    new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.06, side: THREE.BackSide }),
  );
  group.add(atmo);

  group.add(buildGraticule());
  group.add(buildCoastlines());

  return { group, sphere };
}

/** Lat/lon grid every 15°. */
function buildGraticule(): THREE.LineSegments {
  const pts: number[] = [];
  const push = (lon: number, lat: number) => {
    const v = lonLatToVec3(lon, lat, GLOBE_R * 1.001);
    pts.push(v.x, v.y, v.z);
  };
  // meridians
  for (let lon = -180; lon < 180; lon += 15) {
    for (let lat = -90; lat < 90; lat += 3) { push(lon, lat); push(lon, lat + 3); }
  }
  // parallels
  for (let lat = -75; lat <= 75; lat += 15) {
    for (let lon = -180; lon < 180; lon += 3) { push(lon, lat); push(lon, lat + 3); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: GUN, transparent: true, opacity: 0.5 }));
}

/** Real coastlines from world-atlas land polygons, as one batched LineSegments. */
function buildCoastlines(): THREE.LineSegments {
  const fc = feature(land110m as never, (land110m as never as { objects: { land: never } }).objects.land) as unknown as {
    features: { geometry: { type: string; coordinates: number[][][] | number[][][][] } }[];
  };

  const pts: number[] = [];
  const addRing = (ring: number[][]) => {
    for (let i = 0; i < ring.length - 1; i++) {
      const a = lonLatToVec3(ring[i][0], ring[i][1], GLOBE_R * 1.002);
      const b = lonLatToVec3(ring[i + 1][0], ring[i + 1][1], GLOBE_R * 1.002);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  };
  for (const f of fc.features) {
    const g = f.geometry;
    if (g.type === 'Polygon') {
      (g.coordinates as number[][][]).forEach(addRing);
    } else if (g.type === 'MultiPolygon') {
      (g.coordinates as number[][][][]).forEach((poly) => poly.forEach(addRing));
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.85 }));
}
