import type { UnitKind } from '../../cesium/unitModels';

/**
 * Weapons, and the three ways a thing can hit another thing.
 *
 * Combat used to be one number per chassis — a range, a damage, a period — which made every fight
 * the same fight at a different distance. This splits an attack into a KIND, and the kind is what
 * decides how the fight feels:
 *
 *   MELEE      Contact reach. The hardest hitting weapons in the game per second, on the shortest
 *              leash: a melee unit has to cross the ground its target is shooting across, and it
 *              spends that crossing being shot. It closes on its own (see the combat pass) rather
 *              than waiting to be micromanaged into contact.
 *   RANGED     Hitscan. Fires, and the damage is already applied — the beam is a drawing of a hit
 *              that has happened. The dependable middle: no travel, no lead, no splash.
 *   PROJECTILE A round that FLIES. Aimed where the target stood when the trigger went, so it lands
 *              on a slow unit and lands behind a fast one, and it hurts everything inside its
 *              splash rather than the one thing it was aimed at. The long-range option, paid for
 *              in the seconds between firing and landing.
 *
 * That triangle is the whole reason both armies field all three: projectiles out-range ranged fire
 * and punish massed slow units, ranged fire kills melee before it lands, and melee walks through
 * projectile fire (it leads badly against anything quick) to reach the artillery.
 */

export type AttackKind = 'melee' | 'ranged' | 'projectile';

export interface Weapon {
  name: string;
  kind: AttackKind;
  /** Reach in metres. Melee reaches are deliberately a fraction of a rifle's. */
  rangeM: number;
  /** Damage per shot, before splash falloff. */
  dmg: number;
  /** Seconds between shots. */
  periodS: number;
  /**
   * Flight speed, metres per second. PROJECTILE only — it's what turns range into a delay, and a
   * slow round is what makes leading a fast target fail.
   */
  speedMps?: number;
  /**
   * Splash radius on impact, metres. Everything inside takes the hit, friend included — a mortar
   * does not check flags, which is the cost of firing one into a melee.
   */
  splashM?: number;
}

// ---- basic attacks ------------------------------------------------------------------------------
//
// Every chassis in the game has one, including the workers. A worker's is a genuinely bad weapon —
// a bucket swung at contact range — but "bad at fighting" and "cannot fight" are different design
// statements, and the second one made a worker a spectator at its own death.

