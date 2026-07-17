import { GeoTransform } from '../core/geo';
import { RegionManifest } from './RegionManifest';
import { HeightField } from './HeightField';
import { loadElevationGrid } from './terrainTiles';

/** Vertical exaggeration — real relief over a 64 km span is subtle; a little lift reads better. */
const EXAGGERATION = 1.5;

export interface RealHeightField extends HeightField {
  readonly min: number;
  readonly max: number;
  readonly zoom: number;
  readonly tiles: number;
}

/**
 * Loads real elevation tiles for the manifest's theater and exposes them as a HeightField in ENU
 * meters. Converts each (x,z) sample back to lat/lon via the region's GeoTransform, then bilinearly
 * samples the stitched grid. Throws if tiles can't be fetched (caller falls back to placeholder).
 */
export async function createTileHeightField(manifest: RegionManifest): Promise<RealHeightField> {
  const geo = new GeoTransform(manifest.center);
  const grid = await loadElevationGrid(manifest.center, manifest.diameterMeters);

  return {
    halfExtent: manifest.diameterMeters / 2,
    seaLevel: 0,
    min: grid.min * EXAGGERATION,
    max: grid.max * EXAGGERATION,
    zoom: grid.zoom,
    tiles: grid.tiles,
    heightAt(x, z) {
      const { lat, lon } = geo.toLatLon({ x, z });
      return grid.sample(lat, lon) * EXAGGERATION;
    },
  };
}
