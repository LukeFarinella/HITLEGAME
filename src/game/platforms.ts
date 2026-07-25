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
  ('drone' | 'dog' | 'quad' | 'spider' | 'biped' | 'walker' | 'naval' | 'interceptor' | 'skid');

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
  /** Tasking that must be cleared before this can be bought at all. */
  requiresMission?: string;
  /** Fork branch that must have been taken before this is offered — see Asset.requiresChoice. */
  requiresChoice?: { mission: string; choice: string; label: string };
  /** Gear slots. Bigger platforms carry more. Shared across every unit of the type. */
  hardpoints: number;
  /** Base sensor disc radius, metres, before any gear. */
  sensorM: number;
  /** Metres per second. */
  speed: number;
  /** Cruise altitude above ground. 0 for anything that walks. */
  altM: number;
  /**
   * Whether this platform is confined to the road network.
   *
   * Only the dog is. Everything else — legged, flying or floating — goes point to point, and the
   * dog having to take the streets is what makes it feel like the cheap option rather than just a
   * slower one: a target three blocks away is three blocks away, and a target across a river is a
   * different problem entirely.
   */
  roadBound?: boolean;
  /**
   * Capabilities the platform has WITHOUT gear, usable only against units attacking the network.
   *
   * Deliberately not the same thing as a fitted rig. Taking hold of somebody who is pulling a site
   * down is self-defence of company property; taking hold of a member of the public is custody, and
   * that needs both the hardware and the authority the chain grants for it. Keeping them separate is
   * what lets the opening platform answer an attack without quietly handing the operator a power the
   * story hasn't given them yet.
   *
   * These are also MANUAL only — they never feed the automatic detain sweep, because a platform that
   * deals with attackers on its own is a platform the operator isn't answerable for.
   */
  selfDefence?: Capability[];
}

/**
 * Listed in unlock order. The campaign opens fielding one arachnid and nothing else; the disc sits
 * in the last slot behind the walker, because being the only airborne platform — and by far the
 * fastest thing on the board — is the capstone capability rather than the entry one.
 */
