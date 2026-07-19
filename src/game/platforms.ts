import type { UnitKind } from '../cesium/unitModels';

/**
 * Player platforms and the gear that bolts onto them.
 *
 * A platform is a hero unit: one at most, bought outright, ordered directly, and defined mostly by
 * what's installed on it rather than by what it is. That's the point of the hardpoint — the disc
 * and the siege walker run the same gear catalog, and which capabilities the player has in a
 * theater is a loadout question, not a purchase-list question.
 *
 * Capabilities are declared as string tags rather than booleans so a new piece of gear is a catalog
 * entry plus one `hasCapability` check at the point it matters.
 */

export type PlatformId = UnitKind &
  ('drone' | 'spider' | 'biped' | 'walker' | 'naval' | 'interceptor');

/** What a piece of gear grants. The scene asks for these by name. */
export type Capability = 'laser' | 'wide-sensor' | 'deep-scan' | 'detain';

/**
 * Base sensor radius for every platform — the same disc an obelisk watches.
 *
 * A platform sees no further than a fixed site by default. What it has over an obelisk is that it
 * MOVES, and what extends its reach is gear: the wide-aperture pod is the upgrade that turns a
 * platform into an area sensor rather than a walking obelisk.
 */
export const BASE_SENSOR_M = 750;

/** Buying more of a platform you already field. */
export interface Expansion {
  /** How many additional units this adds. */
  count: number;
  cost: number;
  name: string;
  blurb: string;
}

export interface PlatformDef {
  id: PlatformId;
  name: string;
  blurb: string;
  /** Cost of the first one. */
  cost: number;
  /** How many can be fielded at once. */
  maxCount: number;
  /** The one purchase that takes the fleet from 1 to {@link maxCount}, if there is one. */
  expansion?: Expansion;
  /** Must be fielded first — this is what makes a platform a late slot rather than just a dear one. */
  requires?: PlatformId;
  /** Gear slots. Bigger platforms carry more. Shared across every unit of the type. */
  hardpoints: number;
  /** Base sensor disc radius, metres, before any gear. */
  sensorM: number;
  /** Metres per second. */
  speed: number;
  /** Cruise altitude above ground. 0 for anything that walks. */
  altM: number;
}

/**
 * Listed in unlock order. The campaign opens fielding one arachnid and nothing else; the disc sits
 * in the last slot behind the walker, because being the only airborne platform — and by far the
 * fastest thing on the board — is the capstone capability rather than the entry one.
 */
