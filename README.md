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

Raw OSM road geometry is sparse and angular, so before rendering each polyline is smoothed with
**two iterations of Chaikin corner-cutting** (`chaikin()` in `roads.ts`) — endpoints stay fixed so
roads still meet exactly at their intersection nodes, but bends round into clean curves (158k → 677k
segments for an SF theater). Units route on the smoothed geometry too, so they follow the curves.

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

## Buildings (procedural, from road density)

Buildings are **generated procedurally from the real road network** (`procBuildings.ts`), not
fetched. Real OSM footprints turned out too sparse and geographically uneven — z14 only covers a
small core, and a downtown returns ~5k big highrises with nothing between them. **Road density is a
far better signal for where a city is,** and we already have the full real road graph across the
theater.

How it works:

- **Density field.** Rasterise every road segment's length into a ~300 m grid, weighted by class
  (local streets count full; freeways less, since they run *between* cities). `sqrt`-normalised so a
  whole district reads as urban, not just the single peak cell.
- **Line the streets.** For each cell, seed candidates in proportion to density, snap each to
  **front the nearest road** (near edge ~11 m off the centreline, footprint extending into the
  block, long axis along the street). This lines every road and leaves the roadway clear — so
  traffic shows *between* the buildings instead of boxes landing on the road.
- **Scale with density.** Footprints grow (20→60 m) and heights rise (14→85 m, with a tower tail up
  to 230 m) toward the core; suburbs get small low-rises; the countryside stays bare. A spatial-hash
  reject stops overlaps.
- **Coverage + cap.** Generated out to a metro radius (26 km desktop / 14 km mobile) — density
  self-limits the rural remainder — with a hard cap (120k desktop / 35k mobile), densest cells
  filled first. Seattle yields **~93k buildings**; arrival building coverage went from 0.4% (real
  footprints) to **11.3%**, street-level nadir to **17.6%**, while roads stay clearly visible
  between them (~124k road px at street zoom). 74 fps arrival / ~45 fps at street level.

The footprints feed the **same extruder and progressive chunked renderer** as before — the generator
only swaps the source, so all the rendering carries over:

- **Progressive chunks.** `buildBuildings` emits one primitive per ~3,000 buildings via a callback,
  each added to the scene as it's ready, so the skyline visibly fills in from ~1 s instead of a 9 s
  blank pop. A staleness check aborts a build the user has left.
- **Flat shading without duplicate vertices.** The normal is recovered per-fragment from `dFdx/dFdy`
  of the eye-space position, so walls and roof share one bottom ring and one top ring — 2 vertices
  per footprint point. Roofs are `earcut`-ed. Coordinate conversion is inlined (skipping
  `Cesium.Cartesian3.fromDegrees`' per-call scratch); indices go straight into preallocated typed
  arrays.
- Ground height is sampled **once per building**, not per vertex (a footprint is tens of metres
  across; the terrain mesh is ~300 m per vertex).

The fly-in **frames the city obliquely** (`flyToBoundingSphere` at the centre, ~7.5 km / −38°) so you
arrive to a skyline rather than at theater-overview height where real-scale buildings are sub-pixel.

Tradeoff: these aren't *real* footprints — it's a procedural city. But it's dense everywhere there's
a real street grid, which is what reads as a city and what the real data couldn't deliver. (The old
OSM path still lives in `buildings.ts::fetchBuildings`, now unused.)

## Units

Live units — land / sea / air / foot — each a procedural low-poly model, moving every frame.
They're **GPU-instanced**: the model mesh uploads once and a per-instance buffer (position +
heading + scale + state colour) is rewritten each frame, so all units of a kind draw in one
`drawElementsInstanced` call. Everything else in the theater bakes static geometry once; units
can't, and the two other options don't fit — a `Primitive` can't be rebuilt per frame (shader
compile, async upload) and Entities charge a per-entity updater. So the unit layer drops below
Cesium's Primitive/Appearance abstraction to the renderer classes it exposes but doesn't type
(`DrawCommand`, `VertexArray`, `Buffer`, `ShaderProgram`) — see `instancedModels.ts`.

