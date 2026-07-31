import * as Cesium from 'cesium';
import type { RoadNet } from './roads';
import { InstancedModelBatch } from './instancedModels';
import {
  dataCenterMesh, roboticsMesh, acquisitionsMesh, harborMesh, skyhookMesh, techMesh, aviationMesh,
  specialMesh, turretMesh, flakMesh, generatorMesh, residenceMesh,
} from './unitModels';
import {
  STRUCTURES,
  BUILD_RULES,
  metresBetween,
  type Structure,
  type StructureType,
} from '../game/rts/structures';

/**
 * The RTS build layer — everything you see while constructing a base, and the geometry tests that
 * decide where you may.
 *
 * It renders three things the campaign never needed: dim markers at every surveyed obelisk SITE (so
 * you can see where an obelisk may go), a marker + footprint ring for each FACILITY you've built, and
 * a live placement GHOST that turns red where a spot is illegal. It also owns a coarse road-occupancy
 * grid, because "near a road" has to be answered every mouse-move and scanning 30k polylines each
 * frame is not that.
 *
 * Obelisks themselves are NOT drawn here — they ride the existing obelisk-pyramid + sensor rebuild in
 * the scene, so a built obelisk is a real network site with coverage and servicing for free. This
 * layer only draws the facilities and the build affordances around them.
 */

const mPerLat = 111_320;
const DEG = Math.PI / 180;

/**
 * Millstone's colour, for everything of theirs on the map.
 *
 * The same green the enemy Nexus marker has always worn. Whose a building is outranks what it is:
 * "is that mine" is the first question anyone asks of a structure on this map, and a Millstone
 * generator in the player's yellow would be answering the second question first.
 */
const HOSTILE = Cesium.Color.fromCssColorString('#3FBF6F');

/** One placed building in a mesh batch. `foe` is what makes it wear Millstone's colour. */
interface FacilityInstance {
  id: number;
  lon: number;
  lat: number;
  foe?: boolean;
}

/** A surveyed obelisk position: where an obelisk MAY be built. */
export interface BuildSite {
  index: number; // global obelisk index
  lon: number;
  lat: number;
}

/** Colour per facility type — steel-blue economy/tech, warmer for the unit factories. */
const FACILITY_COLOR: Record<StructureType, string> = {
  nexus: '#E23A2E',
  obelisk: '#E23A2E',
  robotics: '#E7A13B',
  acquisitions: '#D9C24A',
  harbor: '#3F8FA0',
  skyhook: '#8FD8F0',
  aviation: '#3FA0E0',
  tech: '#8B6FE0',
  supply: '#3FBF6F',
  special: '#E0553F',
  turret: '#C9CDD2',
  flak: '#9AA6C4',
  generator: '#C4E04A',
  residence: '#8FBF6F',
};

/** A short glyph per facility, drawn into the billboard so a base reads at a glance. */
const FACILITY_GLYPH: Record<StructureType, string> = {
  nexus: '◈',
  obelisk: '▲',
  robotics: 'R',
  acquisitions: 'A',
  harbor: 'H',
  skyhook: 'K',
  aviation: 'V',
  tech: 'T',
  supply: 'D',
  special: 'S',
  turret: 'G',
  flak: 'F',
  generator: 'P',
  residence: 'B',
};

/** The facilities that render as a 3D building. Obelisks/the Nexus render as obelisk geometry. */
type FacilityType =
  | 'supply' | 'robotics' | 'acquisitions' | 'harbor' | 'skyhook' | 'tech' | 'aviation' | 'special'
  | 'turret' | 'flak' | 'generator' | 'residence';
