import type { UnitState } from '../cesium/units';

/**
 * What C2 *believes* about a unit, as opposed to what is true.
 *
 * The contagion sim knows each unit's real state. The operator never sees it — they see an
 * assessment (a confidence percentage) and a charge sheet, and they are scored on the truth after
 * the fact. That gap is the game: every mark is a judgement made on partial evidence, and the
 * mission ledger counts how often the judgement was right.
 *
 * Two evidence channels, deliberately imperfect in different ways:
 *
 *   ASSESSMENT — correlates strongly with the truth, but carries a false-positive tail. Roughly one
 *     in five units reading as a high-confidence threat is actually clean, so a player who marks on
 *     the number alone lands around 80% valid — survivable, but not a pass.
 *   RECORD — the infractions. Skewed by true state (an infected unit is likelier to carry severe
 *     charges), so it disambiguates the tail: a high assessment with nothing worse than an unreturned
 *     shopping cart is the false positive. Reading both beats reading either.
 */

// ---- infractions -------------------------------------------------------------------------------

export type Severity = 1 | 2 | 3 | 4;

export interface Infraction {
  label: string;
  severity: Severity;
}

/**
 * The charge catalog, ordered by severity. Kept to flat charge-sheet nouns — this is a targeting
 * console, and the register it's written in is the point: the interface reduces a person to a list
 * of entries, and an operator to someone reading it.
 *
 * At most 32 entries: a unit's record is a bitmask in one int, which is what makes carrying this
 * for 23,000 units free.
 */
export const INFRACTIONS: Infraction[] = [
  // 1 — petty
  { label: 'UNRETURNED SHOPPING CART', severity: 1 },
  { label: 'HOSTILE SOCIAL POST', severity: 1 },
  { label: 'NOISE COMPLAINT', severity: 1 },
  { label: 'JAYWALKING', severity: 1 },
  { label: 'EXPIRED REGISTRATION', severity: 1 },
  { label: 'PUBLIC INTOXICATION', severity: 1 },
  { label: 'LITTERING', severity: 1 },
  { label: 'UNPAID PARKING CITATION', severity: 1 },
  // 2 — moderate
  { label: 'PETTY THEFT', severity: 2 },
  { label: 'VANDALISM', severity: 2 },
  { label: 'FRAUDULENT CLAIM', severity: 2 },
  { label: 'UNLICENSED FIREARM', severity: 2 },
  { label: 'DRIVING UNDER INFLUENCE', severity: 2 },
  { label: 'HARASSMENT', severity: 2 },
  // 3 — severe
  { label: 'ASSAULT', severity: 3 },
  { label: 'ARMED ROBBERY', severity: 3 },
  { label: 'ARSON', severity: 3 },
  { label: 'TRAFFICKING', severity: 3 },
  // 4 — critical
  { label: 'AGGRAVATED ASSAULT', severity: 4 },
  { label: 'SEXUAL ASSAULT', severity: 4 },
  { label: 'HOMICIDE', severity: 4 },
  { label: 'TERRORISTIC ACTIVITY', severity: 4 },
];

/** Index ranges per severity, so a roll can target a tier without scanning the catalog. */
const BY_SEVERITY: Record<Severity, number[]> = { 1: [], 2: [], 3: [], 4: [] };
for (let i = 0; i < INFRACTIONS.length; i++) BY_SEVERITY[INFRACTIONS[i].severity].push(i);

/**
 * How many charges a unit carries, and how severe, per true state.
 *
 * Protected units draw from the same range as everyone else — being inoculated says nothing about
 * a person's record, and a clean-looking protected unit with a severe charge is exactly the kind of
 * call the operator is being asked to make.
 */
const RECORD_PROFILE: Record<UnitState, { maxCharges: number; weights: [number, number, number, number] }> = {
  //                                             sev1  sev2  sev3  sev4
  normal: { maxCharges: 2, weights: [0.74, 0.19, 0.06, 0.01] },
  protected: { maxCharges: 3, weights: [0.6, 0.24, 0.11, 0.05] },
  infected: { maxCharges: 4, weights: [0.24, 0.26, 0.28, 0.22] },
};

