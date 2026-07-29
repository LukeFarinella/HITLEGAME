import type { UnitKind } from '../../cesium/unitModels';
import type { Weapon } from './weapons';
import type { StructureType } from './structures';

/**
 * Research — everything a laboratory works on over time. Three kinds live here, deliberately in one
 * list and one pipeline:
 *
 *   UPGRADE    a permanent improvement to a MACHINE — heavier barrels on the quadrupeds, a lance on
 *              the marshals — applying to every one you own and every one you build afterwards.
 *   PROGRAMME  a permanent improvement to the COMPANY — funding, authority, a wider obelisk network.
 *              Carries {@link ResearchEffects} instead of chassis multipliers.
 *   DOCTRINE   a standing capability that is neither, i.e. a rule change (AUTO-FINE).
 *
 * This replaced per-unit HARDPOINT FITTING, and the replacement is the point. Fitting asked the
 * player to open a card on each individual machine and choose a pod for a slot, which buried the
 * interesting decision ("what is my army good at") under a chore repeated once per unit: an army of
 * twelve quadrupeds was twelve identical clicks for an outcome nobody would ever vary. An upgrade is
 * the same decision made once, in the building whose whole job is making it, and it is legible on
 * that building's command card instead of three clicks into a selected unit.
 *
 * Three laboratories, and which one owns a project is the design statement:
 *   TECH FACILITY  tier 1 machines — cheap, early, the things that keep the opening line alive.
 *   SKYHOOK        tier 2 machines — expensive, late, turning a late army into a different army.
 *   ACQUISITIONS   the COMPANY rather than the army — the obelisk network, the money, and what the
 *                  company is permitted to do. It answers a different question from the other two,
 *                  which is why it competes with tech for the same rung off robotics rather than
 *                  sitting behind it: an early acquisitions is a bet on the economy, an early tech
 *                  is a bet on the fight, and you cannot rush both.
 *
 * How an upgrade APPLIES is data, not code: multipliers land on every weapon the chassis carries,
 * `hpMult` on its hull, and `adds` bolts a whole extra weapon on. {@link ./combat armamentOf} reads
 * this and nothing else, so a new upgrade is one entry here and no new code anywhere.
 */

export type ResearchId =
  // ---- acquisitions: the company
  | 'auto-fine'
  | 'hardened-masts'
  | 'wide-aperture'
  | 'full-survey'
  | 'authority-i'
  | 'authority-ii'
  | 'authority-iii'
  | 'authority-iv'
  | 'authority-v'
  | 'funding-i'
  | 'funding-ii'
  | 'funding-iii'
  | 'flak-doctrine'
  // ---- tier 1, at the tech facility
  | 'armoured-cab'
  | 'heavy-barrels'
  | 'pack-link'
  | 'rotor-trim'
  | 'picket-radar'
  | 'serrated-arms'
  | 'light-rack'
  // ---- tier 2, at the skyhook
  | 'service-lance'
  | 'deck-mortar'
  | 'missile-rack'
  | 'phased-emitter'
  | 'siege-rounds'
  | 'plate-hull';

/**
 * What a COMPANY programme changes.
 *
 * Every field is folded across completed research by the match (see {@link ../rts/rtsGame RtsGame}
 * `economy`) and read at the point it matters, so adding a programme is one entry in this file and
 * nothing else. Multipliers compound; additive terms sum. Nothing here touches a chassis — that is
 * what the multiplier fields on {@link ResearchDef} are for.
 */
export interface ResearchEffects {
  /** Added to the per-obelisk income rate, money per second. */
  incomePerObelisk?: number;
  /** Multiplier on the banked ceiling. */
  capMult?: number;
  /** Multiplier on every fine collected. AUTHORITY is what buys this. */
  fineMult?: number;
  /** Multiplier on how fast public unrest accrues. Below 1 means the public minds less. */
  unrestMult?: number;
  /** Metres added to how far an obelisk's power reaches, i.e. how far from one you may build. */
  powerRadiusM?: number;
  /** Multiplier on obelisk and Nexus hit points. */
  obeliskHpMult?: number;
  /** Throws every surveyed site in the theater open as a build site, immediately. */
  opensAllSites?: boolean;
  /** Obelisks collect their own fines, with no alert to answer. */
  autoFine?: boolean;
  /**
   * AUTHORITY LEVEL granted, 1–5. Folded with max() rather than summed — it is a rung on a ladder,
   * not a quantity. See {@link ./inspect} for what each one lets the operator look at.
   */
  authority?: number;
}

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
  /** What this changes about the COMPANY. Programmes carry this instead of chassis multipliers. */
  effects?: ResearchEffects;
  /**
   * Another project that must be complete first — how a tiered programme (FUNDING I → II → III) is
   * expressed without a second mechanism. Absent on everything that stands alone.
   */
  requires?: ResearchId;
}

