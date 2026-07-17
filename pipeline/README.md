# Offline region pipeline

Turns a `center lat/lon + diameter` into game-ready assets. Runs **once per theater**, entirely
offline, and emits a `manifest.json` (+ eventually a baked `heightmap.png`) that the runtime loads.

## Current state

`build-region.mjs` is a **stub** — it writes a manifest with placeholder elevation, and the runtime
renders procedural terrain from it. The steps below are the real pipeline to implement next.

## Real pipeline (to implement)

Requires [GDAL](https://gdal.org) on the PATH (`gdalwarp`, `gdal_translate`, `gdalbuildvrt`).

1. **Bounding box** — from center + diameter, compute the lat/lon bbox (add ~10% margin).
2. **Elevation** — fetch Copernicus GLO-30 DEM tiles for the bbox (AWS open data:
   `s3://copernicus-dem-30m/`). Merge with `gdalbuildvrt`.
3. **Bathymetry** — fetch the GEBCO grid for the bbox; merge below sea level so coastlines are correct.
4. **Reproject** — `gdalwarp` to a local azimuthal/UTM projection centered on the theater (meters).
5. **Clip to circle** — mask everything outside `diameter/2` meters from center.
6. **Downsample** — resample to `resolution` (e.g. 512 or 1024) for the strategic base layer.
7. **Export** — `gdal_translate` to a 16-bit PNG heightmap; record real `elevation.min/max` in the manifest.
8. *(later)* **OSM layer** — pull roads + building footprints from Overpass for the bbox, emit a road
   graph JSON and building footprints; bake a movement-cost grid (slope + landcover + roads + water).

## Data sources

| Layer        | Source                              | License   |
| ------------ | ----------------------------------- | --------- |
| Elevation    | Copernicus GLO-30 DEM               | permissive |
| Bathymetry   | GEBCO / ETOPO                       | permissive |
| Roads/bldgs  | OpenStreetMap (Overpass / Geofabrik)| ODbL      |
| Landcover    | ESA WorldCover                      | CC-BY     |
