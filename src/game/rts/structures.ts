/**
 * The RTS build catalog and placement rules.
 *
 * Pure data + geometry: this module knows what a structure costs and where it is ALLOWED to go, but
 * nothing about Cesium, money, or rendering. The scene owns the terrain/road/coverage tests and the
 * money; it asks this module "is this a legal spot?" and "what does this cost?", then builds.
 *
 * Three placement kinds, matching the design:
 *   - `site`  — obelisks. They may only stand on a SURVEYED SITE (one of the theater's predetermined
 *               obelisk positions) — but on ANY of them, however far out. The Nexus is one of these;
 *               every other is a build slot. There is no distance rule, because the obelisk is the
 *               PYLON: it is the thing that projects the right to build, so making where it may go
 *               depend on where you have already built would leave nothing able to open new ground.
 *   - `free`  — facilities. Placed on open ground, NEAR A ROAD and inside the POWER RADIUS of an
 *               obelisk. That is the whole base-building loop: plant a pylon on a site, build the
 *               cluster it lights up, plant the next pylon further out.
 *   - `shore` — the harbor. Stands on LAND but within {@link BUILD_RULES.SHORE_DIST_M} of navigable
 *               water, and is exempt from the road rule: a quay is defined by the water it reaches,
 *               and demanding a road as well makes a coastline of cliffs and beaches unbuildable.
 *               This is the one structure whose legal ground is decided by the terrain rather than by
 *               your own base, which is what makes a coastal theater play differently from an inland
 *               one — on a landlocked map there is no navy, and that is a real strategic fact rather
 *               than a missing feature.
 */

export type StructureType =
  | 'nexus'
  | 'obelisk'
  | 'robotics'
  | 'acquisitions'
  | 'harbor'
  | 'skyhook'
  | 'aviation'
  | 'tech'
  | 'supply'
  | 'special';

/** Placeable structure types, in command-bar order. The Nexus is never built — you start with it. */
export const BUILDABLE: StructureType[] = [
  'obelisk', 'supply', 'robotics', 'acquisitions', 'harbor', 'tech', 'aviation', 'special', 'skyhook',
];

export interface StructureDef {
  type: StructureType;
  name: string;
  /** One line for the command-bar tooltip. */
  blurb: string;
  cost: number;
  maxHp: number;
  /** Where it may stand — a surveyed obelisk site, free ground, or the coast. See the module header. */
  placement: 'site' | 'free' | 'shore';
  /** Command-bar hotkey. */
  hotkey: string;
  /** Ground-footprint radius in metres — its ring, and the spacing other structures keep from it. */
  footprintM: number;
  /** Supply this structure adds to the cap. The Nexus opens some; the supply building is the rest. */
  supplyProvided?: number;
  /** Seconds a worker spends building it on site. 0 for the Nexus (never built). */
  buildTimeS: number;
  /**
   * Tech-tree prerequisite: a number of obelisks that must stand, and/or a structure that must
   * already be built. This is what makes the base a chain — 3 obelisks → data center → robotics →
   * tech → aviation → the special unit — rather than a menu you buy in any order.
   */
  requires?: { obelisks?: number; structure?: StructureType };
}

