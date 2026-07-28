import type { UnitKind } from '../../cesium/unitModels';
import { BASIC_ATTACK, MOUNT_BY_ID, type RtsLoadout, type Weapon } from './weapons';

/**
 * Combat numbers for the RTS mode — what each chassis can absorb, and what it can carry.
 *
 * Keyed by MESH KIND, which now identifies the army as well as the machine: the two rosters field
 * disjoint chassis (see {@link ../../cesium/unitModels MILLSTONE_KINDS}), so there is no longer any
 * such thing as "a quadruped" that could belong to either side. What a unit IS answers whose it is.
 *
 * The WEAPONS are not here — they live in {@link ./weapons}, because a unit's armament is its basic
 * attack plus whatever is fitted, and the fitted half is per-unit state rather than per-chassis
 * data. This module owns the two things that are genuinely fixed by the chassis: how much damage it
 * soaks, and how many hardpoints it has to fit things into.
 *
 * Balance intent, so the numbers read as decisions rather than dice:
 *
 * GORGON shoots. Its line is ranged, it out-ranges Millstone's line by a mile, and its problem is
 * that everything it owns dies quickly at contact range. A Gorgon army that gets to shoot for ten
 * seconds before contact wins; one that gets surprised at 200 m loses regardless of what it cost.
 *   - The QUADRUPED is the line: cheap, short-armed, dies in threes.
 *   - The ARACHNID is the exception that proves it: the one Gorgon unit that has to close, trading
 *     the line's standoff for roughly twice its damage once it arrives. It has 220 hit points against
 *     the flenser's 260 and gets there first, so the trade is decided by whether it reaches contact
 *     with its health intact — which is your escort's problem, not its own. Note the side effect of
 *     fitting: a gun in its hardpoint makes it no longer melee-only, and a unit that isn't melee-only
 *     stops closing on its own. Fitting a lance buys standoff and gives up the chase.
 *   - The INTERCEPTOR outranges the quadruped and hits harder per shot, but its damage-per-second is
 *     barely better — what you're buying is the standoff and the airspeed.
 *   - The GIGA WALKER outranges everything and soaks an obelisk's worth of fire. One giga anchors an
 *     assault; it does not replace the army, because DPS-per-cost still favours the dogs.
 *   - The WORKER can now fight, badly, with a bucket. Losing one to a wave you ignored is still the
 *     cost of ignoring the wave — it just isn't a spectator at its own death any more.
 *
 * MILLSTONE closes. Its line carries no gun at all, so every point of damage it deals is damage it
 * drove into contact to deal — and it is built to survive that drive: a ripper has 36% more hit
 * points than the quadruped it is sent against and costs the AI nothing. What stops it is being
 * shot for long enough, which is exactly the thing its artillery exists to make expensive.
 */

export interface ChassisCombat {
  hp: number;
  /**
   * Empty hardpoints the player can fit weapons into. Zero on Millstone's chassis — its hardpoints
   * come pre-filled from the factory (see {@link fitted}), because there is no operator on that side
   * to make the choice and an AI silently refitting itself is just a stat line with extra steps.
   */
  hardpoints: number;
  /** Weapons welded on at the factory. Millstone's half of the hardpoint system. */
  fitted?: Weapon[];
}

/**
 * Hit points and hardpoint capacity per chassis. Civilians are absent — the combat pass never arms
 * one, and {@link chassisCombat} throws rather than inventing a stat line for a bus.
 */
