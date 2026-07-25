import type { PlatformId } from '../platforms';
import type { StructureType } from './structures';

/**
 * The RTS unit roster.
 *
 * Units are sorted into four CATEGORIES — worker, infantry, aerial, special — the way an RTS sorts a
 * production tree. Each unit reuses an existing platform MESH (the game already has quadrupeds,
 * interceptors and a colossus modelled) so this is a data layer over the renderer, not new art.
 *
 * The producer is the whole tree: a unit is built from exactly one building, so selecting that
 * building is what surfaces the unit as an option. The Nexus builds workers; the robotics facility
 * builds infantry and the one special unit; aviation builds air. Nothing else here decides UI — the
 * command card just reads {@link unitsFrom}.
 */

export type UnitCategory = 'worker' | 'infantry' | 'aerial' | 'special';
export type RtsUnitId = 'worker' | 'quadruped' | 'interceptor' | 'giga';

export interface RtsUnitDef {
  id: RtsUnitId;
  name: string;
  category: UnitCategory;
  /** The existing platform mesh this unit renders as. */
  meshKind: PlatformId;
  cost: number;
  /** Seconds in the production queue before it rolls out. */
  buildTimeS: number;
  /** Supply consumed while alive — the whole point of the supply building. */
  supply: number;
  /** The one building that produces it. Selecting that building offers this unit. */
  producedBy: StructureType;
  hotkey: string;
}

export const RTS_UNITS: Record<RtsUnitId, RtsUnitDef> = {
  worker: {
    id: 'worker',
    name: 'WORKER DRONE',
    category: 'worker',
    meshKind: 'quad', // a small quadcopter — the builder drone
    cost: 50,
    buildTimeS: 8,
    supply: 1,
    producedBy: 'nexus',
    hotkey: 'W',
  },
  quadruped: {
    id: 'quadruped',
    name: 'QUADRUPED',
    category: 'infantry',
    meshKind: 'dog',
    cost: 75,
    buildTimeS: 12,
    supply: 2,
    producedBy: 'robotics',
    hotkey: 'Q',
  },
  interceptor: {
    id: 'interceptor',
    name: 'INTERCEPTOR',
    category: 'aerial',
    meshKind: 'interceptor',
    cost: 150,
    buildTimeS: 20,
    supply: 3,
    producedBy: 'aviation',
    hotkey: 'C',
  },
  giga: {
    id: 'giga',
    name: 'GIGA WALKER',
    category: 'special',
    meshKind: 'walker',
    cost: 400,
    buildTimeS: 45,
    supply: 8,
    producedBy: 'robotics',
    hotkey: 'G',
  },
};

export const RTS_UNIT_LIST: RtsUnitDef[] = Object.values(RTS_UNITS);

/** The units a given building can produce, in roster order — what its command card offers. */
export function unitsFrom(type: StructureType): RtsUnitDef[] {
  return RTS_UNIT_LIST.filter((u) => u.producedBy === type);
}

/** Whether a building produces anything at all (drives whether it shows a production card). */
export function producesUnits(type: StructureType): boolean {
  return RTS_UNIT_LIST.some((u) => u.producedBy === type);
}
