import type { PlatformId } from '../platforms';

/**
 * Combat numbers for the RTS mode — hit points and the one weapon each chassis carries.
 *
 * Keyed by MESH KIND ({@link PlatformId}) rather than by roster id, because both armies field the
 * same chassis: a Millstone quadruped is the player's quadruped with a different paymaster. The
 * unit field stamps these onto a unit when it's armed (see units.ts `armRtsCombat`), so the sim
 * never has to look a unit's stats up mid-fight — the stats travel with the unit.
 *
 * Balance intent, so the numbers read as decisions rather than dice:
 *   - The QUADRUPED is the line infantry: cheap, short-armed, dies in threes.
 *   - The INTERCEPTOR outranges the quadruped and hits harder per shot, but its damage-per-second
 *     is barely better — what you're buying is the standoff and the airspeed.
 *   - The GIGA WALKER outranges everything, out-hits everything, and soaks an obelisk's worth of
 *     fire. One giga anchors an assault; it does not replace the army, because DPS-per-cost still
 *     favours the dogs.
 *   - The WORKER is unarmed. Losing one to a wave you ignored is the cost of ignoring the wave.
 */
export interface CombatStats {
  hp: number;
  /** Weapon reach in metres. 0 = unarmed. */
  rangeM: number;
  /** Damage per shot. */
  dmg: number;
  /** Seconds between shots. */
  periodS: number;
}

export const RTS_COMBAT: Partial<Record<PlatformId, CombatStats>> = {
  skid: { hp: 80, rangeM: 0, dmg: 0, periodS: 1 },
  dog: { hp: 140, rangeM: 650, dmg: 12, periodS: 0.8 },
  interceptor: { hp: 160, rangeM: 1500, dmg: 30, periodS: 1.5 },
  walker: { hp: 1200, rangeM: 1900, dmg: 60, periodS: 1.4 },
};

/** Stats for a chassis, throwing if it was never given any — fielding it armed is a code bug. */
export function combatStats(kind: PlatformId): CombatStats {
  const s = RTS_COMBAT[kind];
  if (!s) throw new Error(`no RTS combat stats for ${kind}`);
  return s;
}