export const STRUCTURES: Record<StructureType, StructureDef> = {
  nexus: {
    type: 'nexus',
    name: 'NEXUS',
    blurb: 'Your main obelisk. Its fall ends the match. Trickles income, sees the ground around it, and carries a battery that will see off a raiding party but not a wave.',
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
    blurb: 'Pylon. Powers every building around it, and raises your income and its cap. Stands on any surveyed site, however far out.',
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
    blurb: 'Builds the ground line — quadrupeds, and the kite scout once the tech facility stands.',
    cost: 400,
    maxHp: 1000,
    placement: 'free',
    hotkey: 'R',
    footprintM: 300,
    buildTimeS: 22,
    requires: { structure: 'supply' },
  },
  acquisitions: {
    type: 'acquisitions',
    name: 'ACQUISITIONS',
    blurb: 'Corporate. Upgrades the obelisk network, opens new sites, raises your authority and your funding.',
    cost: 350,
    maxHp: 800,
    placement: 'free',
    hotkey: 'A',
    footprintM: 280,
    buildTimeS: 20,
    // Off robotics, alongside the tech facility rather than behind it. The two labs answer different
    // questions — tech makes your MACHINES better, acquisitions makes your COMPANY bigger — and
    // making them compete for the same rung is the point: an early acquisitions is a bet on the
    // economy, an early tech is a bet on the fight.
    requires: { structure: 'robotics' },
  },
  harbor: {
    type: 'harbor',
    name: 'HARBOR',
    blurb: 'Builds water units — the USV picket and, once the tech facility stands, the littoral hull. Must be built on the coast.',
    cost: 450,
    maxHp: 900,
    placement: 'shore',
    hotkey: 'H',
    footprintM: 300,
    buildTimeS: 24,
    // Same rung as robotics, deliberately: the harbor is an EARLY option you can open instead of
    // committing everything to the ground line, not a late-game annex. What it can build changes as
    // the tree grows (see the littoral's tech gate) rather than the harbor itself arriving late.
    requires: { structure: 'supply' },
  },
  aviation: {
    type: 'aviation',
    name: 'AVIATION FACILITY',
    blurb: 'Builds air units — interceptors and the disc observer.',
    cost: 550,
    maxHp: 850,
    placement: 'free',
    hotkey: 'V',
    footprintM: 300,
    buildTimeS: 26,
    requires: { structure: 'tech' },
  },
  tech: {
    type: 'tech',
    name: 'TECH FACILITY',
    blurb: 'Researches machine upgrades — heavier barrels, tougher hulls, longer reach. Unlocks the kite and the littoral.',
    cost: 350,
    maxHp: 800,
    placement: 'free',
    hotkey: 'T',
    footprintM: 280,
    buildTimeS: 20,
    requires: { structure: 'robotics' },
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
    requires: { obelisks: 3 },
  },
  skyhook: {
    type: 'skyhook',
    name: 'SKYHOOK',
    blurb: 'Orbital tether. Unlocks the disc observer and the giga walker, and calls orbital bombardment on ground you pick.',
    cost: 800,
    maxHp: 950,
    placement: 'free',
    hotkey: 'K',
    footprintM: 300,
    buildTimeS: 38,
    // A SECOND lab hanging off tech, parallel to aviation rather than behind special. That makes it
    // a real fork in the build: the tether is what turns your top end on, but it competes for the
    // same money as the aviation-into-special line that produces the things it unlocks.
    requires: { structure: 'tech' },
  },
  special: {
    type: 'special',
    name: 'SPECIAL FACILITY',
    blurb: 'Builds the heavy line and the capstones — arachnids, marshals and the siege walker.',
    cost: 700,
    maxHp: 1100,
    placement: 'free',
    hotkey: 'S',
    footprintM: 320,
    buildTimeS: 34,
    requires: { structure: 'aviation' },
  },
};