/** The basic attack every chassis carries, keyed by mesh kind. Both armies. */
export const BASIC_ATTACK: Record<UnitKind, Weapon> = {
  // ---- ambient population. Civilians carry nothing; these exist so the record is total, and the
  // combat pass never fields them anyway.
  land: { name: 'NONE', kind: 'melee', rangeM: 0, dmg: 0, periodS: 1 },
  sea: { name: 'NONE', kind: 'melee', rangeM: 0, dmg: 0, periodS: 1 },
  air: { name: 'NONE', kind: 'melee', rangeM: 0, dmg: 0, periodS: 1 },
  foot: { name: 'NONE', kind: 'melee', rangeM: 0, dmg: 0, periodS: 1 },

  // ---- Gorgon ---------------------------------------------------------------------------------
  // The player's line is RANGED by default: precise, standoff, and the thing Millstone has to cross
  // ground to reach. Three exceptions carry the other kinds, so the player owns all three without
  // having to fit anything.
  skid: { name: 'LOADER BUCKET', kind: 'melee', rangeM: 90, dmg: 14, periodS: 1.6 },
  dog: { name: 'SHOULDER GUN', kind: 'ranged', rangeM: 650, dmg: 12, periodS: 0.8 },
  // The one Gorgon unit that CHASES. A pursuit walker that then shot from 800 m was a contradiction:
  // the speed bought nothing the shoulder gun didn't already have. Blades make the legs the point —
  // it runs something down and takes it apart, which is the only way the player owns the melee corner
  // of the triangle without fitting a ram to something slow.
  spider: { name: 'PURSUIT BLADES', kind: 'melee', rangeM: 150, dmg: 42, periodS: 0.8 },
  biped: { name: 'SERVICE CANNON', kind: 'ranged', rangeM: 950, dmg: 26, periodS: 0.9 },
  quad: { name: 'SIDEARM', kind: 'ranged', rangeM: 700, dmg: 8, periodS: 1.0 },
  interceptor: { name: 'STRIKE LANCE', kind: 'ranged', rangeM: 1500, dmg: 30, periodS: 1.5 },
  // The picket's gun is the smallest thing that shoots: enough to bully another picket or finish a
  // worker, nowhere near enough to trade with a hull.
  usv: { name: 'PICKET GUN', kind: 'ranged', rangeM: 600, dmg: 9, periodS: 0.8 },
  // The hull's gun is the player's basic projectile: it lobs, so it reaches past anything on the
  // shore that could answer it, and it lands late.
  naval: { name: 'DECK GUN', kind: 'projectile', rangeM: 1200, dmg: 22, periodS: 1.1, speedMps: 900, splashM: 90 },
  drone: { name: 'ALTITUDE LANCE', kind: 'ranged', rangeM: 1700, dmg: 20, periodS: 1.2 },
  walker: { name: 'SIEGE BATTERY', kind: 'projectile', rangeM: 1900, dmg: 60, periodS: 1.4, speedMps: 800, splashM: 140 },

  // ---- Millstone ------------------------------------------------------------------------------
  // The rival army is MELEE-forward. It is built to close: cheap grinding hardware that wants to be
  // in contact, screened by artillery that makes standing still expensive. Where Gorgon shoots
  // across ground, Millstone takes it.
  drudge: { name: 'GRAB CLAW', kind: 'melee', rangeM: 90, dmg: 16, periodS: 1.5 },
  ripper: { name: 'CUTTER DRUM', kind: 'melee', rangeM: 120, dmg: 30, periodS: 0.9 },
  flenser: { name: 'FLENSING ARMS', kind: 'melee', rangeM: 140, dmg: 44, periodS: 0.8 },
  bulwark: { name: 'PLATE MORTAR', kind: 'projectile', rangeM: 1250, dmg: 34, periodS: 1.8, speedMps: 700, splashM: 130 },
  mote: { name: 'FAN GUN', kind: 'ranged', rangeM: 620, dmg: 7, periodS: 0.9 },
  shrike: { name: 'ROCKET RAIL', kind: 'projectile', rangeM: 1450, dmg: 28, periodS: 1.6, speedMps: 1100, splashM: 80 },
  hulk: { name: 'BARGE GUN', kind: 'projectile', rangeM: 1150, dmg: 26, periodS: 1.3, speedMps: 850, splashM: 100 },
  censer: { name: 'CENSER EMITTER', kind: 'ranged', rangeM: 1600, dmg: 18, periodS: 1.1 },
  // The capstone is the army's name made literal: a grinding wheel that reduces whatever it reaches.
  // Enormous melee damage on a platform slow enough that reaching anything is the hard part.
  leviathan: { name: 'GRINDING WHEEL', kind: 'melee', rangeM: 260, dmg: 150, periodS: 1.5 },
};

// ---- hardpoint weapons --------------------------------------------------------------------------

export type WeaponId =
  | 'pintle'
  | 'lance'
  | 'mortar'
  | 'missiles'
  | 'ram'
  | 'flak';

export interface MountDef {
  id: WeaponId;
  name: string;
  /** One line for the fitting card. */
  blurb: string;
  /** Money, charged when it is fitted. Refitting a slot refunds nothing — a pod is consumed. */
  cost: number;
  weapon: Weapon;
  /** Chassis this fits, or 'all' for anything with a slot. */
  fits: UnitKind[] | 'all';
  hotkey: string;
}

/**
 * What the player can bolt into a hardpoint.
 *
 * The catalog is deliberately short and each entry is a different ANSWER rather than a bigger
 * number: the ram is how a slow platform stops being kited, the mortar is how a ground line reaches
 * something that outranges it, the flak is how an army that keeps losing to air stops losing to air.
 * Fitting is per-unit and permanent for that unit's life, so a loadout is a decision about one
 * machine rather than a global upgrade — which is what makes a mixed army worth building.
 */