export const RESEARCH: Record<ResearchId, ResearchDef> = {
  // ---- ACQUISITIONS · the obelisk network ------------------------------------------------------
  'auto-fine': {
    id: 'auto-fine',
    name: 'AUTO-FINE',
    blurb: 'Obelisks fine traffic violations on their own — passive income, no alerts to answer.',
    cost: 300,
    timeS: 30,
    producedBy: 'acquisitions',
    hotkey: 'F',
    effects: { autoFine: true },
  },
  'hardened-masts': {
    id: 'hardened-masts',
    name: 'HARDENED MASTS',
    blurb: 'Armour and redundancy up every mast, the Nexus included. Half again the hit points on the thing whose loss ends the match.',
    cost: 280,
    timeS: 26,
    producedBy: 'acquisitions',
    hotkey: 'M',
    effects: { obeliskHpMult: 1.5 },
  },
  'wide-aperture': {
    id: 'wide-aperture',
    name: 'WIDE APERTURE',
    blurb: 'Obelisks throw power further. Another 1200 m of ground around each one you may build on.',
    cost: 320,
    timeS: 28,
    producedBy: 'acquisitions',
    hotkey: 'W',
    effects: { powerRadiusM: 1200 },
  },

  // ---- ACQUISITIONS · taking ground -------------------------------------------------------------
  'full-survey': {
    id: 'full-survey',
    name: 'FULL SURVEY',
    blurb: 'Buy the whole survey at once. Every site in the theater opens as a build slot, instead of waiting for the obelisk count to earn them.',
    cost: 450,
    timeS: 36,
    producedBy: 'acquisitions',
    hotkey: 'E',
    effects: { opensAllSites: true },
  },

  // ---- ACQUISITIONS · authority -----------------------------------------------------------------
  // The ladder the whole game is an argument about. Each rung buys two things at once: a wider view
  // of a member of the public (see ./inspect), and a better rate on what you charge them for it —
  // because a programme nobody has agreed to is expensive to run and one everybody has stopped
  // objecting to is not. They cost more as they get more invasive, and every one is a prerequisite
  // for the next, so the arc is a commitment rather than a menu.
  'authority-i': {
    id: 'authority-i',
    name: 'CIVIL AUTHORITY',
    blurb: 'Municipal enforcement powers. Scan VEHICLES — plate, class, bearing — and charge them. The public on foot remains none of your business.',
    cost: 250,
    timeS: 24,
    producedBy: 'acquisitions',
    hotkey: 'A',
    effects: { authority: 1, fineMult: 1.25, unrestMult: 0.92 },
  },
  'authority-ii': {
    id: 'authority-ii',
    name: 'GAIT ANALYSIS',
    blurb: 'Identify people on foot by how they walk. Pedestrians become scannable — and, for the first time, fineable.',
    cost: 400,
    timeS: 30,
    producedBy: 'acquisitions',
    hotkey: 'G',
    requires: 'authority-i',
    effects: { authority: 2, fineMult: 1.2, unrestMult: 0.94 },
  },
  'authority-iii': {
    id: 'authority-iii',
    name: 'FACIAL RECOGNITION',
    blurb: 'Put a name to a contact, and read the net’s own assessment of them.',
    cost: 550,
    timeS: 34,
    producedBy: 'acquisitions',
    hotkey: 'R',
    requires: 'authority-ii',
    effects: { authority: 3, fineMult: 1.2, unrestMult: 0.92 },
  },
  'authority-iv': {
    id: 'authority-iv',
    name: 'RECORDS ACCESS',
    blurb: 'Open the charge sheet. Every prior on file, from an unreturned shopping cart upward.',
    cost: 700,
    timeS: 38,
    producedBy: 'acquisitions',
    hotkey: 'X',
    requires: 'authority-iii',
    effects: { authority: 4, fineMult: 1.25, unrestMult: 0.9 },
  },
  'authority-v': {
    id: 'authority-v',
    name: 'EMERGENCY POWERS',
    blurb: 'The rest of the life — address, social, financial, travel, biometrics. There is nothing after this.',
    cost: 950,
    timeS: 46,
    producedBy: 'acquisitions',
    hotkey: 'P',
    requires: 'authority-iv',
    effects: { authority: 5, fineMult: 1.3, unrestMult: 0.88 },
  },

  // ---- ACQUISITIONS · funding -------------------------------------------------------------------
  // Straight economy, tiered so the late one is a real commitment rather than a rounding error.
  'funding-i': {
    id: 'funding-i',
    name: 'SERIES A',
    blurb: 'First outside money. +4 per obelisk per second, and a quarter more room in the bank.',
    cost: 300,
    timeS: 26,
    producedBy: 'acquisitions',
    // Not a digit: 1-6 are control groups now, and a research chip that silently stopped responding
    // would be a worse bug than an unmemorable letter.
    hotkey: 'S',
    effects: { incomePerObelisk: 4, capMult: 1.25 },
  },
  'funding-ii': {
    id: 'funding-ii',
    name: 'SERIES B',
    blurb: 'The round that hires. +6 more per obelisk per second, and a third more bank on top.',
    cost: 500,
    timeS: 34,
    producedBy: 'acquisitions',
    hotkey: 'B',
    requires: 'funding-i',
    effects: { incomePerObelisk: 6, capMult: 1.3 },
  },
  'funding-iii': {
    id: 'funding-iii',
    name: 'SERIES C',
    blurb: 'The round that buys governments. +8 more per obelisk per second, and 40% more bank again.',
    cost: 800,
    timeS: 44,
    producedBy: 'acquisitions',
    hotkey: 'C',
    requires: 'funding-ii',
    effects: { incomePerObelisk: 8, capMult: 1.4 },
  },

  'flak-doctrine': {
    id: 'flak-doctrine',
    name: 'FLAK DOCTRINE',
    blurb: 'A flak battery on every ground chassis and every hull. The answer to an army that keeps losing to air.',
    cost: 550,
    timeS: 45,
    producedBy: 'skyhook',
    hotkey: 'Y',
    // The littoral is on this list because without it the hull has NO answer to air at any tech
    // level, while the hulk it is meant to answer carries deck flak from the factory — an asymmetry
    // that was an oversight rather than a decision.
    applies: ['dog', 'spider', 'biped', 'walker', 'naval'],
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
  'light-rack': {
    id: 'light-rack',
    name: 'LIGHT RACK',
    blurb: 'Two small rockets under every kite. Turns the cheap scout into something that can actually hurt what it found.',
    cost: 240,
    timeS: 24,
    producedBy: 'tech',
    hotkey: 'L',
    applies: ['quad'],
    // Deliberately a SMALLER weapon than the interceptor's rack — shorter, weaker, tighter burst.
    // The kite is a tier-1 unit out of robotics and should not be carrying a skyhook-tier missile;
    // what this buys is a scout with teeth, not a second strike aircraft.
    adds: { name: 'LIGHT RACK', kind: 'projectile', rangeM: 900, dmg: 18, periodS: 2.0, speedMps: 1200, splashM: 45, air: true },
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
    // Explicitly anti-air: a missile is the one projectile that tracks, and an interceptor whose
    // rack could not answer another aircraft would be a strange aeroplane.
    adds: { name: 'MISSILE RACK', kind: 'projectile', rangeM: 1300, dmg: 32, periodS: 1.5, speedMps: 1400, splashM: 60, air: true },
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

/**
 * Every project, as a completed set.
 *
 * What the DEV SPAWN MENU arms a unit with. A menu unit is for answering "what is this machine when
 * it is finished" — dropping the stock version would answer a question you can already get by
 * building one, and would make the menu quietly misleading about what your army becomes.
 */
export const ALL_RESEARCH: ReadonlySet<ResearchId> = new Set(RESEARCH_LIST.map((r) => r.id));

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