/** Placement geometry, in metres. One place so the whole "where can I build" feel is a few numbers. */
export const BUILD_RULES = {
  // There is no OBELISK_REACH_M any more. An obelisk may stand on any surveyed site, however far
  // out — it is the pylon that projects the right to build, so a rule about where it may go based on
  // where you have already built made the one structure that opens new ground unable to open any.
  /** How close the cursor must be to a surveyed site for the obelisk ghost to snap onto it. */
  OBELISK_SNAP_M: 2500,
  /**
   * How far an obelisk's POWER reaches, in metres. A facility must stand inside this of a live
   * obelisk (the Nexus counts) or it cannot be built.
   *
   * This replaced the old "near the Nexus or another facility" rule, and the swap is the whole
   * economy in one number. Before, a base grew as an undifferentiated sprawl and an obelisk was
   * something you built for income somewhere else. Now the obelisk is the thing your base hangs off:
   * taking ground is what lets you build on it, an obelisk that falls takes its whole cluster's power
   * with it, and a forward obelisk is a forward base rather than a distant meter. The radius is
   * deliberately generous — this is meant to make expansion meaningful, not to make placement fiddly.
   */
  POWER_RADIUS_M: 2500,
  /** A facility must sit within this of a road. */
  ROAD_DIST_M: 450,
  /**
   * How close to navigable water a `shore` structure must stand, in metres.
   *
   * Measured against the theater's shoreline distance field, so it is distance to the actual coast
   * rather than to some sampled water pixel. Generous enough that a harbor can sit on a beach or a
   * bluff rather than demanding the waterline exactly, tight enough that "on the coast" still means
   * something.
   */
  SHORE_DIST_M: 700,
  /**
   * No FACILITY may be built closer than this to another facility — basic spacing so buildings don't
   * stack into one unreadable pile.
   *
   * Obelisks are exempt on both sides of the test: you may build a facility right up against one, and
   * on top of a surveyed site if you like. An obelisk is the power source its cluster gathers around,
   * so making it repel the things it powers was exactly backwards.
   */
  MIN_SPACING_M: 260,
};

/**
 * The Nexus' own defensive laser.
 *
 * Sized against exactly one job: repelling three or four enemy WORKERS. A drudge has 90 hit points,
 * so five shots kills one and four of them take about sixteen seconds to clear — during which they
 * deal roughly 680 damage to a 2000-point Nexus. It wins, and it costs you a third of your main
 * building, which is the right answer to "I ignored some harassment".
 *
 * And it is sized to LOSE to anything real. Three rippers need nine shots each: twenty-two seconds,
 * in which they deal more than 2000. The Nexus does not defend itself against a wave. It defends
 * itself against being nibbled to death while your army is somewhere else, and that is all.
 *
 * Only the player's Nexus carries it. Millstone's is a target and nothing else — giving the enemy
 * base a gun would make rushing it a different game, and nobody asked for that.
 */
export const NEXUS_LASER = {
  name: 'NEXUS BATTERY',
  kind: 'ranged' as const,
  rangeM: 800,
  dmg: 22,
  periodS: 0.8,
};

/**
 * A STRUCTURE ABILITY — something a building does on command, rather than something it produces.
 *
 * Kept as data next to the buildings for the same reason units are: the command card reads
 * {@link abilitiesFrom} and needs no knowledge of what any particular ability means. The scene owns
 * what firing one actually does.
 */
export type AbilityId = 'orbital';

export interface AbilityDef {
  id: AbilityId;
  name: string;
  blurb: string;
  /** Money per use. */
  cost: number;
  /** Seconds before the same building can fire it again. */
  cooldownS: number;
  /** The building that offers it. */
  from: StructureType;
  hotkey: string;
}

export const ABILITIES: AbilityDef[] = [
  {
    id: 'orbital',
    name: 'ORBITAL STRIKE',
    blurb:
      'Drops a round from the tether onto ground you pick. Wide, heavy, and it does not distinguish — everything standing in the ring is in it, including yours.',
    cost: 300,
    cooldownS: 50,
    from: 'skyhook',
    hotkey: 'B',
  },
];

/** The abilities a building offers, in catalog order — what its command card adds under the units. */
export function abilitiesFrom(type: StructureType): AbilityDef[] {
  return ABILITIES.filter((a) => a.from === type);
}

export const ABILITY_BY_ID = new Map<AbilityId, AbilityDef>(ABILITIES.map((a) => [a.id, a]));

/**
 * Orbital strike numbers. Separate from the ability's cost/cooldown because these are the WEAPON,
 * and the weapon is what balance work touches.
 *
 * The round falls from 120 km, which is what gives it its tell: several seconds of a bright point
 * dropping out of the sky before anything happens, long enough to walk out of if you notice.
 */
export const ORBITAL = {
  dmg: 320,
  splashM: 420,
  /** Metres per second on the way down. 120 km at 12 km/s is a ten-second warning. */
  speedMps: 12_000,
  dropFromM: 120_000,
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
