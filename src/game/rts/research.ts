import type { UnitKind } from '../../cesium/unitModels';
import type { Weapon } from './weapons';
import type { StructureType } from './structures';

/**
 * Research — everything a laboratory works on over time. Two kinds live here, deliberately in one
 * list and one pipeline:
 *
 *   DOCTRINE   a standing company-wide capability with no chassis attached (AUTO-FINE).
 *   UPGRADE    a permanent improvement to a machine — heavier barrels on the quadrupeds, a lance on
 *              the marshals — applying to every one you own and every one you build afterwards.
 *
 * This replaced per-unit HARDPOINT FITTING, and the replacement is the point. Fitting asked the
 * player to open a card on each individual machine and choose a pod for a slot, which buried the
 * interesting decision ("what is my army good at") under a chore repeated once per unit: an army of
 * twelve quadrupeds was twelve identical clicks for an outcome nobody would ever vary. An upgrade is
 * the same decision made once, in the building whose whole job is making it, and it is legible on
 * that building's command card instead of three clicks into a selected unit.
 *
 * Two labs, so the tree has a shape:
 *   TECH FACILITY  tier 1 — cheap, early, the things that keep the opening line alive.
 *   SKYHOOK        tier 2 — expensive, late, the things that turn a late army into a different army.
 *
 * How an upgrade APPLIES is data, not code: multipliers land on every weapon the chassis carries,
 * `hpMult` on its hull, and `adds` bolts a whole extra weapon on. {@link ./combat armamentOf} reads
 * this and nothing else, so a new upgrade is one entry here and no new code anywhere.
 */

export type ResearchId =
  | 'auto-fine'
  | 'flak-doctrine'
  // ---- tier 1, at the tech facility
  | 'armoured-cab'
  | 'heavy-barrels'
  | 'pack-link'
  | 'rotor-trim'
  | 'picket-radar'
  | 'serrated-arms'
  // ---- tier 2, at the skyhook
  | 'service-lance'
  | 'deck-mortar'
  | 'missile-rack'
  | 'phased-emitter'
  | 'siege-rounds'
  | 'plate-hull';

export interface ResearchDef {
  id: ResearchId;
  name: string;
  blurb: string;
  cost: number;
  /** Seconds the facility spends researching it. */
  timeS: number;
  /** The building that researches it — selecting that building offers it. */
  producedBy: StructureType;
  hotkey: string;
  /**
   * Chassis this improves. Absent on a doctrine, which changes a rule rather than a machine.
   *
   * Keyed by MESH KIND rather than by unit id because the combat layer only ever knows a unit by its
   * chassis — the same reason hit points are keyed that way.
   */
  applies?: UnitKind[];
  /** Multiplier on every weapon's damage. */
  dmgMult?: number;
  /** Multiplier on every weapon's reach. */
  rangeMult?: number;
  /** Multiplier on the seconds between shots — BELOW 1 IS FASTER. */
  periodMult?: number;
  /** Multiplier on splash radius, for the weapons that have one. */
  splashMult?: number;
  /** Multiplier on the chassis' hit points. */
  hpMult?: number;
  /** A whole extra weapon, welded on army-wide. */
  adds?: Weapon;
}