export const PLATFORMS: PlatformDef[] = [
  {
    id: 'dog',
    name: 'KENNEL QUADRUPED',
    blurb:
      'Four-legged walker at animal scale. Confined to the road network and no match for traffic — the cheapest way to have eyes somewhere.',
    cost: 2000,
    maxCount: 4,
    expansion: {
      count: 3,
      cost: 500,
      name: 'KENNEL PACK',
      blurb: 'Three more quadrupeds, for a picket across the street grid rather than a single set of eyes.',
    },
    hardpoints: 1,
    sensorM: BASE_SENSOR_M,
    // Responsiveness pass: every platform runs at 3× its old spec so orders read as immediate rather
    // than as a slow drift across the theater. The dog is still the slowest thing you can field and
    // still road-bound — its limit is the street grid, not the speedometer.
    speed: 132,
    altM: 0,
    roadBound: true,
    // The quadruped can take an attacker off a site bare-handed. It is the campaign's opening
    // platform and attacks begin long before custody authority exists — without this the entire
    // early game has no answer to a siege at all.
    selfDefence: ['detain'],
  },
  {
    id: 'quad',
    requiresMission: 'canvass',
    name: 'KITE QUADCOPTER',
    blurb:
      'The quadruped’s aerial counterpart: the same sensor at the same modest pace, but it crosses rivers, rail and rooftops instead of driving around them.',
    cost: 4500,
    maxCount: 3,
    expansion: {
      count: 2,
      cost: 8000,
      name: 'KITE FLIGHT',
      blurb: 'Two more rotorcraft, so a theater can be covered from the air without waiting on roads.',
    },
    hardpoints: 1,
    sensorM: BASE_SENSOR_M,
    // Marginally quicker than the dog. What it is buying is not speed, it is the straight line.
    speed: 180,
    altM: 400,
  },
  {
    id: 'spider',
    requiresMission: 'custody',
    name: 'ARACHNID PURSUIT',
    blurb:
      'Six-legged walker at vehicle scale. Outruns everything on the road and goes where the road does not — the first platform that can actually chase a contact down.',
    cost: 11_000,
    maxCount: 3,
    requires: 'dog',
    expansion: {
      count: 2,
      cost: 14_000,
      name: 'ARACHNID PICKET',
      blurb: 'Two more pursuit walkers, for a picket line across the theater rather than a single response.',
    },
    hardpoints: 2,
    sensorM: BASE_SENSOR_M,
    // Comfortably faster than the traffic it moves through (ground vehicles run 80 m/s), and off
    // the graph entirely — this is the platform you buy when the dog could not get there in time.
    speed: 780,
    altM: 0,
  },
  {
    id: 'biped',
    requiresMission: 'lockdown',
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
    speed: 420,
    altM: 0,
  },
  {
    id: 'naval',
    requiresMission: 'prisoners',
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
    speed: 540,
    altM: 0,
  },
  {
    id: 'interceptor',
    requiresMission: 'protect2',
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
    speed: 3720,
    altM: 2400,
  },
  {
    id: 'walker',
    requiresMission: 'attrition',
    name: 'COLOSSUS SIEGE WALKER',
    blurb:
      'Four-legged siege platform spanning several city blocks. Slow, enormous, and carries four hardpoints.',
    cost: 42_000,
    maxCount: 1,
    hardpoints: 4,
    sensorM: BASE_SENSOR_M,
    speed: 84,
    altM: 0,
  },
  {
    id: 'drone',
    requiresMission: 'quarantine',
    name: 'DISC OBSERVER',
    blurb:
      'High-altitude disc. The only airborne platform and the fastest thing on the board — it crosses a theater while a walker crosses a city.',
    cost: 55_000,
    maxCount: 1,
    requires: 'walker',
    hardpoints: 2,
    sensorM: BASE_SENSOR_M,
    speed: 6000,
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
  /** Tasking that must be cleared before this can be bought at all. */
  requiresMission?: string;
  /** Fork branch that must have been taken before this is offered — see Asset.requiresChoice. */
  requiresChoice?: { mission: string; choice: string; label: string };
  /**
   * Blast radius in metres for an AREA weapon (napalm, MOAB, the orbital laser). Metadata only for
   * now — the lethal-service path still fires one shot at one contact. When area service lands, this
   * is what it reads to sweep everyone in the ring, so the ladder is a real escalation and not four
   * reskins of the same beam. The flag also lets the store say "AREA" on the ones that don't
   * discriminate, which is the whole point of them.
   */
  areaM?: number;
}

/**
 * The lethal-service capability is tagged `'laser'` for historical reasons — it predates there being
 * more than one lethal weapon. Every weapon below that can KILL grants it (the machine gun, napalm,
 * the orbital laser, the MOAB), and the EXECUTE rung asks for it by that name. Read it as "can carry
 * out a killing", not "is literally a laser".
 */
export const GEAR: GearDef[] = [
  // ---- non-lethal takedown (grant 'detain') ----
  {
    id: 'taser',
    requiresMission: 'stopsearch',
    name: 'TASER LANCE',
    blurb:
      'The lightest way to put a contact on the ground. Non-lethal, cheap, and fits the small platforms the heavier rig will not.',
    cost: 3500,
    grants: 'detain',
    requiresAuth: 'detain',
    fits: ['dog', 'quad', 'spider', 'biped'],
  },
  {
    id: 'less-lethal',
    requiresMission: 'defend',
    name: 'LESS-LETHAL SUITE',
    blurb:
      'Gas, foam and stun over an area — clears a crowd off a site without killing it. Custody by volume rather than by contact.',
    cost: 8000,
    grants: 'detain',
    requiresAuth: 'detain',
    areaM: 60,
    fits: ['spider', 'biped', 'walker', 'naval'],
  },
  // ---- lethal service (grant 'laser') ----
  {
    id: 'machine-gun',
    requiresMission: 'containment',
    name: 'AUTOCANNON',
    blurb:
      'Kinetic lethal service — the first weapon cleared to carry out an execution. Crude, cheap, and it does the job the beam does.',
    cost: 8000,
    grants: 'laser',
    fits: ['dog', 'spider', 'biped', 'walker', 'naval', 'interceptor'],
  },
  {
    id: 'laser',
    requiresMission: 'sanction',
    name: 'DIRECTED ENERGY EMITTER',
    blurb: 'Silent, precise lethal service inside the platform’s envelope. Cleaner than the autocannon, and it fits anything.',
    cost: 12_000,
    grants: 'laser',
    fits: 'all',
  },
  {
    id: 'napalm',
    requiresMission: 'supply',
    name: 'INCENDIARY POD',
    blurb:
      'Denies ground rather than reads it. Lethal over an area and does not distinguish — everyone in the ring is in it.',
    cost: 16_000,
    grants: 'laser',
    areaM: 120,
    fits: ['interceptor', 'walker', 'drone'],
  },
  {
    id: 'orbital-laser',
    requiresMission: 'terrorstrike',
    name: 'ORBITAL LANCE',
    blurb:
      'Lethal service from above the atmosphere, on coordinates you confirm. Long reach, wide footprint, no platform in the theater required underneath it.',
    cost: 24_000,
    grants: 'laser',
    areaM: 90,
    fits: ['drone', 'interceptor'],
  },
  {
    id: 'moab',
    requiresMission: 'consolidation',
    name: 'MASS ORDNANCE',
    blurb: 'The largest thing the console can drop. Lethal across several blocks — a front, not a contact.',
    cost: 40_000,
    grants: 'laser',
    areaM: 300,
    fits: ['interceptor', 'walker', 'drone'],
  },
  // ---- sensor / support ----
  {
    id: 'sensor-pod',
    // Rides the ADVANCED SENSOR RANGE branch of the mandate fork — taking TEMPORARY OBELISKS instead
    // closes this off for the campaign.
    requiresChoice: { mission: 'mandate', choice: 'sensor-range', label: 'ADVANCED SENSOR RANGE' },
    name: 'WIDE-APERTURE SENSOR POD',
    blurb: 'Widens the platform’s sensor envelope by 65%.',
    cost: 5500,
    grants: 'wide-sensor',
    fits: 'all',
  },
  {
    id: 'detainer',
    requiresMission: 'custody',
    name: 'DETAINMENT RIG',
    blurb:
      'Takes obelisk attackers non-lethally inside the platform’s envelope. Needs no execution authority and never touches the ledger.',
    cost: 6500,
    grants: 'detain',
    requiresAuth: 'detain',
    // Anything that can physically reach a person. Not the disc — you cannot take someone into
    // custody from cruise altitude.
    fits: ['dog', 'spider', 'biped', 'walker', 'naval'],
  },
  {
    id: 'deep-scan',
    requiresMission: 'sanction',
    name: 'DEEP-SCAN ARRAY',
    blurb:
      'Tightens assessment on contacts inside the envelope — fewer false readings to act on.',
    cost: 7500,
    grants: 'deep-scan',
    fits: ['drone', 'quad', 'biped', 'walker', 'naval'],
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