export const PLATFORMS: PlatformDef[] = [
  {
    id: 'spider',
    name: 'ARACHNID SCOUT',
    blurb:
      'Six-legged walker at infantry scale. Outruns traffic through the street grid and reads what an orbital sensor cannot.',
    cost: 3000,
    maxCount: 4,
    expansion: {
      count: 3,
      cost: 7500,
      name: 'ARACHNID PICKET',
      blurb: 'Three more scouts, for a picket line across the theater rather than a single set of eyes.',
    },
    hardpoints: 1,
    sensorM: BASE_SENSOR_M,
    // Faster than the traffic it moves through (ground vehicles run 80 m/s). A scout that can be
    // outrun by the contacts it's watching can't reposition onto anything, which mattered more once
    // platform sensors came down to an obelisk's 750 m — reach is now legwork, not aperture.
    speed: 110,
    altM: 0,
  },
  {
    id: 'biped',
    name: 'MARSHAL BIPED',
    blurb:
      'Digitigrade two-legged walker, twice the mass of a ground vehicle. Fast enough to chase and armed enough to matter.',
    cost: 9000,
    maxCount: 2,
    expansion: {
      count: 1,
      cost: 11_000,
      name: 'SECOND MARSHAL',
      blurb: 'A second biped, so the pair can cover opposite ends of a theater.',
    },
    hardpoints: 2,
    sensorM: BASE_SENSOR_M,
    speed: 70,
    altM: 0,
  },
  {
    id: 'naval',
    name: 'LITTORAL DRONE',
    blurb:
      'Trimaran hull that works the coast and the crossings. The only platform that can hold station over water, where the ground platforms cannot follow.',
    cost: 16_000,
    maxCount: 2,
    expansion: {
      count: 1,
      cost: 18_000,
      name: 'SECOND HULL',
      blurb: 'A second littoral drone, so both sides of a strait can be held at once.',
    },
    hardpoints: 2,
    sensorM: BASE_SENSOR_M,
    speed: 90,
    altM: 0,
  },
  {
    id: 'interceptor',
    name: 'RAPTOR INTERCEPTOR',
    blurb:
      'Flying wing that dives on obelisk attackers without being tasked. Its strike is an area effect and it does not distinguish — everyone standing nearby is in it.',
    cost: 24_000,
    maxCount: 2,
    expansion: {
      count: 1,
      cost: 26_000,
      name: 'SECOND RAPTOR',
      blurb: 'A second wing, halving the time any site waits for one.',
    },
    hardpoints: 1,
    sensorM: BASE_SENSOR_M,
    speed: 620,
    altM: 2400,
  },
  {
    id: 'walker',
    name: 'COLOSSUS SIEGE WALKER',
    blurb:
      'Four-legged siege platform spanning several city blocks. Slow, enormous, and carries four hardpoints.',
    cost: 42_000,
    maxCount: 1,
    hardpoints: 4,
    sensorM: BASE_SENSOR_M,
    speed: 14,
    altM: 0,
  },
  {
    id: 'drone',
    name: 'DISC OBSERVER',
    blurb:
      'High-altitude disc. The only airborne platform and the fastest thing on the board — it crosses a theater while a walker crosses a city.',
    cost: 55_000,
    maxCount: 1,
    requires: 'walker',
    hardpoints: 2,
    sensorM: BASE_SENSOR_M,
    speed: 1000,
    altM: 1800,
  },
];

export const PLATFORM_BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

export interface GearDef {
  id: string;
  name: string;
  blurb: string;
  cost: number;
  grants: Capability;
  /** Platforms this fits, or 'all'. */
  fits: PlatformId[] | 'all';
  /**
   * Standing authorization required before this can be bought at all. Custody is granted by
   * the mission chain, not by money — the rig is useless without the power to use it.
   */
  requiresAuth?: 'detain' | 'execute';
}

export const GEAR: GearDef[] = [
  {
    id: 'laser',
    name: 'DIRECTED ENERGY EMITTER',
    blurb: 'Services contacts marked for execution that come inside the platform’s sensor envelope.',
    cost: 9000,
    grants: 'laser',
    fits: 'all',
  },
  {
    id: 'sensor-pod',
    name: 'WIDE-APERTURE SENSOR POD',
    blurb: 'Widens the platform’s sensor envelope by 65%.',
    cost: 5500,
    grants: 'wide-sensor',
    fits: 'all',
  },
  {
    id: 'detainer',
    name: 'DETAINMENT RIG',
    blurb:
      'Takes obelisk attackers non-lethally inside the platform’s envelope. Needs no execution authority and never touches the ledger.',
    cost: 6500,
    grants: 'detain',
    requiresAuth: 'detain',
    // Anything that can physically reach a person. Not the disc — you cannot take someone into
    // custody from cruise altitude.
    fits: ['spider', 'biped', 'walker', 'naval'],
  },
  {
    id: 'deep-scan',
    name: 'DEEP-SCAN ARRAY',
    blurb:
      'Tightens assessment on contacts inside the envelope — fewer false readings to act on.',
    cost: 7500,
    grants: 'deep-scan',
    fits: ['drone', 'biped', 'walker', 'naval'],
  },
];

export const GEAR_BY_ID = new Map(GEAR.map((g) => [g.id, g]));

/** How much a wide-aperture pod multiplies a platform's sensor radius. */
export const WIDE_SENSOR_MULT = 1.65;

/** A platform's fitted gear, one entry per hardpoint. `null` is an empty slot. */
export type Loadout = (string | null)[];

export function emptyLoadout(def: PlatformDef): Loadout {
  return new Array(def.hardpoints).fill(null);
}

export function gearFits(gear: GearDef, platform: PlatformId): boolean {
  return gear.fits === 'all' || gear.fits.includes(platform);
}
