import { LatLon, Enu } from './types';

const M_PER_DEG_LAT = 111_320;

/**
 * Local East-North-Up projection around a center point. Accurate enough for a ~320 km theater;
 * every world/sim/feed coordinate lives in this metric space so there is no globe math at runtime.
 */
export class GeoTransform {
  readonly center: LatLon;
  private readonly mPerLon: number;

  constructor(center: LatLon) {
    this.center = center;
    this.mPerLon = M_PER_DEG_LAT * Math.cos((center.lat * Math.PI) / 180);
  }

  toEnu(p: LatLon): Enu {
    return {
      x: (p.lon - this.center.lon) * this.mPerLon,
      z: -(p.lat - this.center.lat) * M_PER_DEG_LAT,
    };
  }

  toLatLon(e: Enu): LatLon {
    return {
      lat: this.center.lat - e.z / M_PER_DEG_LAT,
      lon: this.center.lon + e.x / this.mPerLon,
    };
  }
}

/** Great-circle distance in meters — used to clip contacts to the circular theater. */
export function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
