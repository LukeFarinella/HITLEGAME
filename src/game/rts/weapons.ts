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
 *
 * What a unit is CARRYING is assembled in {@link ./combat armamentOf}: this basic attack, plus any
 * factory-fitted weapon the chassis has, plus every researched upgrade that touches it.
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
  // it runs something down and takes it apart, which is how the player owns the melee corner of the
  // triangle at all. SERRATED ARMS sharpens it further.
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

// The hardpoint catalog that used to live below this line is gone. Bolting a weapon pod onto one
// individual machine was replaced by researching an upgrade that lands on every machine of that
// kind — see {@link ./research}. The weapons themselves survived the move: the lance, the mortar,
// the missile rack and the flak battery are the same numbers, now attached to a project rather than
// to a slot.
