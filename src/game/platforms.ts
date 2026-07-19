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

export type PlatformId = UnitKind & ('drone' | 'spider' | 'biped' | 'walker');

/** What a piece of gear grants. The scene asks for these by name. */
export type Capability = 'laser' | 'wide-sensor' | 'deep-scan';

export interface PlatformDef {
  id: PlatformId;
  name: string;
  blurb: string;
  cost: number;
  /** Gear slots. Bigger platforms carry more. */
  hardpoints: number;
  /** Base sensor disc radius, metres, before any gear. */
  sensorM: number;
  /** Metres per second. */
  speed: number;
  /** Cruise altitude above ground. 0 for anything that walks. */
  altM: number;
}

export const PLATFORMS: PlatformDef[] = [
  {
    id: 'drone',
    name: 'DISC OBSERVER',
    blurb: 'High-altitude disc. Fastest repositioning on the board and the widest bare sensor.',
    cost: 4000,
    hardpoints: 2,
    sensorM: 6000,
    speed: 1000,
    altM: 1800,
  },
  {
    id: 'spider',
    name: 'ARACHNID SCOUT',
    blurb:
      'Six-legged walker at infantry scale. Slips through the street grid and reads what an orbital sensor cannot.',
    cost: 3000,
    hardpoints: 1,
    sensorM: 1400,
    speed: 26,
    altM: 0,
  },
  {
    id: 'biped',
    name: 'MARSHAL BIPED',
    blurb:
      'Digitigrade two-legged walker, twice the mass of a ground vehicle. Fast enough to chase and armed enough to matter.',
    cost: 9000,
    hardpoints: 2,
    sensorM: 3200,
    speed: 70,
    altM: 0,
  },
  {
    id: 'walker',
    name: 'COLOSSUS SIEGE WALKER',
    blurb:
      'Four-legged siege platform spanning several city blocks. Slow, enormous, and carries four hardpoints.',
    cost: 42_000,
    hardpoints: 4,
    sensorM: 9000,
    speed: 14,
    altM: 0,
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
    id: 'deep-scan',
    name: 'DEEP-SCAN ARRAY',
    blurb:
      'Tightens assessment on contacts inside the envelope — fewer false readings to act on.',
    cost: 7500,
    grants: 'deep-scan',
    fits: ['drone', 'biped', 'walker'],
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
