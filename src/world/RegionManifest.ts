import { LatLon } from '../core/types';

/**
 * Emitted by the offline pipeline (pipeline/build-region.mjs) — describes one baked theater.
 * The runtime loads this instead of hard-coding a region, so "anywhere on Earth" = a new manifest.
 */
export interface RegionManifest {
  center: LatLon;
  diameterMeters: number;
  /** Elevation range used to decode a 16-bit heightmap, in meters. */
  elevation: { min: number; max: number };
  /** Path to a baked heightmap image, or null to use the built-in procedural placeholder. */
  heightmap: string | null;
  /** Terrain samples across the full extent. */
  resolution: number;
  name?: string;
}
