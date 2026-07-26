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

/**
 * NOTE ON HEALTH. Hit points are NOT defined here — they live in {@link ../rts/combat RTS_COMBAT},
 * keyed by chassis, because both armies field the same chassis and the combat pass stamps those
 * stats onto a unit when it is armed. The unit card reads the LIVE value off the field
 * (`unitField.rtsHpOf`), so what it shows is always the number combat is actually shooting at.
 * Shield and energy have no combat model yet and are owned here.
 */
export type UnitCategory = 'worker' | 'infantry' | 'aerial' | 'special';
export type RtsUnitId = 'worker' | 'quadruped' | 'interceptor' | 'giga';

export interface RtsUnitDef {
  id: RtsUnitId;
  name: string;
  category: UnitCategory;
  /** One line on what it's for — the unit card's description. */
  blurb: string;
  /** The existing platform mesh this unit renders as. */
  meshKind: PlatformId;
  /**
   * Regenerating damage buffer, absorbed before HP. Zero on units that carry no emitter — a worker
   * has nothing to project a screen with, which is part of why it must be escorted.
   */
  maxShield: number;
  /** Ability charge, spent by special actions. Regenerates. Zero on units with no abilities. */
  maxEnergy: number;
  cost: number;
  /** Seconds in the production queue before it rolls out. */
  buildTimeS: number;
  /** Supply consumed while alive — the whole point of the supply building. */
  supply: number;
  /** The one building that produces it. Selecting that building offers this unit. */
  producedBy: StructureType;
  /** A structure that must ALSO be built before this unit unlocks — the special unit's tech gate. */
  requiresStructure?: StructureType;
  hotkey: string;
}

export const RTS_UNITS: Record<RtsUnitId, RtsUnitDef> = {
  worker: {
    id: 'worker',
    name: 'WORKER',
    category: 'worker',
    blurb: 'Skid-steer loader. Constructs and repairs. Unarmed and unscreened — keep it behind the line.',
    meshKind: 'skid', // a skid-steer loader — the ground construction unit
    maxShield: 0,
    maxEnergy: 0,
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
    blurb: 'Four-legged line unit. Cheap, quick to field, and the backbone of any ground push.',
    meshKind: 'dog',
    maxShield: 40,
    maxEnergy: 0,
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
    blurb: 'Flying wing. Crosses the theater in seconds and strikes ground it was sent at.',
    meshKind: 'interceptor',
    maxShield: 80,
    maxEnergy: 100,
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
    blurb: 'Siege platform spanning several city blocks. Slow, enormous, and very hard to stop.',
    meshKind: 'walker',
    maxShield: 300,
    maxEnergy: 200,
    cost: 400,
    buildTimeS: 45,
    supply: 8,
    producedBy: 'robotics',
    requiresStructure: 'aviation', // the special unit sits at the top of the tech chain
    hotkey: 'G',
  },
};

/** Shield/energy regeneration, per second. Shields come back after a fight; HP does not. */
export const RTS_REGEN = { shield: 2, energy: 1.5 };

export const RTS_UNIT_LIST: RtsUnitDef[] = Object.values(RTS_UNITS);

/** The units a given building can produce, in roster order — what its command card offers. */
export function unitsFrom(type: StructureType): RtsUnitDef[] {
  return RTS_UNIT_LIST.filter((u) => u.producedBy === type);
}

/** Whether a building produces anything at all (drives whether it shows a production card). */
export function producesUnits(type: StructureType): boolean {
  return RTS_UNIT_LIST.some((u) => u.producedBy === type);
}