const FACILITY_TYPES: FacilityType[] = [
  'supply', 'robotics', 'acquisitions', 'harbor', 'skyhook', 'tech', 'aviation', 'special',
  'turret', 'flak', 'generator', 'residence',
];
/** Built once at module load — one shared mesh per facility type. */
const FACILITY_MESH: Record<FacilityType, ReturnType<typeof dataCenterMesh>> = {
  supply: dataCenterMesh(),
  robotics: roboticsMesh(),
  acquisitions: acquisitionsMesh(),
  harbor: harborMesh(),
  skyhook: skyhookMesh(),
  tech: techMesh(),
  aviation: aviationMesh(),
  special: specialMesh(),
  turret: turretMesh(),
  flak: flakMesh(),
  generator: generatorMesh(),
  residence: residenceMesh(),
};
/** Per-type mesh scale so each building reads at theater zoom. */
// The skyhook is scaled DOWN relative to the others because its mesh is already ~130 m tall before
// scale; at 2.4 it would tower absurdly over a city rather than impressively.
// The two defences are scaled UP relative to their mesh, not down: they are small objects that
// still have to be findable on a 320 km disc.
const FACILITY_SCALE: Record<FacilityType, number> = { supply: 2.4, robotics: 2.4, acquisitions: 2.4, harbor: 2.4, skyhook: 1.6, tech: 2.6, aviation: 2.4, special: 2.5, turret: 3.6, flak: 3.4, generator: 2.6, residence: 2.4 };
const isFacilityType = (t: StructureType): t is FacilityType => (FACILITY_TYPES as StructureType[]).includes(t);

/**
 * A coarse spatial index of road vertices, so "is this point near a road" is a handful of cell
 * lookups instead of a full scan. Cells are sized to the road-distance rule; a query tests the true
 * metric distance against vertices in the 3×3 neighbourhood, so the answer is exact, not just cell
 * resolution.
 */
class RoadGrid {
  private cells = new Map<string, number[][]>();
  private cellLat: number;
  private cellLon: number;

  constructor(net: RoadNet | undefined, centerLat: number) {
    this.cellLat = BUILD_RULES.ROAD_DIST_M / mPerLat;
    this.cellLon = BUILD_RULES.ROAD_DIST_M / (mPerLat * Math.max(0.15, Math.cos(centerLat * DEG)));
    if (!net) return;
    for (const road of net.roads) {
      for (const p of road.coords) this.add(p[0], p[1]);
    }
  }

  private key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }

  private add(lon: number, lat: number): void {
    const cx = Math.floor(lon / this.cellLon);
    const cy = Math.floor(lat / this.cellLat);
    const k = this.key(cx, cy);
    let list = this.cells.get(k);
    if (!list) this.cells.set(k, (list = []));
    list.push([lon, lat]);
  }

  /** True if any road vertex is within {@link BUILD_RULES.ROAD_DIST_M} of the point. */
  near(lon: number, lat: number): boolean {
    const cx = Math.floor(lon / this.cellLon);
    const cy = Math.floor(lat / this.cellLat);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(cx + dx, cy + dy));
        if (!list) continue;
        for (const [vlon, vlat] of list) {
          if (metresBetween(lon, lat, vlon, vlat) <= BUILD_RULES.ROAD_DIST_M) return true;
        }
      }
    }
    return false;
  }

  /**
   * True if NO road vertex lies within `radiusM` — "how far from anything is this".
   *
   * The same index read at a coarser scale: the cell is sized to the build rule's 450 m, so a 6 km
   * query walks a 27×27 block of cells. Expensive per call and run a few dozen times at match start
   * to place the enemy base, never per frame.
   */
  clear(lon: number, lat: number, radiusM: number): boolean {
    const cx = Math.floor(lon / this.cellLon);
    const cy = Math.floor(lat / this.cellLat);
    // Cells are one ROAD_DIST_M across in both axes by construction, so the span is the same number
    // of cells either way regardless of latitude.
    const span = Math.ceil(radiusM / BUILD_RULES.ROAD_DIST_M);
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const list = this.cells.get(this.key(cx + dx, cy + dy));
        if (!list) continue;
        for (const [vlon, vlat] of list) {
          if (metresBetween(lon, lat, vlon, vlat) <= radiusM) return false;
        }
      }
    }
    return true;
  }
}

