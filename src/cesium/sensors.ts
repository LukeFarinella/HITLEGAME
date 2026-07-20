import * as Cesium from 'cesium';

/**
 * The obelisk sensor network for a theater.
 *
 * Every obelisk watches a disc of radius `range`. Two questions get asked every frame, both against
 * thousands of obelisks and thousands of units, so both go through a uniform grid instead of an
 * O(obelisks x units) sweep:
 *
 *   - "is this unit seen?"  -> a COVERAGE grid, stamped once with every obelisk's disc. Units
 *      outside it render faint (out of sensor range). O(1) per unit.
 *   - "does this obelisk see an infected unit?" -> a THREAT grid, restamped each frame from the
 *      infected units' discs. An obelisk is alerted if its own cell is threatened, and alerted
 *      obelisks glow red. O(1) per obelisk.
 *
 * Both grids share one geometry keyed on the theater bbox, so a lon/lat maps to the same cell in
 * each.
 */

const DEG = Math.PI / 180;
const mPerLat = 111_320;

/** Grid resolution relative to sensor range — finer gives smoother coverage edges, at more cells. */
const CELL_FRACTION = 0.5;

/** How many airdropped sites a theater can carry on top of its fixed network. */
const DROP_HEADROOM = 64;

/** Faint ring drawn at each obelisk to show its range. Additive, so overlaps read as denser cover. */
const RING_SEGMENTS = 40;
const RING_COLOR = Cesium.Color.fromCssColorString('#E23A2E'); // company red, kept very low alpha
const RING_ALPHA = 0.16;
const RING_LIFT = 25; // metres above the mesh