export const RESEARCH: Record<ResearchId, ResearchDef> = {
  // ---- doctrine: no chassis, changes a rule ----------------------------------------------------
  'auto-fine': {
    id: 'auto-fine',
    name: 'AUTO-FINE',
    blurb: 'Obelisks fine traffic violations on their own — passive income, no alerts to answer.',
    cost: 300,
    timeS: 30,
    producedBy: 'tech',
    hotkey: 'F',
  },
  'flak-doctrine': {
    id: 'flak-doctrine',
    name: 'FLAK DOCTRINE',
    blurb: 'Every ground chassis carries a flak battery. The answer to an army that keeps losing to air.',
    cost: 550,
    timeS: 45,
    producedBy: 'skyhook',
    hotkey: 'Y',
    applies: ['dog', 'spider', 'biped', 'walker'],
    adds: { name: 'FLAK BATTERY', kind: 'ranged', rangeM: 1100, dmg: 14, periodS: 0.5 },
  },

  // ---- tier 1 · TECH FACILITY ------------------------------------------------------------------
  'armoured-cab': {
    id: 'armoured-cab',
    name: 'ARMOURED CAB',
    blurb: 'Plate around the worker cab. It still cannot fight, but it survives being noticed.',
    cost: 150,
    timeS: 20,
    producedBy: 'tech',
    hotkey: 'W',
    applies: ['skid'],
    hpMult: 1.5,
  },
  'heavy-barrels': {
    id: 'heavy-barrels',
    name: 'HEAVY BARRELS',
    blurb: 'Rebored shoulder guns on the quadrupeds. Half again the damage out of the line you already own.',
    cost: 200,
    timeS: 24,
    producedBy: 'tech',
    hotkey: 'Q',
    applies: ['dog'],
    dmgMult: 1.5,
  },
  'pack-link': {
    id: 'pack-link',
    name: 'PACK LINK',
    blurb: 'Quadrupeds share targeting and load. Tougher hulls, and they shoot faster in company.',
    cost: 280,
    timeS: 28,
    producedBy: 'tech',
    hotkey: 'P',
    applies: ['dog'],
    hpMult: 1.35,
    periodMult: 0.85,
  },
  'rotor-trim': {
    id: 'rotor-trim',
    name: 'ROTOR TRIM',
    blurb: 'Trimmed rotors and a longer sight line on the kites. Sees further, shoots oftener.',
    cost: 180,
    timeS: 20,
    producedBy: 'tech',
    hotkey: 'K',
    applies: ['quad'],
    rangeMult: 1.35,
    periodMult: 0.8,
  },
  'picket-radar': {
    id: 'picket-radar',
    name: 'PICKET RADAR',
    blurb: 'A mast on every USV. The picket finally out-ranges what it is picketing against.',
    cost: 190,
    timeS: 22,
    producedBy: 'tech',
    hotkey: 'U',
    applies: ['usv'],
    rangeMult: 1.5,
    dmgMult: 1.2,
  },
  'serrated-arms': {
    id: 'serrated-arms',
    name: 'SERRATED ARMS',
    blurb: 'Reground blade arms on the arachnids. Enough to win the melee it was losing.',
    cost: 260,
    timeS: 26,
    producedBy: 'tech',
    hotkey: 'A',
    applies: ['spider'],
    dmgMult: 1.4,
    hpMult: 1.15,
  },

  // ---- tier 2 · SKYHOOK ------------------------------------------------------------------------
  'service-lance': {
    id: 'service-lance',
    name: 'SERVICE LANCE',
    blurb: 'A directed lance over every marshal, firing past the line it is standing behind.',
    cost: 420,
    timeS: 34,
    producedBy: 'skyhook',
    hotkey: 'M',
    applies: ['biped'],
    adds: { name: 'DIRECTED LANCE', kind: 'ranged', rangeM: 1400, dmg: 24, periodS: 1.3 },
  },
  'deck-mortar': {
    id: 'deck-mortar',
    name: 'DECK MORTAR',
    blurb: 'A siege mortar on the littoral hulls. Shells a coastline from water nothing can follow onto.',
    cost: 400,
    timeS: 32,
    producedBy: 'skyhook',
    hotkey: 'L',
    applies: ['naval'],
    adds: { name: 'SIEGE MORTAR', kind: 'projectile', rangeM: 1700, dmg: 40, periodS: 2.2, speedMps: 650, splashM: 160 },
  },
  'missile-rack': {
    id: 'missile-rack',
    name: 'MISSILE RACK',
    blurb: 'Racks on every interceptor. Fast rounds, tight burst — the projectile that still lands on something moving.',
    cost: 380,
    timeS: 30,
    producedBy: 'skyhook',
    hotkey: 'C',
    applies: ['interceptor'],
    adds: { name: 'MISSILE RACK', kind: 'projectile', rangeM: 1300, dmg: 32, periodS: 1.5, speedMps: 1400, splashM: 60 },
  },
  'phased-emitter': {
    id: 'phased-emitter',
    name: 'PHASED EMITTER',
    blurb: 'The disc stops sightseeing. Half again the damage from the highest thing you own.',
    cost: 460,
    timeS: 36,
    producedBy: 'skyhook',
    hotkey: 'O',
    applies: ['drone'],
    dmgMult: 1.5,
    periodMult: 0.85,
  },
  'siege-rounds': {
    id: 'siege-rounds',
    name: 'SIEGE ROUNDS',
    blurb: 'Heavier shells in the giga battery. Wider blast, and more of it in the middle.',
    cost: 520,
    timeS: 40,
    producedBy: 'skyhook',
    hotkey: 'G',
    applies: ['walker'],
    dmgMult: 1.3,
    splashMult: 1.5,
  },
  'plate-hull': {
    id: 'plate-hull',
    name: 'PLATE HULL',
    blurb: 'Slab armour over the walker. It was already hard to stop.',
    cost: 480,
    timeS: 38,
    producedBy: 'skyhook',
    hotkey: 'H',
    applies: ['walker'],
    hpMult: 1.35,
  },
};

export const RESEARCH_LIST: ResearchDef[] = Object.values(RESEARCH);

/** What a building can research, in order — its command card offers these alongside any units. */
export function researchFrom(type: StructureType): ResearchDef[] {
  return RESEARCH_LIST.filter((r) => r.producedBy === type);
}

/** The completed upgrades that touch a chassis — what the combat layer folds in when it arms one. */
export function upgradesFor(kind: UnitKind, done: ReadonlySet<ResearchId>): ResearchDef[] {
  const out: ResearchDef[] = [];
  for (const id of done) {
    const def = RESEARCH[id];
    if (def?.applies?.includes(kind)) out.push(def);
  }
  return out;
}

/** Every chassis a completed research touches — the units that must be re-armed in the field. */
export function kindsTouchedBy(id: ResearchId): UnitKind[] {
  return RESEARCH[id]?.applies ?? [];
}