// ---- power tethers ------------------------------------------------------------------------------
//
// The visible form of the build rule: every building is drawn wired back to the obelisk that powers
// it. Red because it is the same red the obelisks themselves carry, and thin because there is one per
// building and a base of nine should still read as a base rather than a cat's cradle.

const POWER_COLOR = Cesium.Color.fromCssColorString('#E23A2E').withAlpha(0.85);
/** Metres up the obelisk the cable leaves from. */
const POWER_MAST_M = 150;
/** Metres above ground the cable lands on the building. */
const POWER_EAVE_M = 55;
/** How far the cable dips between its ends. */
const POWER_SAG_M = 28;
const POWER_SEGMENTS = 14;
/** Base 16-bit dash pattern: short marks, long gaps — a pulse travelling, not a dashed border. */
const POWER_DASH = 0b1100010001000100;
/** Seconds between one-bit rotations of the pattern. */
const POWER_STEP_S = 0.055;

// ---- unrest rings -------------------------------------------------------------------------------
//
// The public's anger at a data center, drawn where it is felt. Orange rather than the obelisk red or
// the Millstone green: this is not a weapon and it is not the enemy, it is the neighbourhood.

const UNREST_COLOR = Cesium.Color.fromCssColorString('#F27A2E');
/** Radius at full anger, metres — matches UNREST.RING_M in the model. */
const UNREST_RING_M = 900;
const UNREST_SEGMENTS = 48;
const UNREST_LIFT_M = 30;

/** A ring of world positions around a ground point, for footprints and the ghost. */
function ringPositions(
  lon: number,
  lat: number,
  radiusM: number,
  height: number,
  segments = 40,
): Cesium.Cartesian3[] {
  const dLat = radiusM / mPerLat;
  const dLon = radiusM / (mPerLat * Math.max(0.15, Math.cos(lat * DEG)));
  const out: Cesium.Cartesian3[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push(Cesium.Cartesian3.fromDegrees(lon + dLon * Math.cos(a), lat + dLat * Math.sin(a), height));
  }
  return out;
}

/** A billboard texture: a coloured rounded chip carrying the facility's glyph. Cached per type. */
const texCache = new Map<StructureType, HTMLCanvasElement>();
function facilityTexture(type: StructureType): HTMLCanvasElement {
  const hit = texCache.get(type);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const color = FACILITY_COLOR[type];
  g.fillStyle = 'rgba(10,12,16,0.9)';
  g.strokeStyle = color;
  g.lineWidth = 4;
  const r = 12;
  g.beginPath();
  g.roundRect(6, 6, 52, 52, r);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.font = '700 34px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(FACILITY_GLYPH[type], 32, 36);
  texCache.set(type, c);
  return c;
}

/** The Millstone Nexus chip — the nexus glyph in hostile green. Built once, cached. */
/** The facility chip in Millstone's green — an enemy building, whatever type it happens to be. */
const foeTexCache = new Map<StructureType, HTMLCanvasElement>();
function enemyFacilityTexture(type: StructureType): HTMLCanvasElement {
  const hit = foeTexCache.get(type);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  const color = HOSTILE.toCssColorString();
  g.fillStyle = 'rgba(10,12,16,0.9)';
  g.strokeStyle = color;
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(6, 6, 52, 52, 12);
  g.fill();
  g.stroke();
  g.fillStyle = color;
  g.font = '700 34px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(FACILITY_GLYPH[type], 32, 36);
  foeTexCache.set(type, c);
  return c;
}

let enemyNexusTex: HTMLCanvasElement | null = null;
function enemyNexusTexture(): HTMLCanvasElement {
  if (enemyNexusTex) return enemyNexusTex;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,12,16,0.9)';
  g.strokeStyle = '#3FBF6F';
  g.lineWidth = 4;
  g.beginPath();
  g.roundRect(6, 6, 52, 52, 12);
  g.fill();
  g.stroke();
  g.fillStyle = '#3FBF6F';
  g.font = '700 34px ui-monospace, monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('◈', 32, 36);
  enemyNexusTex = c;
  return c;
}

