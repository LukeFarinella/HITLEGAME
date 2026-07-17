import { fbm } from '../core/noise';
import { RegionManifest } from './RegionManifest';

/** Samples elevation (meters) at ENU (x,z). The placeholder is procedural; swap for DEM sampling later. */
export interface HeightField {
  readonly halfExtent: number; // meters from center to edge
  readonly seaLevel: number;
  heightAt(x: number, z: number): number;
}

export function createPlaceholderHeightField(m: RegionManifest): HeightField {
  const halfExtent = m.diameterMeters / 2;
  const { min, max } = m.elevation;
  // Feature scale ~tens of km so a 320 km theater reads as mountains + valleys.
  const featureKm = 40;
  const s = 1 / (featureKm * 1000);

  return {
    halfExtent,
    seaLevel: 0,
    heightAt(x, z) {
      const ridged = fbm(x * s + 1000, z * s + 1000, 6);
      // Bias a coastline in from the west edge for visual interest.
      const coast = (x + halfExtent) / (2 * halfExtent); // 0 at west edge -> 1 at east
      const land = Math.max(0, ridged * 1.15 - 0.35 + coast * 0.25);
      return min + land * (max - min);
    },
  };
}