Positions are ECEF (millions of metres, past float32), so each is split high/low and reassembled
relative to the eye in the vertex shader — the same trick Cesium's own geometry uses. The model's
local vertices stay in metres and are placed in an ENU frame the shader builds from the instance's
own direction, so a unit sits level and faces its heading anywhere on the globe.

- **Land + foot** route the **real road graph**. `units.ts` turns the fetched road polylines into
  a graph — endpoints within ~1 m are one node (OSM splits ways at intersections, so shared
  endpoints are how roads connect) — giving ~33k edges / ~53k nodes for an SF theater. At each
  junction a unit takes the **straightest continuation, biased toward bigger roads** (not a random
  turn), so traffic flows *through* interchanges instead of meandering and backtracking — the
  median unit covers 786 m of a possible 814 m over 10 s. Vehicles spawn 45% on freeways and
  straightest-continuation keeps them there (~56% ride motorways/trunks), giving a constant stream
  on the highways; pedestrians stay on surface streets. Spawns are length-weighted so long roads
  carry proportionally more traffic and units don't pile onto tiny stubs.
- **Sea** units spawn only where the baked terrain is below water and wander, turning away from
  shore and the theater rim. **Air** units fly waypoints above the ground.
- **States** are orthogonal to kind: every unit is `normal` / `protected` / `infected`, shown
  **white / yellow / red** as a per-instance colour (verified by forcing each state: 483 red /
  495 yellow / 477 white px). Seeded ~70/20/10. `I` in a theater sweeps the infection wider so the
  red state is easy to watch — a stand-in until a real contagion sim lands on top of this field.

**5,770 units** (2500 land · 3000 foot · 150 sea · 120 air; ~1/3 that on mobile) with terrain,
roads, buildings and the sensor network all live render in **~9 ms** at a downtown zoom. The sim
steps in `scene.preUpdate` on real wall-clock dt, clamped to 0.1 s so a backgrounded tab doesn't
teleport everyone. States seed ~90% normal / ~5% protected / ~5% infected.

## Sensor network (`sensors.ts`)

Every obelisk watches a disc (`SENSOR_RANGE_M`, 750 m) shown as a faint additive ring, and that
drives two things — unit visibility and obelisk alerts. Both are relations between thousands of
obelisks and thousands of units, so neither is an O(obelisks × units) sweep; both go through one
uniform grid keyed on the theater bbox:

- **Unit visibility** — a **coverage** grid, stamped once with every obelisk's disc. A unit outside
  it is out of sensor range and renders at **30% opacity** (a stand-in for fog of war — units may
  be culled entirely later). O(1) per unit. Verified by the instance alpha: ships offshore come out
  99% faint (obelisks are land sensors), rural air units mostly faint, metro land/foot ~70% seen.
- **Obelisk alerts** — a **threat** grid, restamped each frame from the *infected* units' discs. An
  obelisk whose cell is threatened is seeing an infected unit and **glows red** (a
  `PointPrimitiveCollection` where only alerted apexes are shown, toggling just the per-frame
  delta). Verified at 750 m: 167 infected light ~334 obelisks (~5% of the network); the `I` sweep
  raises both together.

`SENSOR_RANGE_M` tunes the whole feel — at 750 m a few obelisks light up per infected unit; the
alert count scales with range² (1500 m alerted ~4× as many).

**Known gaps (next pass):** the marquee-select box still targets the old point-unit collection, not
the instanced units — it needs re-pointing. Units are a fixed size, so they're clear at a tactical
zoom (a few km) but sub-pixel from the 95 km entry view; a screen-space size floor (like the road
ribbons already have) would fix that. And "infected" is still a colour + the `I` demo sweep, not yet
a real contagion sim — but the state field and threat grid are exactly what one would build on.

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
src/cesium/procBuildings.ts           procedural city from road density (footprints + heights)
src/cesium/buildings.ts               footprint extruder + progressive chunked renderer
src/cesium/instancedModels.ts         GPU-instanced model batch (custom DrawCommand)
src/cesium/unitModels.ts              procedural low-poly unit meshes (land/sea/air/foot)
src/cesium/units.ts                   unit sim: road-graph routing, wander, states, opacity
src/cesium/sensors.ts                 obelisk sensor grid: coverage, threat/alerts, range rings
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