export class RtsBuildLayer {
  /** Dim dots at every unbuilt surveyed obelisk site. */
  readonly siteDots = new Cesium.PointPrimitiveCollection();
  /** Facility footprint rings. */
  readonly rings = new Cesium.PolylineCollection();
  /** Facility glyph billboards. */
  readonly icons = new Cesium.BillboardCollection();
  /** The live placement preview ring. */
  readonly ghost = new Cesium.PolylineCollection();
  /** The selected producing structure's rally point, if it has one. */
  readonly rallyDots = new Cesium.PointPrimitiveCollection();
  /** In-progress construction sites — an amber ring while a worker builds. */
  readonly construction = new Cesium.PolylineCollection();
  private constructionLines = new Map<number, Cesium.Polyline>();
  /** Unrest rings: a pulsing ring around every data center, brightening as the ground turns. */
  readonly unrest = new Cesium.PolylineCollection();
  private unrestRings: { line: Cesium.Polyline; material: Cesium.Material; positions: Cesium.Cartesian3[]; lon: number; lat: number }[] = [];
  private unrestT = 0;
  private unrestLevel = 0;
  /** Power tethers: a thin crawling red line from each obelisk to every building it powers. */
  readonly power = new Cesium.PolylineCollection();
  private powerLines: Cesium.Polyline[] = [];
  private powerMaterials: Cesium.Material[] = [];
  private dashPhase = 0;
  private dashClock = 0;

  private roadGrid: RoadGrid;
  private ghostLine: Cesium.Polyline | undefined;
  /** Second, wider ghost ring: the power a pylon would project from where the cursor is. */
  private ghostPower: Cesium.Polyline | undefined;

  /** One instanced 3D-model batch per facility type — the buildings themselves. */
  private facilityBatch: Record<FacilityType, InstancedModelBatch>;
  /** Placed instances per type, kept so the batch can be re-written when one is added or falls. */
  // Derived from FACILITY_TYPES rather than written out, so adding a facility can't leave it with
  // nowhere to record its instances — the previous hand-written literal was one line per type and
  // one more thing to forget.
  private facilityList = Object.fromEntries(
    FACILITY_TYPES.map((t) => [t, [] as FacilityInstance[]]),
  ) as Record<FacilityType, FacilityInstance[]>;
  /** Ring + icon per ENEMY building id, kept apart so a rebuild can drop them all in one pass. */
  private enemyVisuals = new Map<number, { ring: Cesium.Polyline; icon: Cesium.Billboard }>();
  /** Ring + icon per structure id, so a destroyed structure can take its chrome down with it. */
  private structureVisuals = new Map<number, { ring: Cesium.Polyline; icon: Cesium.Billboard }>();
  /** The Millstone Nexus marker, present only during a match with an enemy still standing. */
  private enemyNexus: { ring: Cesium.Polyline; icon: Cesium.Billboard } | null = null;
  /** The building batches, for the scene to add to / remove from the primitive collection. */
  readonly meshBatches: InstancedModelBatch[];

