# HITLGAME — GORGON // SENTINEL C2

A **command & control prototype played on the real Earth**. You orbit a stylized tactical globe,
pick a **200-mile theater** anywhere on the planet, and fly seamlessly down into it — real terrain,
real bathymetry, real borders, rendered as a defense console rather than a photo.

Built on **CesiumJS** (for Google-Earth-style continuous space→ground LOD) with a custom terrain
provider and the **GORGON** brand system.

## Run

Requires **Node 18+**.

```bash
npm install
npm run dev          # http://localhost:5173
npm run dev:lan      # also serve on your LAN (for phone testing)
```

Optional — put a free [Cesium Ion](https://cesium.com/ion) token in `.env` (see `.env.example`):

```
VITE_CESIUM_ION_TOKEN=your_token_here
```

The app runs **without** it. The token only matters if your Ion account has the
**Cesium World Bathymetry** asset, which is preferred when available; otherwise terrain comes from
the free AWS source below.

## The two modes

| Mode | Controls | What's drawn |
| --- | --- | --- |
| **Orbit** | drag orbit · wheel zoom · **click** selects a 200-mi theater | dark globe, 1:50m country borders, graticule, 200-mi cursor ring |
| **Theater / C2** | **LMB free** (reserved for unit marquee) · right/middle-drag pan · wheel zoom · ctrl+middle tilt · **ESC** back to orbit | filled lit terrain + elevation ramp, 10-mi grid, water plane, 1:10m borders + US state lines (clamped) |

Press **`U`** in a theater to cycle a unit stress test (500 → 2,000 → 5,000 → 0). An FPS counter is
shown on screen.

## Terrain

`src/cesium/TerrariumTerrainProvider.ts` — a custom Cesium terrain provider over **AWS Terrain
Tiles** (terrarium-encoded PNGs): SRTM/GMTED land **plus ETOPO1/GEBCO bathymetry** in one global
source, free and with no Ion asset.

Two things worth knowing, both measured:

- **Bathymetry data stops at z10.** Deeper ocean tiles exist but are **all zeros**, not 404s — so
  naively trusting them makes the seabed rise to sea level as you zoom. Tiles that decode to all
  zeros above z10 are rebuilt from their z10 ancestor (bilinear overzoom). Land (data to z14+) is
  unaffected. Verified: Mariana Trench holds ~−10,590 m from z10 through z13.
- **Tiles need the dev proxy.** The S3 bucket sends no CORS header and we read pixels off a canvas,
  so `vite.config.ts` proxies `/tiles/terrarium/*`. **A hosted build would need its own proxy.**

Quality is device-adaptive: phones get 33×33 samples/tile, max level 13, and a 0.75 resolution
scale; desktop gets 65×65 and level 14.

## The coastline is a distance field (`src/cesium/theaterMap.ts`)

The theater is one static mesh, and we get very close to it (min zoom 400 m). Deciding land/water
per **mesh vertex** quantises the coast to the grid — ~300 m cells at 1024 samples — and then
interpolates the colour across each triangle, which is what read as "raster splotchiness" up close.

So the shoreline is **not** in the mesh. The vector land polygons are rasterised to an *antialiased*
coverage mask, converted to a **signed distance field** (Felzenszwalb EDT, tiny-sdf's sub-texel
seeding), uploaded as a texture, and thresholded per-fragment against `fwidth` in the shader.
Distance is linear either side of an edge, so bilinear sampling reconstructs a straight coast
segment *exactly*, and the edge stays ~1 px at any zoom — measured: **one transitional pixel from
1.7 m/px to 115 m/px, a 67× range.** The limit is now the source vectors (Natural Earth 1:10m,
~1 km between points), not our grid. The sea surface is clipped by the same field, so the waterline
is one crisp edge rather than two that disagree.

Three Cesium behaviours cost real time here — all measured, all easy to hit again:

- **`Texture` uploads with `flipY: true` by default**, and `Material` doesn't override it. A canvas
  handed to a material arrives **mirrored vertically**; `gorgon_shoreDistance` flips `st.y` back.
  Skipping it mirrors the coast about the bbox's centre latitude — subtle enough to look almost
  right, and it reads as a *blurry* shoreline (the field's gradient goes wrong, inflating `fwidth`).
- **Custom post-process stages don't get `LOG_DEPTH` defined**, so `czm_readDepth` and
  `czm_windowToEyeCoordinates` hand back the raw log-Z as if it were an NDC depth and every
  fragment reconstructs to ~the far plane. Linearising it first doesn't work either: at theatre
  range the linear NDC depth is ~0.99999, i.e. ~2 significant digits in a float32. Mirror Cesium's
  own `LOG_DEPTH` branch and carry distance-from-camera in `w`. (Symptom when wrong: the rim bokeh
  silently blurs the *entire* scene.)
- **A `Polyline` destroys its own material**, so a `Material` instance may not be shared across
  polylines whose collection gets destroyed — the second `_destroy()` throws "This object was
  destroyed". Sharing buys nothing anyway: `PolylineCollection` buckets by `material.type` and
  groups draw calls by *uniform values*, so N identical `Color` materials still collapse to one
  bucket. Only the orbit border collection (never removed) shares one.

## Nothing exists outside the theater

Selecting a theater kills the globe, sky atmosphere, and fog, and clears the background to black.
The terrain fades to black over the outer 7% of the radius, and border/grid lines are clipped to
the disc (interpolated to the exact boundary, not to the nearest vertex) so nothing hangs in the
void. A custom post-process stage then **defocuses by ground distance from the theater centre** —
not by depth, so the near and far rim blur alike — reconstructing each fragment's world position
and sampling a golden-angle disc kernel. Measured: the rim falls to black over 2 px with the stage
off and 8 px with it on, while interior detail is bit-identical either way.

## Obelisks

Fixed defensive sites — 115,502 of them. `tools/build-obelisks.mjs` pulls the source sheet (an
OpenStreetMap surveillance-camera export: `@lat,@lon,camera:direction`), keeps the points inside
the **US nation polygon** from `us-atlas` — not a lat/lon box, which would swallow Vancouver,
southern Ontario and northern Mexico — dedupes exact sites, and writes `public/obelisks.bin`.
Re-run it to refresh the data:

```bash
node tools/build-obelisks.mjs      # -> public/obelisks.bin (1.4 MB)
```

The format is flat binary (`float32 lon, float32 lat, int16 heading, int16 flags`) because ~115k
records of JSON is megabytes of main-thread parse for no benefit.

One dataset, two renderings, swapped by mode:

- **Orbit — additive heat splats.** Each site is one point, blended `ONE/ONE`, so crowding sums on
  its own and ramps orange → yellow → white. No binning pass, one draw call. Each splat is a bright
  tight **core** plus a dim wide **halo**, because one lobe can't do both jobs: density spans ~4
  orders of magnitude (one site in open country vs ~7,500 inside a city), and a single linear
  gaussian either makes the lone site invisible or blows every metro to flat white. The core says
  "one orange site"; the halo is low enough to sum over hundreds before it clips. `HEAT_DOT` and
  `HEAT_INTENSITY` in `gorgonGlobe.ts` are the two dials.
- **Theater — real geometry.** Every site inside the disc becomes a tall skinny pyramid (150 m on a
  14 m base — Washington Monument proportions), merged into one primitive, sitting on the baked
  terrain via `heightAt`. A city theater holds ~6,000–7,300 of them: SF 6,490 · LA 7,296 ·
  Denver 2,059. Face 0 of each pyramid looks along the site's heading and carries a glowing **eye**
  lens; the apex glows orange — that's where the electrical attack will fire from.

  The shaft is a brand-orange gradient, dark at the base and hot at the tip, and it is **half
  emissive** rather than fully lit. That's legibility, not decoration: at the theater's opening
  altitude a 150 m obelisk is barely a pixel tall, so a purely diffuse body averages into the
  terrain and vanishes. An additive **apex flare** (same splat trick as orbit) finishes the job —
  its contribution scales inversely with zoom, which is exactly where it's needed. Measured orange
  pixels with the flare vs without: **14,217 / 8,065 at 95 km**, 7,163 / 5,769 at 20 km,
  1,103 / 937 at 2 km — and at 95 km the "without" peak was the *red border* colour, i.e. the
  obelisks were contributing essentially no orange at all before.

Two things about the data worth knowing:

- **Only 2,210 sites (1.9%) have a real heading.** The source column is free text — degrees,
  compass letters, `NB`/`EB`, plus ranges (`0-360`, `0;180`) and junk (`Down`, `Flock Raven`).
  Ambiguous values are dropped rather than guessed. The rest get a heading hashed from their own
  coordinates: arbitrary, but stable across reloads, so an obelisk always looks the same way.
  `headingIsReal` marks which is which.
- **No Alaska or Hawaii.** The source has zero sites there, so an Anchorage theater is empty.

## Roads

Real OSM roads, from **OpenFreeMap** (`https://tiles.openfreemap.org`) — free vector tiles, no API
key, and it sends `Access-Control-Allow-Origin: *`, so unlike the terrarium bucket these need no
dev proxy and a hosted build works as-is. Same philosophy as the rest of the theater: fetched once
per theater at a fixed zoom, draped on the baked mesh, never streamed. The fetch runs in parallel
with the terrain build and a road failure is caught — it costs the roads, not the theater.

Desktop pulls **z11** (motorway/trunk/primary/secondary/tertiary; ~7.5 MB over a 200-mi box in
~2 s); phones pull z10 and drop tertiary. z12 would add every residential street for ~14× the
tiles, which at ~320 m/px zoomed out is an unreadable smear. Measured: SF 158,781 segments ·
NY 308,793 · Denver 107,653.

**The tile URL must come from TileJSON.** It carries a dated snapshot
(`/planet/20260621_080001_pt/{z}/{x}/{y}.pbf`); the unversioned path answers **200 with a
zero-byte body** and `X-Ofm-Debug: empty tile` — a silent no-roads failure, not an error. So
`roads.ts` resolves the template at runtime rather than hardcoding a snapshot that will rot.

### Roads are one merged ribbon primitive, not a PolylineCollection

Two constraints pinned this design, both measured rather than assumed:

- **Not a PolylineCollection.** Draping ~27k road lines into one cost **~1,200 ms per frame**;
  hiding that single collection took the same frame to **22.8 ms**. It re-walks every polyline on
  the CPU each update to expand it into screen-space quads — the same per-object trap units and
  borders already avoid. It just doesn't bite until ~27k lines.
- **Not GL lines.** `ALIASED_LINE_WIDTH_RANGE` is **[1,1]** on ANGLE/D3D11 and every other
  mainstream backend, so `PrimitiveType.LINES` can only ever be 1 px.

So each point carries two vertices (side −1/+1) and the **vertex shader** pushes them apart along
the screen-space normal, found by projecting a second point 8 m along the line's tangent. Same
technique `PolylineCollection` uses; the difference is it runs once per vertex on the GPU instead
of once per line per frame on the CPU. **New York, at 308,793 segments, renders in 1.28–1.58 ms** —
roughly 2× flat lines, ~800× the collection.

Width is `max(real metres, a pixel floor)` via `czm_metersPerPixel`, which gives two regimes.
Measured against a lone motorway (real width 32 m) over Altamont Pass:

| altitude | m/px | drawn | implied width | regime |
| --- | --- | --- | --- | --- |
| 4 km | 5.77 | 7 px | 40.4 m | real width |
| 12 km | 17.32 | 2 px | **34.6 m** | real width |
| 60 km | 86.6 | 2 px | 173 m | pixel floor |

At theater scale a motorway is a fourteenth of a pixel, so without the floor the network would
simply vanish; up close the real geometry takes over.

## Buildings

Real OSM footprints, extruded to real heights — but **a core around the theater centre, not the
whole theater**. That isn't a shortcut, it's forced: OpenMapTiles only carries the `building`
layer at **z13–14**, and only z14 has `render_height` (z13 merges every building into one
property-less blob). A 200-mile box at z14 is **~27,900 tiles**. So `BUILDING_RADIUS_M` (6 km
desktop / 3 km mobile) defines an objective core; the rest of the theater stays bare terrain.

**OSM counts every shed, garage and carport**, and that dominates the cost. At a 6 km core SF has
147,689 footprints and NYC 228,732 — ~3M vertices of extrusion. Filtering to real structures
(`>=10 m` tall, `>=150 m²` footprint) keeps the skyline and drops ~85%:

| theater | buildings | triangles | tiles |
| --- | --- | --- | --- |
| New York | 43,521 | 1,107k | 62 |
| San Francisco | 19,430 | 689k | 43 |
| Chicago | 9,709 | 262k | 39 |
| Denver | 4,931 | 192k | 56 |

Two implementation notes worth keeping:

- **OpenFreeMap merges footprints by height.** One "feature" is a whole height class holding a
  MultiPolygon of every building at that height — a single downtown SF z14 tile is 131 features but
  **4,215 buildings**. Iterate the polygons, not the features.
- **Flat shading without duplicate vertices.** The normal is recovered per-fragment from
  `dFdx/dFdy` of the eye-space position, so walls and roof share one bottom ring and one top ring —
  2 vertices per footprint point instead of the 4-per-wall-quad a normal attribute would force.
  That's ~0.9M vertices instead of ~3.5M for a city core. Roofs are `earcut`-ed with hole support;
  verified at **72% coverage** looking straight down at the Financial District (missing roofs would
  show only thin wall slivers).

Ground height is sampled **once per building**, not per vertex: a footprint is tens of metres
across and the terrain mesh is ~300 m per vertex, so per-vertex sampling would only skew something
that should sit level.

With terrain, roads, buildings, obelisks and the rim bokeh all live, a theater renders in
**0.25–0.66 ms**.

## Performance notes (this project expects *thousands* of units)

Cesium's **Entity** system runs a per-entity updater every frame and does not scale. So:

- **Units live in a `PointPrimitiveCollection`** (batched to ~one draw call) — never entities.
  Real units should graduate to a `BillboardCollection`, same principle.
- **Borders are batched primitives**, not entities: a single `PolylineCollection` of 1:50m country
  lines for orbit (state lines are invisible from 16,000 km — not drawn), and only the 1:10m lines
  **inside the theater box** are terrain-clamped. This took entities in data sources from **4,324 →
  0 (orbit) / ~43 (theater)**.

## Layout

```
src/cesium/gorgonGlobe.ts             app entry: viewer, styling, modes, controls, grid, rim bokeh, units
src/cesium/theaterMap.ts              the static theater mesh: elevation, shoreline SDF, sea, shaders
src/cesium/obelisks.ts                obelisk sites: orbit heat splats + theater pyramid geometry
src/cesium/roads.ts                   OSM vector tiles -> one merged shader-expanded ribbon
src/cesium/buildings.ts               OSM footprints -> extruded core around the theater centre
tools/build-obelisks.mjs              sheet -> US-filtered public/obelisks.bin
src/cesium/TerrariumTerrainProvider.ts  custom topo+bathy terrain provider
src/ui/theme.css                      GORGON design tokens + HUD/overlay
brand/guidelines.html                 brand system (published artifact)
brand/globe-preview.html              self-contained canvas globe preview (generated)
tools/build-globe-preview.mjs         generates the preview by inlining real coastline data
```

`window.__gorgon` is exposed in dev only (`Cesium`, `viewer`, `enterTheater`, `exitTheater`,
`spawnUnits`, `mode`) for inspection.

## Data & attribution

| Layer | Source | License |
| --- | --- | --- |
| Terrain + bathymetry | AWS Terrain Tiles (SRTM, GMTED, ETOPO1/GEBCO) | public domain |
| Roads + buildings | OpenStreetMap via [OpenFreeMap](https://openfreemap.org) | ODbL — **OSM attribution required** |
| Obelisk sites | OpenStreetMap (surveillance export) | ODbL — **OSM attribution required** |
| Country borders / coastlines | Natural Earth via `world-atlas` | public domain |
| US state lines | Natural Earth via `us-atlas` | public domain |
| Globe engine | CesiumJS (Apache-2.0) — attribution shown on screen | |

## Status / next

- [x] Stylized Cesium globe, seamless fly-in, 200-mi theater + C2 controls
- [x] Real topo + bathymetry, elevation ramp, grid, water plane
- [x] High-fidelity borders + US state lines, batched for performance
- [ ] Real unit layer (billboards, marquee select, orders) — LMB is reserved for it
- [ ] Live real-world data feeds (aircraft/ships) → contacts
- [ ] Legacy Three.js prototype under `src/{world,globe,render,sim,feeds}` is **dead code**,
      superseded by Cesium — safe to delete once the repo is under version control