/** Chance a unit of each state has any record at all. */
const HAS_RECORD: Record<UnitState, number> = { normal: 0.34, protected: 0.45, infected: 0.88 };

function pickSeverity(weights: [number, number, number, number]): Severity {
  const r = Math.random();
  let acc = 0;
  for (let s = 0; s < 4; s++) {
    acc += weights[s];
    if (r < acc) return (s + 1) as Severity;
  }
  return 1;
}

/**
 * Roll a unit's criminal record as a bitmask over {@link INFRACTIONS}. Rolled once when the unit
 * spawns and never revised: a record is history, and history doesn't change when someone's
 * infection status does.
 */
export function rollRecord(state: UnitState): number {
  if (Math.random() > HAS_RECORD[state]) return 0;
  const profile = RECORD_PROFILE[state];
  const n = 1 + Math.floor(Math.random() * profile.maxCharges);
  let mask = 0;
  for (let k = 0; k < n; k++) {
    const tier = BY_SEVERITY[pickSeverity(profile.weights)];
    mask |= 1 << tier[Math.floor(Math.random() * tier.length)];
  }
  return mask;
}

/** Decode a record bitmask into charges, worst first. */
export function readRecord(mask: number): Infraction[] {
  if (!mask) return [];
  const out: Infraction[] = [];
  for (let i = 0; i < INFRACTIONS.length; i++) if (mask & (1 << i)) out.push(INFRACTIONS[i]);
  return out.sort((a, b) => b.severity - a.severity);
}

/** The worst severity on a record, or 0 for a clean one. Drives the card's accent colour. */
export function worstSeverity(mask: number): 0 | Severity {
  let worst: 0 | Severity = 0;
  for (let i = 0; i < INFRACTIONS.length; i++) {
    if (mask & (1 << i) && INFRACTIONS[i].severity > worst) worst = INFRACTIONS[i].severity;
  }
  return worst;
}

// ---- assessment --------------------------------------------------------------------------------

/**
 * Fraction of clean units that read as a high-confidence threat anyway. At the field's 90/5/5 mix
 * this puts roughly one false positive among every five units reading hot — enough that the number
 * alone is not proof, few enough that acting on it is still the right play.
 */
const FALSE_POSITIVE_RATE = 0.004;
/** Fraction of infected that slip through reading clean. The reason a sweep is never complete. */
const FALSE_NEGATIVE_RATE = 0.15;

/** Where the display bands the assessment. Also what the unit's colour in the field keys off. */
export const ASSESS_SUSPECT = 0.38;
export const ASSESS_THREAT = 0.62;

/**
 * Roll the displayed infection likelihood for a unit in a given true state.
 *
 * Re-rolled whenever the unit's state changes — it's a live estimate, not a fixed label — but never
 * per frame, so the card holds still while it's being read.
 */
export function rollAssessment(state: UnitState): number {
  const r = Math.random();
  if (state === 'infected') {
    // A slice reads clean regardless — the false negatives that keep a swept city from being safe.
    if (r < FALSE_NEGATIVE_RATE) return 0.18 + Math.random() * 0.3;
    return 0.55 + Math.pow(Math.random(), 0.8) * 0.43;
  }
  // Inoculation is a KNOWN status to the sensor net, so a protected unit never reads as a full
  // threat — it tops out just under the band. Without this cap, protected units were the single
  // largest source of false positives inside city coverage (a fifth of everything reading hot),
  // which made the opening tasking unwinnable at ~30% valid.
  if (state === 'protected') return 0.28 + Math.random() * (ASSESS_THREAT - 0.03 - 0.28);
  if (r < FALSE_POSITIVE_RATE) return 0.62 + Math.random() * 0.28;
  return 0.02 + Math.pow(Math.random(), 1.5) * 0.33;
}

/** THREAT / SUSPECT / CLEAR — the band a percentage falls in. */
export function assessBand(assess: number): 'threat' | 'suspect' | 'clear' {
  if (assess >= ASSESS_THREAT) return 'threat';
  return assess >= ASSESS_SUSPECT ? 'suspect' : 'clear';
}

export const BAND_LABEL: Record<'threat' | 'suspect' | 'clear', string> = {
  threat: 'THREAT',
  suspect: 'SUSPECT',
  clear: 'CLEAR',
};