export const MOUNTS: MountDef[] = [
  {
    id: 'pintle',
    name: 'PINTLE GUN',
    blurb: 'A second barrel on the same mount. Cheap, short, and it simply adds fire.',
    cost: 60,
    weapon: { name: 'PINTLE GUN', kind: 'ranged', rangeM: 600, dmg: 10, periodS: 0.7 },
    fits: 'all',
    hotkey: '1',
  },
  {
    id: 'lance',
    name: 'DIRECTED LANCE',
    blurb: 'Long, precise, silent. Reaches past the line it is standing behind.',
    cost: 130,
    weapon: { name: 'DIRECTED LANCE', kind: 'ranged', rangeM: 1400, dmg: 24, periodS: 1.3 },
    fits: ['spider', 'biped', 'walker', 'naval', 'drone', 'interceptor'],
    hotkey: '2',
  },
  {
    id: 'mortar',
    name: 'SIEGE MORTAR',
    blurb: 'Lobbed and slow. Out-ranges a ground line and does not care what else is standing there.',
    cost: 170,
    weapon: { name: 'SIEGE MORTAR', kind: 'projectile', rangeM: 1700, dmg: 40, periodS: 2.2, speedMps: 650, splashM: 160 },
    fits: ['biped', 'walker', 'naval'],
    hotkey: '3',
  },
  {
    id: 'missiles',
    name: 'MISSILE RACK',
    blurb: 'Fast rounds, tight burst radius. The projectile that still lands on something moving.',
    cost: 150,
    weapon: { name: 'MISSILE RACK', kind: 'projectile', rangeM: 1300, dmg: 32, periodS: 1.5, speedMps: 1400, splashM: 60 },
    fits: ['quad', 'interceptor', 'drone', 'walker', 'naval', 'usv'],
    hotkey: '4',
  },
  {
    id: 'ram',
    name: 'BREACHING RAM',
    blurb: 'Contact reach, brutal damage. What a slow platform fits so that being caught is the other side’s problem.',
    cost: 110,
    weapon: { name: 'BREACHING RAM', kind: 'melee', rangeM: 150, dmg: 70, periodS: 1.2 },
    fits: ['dog', 'spider', 'biped', 'walker', 'skid'],
    hotkey: '5',
  },
  {
    id: 'flak',
    name: 'FLAK BATTERY',
    blurb: 'A fast, wide burst built for things in the air. Unpleasant at any altitude, lethal at cruise.',
    cost: 120,
    weapon: { name: 'FLAK BATTERY', kind: 'ranged', rangeM: 1100, dmg: 14, periodS: 0.5 },
    fits: ['dog', 'spider', 'biped', 'walker', 'naval', 'quad', 'usv'],
    hotkey: '6',
  },
];

export const MOUNT_BY_ID = new Map(MOUNTS.map((m) => [m.id, m]));

/** Whether a mount fits a chassis. */
export function mountFits(mount: MountDef, kind: UnitKind): boolean {
  return mount.fits === 'all' || mount.fits.includes(kind);
}

/** The mounts offerable on a chassis, in catalog order — what the fitting card lists. */
export function mountsFor(kind: UnitKind): MountDef[] {
  return MOUNTS.filter((m) => mountFits(m, kind));
}

/** A unit's fitted hardpoints, one entry per slot. `null` is empty. */
export type RtsLoadout = (WeaponId | null)[];

/** Every weapon a chassis is currently firing: its basic attack plus whatever is bolted on. */
export function weaponsOf(kind: UnitKind, loadout: RtsLoadout | undefined): Weapon[] {
  const out: Weapon[] = [BASIC_ATTACK[kind]];
  for (const id of loadout ?? []) {
    if (!id) continue;
    const m = MOUNT_BY_ID.get(id);
    if (m) out.push(m.weapon);
  }
  return out;
}
