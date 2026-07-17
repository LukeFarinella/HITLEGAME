import * as THREE from 'three';
import { LatLon } from '../core/types';

/** Scene radius of the globe (world units). */
export const GLOBE_R = 100;
export const EARTH_KM = 6371;

const DEG = Math.PI / 180;

/** lon/lat (degrees) -> point on a sphere of radius r. Inverse of vec3ToLonLat — keep them in sync. */
export function lonLatToVec3(lon: number, lat: number, r: number = GLOBE_R, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = lat * DEG;
  const theta = lon * DEG;
  const cp = Math.cos(phi);
  return out.set(r * cp * Math.cos(theta), r * Math.sin(phi), -r * cp * Math.sin(theta));
}

/** Point on the globe -> lon/lat (degrees). */
export function vec3ToLonLat(v: THREE.Vector3): LatLon {
  const r = v.length();
  const lat = Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)) / DEG;
  const lon = Math.atan2(-v.z, v.x) / DEG;
  return { lat, lon };
}

/** World-unit radius of a circle of `km` ground radius on the globe surface. */
export function kmToWorldRadius(km: number): number {
  return GLOBE_R * Math.sin(km / EARTH_KM);
}

export const MILE_KM = 1.609344;