export const RTS_COMBAT: Partial<Record<UnitKind, ChassisCombat>> = {
  // ---- Gorgon ---------------------------------------------------------------------------------
  skid: { hp: 80, hardpoints: 1 },
  dog: { hp: 140, hardpoints: 1 },
  spider: { hp: 220, hardpoints: 1 },
  biped: { hp: 320, hardpoints: 2 },
  quad: { hp: 90, hardpoints: 1 },
  interceptor: { hp: 160, hardpoints: 1 },
  // The picket is deliberately flimsy: one hardpoint, and a hull's deck gun kills it in three. What
  // you are buying is presence on water early, not a fight.
  usv: { hp: 90, hardpoints: 1 },
  naval: { hp: 260, hardpoints: 2 },
  drone: { hp: 400, hardpoints: 2 },
  // Four slots, as in the campaign catalog: the walker is the platform defined by what's bolted to
  // it rather than by what it is, and that is as true in a skirmish as in the campaign.
  walker: { hp: 1200, hardpoints: 4 },

  // ---- Millstone ------------------------------------------------------------------------------
  drudge: { hp: 90, hardpoints: 0 },
  // The line. Tougher than the dog it walks at, because walking at it is the entire plan.
  ripper: { hp: 190, hardpoints: 0 },
  flenser: { hp: 260, hardpoints: 0 },
  // The heavies carry a second, pre-fitted weapon — a close-in gun so an artillery piece caught at
  // contact range isn't simply free, which is the same reason a player fits a pintle.
  bulwark: {
    hp: 420,
    hardpoints: 0,
    fitted: [{ name: 'HULL GUN', kind: 'ranged', rangeM: 420, dmg: 9, periodS: 0.6 }],
  },
  mote: { hp: 80, hardpoints: 0 },
  shrike: {
    hp: 170,
    hardpoints: 0,
    fitted: [{ name: 'STRAFING GUN', kind: 'ranged', rangeM: 700, dmg: 11, periodS: 0.7 }],
  },
  hulk: {
    hp: 300,
    hardpoints: 0,
    fitted: [{ name: 'DECK FLAK', kind: 'ranged', rangeM: 900, dmg: 12, periodS: 0.55 }],
  },
  censer: { hp: 360, hardpoints: 0 },
  // The capstone runs three weapons at once: the wheel for anything that reaches it, and a pair of
  // batteries so that staying away from the wheel is also not free. It is meant to be answered by
  // an army, not by a unit.
  leviathan: {
    hp: 1500,
    hardpoints: 0,
    fitted: [
      { name: 'HULL BATTERY', kind: 'ranged', rangeM: 1100, dmg: 22, periodS: 0.9 },
      { name: 'SIEGE MORTAR', kind: 'projectile', rangeM: 1800, dmg: 45, periodS: 2.4, speedMps: 700, splashM: 150 },
    ],
  },
};

/** Chassis stats, throwing if it was never given any — fielding it armed is a code bug. */
export function chassisCombat(kind: UnitKind): ChassisCombat {
  const s = RTS_COMBAT[kind];
  if (!s) throw new Error(`no RTS combat stats for ${kind}`);
  return s;
}

/** How many hardpoints a chassis offers the player. Zero for anything with none, never throws. */
export function hardpointsOf(kind: UnitKind): number {
  return RTS_COMBAT[kind]?.hardpoints ?? 0;
}

/**
 * Everything a unit fights with: hit points, and every weapon it is currently carrying — its basic
 * attack first, then the factory-fitted ones, then whatever the player has bolted into its
 * hardpoints. This is what gets stamped onto a unit when it's armed, so the sim never looks
 * anything up mid-fight; the armament travels with the unit.
 */
export function armamentOf(kind: UnitKind, loadout?: RtsLoadout): { hp: number; weapons: Weapon[] } {
  const c = chassisCombat(kind);
  const weapons: Weapon[] = [BASIC_ATTACK[kind], ...(c.fitted ?? [])];
  for (const id of loadout ?? []) {
    const m = id ? MOUNT_BY_ID.get(id) : undefined;
    if (m) weapons.push(m.weapon);
  }
  // A chassis whose basic attack is a placeholder (the ambient kinds) would arrive here with a
  // zero-damage weapon; drop those so the fight never carries a weapon that can't do anything.
  return { hp: c.hp, weapons: weapons.filter((w) => w.dmg > 0) };
}