const RING_VS = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec4 color;
in float batchId;
out vec4 v_color;
void main() {
  v_color = color;
  gl_Position = czm_modelViewProjectionRelativeToEye * czm_computePosition();
}`;
const RING_FS = `
in vec4 v_color;
void main() { out_FragColor = v_color; }`;

export class SensorField {
  private range: number;
  private cell: number;
  private w: number;
  private h: number;
  private w0: number; // bbox west
  private s0: number; // bbox south
  private cosLat: number;
  private coverage: Uint8Array;
  private threat: Uint8Array;
  /**
   * Which obelisk owns each covered cell — the nearest one that stamped it. Built alongside the
   * coverage grid so "which obelisk services this point" is an array index rather than a scan over
   * thousands of sites, which matters when a marked convoy rolls into range all at once.
   */
  private coverOwner: Int32Array;

  private obLon: Float64Array;
  private obLat: Float64Array;
  /** Live site count, including anything airdropped this session. */
  obeliskCount: number;
  /**
   * Sites the theater was built with, before any airdrops.
   *
   * The siege only ever aims at these. An airdropped site has no entry in the campaign's ownership
   * mask, so "this obelisk fell" could not be recorded against it — and a temporary site the player
   * can re-place for pocket change is the wrong thing to be defending anyway.
   */
  readonly fixedCount: number;

  /** Faint range rings, one merged primitive. */
  readonly rings: Cesium.Primitive | undefined;
  /** Red glow points; only alerted obelisks are shown. */
  readonly glow: Cesium.PointPrimitiveCollection;
  private glowPoints: Cesium.PointPrimitive[] = [];
  private shown = new Set<number>();

  constructor(
    lonLat: Float64Array,
    apex: Float64Array,
    range: number,
    bbox: [number, number, number, number],
    heightAt: (lon: number, lat: number) => number,
  ) {
    this.range = range;
    this.obeliskCount = lonLat.length / 2;
    this.fixedCount = this.obeliskCount;
    // Over-allocated so airdrops can be appended without reallocating every time one lands.
    this.obLon = new Float64Array(this.obeliskCount + DROP_HEADROOM);
    this.obLat = new Float64Array(this.obeliskCount + DROP_HEADROOM);
    for (let i = 0; i < this.obeliskCount; i++) {
      this.obLon[i] = lonLat[i * 2];
      this.obLat[i] = lonLat[i * 2 + 1];
    }

    const [w, s, e, n] = bbox;
    this.w0 = w;
    this.s0 = s;
    this.cosLat = Math.max(0.15, Math.cos(((s + n) / 2) * DEG));
    this.cell = range * CELL_FRACTION;
    const spanX = (e - w) * mPerLat * this.cosLat;
    const spanY = (n - s) * mPerLat;
    this.w = Math.max(1, Math.ceil(spanX / this.cell));
    this.h = Math.max(1, Math.ceil(spanY / this.cell));
    this.coverage = new Uint8Array(this.w * this.h);
    this.threat = new Uint8Array(this.w * this.h);
    this.coverOwner = new Int32Array(this.w * this.h).fill(-1);
    const grownApex = new Float64Array((this.obeliskCount + DROP_HEADROOM) * 3);
    grownApex.set(apex.subarray(0, this.obeliskCount * 3));
    this.apex = grownApex;

    this.stampCoverage();

    this.rings = this.buildRings(heightAt);
    this.glow = new Cesium.PointPrimitiveCollection();
    for (let i = 0; i < this.obeliskCount; i++) {
      this.glowPoints.push(
        this.glow.add({
          position: new Cesium.Cartesian3(apex[i * 3], apex[i * 3 + 1], apex[i * 3 + 2]),
          // Yellow: this is the obelisk reporting a suspected contact, not the company acting.
          color: Cesium.Color.fromCssColorString('#F2C13B').withAlpha(0.85),
          pixelSize: 14,
          show: false,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        }),
      );
    }
  }

  private cellX(lon: number): number {
    return Math.floor(((lon - this.w0) * mPerLat * this.cosLat) / this.cell);
  }
  private cellY(lat: number): number {
    return Math.floor(((lat - this.s0) * mPerLat) / this.cell);
  }

  /**
   * Stamp every obelisk's range disc into the coverage grid, recording the nearest owner per cell.
   * Run once at construction.
   */
  private stampCoverage(): void {
    const rCells = Math.ceil(this.range / this.cell);
    const r2 = rCells * rCells;
    const bestD = new Int32Array(this.w * this.h).fill(0x7fffffff);
    for (let i = 0; i < this.obeliskCount; i++) {
      const cx = this.cellX(this.obLon[i]);
      const cy = this.cellY(this.obLat[i]);
      for (let dy = -rCells; dy <= rCells; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= this.h) continue;
        for (let dx = -rCells; dx <= rCells; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= this.w) continue;
          const d = dx * dx + dy * dy;
          if (d > r2) continue;
          const c = y * this.w + x;
          this.coverage[c] = 1;
          if (d < bestD[c]) {
            bestD[c] = d;
            this.coverOwner[c] = i;
          }
        }
      }
    }
  }

  /**
   * A random site in this theater, for the siege director to aim an attacker at. The index is
   * LOCAL to this field; the caller maps it back through ObeliskPyramids.indices to mark the
   * obelisk destroyed in the campaign-wide ownership mask.
   */
  randomSite(): { local: number; lon: number; lat: number } | null {
    if (!this.fixedCount) return null;
    // Fixed sites only — see the note on `fixedCount`.
    const i = Math.floor(Math.random() * this.fixedCount);
    return { local: i, lon: this.obLon[i], lat: this.obLat[i] };
  }

  /**
   * Add a site to the live network, at runtime.
   *
   * Everything the network does is driven by the coverage grid and the apex table, so a site added
   * here inherits ALL of it for free: units inside its disc become visible and orderable, an armed
   * network services contacts from its apex, and it lights up when it sees an infected. There is no
   * separate code path for a dropped site, which is the point — it is an obelisk.
   *
   * Returns the new local index, or -1 if the field is full.
   */
  addSite(lon: number, lat: number, apex: Cesium.Cartesian3): number {
    if (this.obeliskCount >= this.obLon.length) return -1;
    const i = this.obeliskCount++;
    this.obLon[i] = lon;
    this.obLat[i] = lat;
    this.apex[i * 3] = apex.x;
    this.apex[i * 3 + 1] = apex.y;
    this.apex[i * 3 + 2] = apex.z;
    this.stampOne(i);
    this.glowPoints.push(
      this.glow.add({
        position: Cesium.Cartesian3.clone(apex),
        color: Cesium.Color.fromCssColorString('#F2C13B').withAlpha(0.85),
        pixelSize: 14,
        show: false,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      }),
    );
    return i;
  }

  /**
   * Stamp one site's disc into the coverage grid.
   *
   * Claims a cell when it is uncovered, or when this site is nearer than whatever owns it. That
   * second test is what keeps {@link servicingApex} honest after a drop: without it a new site
   * would either never service anything, or would steal cells from an obelisk standing closer.
   */
  private stampOne(i: number): void {
    const rCells = Math.ceil(this.range / this.cell);
    const r2 = rCells * rCells;
    const cx = this.cellX(this.obLon[i]);
    const cy = this.cellY(this.obLat[i]);
    for (let dy = -rCells; dy <= rCells; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= this.h) continue;
      for (let dx = -rCells; dx <= rCells; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= this.w) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const k = y * this.w + x;
        this.coverage[k] = 1;
        const owner = this.coverOwner[k];
        if (owner < 0) {
          this.coverOwner[k] = i;
          continue;
        }
        // Compare in cells against the current owner — same units the initial stamp used.
        const ox = this.cellX(this.obLon[owner]) - x;
        const oy = this.cellY(this.obLat[owner]) - y;
        if (d2 < ox * ox + oy * oy) this.coverOwner[k] = i;
      }
    }
  }

  /** Apex of one site, by local index. Shared scratch — clone it if you need to keep it. */
  apexAt(local: number): Cesium.Cartesian3 | undefined {
    if (local < 0 || local >= this.obeliskCount) return undefined;
    return Cesium.Cartesian3.fromElements(
      this.apex[local * 3],
      this.apex[local * 3 + 1],
      this.apex[local * 3 + 2],
      this.apexScratch,
    );
  }

  /**
   * The SITE watching a point — position, not apex.
   *
   * servicingApex answers "where would a beam come from"; this answers "which installation saw
   * this", which is what a ping needs to be drawn on.
   */
  servicingSite(lon: number, lat: number): { lon: number; lat: number } | null {
    const x = this.cellX(lon);
    const y = this.cellY(lat);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = this.coverOwner[y * this.w + x];
    if (i < 0) return null;
    return { lon: this.obLon[i], lat: this.obLat[i] };
  }

  /** Is a point inside any obelisk's range? */
  isCovered(lon: number, lat: number): boolean {
    const x = this.cellX(lon);
    const y = this.cellY(lat);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    return this.coverage[y * this.w + x] === 1;
  }

  /**
   * The apex of the obelisk covering a point — where a directed-energy beam would originate.
   * Undefined if nothing watches it. Returns a shared scratch, so copy it if you need to keep it.
   */
  private apex: Float64Array;
  private apexScratch = new Cesium.Cartesian3();
  servicingApex(lon: number, lat: number): Cesium.Cartesian3 | undefined {
    const x = this.cellX(lon);
    const y = this.cellY(lat);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return undefined;
    const i = this.coverOwner[y * this.w + x];
    if (i < 0) return undefined;
    return Cesium.Cartesian3.fromElements(
      this.apex[i * 3],
      this.apex[i * 3 + 1],
      this.apex[i * 3 + 2],
      this.apexScratch,
    );
  }

  /**
   * Restamp the threat grid from this frame's infected units and light up the obelisks that now see
   * one. `infected` is a flat [lon,lat,...] array. Returns the alerted obelisk count for the HUD.
   */
  updateThreat(infected: Float64Array, n: number): number {
    this.threat.fill(0);
    // reuse stamp by wrapping the flat array
    const rCells = Math.ceil(this.range / this.cell);
    const r2 = rCells * rCells;
    for (let i = 0; i < n; i++) {
      const cx = this.cellX(infected[i * 2]);
      const cy = this.cellY(infected[i * 2 + 1]);
      for (let dy = -rCells; dy <= rCells; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= this.h) continue;
        for (let dx = -rCells; dx <= rCells; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= this.w) continue;
          if (dx * dx + dy * dy <= r2) this.threat[y * this.w + x] = 1;
        }
      }
    }

    // Toggle only the obelisks whose alert state changed, so the point collection isn't fully
    // rebuilt every frame.
    let alerted = 0;
    const next = new Set<number>();
    for (let i = 0; i < this.obeliskCount; i++) {
      const x = this.cellX(this.obLon[i]);
      const y = this.cellY(this.obLat[i]);
      const on = x >= 0 && y >= 0 && x < this.w && y < this.h && this.threat[y * this.w + x] === 1;
      if (on) {
        alerted++;
        next.add(i);
        if (!this.shown.has(i)) this.glowPoints[i].show = true;
      }
    }
    for (const i of this.shown) if (!next.has(i)) this.glowPoints[i].show = false;
    this.shown = next;
    return alerted;
  }

  private buildRings(heightAt: (lon: number, lat: number) => number): Cesium.Primitive | undefined {
    const count = this.obeliskCount;
    if (!count) return undefined;
    const per = RING_SEGMENTS;
    const positions = new Float64Array(count * per * 3);
    const colors = new Uint8Array(count * per * 4);
    const indices = new Uint32Array(count * per * 2);
    const cr = Math.round(RING_COLOR.red * 255);
    const cg = Math.round(RING_COLOR.green * 255);
    const cb = Math.round(RING_COLOR.blue * 255);
    const ca = Math.round(RING_ALPHA * 255);
    const p = new Cesium.Cartesian3();
    let v = 0;
    let ix = 0;
    for (let i = 0; i < count; i++) {
      const lon0 = this.obLon[i];
      const lat0 = this.obLat[i];
      const dLat = this.range / mPerLat;
      const dLon = this.range / (mPerLat * Math.max(0.15, Math.cos(lat0 * DEG)));
      const first = v;
      for (let k = 0; k < per; k++) {
        const a = (k / per) * Math.PI * 2;
        const lon = lon0 + dLon * Math.cos(a);
        const lat = lat0 + dLat * Math.sin(a);
        Cesium.Cartesian3.fromDegrees(lon, lat, heightAt(lon, lat) + RING_LIFT, undefined, p);
        positions[v * 3] = p.x;
        positions[v * 3 + 1] = p.y;
        positions[v * 3 + 2] = p.z;
        colors[v * 4] = cr;
        colors[v * 4 + 1] = cg;
        colors[v * 4 + 2] = cb;
        colors[v * 4 + 3] = ca;
        v++;
      }
      for (let k = 0; k < per; k++) {
        indices[ix++] = first + k;
        indices[ix++] = first + ((k + 1) % per);
      }
    }

    const geometry = new Cesium.Geometry({
      attributes: {
        position: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.DOUBLE,
          componentsPerAttribute: 3,
          values: positions,
        }),
        color: new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.UNSIGNED_BYTE,
          componentsPerAttribute: 4,
          normalize: true,
          values: colors,
        }),
      } as unknown as Cesium.GeometryAttributes,
      indices,
      primitiveType: Cesium.PrimitiveType.LINES,
      boundingSphere: Cesium.BoundingSphere.fromVertices(Array.from(positions.subarray(0, Math.min(positions.length, 30000)))),
    });

    const appearance = new Cesium.Appearance({
      vertexShaderSource: RING_VS,
      fragmentShaderSource: RING_FS,
      translucent: true,
      closed: false,
      renderState: {
        depthTest: { enabled: true },
        blending: {
          enabled: true,
          equationRgb: Cesium.BlendEquation.ADD,
          equationAlpha: Cesium.BlendEquation.ADD,
          functionSourceRgb: Cesium.BlendFunction.SOURCE_ALPHA,
          functionSourceAlpha: Cesium.BlendFunction.SOURCE_ALPHA,
          functionDestinationRgb: Cesium.BlendFunction.ONE,
          functionDestinationAlpha: Cesium.BlendFunction.ONE,
        },
        depthMask: false,
      },
    });
    // Additive: keep the state we asked for rather than the derived ALPHA_BLEND.
    const rs = appearance.renderState;
    appearance.getRenderState = () => rs;

    return new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({ geometry }),
      appearance,
      asynchronous: false,
    });
  }

  destroy(): void {
    this.glow.destroy();
  }
}
