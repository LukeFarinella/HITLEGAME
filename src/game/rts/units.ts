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
 * building is what surfaces the unit as an option. Nothing else here decides UI — the command card
 * just reads {@link unitsFrom}.
 *
 *   NEXUS      worker
 *   ROBOTICS   quadruped · kite (behind the tech facility)
 *   AVIATION   interceptor · disc observer
 *   SPECIAL    arachnid · marshal · giga walker · littoral
 *
 * Producer is deliberately NOT the same axis as {@link UnitCategory}: a kite is an aerial unit that
 * happens to roll out of robotics, and an arachnid is infantry that happens to need the special
 * facility. Category says what the machine IS; producer says what you have to have built to get it.
 * Keeping them separate is what lets the tech tree be re-cut without renaming anything.
 *
 * NOTE ON TECH GATES. `requiresStructure` is only for a unit whose producer can exist BEFORE the
 * gate. The chain is 3 obelisks → data center → robotics → tech → aviation → special, so anything
 * produced by aviation or special is already past tech and needs no explicit gate — the facility
 * that builds it IS the gate. Only the kite carries one, because robotics comes before tech.
 */

/**
 * NOTE ON HEALTH. Hit points are NOT defined here — they live in {@link ../rts/combat RTS_COMBAT},
 * keyed by chassis, because both armies field the same chassis and the combat pass stamps those
 * stats onto a unit when it is armed. The unit card reads the LIVE value off the field
 * (`unitField.rtsHpOf`), so what it shows is always the number combat is actually shooting at.
 * Shield and energy have no combat model yet and are owned here.
 */
export type UnitCategory = 'worker' | 'infantry' | 'aerial' | 'special';
export type RtsUnitId =
  | 'worker'
  | 'quadruped'
  | 'arachnid'
  | 'marshal'
  | 'kite'
  | 'interceptor'
  | 'giga'
  | 'disc'
  | 'littoral';

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
  /**
   * A structure that must ALSO be built before this unit unlocks.
   *
   * Only needed when the PRODUCER can exist before the gate — see the note in the module header.
   * Anything produced by aviation or special is already past the tech facility by the build chain,
   * so setting this on one of those would be a lie the UI then has to render.
   */
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
  // ---- robotics: the opening line, plus the scout once the lab is up --------------------------
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
  kite: {
    id: 'kite',
    name: 'KITE',
    category: 'aerial',
    blurb: 'Light quadcopter. Cheap eyes that cross rivers, rail and rooftops instead of driving round them.',
    meshKind: 'quad',
    maxShield: 20,
    maxEnergy: 0,
    cost: 90,
    buildTimeS: 14,
    supply: 2,
    producedBy: 'robotics',
    // The only unit that needs an explicit gate: robotics stands before the tech facility, so
    // without this the kite would be available in the opening.
    requiresStructure: 'tech',
    hotkey: 'K',
  },

  // ---- aviation: the air wing -------------------------------------------------------------------
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
  disc: {
    id: 'disc',
    name: 'DISC OBSERVER',
    category: 'special',
    blurb: 'High-altitude disc. The fastest thing on the board and it sees further than anything you own.',
    meshKind: 'drone',
    maxShield: 200,
    maxEnergy: 200,
    cost: 350,
    buildTimeS: 40,
    supply: 6,
    producedBy: 'aviation',
    hotkey: 'O',
  },

  // ---- special: the heavy line and the capstones ------------------------------------------------
  // Everything here is already two rungs past the tech facility (special ← aviation ← tech), so
  // none of it carries a requiresStructure — the facility that builds it is the gate.
  arachnid: {
    id: 'arachnid',
    name: 'ARACHNID',
    category: 'infantry',
    blurb: 'Six-legged pursuit walker. Outruns anything on the ground and goes where roads do not.',
    meshKind: 'spider',
    maxShield: 60,
    maxEnergy: 0,
    cost: 140,
    buildTimeS: 18,
    supply: 3,
    producedBy: 'special',
    hotkey: 'A',
  },
  marshal: {
    id: 'marshal',
    name: 'MARSHAL',
    category: 'infantry',
    blurb: 'Digitigrade biped, twice the mass of a ground vehicle. Fast enough to chase, armed to matter.',
    meshKind: 'biped',
    maxShield: 120,
    maxEnergy: 0,
    cost: 200,
    buildTimeS: 24,
    supply: 4,
    producedBy: 'special',
    hotkey: 'M',
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
    producedBy: 'special',
    hotkey: 'G',
  },
  littoral: {
    id: 'littoral',
    name: 'LITTORAL',
    category: 'special',
    blurb: 'Trimaran hull for the coast and the crossings. Holds water the ground platforms cannot follow onto.',
    meshKind: 'naval',
    maxShield: 100,
    maxEnergy: 0,
    cost: 220,
    buildTimeS: 26,
    supply: 4,
    producedBy: 'special',
    hotkey: 'L',
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