  constructor(
    net: RoadNet | undefined,
    center: { lon: number; lat: number },
    private heightAt: (lon: number, lat: number) => number,
  ) {
    this.roadGrid = new RoadGrid(net, center.lat);
    // A generous bounds so the buildings never cull inside the theater; culling here is a nicety,
    // not a correctness concern.
    const bounds = new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(center.lon, center.lat, 0), 500_000);
    // Same reason as facilityList: one batch per declared type, not per remembered type.
    this.facilityBatch = Object.fromEntries(
      FACILITY_TYPES.map((t) => [t, new InstancedModelBatch(FACILITY_MESH[t], 24, bounds, false)]),
    ) as Record<FacilityType, InstancedModelBatch>;
    this.meshBatches = FACILITY_TYPES.map((t) => this.facilityBatch[t]);
  }

  /** Redraw the dim "you may build an obelisk here" dots, excluding sites already built on. */
  setSites(sites: BuildSite[], built: Set<number>): void {
    this.siteDots.removeAll();
    const cond = new Cesium.DistanceDisplayCondition(0, Number.MAX_VALUE);
    for (const s of sites) {
      if (built.has(s.index)) continue;
      this.siteDots.add({
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, this.heightAt(s.lon, s.lat) + 20),
        color: Cesium.Color.fromCssColorString('#3FA0E0').withAlpha(0.5),
        pixelSize: 6,
        outlineColor: Cesium.Color.fromCssColorString('#0a0c10').withAlpha(0.8),
        outlineWidth: 1,
        distanceDisplayCondition: cond,
        disableDepthTestDistance: 1e12,
      });
    }
  }

  /** Draw a facility: the 3D building, a footprint ring, and an overview icon for when it's tiny. */
  addFacility(s: Structure): void {
    const def = STRUCTURES[s.type];
    const h = this.heightAt(s.lon, s.lat);
    const color = Cesium.Color.fromCssColorString(FACILITY_COLOR[s.type]);
    const ring = this.rings.add({
      positions: ringPositions(s.lon, s.lat, def.footprintM, h + 25),
      width: 2,
      material: Cesium.Material.fromType('Color', { color: color.withAlpha(0.8) }),
    });
    // The building itself — a lit 3D model, coloured by type.
    if (isFacilityType(s.type)) {
      this.facilityList[s.type].push({ id: s.id, lon: s.lon, lat: s.lat });
      this.rewriteFacilityBatch(s.type);
    }
    // A 24 px icon, but ONLY once the building has gone small at the overview — up close the mesh
    // speaks for itself.
    const icon = this.icons.add({
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h + 260),
      image: facilityTexture(s.type),
      width: 30,
      height: 30,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      distanceDisplayCondition: new Cesium.DistanceDisplayCondition(12_000, Number.MAX_VALUE),
      disableDepthTestDistance: 1e12,
    });
    this.structureVisuals.set(s.id, { ring, icon });
  }

  /** Take a fallen structure's chrome down: ring, icon, and its slot in the building batch. */
  removeFacility(s: Structure): void {
    const vis = this.structureVisuals.get(s.id);
    if (vis) {
      this.rings.remove(vis.ring);
      this.icons.remove(vis.icon);
      this.structureVisuals.delete(s.id);
    }
    if (isFacilityType(s.type)) {
      this.facilityList[s.type] = this.facilityList[s.type].filter((f) => f.id !== s.id);
      this.rewriteFacilityBatch(s.type);
    }
  }

  /**
   * Replace the whole of Millstone's built base.
   *
   * Wholesale rather than incremental: the enemy puts up a building every thirty-odd seconds and
   * loses them in raids, so the list is short and changes rarely, and a rebuild that cannot drift
   * out of step with the director is worth more than the handful of allocations it costs.
   */
  setEnemyFacilities(list: { id: number; type: StructureType; lon: number; lat: number }[]): void {
    for (const vis of this.enemyVisuals.values()) {
      this.rings.remove(vis.ring);
      this.icons.remove(vis.icon);
    }
    this.enemyVisuals.clear();
    const touched = new Set<FacilityType>();
    for (const t of FACILITY_TYPES) {
      if (this.facilityList[t].some((f) => f.foe)) {
        this.facilityList[t] = this.facilityList[t].filter((f) => !f.foe);
        touched.add(t);
      }
    }

    for (const b of list) {
      const def = STRUCTURES[b.type];
      const h = this.heightAt(b.lon, b.lat);
      const ring = this.rings.add({
        positions: ringPositions(b.lon, b.lat, def.footprintM, h + 25),
        width: 2,
        material: Cesium.Material.fromType('Color', { color: HOSTILE.withAlpha(0.7) }),
      });
      const icon = this.icons.add({
        position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, h + 220),
        image: enemyFacilityTexture(b.type),
        width: 26,
        height: 26,
        verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(12_000, Number.MAX_VALUE),
        disableDepthTestDistance: 1e12,
      });
      this.enemyVisuals.set(b.id, { ring, icon });
      if (isFacilityType(b.type)) {
        this.facilityList[b.type].push({ id: -1000 - b.id, lon: b.lon, lat: b.lat, foe: true });
        touched.add(b.type);
      }
    }
    for (const t of touched) this.rewriteFacilityBatch(t);
  }

  /**
   * Mark the Millstone Nexus: a hostile-green ring and glyph on the enemy's home site. The obelisk
   * pyramid under it is ambient network geometry, the way the player's own Nexus renders — the
   * marker is what says WHOSE it is.
   */
  setEnemyNexus(lon: number, lat: number): void {
    this.clearEnemyNexus();
    const h = this.heightAt(lon, lat);
    const green = Cesium.Color.fromCssColorString('#3FBF6F');
    const ring = this.rings.add({
      positions: ringPositions(lon, lat, STRUCTURES.nexus.footprintM, h + 25),
      width: 3,
      material: Cesium.Material.fromType('Color', { color: green.withAlpha(0.85) }),
    });
    const icon = this.icons.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, h + 260),
      image: enemyNexusTexture(),
      width: 30,
      height: 30,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: 1e12,
    });
    this.enemyNexus = { ring, icon };
  }

  /** The enemy Nexus fell — its marker goes with it. */
  clearEnemyNexus(): void {
    if (!this.enemyNexus) return;
    this.rings.remove(this.enemyNexus.ring);
    this.icons.remove(this.enemyNexus.icon);
    this.enemyNexus = null;
  }

  /** Re-upload one facility type's instances after a build. Buildings are static, so this is rare. */
  private rewriteFacilityBatch(ft: FacilityType): void {
    const batch = this.facilityBatch[ft];
    const color = Cesium.Color.fromCssColorString(FACILITY_COLOR[ft]);
    batch.beginFrame();
    for (const inst of this.facilityList[ft]) {
      const world = Cesium.Cartesian3.fromDegrees(inst.lon, inst.lat, this.heightAt(inst.lon, inst.lat));
      // Whose it is beats what it is: an enemy building wears Millstone's green whatever type it is,
      // because "is that mine" is the first question anybody asks of a building on this map.
      batch.setInstance(world, 0, FACILITY_SCALE[ft], inst.foe ? HOSTILE : color);
    }
    batch.endFrame();
  }

  /** Show the placement preview at a point, tinted by whether the spot is legal. */
  /**
   * Draw the placement ghost: a footprint ring, and optionally the POWER radius the thing would
   * project if it were built.
   *
   * The power ring is what makes an obelisk legible as a pylon. Without it the player is told "NO
   * OBELISK POWER" at a spot and has to guess how far away the nearest mast would have to be; with
   * it, planting one shows exactly how much ground it opens, before paying for it.
   */
  showGhost(lon: number, lat: number, radiusM: number, valid: boolean, powerM = 0): void {
    const color = valid
      ? Cesium.Color.fromCssColorString('#3FBF6F').withAlpha(0.9)
      : Cesium.Color.fromCssColorString('#E23A2E').withAlpha(0.9);
    const h = this.heightAt(lon, lat);
    const positions = ringPositions(lon, lat, radiusM, h + 25);
    if (!this.ghostLine) {
      this.ghostLine = this.ghost.add({ positions, width: 3, material: Cesium.Material.fromType('Color', { color }) });
    } else {
      this.ghostLine.positions = positions;
      (this.ghostLine.material as Cesium.Material).uniforms.color = color;
    }

    if (powerM <= 0) {
      if (this.ghostPower) {
        this.ghost.remove(this.ghostPower);
        this.ghostPower = undefined;
      }
      return;
    }
    // Fainter and wider than the footprint, in the obelisk red, so it reads as "what this would
    // light up" rather than as a second thing being placed.
    const pcol = Cesium.Color.fromCssColorString('#E23A2E').withAlpha(valid ? 0.5 : 0.22);
    const ppos = ringPositions(lon, lat, powerM, h + 25, 72);
    if (!this.ghostPower) {
      this.ghostPower = this.ghost.add({ positions: ppos, width: 1.6, material: Cesium.Material.fromType('Color', { color: pcol }) });
    } else {
      this.ghostPower.positions = ppos;
      (this.ghostPower.material as Cesium.Material).uniforms.color = pcol;
    }
  }

  hideGhost(): void {
    if (this.ghostLine) {
      this.ghost.remove(this.ghostLine);
      this.ghostLine = undefined;
    }
    if (this.ghostPower) {
      this.ghost.remove(this.ghostPower);
      this.ghostPower = undefined;
    }
  }

  /** Show the rally point for the selected producing structure — a single green node. */
  setRally(lon: number, lat: number): void {
    this.rallyDots.removeAll();
    this.rallyDots.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat, this.heightAt(lon, lat) + 40),
      color: Cesium.Color.fromCssColorString('#3FBF6F').withAlpha(0.95),
      pixelSize: 11,
      outlineColor: Cesium.Color.fromCssColorString('#0a0c10').withAlpha(0.9),
      outlineWidth: 2,
      disableDepthTestDistance: 1e12,
    });
  }

  clearRally(): void {
    this.rallyDots.removeAll();
  }

  /** Draw an amber "under construction" ring at a site, keyed by construction id. */
  addConstruction(id: number, lon: number, lat: number, radiusM: number): void {
    const line = this.construction.add({
      positions: ringPositions(lon, lat, radiusM, this.heightAt(lon, lat) + 25),
      width: 2,
      material: Cesium.Material.fromType('Color', {
        color: Cesium.Color.fromCssColorString('#E7A13B').withAlpha(0.75),
      }),
    });
    this.constructionLines.set(id, line);
  }

  clearConstruction(id: number): void {
    const line = this.constructionLines.get(id);
    if (line) {
      this.construction.remove(line);
      this.constructionLines.delete(id);
    }
  }

  /**
   * Redraw the power tethers — one line per powered building, back to the obelisk feeding it.
   *
   * Called only when the base actually changes shape, not per frame: the crawl is done by animating
   * the dash pattern in {@link update}, so the geometry is static between builds.
   */
  setPower(links: { flon: number; flat: number; tlon: number; tlat: number }[]): void {
    this.power.removeAll();
    this.powerLines = [];
    this.powerMaterials = [];
    for (const l of links) {
      // Off the obelisk's mast and down onto the building's roofline, with a sag in the middle, so it
      // reads as a cable strung between two things rather than a line drawn on the map.
      const fh = this.heightAt(l.flon, l.flat) + POWER_MAST_M;
      const th = this.heightAt(l.tlon, l.tlat) + POWER_EAVE_M;
      const positions: Cesium.Cartesian3[] = [];
      for (let i = 0; i <= POWER_SEGMENTS; i++) {
        const k = i / POWER_SEGMENTS;
        const lon = l.flon + (l.tlon - l.flon) * k;
        const lat = l.flat + (l.tlat - l.flat) * k;
        const sag = Math.sin(Math.PI * k) * POWER_SAG_M;
        positions.push(Cesium.Cartesian3.fromDegrees(lon, lat, fh + (th - fh) * k - sag));
      }
      const material = Cesium.Material.fromType('PolylineDash', {
        color: POWER_COLOR,
        gapColor: Cesium.Color.TRANSPARENT,
        dashLength: 18,
        dashPattern: POWER_DASH,
      });
      this.powerLines.push(this.power.add({ positions, width: 1.6, material }));
      this.powerMaterials.push(material);
    }
    this.dashPhase = 0;
  }

  /**
   * Redraw the unrest rings — one around each data center.
   *
   * A ring rather than a number on a panel because the anger is a fact about GROUND: it belongs at
   * the shed that caused it, in the neighbourhood that has it, where the player is already looking
   * when they decide whether to plant another one.
   */
  setUnrestSites(sites: { lon: number; lat: number }[]): void {
    this.unrest.removeAll();
    this.unrestRings = [];
    for (const s of sites) {
      const positions: Cesium.Cartesian3[] = [];
      for (let i = 0; i <= UNREST_SEGMENTS; i++) positions.push(new Cesium.Cartesian3());
      const material = Cesium.Material.fromType('Color', { color: UNREST_COLOR.withAlpha(0) });
      const line = this.unrest.add({ positions, width: 2.4, material, show: true });
      this.unrestRings.push({ line, material, positions, lon: s.lon, lat: s.lat });
    }
  }

  /** How angry the ground is, 0–1 — drives how bright and how wide the rings pulse. */
  setUnrestLevel(level: number): void {
    this.unrestLevel = level;
  }

  /** Drop every tether — a match ending, or a base with nothing powered. */
  clearPower(): void {
    this.power.removeAll();
    this.powerLines = [];
    this.powerMaterials = [];
  }

  /**
   * Animate the tethers: rotate the dash bit-pattern so the dashes crawl from the obelisk toward the
   * building — power flowing outward, which is the direction the rule actually runs.
   *
   * Stepped on a clock rather than per frame. A 16-bit pattern rotated once a frame at 60 fps cycles
   * nearly four times a second, which reads as a strobe; {@link POWER_STEP_S} slows it to a crawl.
   */
  update(dt: number): void {
    this.updateUnrest(dt);
    if (!this.powerMaterials.length) return;
    this.dashClock += dt;
    if (this.dashClock < POWER_STEP_S) return;
    this.dashClock = 0;
    this.dashPhase = (this.dashPhase + 1) & 15;
    // Rotate right: with Cesium's dash pattern read from the low bit up, that walks the gaps forward
    // along the line rather than backward.
    const p = POWER_DASH;
    const pattern = ((p >>> this.dashPhase) | (p << (16 - this.dashPhase))) & 0xffff;
    for (const m of this.powerMaterials) (m.uniforms as { dashPattern: number }).dashPattern = pattern;
  }

  /**
   * Breathe the unrest rings.
   *
   * The pulse is a heartbeat rather than a wobble: it quickens with the level, so calm ground barely
   * moves and riotous ground throbs. Amplitude and brightness both scale from zero, which means a
   * freshly-built data center draws a ring that is technically there and visually silent — the anger
   * arrives over minutes, and the ring should say so.
   */
  private updateUnrest(dt: number): void {
    if (!this.unrestRings.length) return;
    const lvl = this.unrestLevel;
    this.unrestT += dt * (0.9 + lvl * 1.8);
    const pulse = 0.5 + 0.5 * Math.sin(this.unrestT * Math.PI);
    const r = UNREST_RING_M * (0.72 + 0.28 * pulse) * (0.55 + 0.45 * lvl);
    const alpha = Math.min(0.85, 0.06 + lvl * (0.55 + 0.3 * pulse));
    for (const ring of this.unrestRings) {
      const mLon = 111_320 * Math.cos((ring.lat * Math.PI) / 180);
      for (let i = 0; i <= UNREST_SEGMENTS; i++) {
        const a = (i / UNREST_SEGMENTS) * Math.PI * 2;
        const lon = ring.lon + (Math.cos(a) * r) / mLon;
        const lat = ring.lat + (Math.sin(a) * r) / 111_320;
        Cesium.Cartesian3.fromDegrees(lon, lat, this.heightAt(lon, lat) + UNREST_LIFT_M, undefined, ring.positions[i]);
      }
      ring.line.positions = ring.positions;
      (ring.material.uniforms as { color: Cesium.Color }).color = UNREST_COLOR.withAlpha(alpha);
    }
  }

  /** Whether a point is close enough to a road for a facility. */
  nearRoad(lon: number, lat: number): boolean {
    return this.roadGrid.near(lon, lat);
  }

  /** Whether there is NO road within `radiusM` — how empty a piece of ground is. */
  roadFree(lon: number, lat: number, radiusM: number): boolean {
    return this.roadGrid.clear(lon, lat, radiusM);
  }
}
