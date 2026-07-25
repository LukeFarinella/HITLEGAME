import * as Cesium from 'cesium';
import type { RoadNet } from './roads';
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
  aviation: '#3FA0E0',
  tech: '#8B6FE0',
};

/** A short glyph per facility, drawn into the billboard so a base reads at a glance. */
const FACILITY_GLYPH: Record<StructureType, string> = {
  nexus: '◈',
  obelisk: '▲',
  robotics: 'R',
  aviation: 'V',
  tech: 'T',
};

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
}

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

export class RtsBuildLayer {
  /** Dim dots at every unbuilt surveyed obelisk site. */
  readonly siteDots = new Cesium.PointPrimitiveCollection();
  /** Facility footprint rings. */
  readonly rings = new Cesium.PolylineCollection();
  /** Facility glyph billboards. */
  readonly icons = new Cesium.BillboardCollection();
  /** The live placement preview ring. */
  readonly ghost = new Cesium.PolylineCollection();

  private roadGrid: RoadGrid;
  private ghostLine: Cesium.Polyline | undefined;

  constructor(
    net: RoadNet | undefined,
    center: { lon: number; lat: number },
    private heightAt: (lon: number, lat: number) => number,
  ) {
    this.roadGrid = new RoadGrid(net, center.lat);
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

  /** Draw a facility: a footprint ring plus a glyph billboard standing over it. */
  addFacility(s: Structure): void {
    const def = STRUCTURES[s.type];
    const h = this.heightAt(s.lon, s.lat);
    const color = Cesium.Color.fromCssColorString(FACILITY_COLOR[s.type]);
    this.rings.add({
      positions: ringPositions(s.lon, s.lat, def.footprintM, h + 25),
      width: 2,
      material: Cesium.Material.fromType('Color', { color: color.withAlpha(0.8) }),
    });
    this.icons.add({
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h + 220),
      image: facilityTexture(s.type),
      width: 34,
      height: 34,
      verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
      disableDepthTestDistance: 1e12,
    });
  }

  /** Show the placement preview at a point, tinted by whether the spot is legal. */
  showGhost(lon: number, lat: number, radiusM: number, valid: boolean): void {
    const color = valid
      ? Cesium.Color.fromCssColorString('#3FBF6F').withAlpha(0.9)
      : Cesium.Color.fromCssColorString('#E23A2E').withAlpha(0.9);
    const positions = ringPositions(lon, lat, radiusM, this.heightAt(lon, lat) + 25);
    if (!this.ghostLine) {
      this.ghostLine = this.ghost.add({ positions, width: 3, material: Cesium.Material.fromType('Color', { color }) });
    } else {
      this.ghostLine.positions = positions;
      (this.ghostLine.material as Cesium.Material).uniforms.color = color;
    }
  }

  hideGhost(): void {
    if (this.ghostLine) {
      this.ghost.remove(this.ghostLine);
      this.ghostLine = undefined;
    }
  }

  /** Whether a point is close enough to a road for a facility. */
  nearRoad(lon: number, lat: number): boolean {
    return this.roadGrid.near(lon, lat);
  }
}
