/**
 * The RTS build catalog and placement rules.
 *
 * Pure data + geometry: this module knows what a structure costs and where it is ALLOWED to go, but
 * nothing about Cesium, money, or rendering. The scene owns the terrain/road/coverage tests and the
 * money; it asks this module "is this a legal spot?" and "what does this cost?", then builds.
 *
 * Two placement kinds, matching the design:
 *   - `site`  — obelisks. They may only stand on a SURVEYED SITE (one of the theater's predetermined
 *               obelisk positions). The Nexus is one of these; every other is a build slot.
 *   - `free`  — facilities. Placed on open ground, but only NEAR A ROAD and WITHIN REACH of the Nexus
 *               or an existing facility, so a base grows as a connected sprawl rather than teleporting
 *               a factory into the wilderness.
 */

export type StructureType = 'nexus' | 'obelisk' | 'robotics' | 'aviation' | 'tech' | 'supply';

/** Placeable structure types, in command-bar order. The Nexus is never built — you start with it. */
export const BUILDABLE: StructureType[] = ['obelisk', 'supply', 'robotics', 'aviation', 'tech'];

export interface StructureDef {
  type: StructureType;
  name: string;
  /** One line for the command-bar tooltip. */
  blurb: string;
  cost: number;
  maxHp: number;
  /** Where it may stand — a surveyed obelisk site, or free ground under the placement rules. */
  placement: 'site' | 'free';
  /** Command-bar hotkey. */
  hotkey: string;
  /** Ground-footprint radius in metres — its ring, and the spacing other structures keep from it. */
  footprintM: number;
  /** Supply this structure adds to the cap. The Nexus opens some; the supply building is the rest. */
  supplyProvided?: number;
  /** Seconds a worker spends building it on site. 0 for the Nexus (never built). */
  buildTimeS: number;
}

export const STRUCTURES: Record<StructureType, StructureDef> = {
  nexus: {
    type: 'nexus',
    name: 'NEXUS',
    blurb: 'Your main obelisk. Its fall ends the match. Trickles income and sees the ground around it.',
    cost: 0,
    maxHp: 2000,
    placement: 'site',
    hotkey: '',
    footprintM: 260,
    supplyProvided: 10,
    buildTimeS: 0,
  },
  obelisk: {
    type: 'obelisk',
    name: 'OBELISK',
    blurb: 'Economy and vision. Raises your income and its cap. Buildable only on a surveyed site.',
    cost: 250,
    maxHp: 700,
    placement: 'site',
    hotkey: 'E',
    footprintM: 220,
    buildTimeS: 8,
  },
  robotics: {
    type: 'robotics',
    name: 'ROBOTICS FACILITY',
    blurb: 'Builds ground units — quadrupeds and walkers.',
    cost: 400,
    maxHp: 1000,
    placement: 'free',
    hotkey: 'R',
    footprintM: 300,
    buildTimeS: 22,
  },
  aviation: {
    type: 'aviation',
    name: 'AVIATION FACILITY',
    blurb: 'Builds air units — quadcopters and interceptors.',
    cost: 550,
    maxHp: 850,
    placement: 'free',
    hotkey: 'V',
    footprintM: 300,
    buildTimeS: 26,
  },
  tech: {
    type: 'tech',
    name: 'TECH FACILITY',
    blurb: 'Researches upgrades — auto-fine obelisks, faster units, and more.',
    cost: 350,
    maxHp: 800,
    placement: 'free',
    hotkey: 'T',
    footprintM: 280,
    buildTimeS: 20,
  },
  supply: {
    type: 'supply',
    name: 'DATA CENTER',
    blurb: 'Raises your supply cap so you can field a larger force.',
    cost: 150,
    maxHp: 750,
    placement: 'free',
    hotkey: 'D',
    footprintM: 260,
    supplyProvided: 10,
    buildTimeS: 14,
  },
};

/** Placement geometry, in metres. One place so the whole "where can I build" feel is a few numbers. */
export const BUILD_RULES = {
  /**
   * A new obelisk must be within this of an existing live obelisk. The surveyed sites are the only
   * legal spots; this keeps expansion a reachable chain outward rather than a site plonked across
   * the map with no line back to your base.
   */
  OBELISK_REACH_M: 14_000,
  /** How close the cursor must be to a surveyed site for the obelisk ghost to snap onto it. */
  OBELISK_SNAP_M: 2500,
  /** A facility must sit within this of the Nexus or another facility — the base's build radius. */
  FACILITY_REACH_M: 7000,
  /** A facility must sit within this of a road. */
  ROAD_DIST_M: 450,
  /** No structure may be built closer than this to another — basic spacing so bases don't stack. */
  MIN_SPACING_M: 260,
};

/** A built (or building) structure. Match state — position, type, health. */
export interface Structure {
  id: number;
  type: StructureType;
  lon: number;
  lat: number;
  hp: number;
  maxHp: number;
  /** For obelisks: the global obelisk index this occupies, so a fall can free the site to rebuild. */
  siteIndex?: number;
}

/** Why a placement is illegal, or null if it's fine. Human-readable — the ghost shows it. */
export type BuildRejection = string | null;

/** Metres between two lon/lat points (small-angle, fine at theater scale). */
export function metresBetween(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const mPerLat = 111_320;
  const mLon = mPerLat * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.hypot((lon2 - lon1) * mLon, (lat2 - lat1) * mPerLat);
}
