export interface LatLon {
  lat: number;
  lon: number;
}

/** Local metric coordinates (meters). Elevation (y) is resolved separately via the HeightField. */
export interface Enu {
  x: number; // east
  z: number; // north maps to -z (away from a top-down camera)
}
