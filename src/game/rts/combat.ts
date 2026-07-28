import type { UnitKind } from '../../cesium/unitModels';
import { BASIC_ATTACK, type Weapon } from './weapons';
import { upgradesFor, type ResearchId } from './research';

/**
 * Combat numbers for the RTS mode — what each chassis can absorb, and what it can carry.
 *
 * Keyed by MESH KIND, which now identifies the army as well as the machine: the two rosters field
 * disjoint chassis (see {@link ../../cesium/unitModels MILLSTONE_KINDS}), so there is no longer any
 * such thing as "a quadruped" that could belong to either side. What a unit IS answers whose it is.
 *
 * The WEAPONS are not here — they live in {@link ./weapons}, and what a unit is CARRYING is the
 * chassis' basic attack plus whatever the company has researched (see {@link ./research}). This
 * module owns the one thing genuinely fixed by the chassis and by nothing else: how much damage it
 * soaks before it comes apart.
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
 *     with its health intact — which is your escort's problem, not its own. SERRATED ARMS is what
 *     turns that trade: with it researched the arachnid wins the flenser duel instead of losing it.
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
   * Weapons welded on at the factory — a second gun the chassis simply HAS.
   *
   * Millstone's, in practice. The player's side gets its extra weapons from researched upgrades
   * instead (see {@link ../rts/research}), because there is an operator on that side to make the
   * choice; there is nobody on Millstone's to make it, and an AI silently refitting itself is a stat
   * line with extra steps.
   */
  fitted?: Weapon[];
}

/**
 * Hit points per chassis. Civilians are absent — the combat pass never arms one, and
 * {@link chassisCombat} throws rather than inventing a stat line for a bus.
 */
export const RTS_COMBAT: Partial<Record<UnitKind, ChassisCombat>> = {
  // ---- Gorgon ---------------------------------------------------------------------------------
  skid: { hp: 80 },
  dog: { hp: 140 },
  spider: { hp: 220 },
  biped: { hp: 320 },
  quad: { hp: 90 },
  interceptor: { hp: 160 },
  // The picket is deliberately flimsy — a hull's deck gun kills it in three. What you are buying is
  // presence on water early, not a fight. PICKET RADAR is what makes it worth keeping later.
  usv: { hp: 90 },
  naval: { hp: 260 },
  drone: { hp: 400 },
  // The most upgradeable thing you own: siege rounds, plate hull and flak doctrine all land on it,
  // which is what makes a late giga a different machine from the one that rolled out of the factory.
  walker: { hp: 1200 },

  // ---- Millstone ------------------------------------------------------------------------------
  drudge: { hp: 90 },
  // The line. Tougher than the dog it walks at, because walking at it is the entire plan.
  ripper: { hp: 190 },
  flenser: { hp: 260 },
  // The heavies carry a second, factory-fitted weapon — a close-in gun so an artillery piece caught
  // at contact range isn't simply free.
  bulwark: {
    hp: 420,
    fitted: [{ name: 'HULL GUN', kind: 'ranged', rangeM: 420, dmg: 9, periodS: 0.6 }],
  },
  mote: { hp: 80 },
  shrike: {
    hp: 170,
    fitted: [{ name: 'STRAFING GUN', kind: 'ranged', rangeM: 700, dmg: 11, periodS: 0.7 }],
  },
  hulk: {
    hp: 300,
    fitted: [{ name: 'DECK FLAK', kind: 'ranged', rangeM: 900, dmg: 12, periodS: 0.55 }],
  },
  censer: { hp: 360 },
  // The capstone runs three weapons at once: the wheel for anything that reaches it, and a pair of
  // batteries so that staying away from the wheel is also not free. It is meant to be answered by
  // an army, not by a unit.
  leviathan: {
    hp: 1500,
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

/**
 * Everything a unit fights with: hit points, and every weapon it is currently carrying — its basic
 * attack, then anything welded on at the factory, then everything the company has RESEARCHED that
 * touches this chassis. This is what gets stamped onto a unit when it is armed, so the sim never
 * looks anything up mid-fight; the armament travels with the unit.
 *
 * `done` is the player's completed research. Millstone is armed with it omitted — its chassis are
 * disjoint from yours, so no upgrade of yours could apply to one anyway, but passing nothing says so
 * out loud rather than relying on that.
 *
 * Multipliers stack MULTIPLICATIVELY across upgrades and land on every weapon in the final list,
 * including ones an upgrade added. That is deliberate: two damage upgrades on the same chassis
 * should compound, and FLAK DOCTRINE's battery on a quadruped should benefit from HEAVY BARRELS the
 * same way the shoulder gun does — the company rebored its barrels, not one gun.
 */
export function armamentOf(
  kind: UnitKind,
  done?: ReadonlySet<ResearchId>,
): { hp: number; weapons: Weapon[] } {
  const c = chassisCombat(kind);
  const ups = done ? upgradesFor(kind, done) : [];
  let hp = c.hp;
  let weapons: Weapon[] = [BASIC_ATTACK[kind], ...(c.fitted ?? [])];

  let dmg = 1, range = 1, period = 1, splash = 1;
  for (const u of ups) {
    if (u.adds) weapons.push(u.adds);
    hp *= u.hpMult ?? 1;
    dmg *= u.dmgMult ?? 1;
    range *= u.rangeMult ?? 1;
    period *= u.periodMult ?? 1;
    splash *= u.splashMult ?? 1;
  }
  if (dmg !== 1 || range !== 1 || period !== 1 || splash !== 1) {
    weapons = weapons.map((w) => ({
      ...w,
      dmg: Math.round(w.dmg * dmg),
      rangeM: Math.round(w.rangeM * range),
      periodS: +(w.periodS * period).toFixed(2),
      splashM: w.splashM === undefined ? undefined : Math.round(w.splashM * splash),
    }));
  }
  // A chassis whose basic attack is a placeholder (the ambient kinds) would arrive here with a
  // zero-damage weapon; drop those so the fight never carries a weapon that can't do anything.
  return { hp: Math.round(hp), weapons: weapons.filter((w) => w.dmg > 0) };
}
