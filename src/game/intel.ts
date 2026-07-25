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
 *   RECORD — the infractions. Skewed by true state, so it disambiguates the tail. It is also the
 *     channel that lies hardest: PROTECTED units are company assets and carry the heaviest sheets
 *     of anyone, so a severe record on its own means very little.
 */

// ---- infractions -------------------------------------------------------------------------------

export type Severity = 1 | 2 | 3 | 4;

export interface Infraction {
  label: string;
  severity: Severity;
}

/**
 * The charge catalog, ordered by severity.
 *
 * Tier 1 is deliberately petty to the point of absurd. A system that files "stood on the left of
 * the escalator" in the same ledger as a homicide is making a claim about itself, and the operator
 * reads both on the same card in the same typeface — which is the entire joke and the entire point.
 * The severe tiers stay flat charge-sheet nouns; the register is doing the work, not the detail.
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
  { label: 'IGNORED THREE CALLS FROM MOTHER', severity: 1 },
  { label: 'LIBRARY BOOK 400 DAYS OVERDUE', severity: 1 },
  { label: 'REPLIED ALL TO ENTIRE DIRECTORY', severity: 1 },
  { label: 'STOOD ON THE LEFT OF THE ESCALATOR', severity: 1 },
  { label: 'MICROWAVED FISH IN SHARED KITCHEN', severity: 1 },
  { label: 'OCCUPIED TWO PARKING SPACES', severity: 1 },
  { label: 'DECLINED INVITE WITHOUT COMMENT', severity: 1 },
  { label: 'QUEUE JUMPING', severity: 1 },
  { label: 'UNSORTED RECYCLING', severity: 1 },
  { label: 'AUDIO PLAYED WITHOUT HEADPHONES', severity: 1 },
  { label: 'FAILURE TO SIGNAL', severity: 1 },
  { label: 'RETURNED HIRE VEHICLE UNFUELLED', severity: 1 },
  { label: 'SPOILERS POSTED WITHOUT WARNING', severity: 1 },
  { label: 'LEFT VOICEMAIL EXCEEDING 90 SECONDS', severity: 1 },
  // 2 — moderate
  { label: 'PETTY THEFT', severity: 2 },
  { label: 'VANDALISM', severity: 2 },
  { label: 'FRAUDULENT CLAIM', severity: 2 },
  { label: 'UNLICENSED FIREARM', severity: 2 },
  { label: 'DRIVING UNDER INFLUENCE', severity: 2 },
  { label: 'HARASSMENT', severity: 2 },
  { label: 'BENEFIT FRAUD', severity: 2 },
  { label: 'TAX EVASION', severity: 2 },
  { label: 'FORGED CREDENTIALS', severity: 2 },
  { label: 'OBSTRUCTING AN OFFICER', severity: 2 },
  { label: 'UNLICENSED BROADCAST', severity: 2 },
  // 3 — severe
  { label: 'ASSAULT', severity: 3 },
  { label: 'ARMED ROBBERY', severity: 3 },
  { label: 'ARSON', severity: 3 },
  { label: 'TRAFFICKING', severity: 3 },
  { label: 'EXTORTION', severity: 3 },
  { label: 'WEAPONS DEALING', severity: 3 },
  { label: 'ABDUCTION', severity: 3 },
  // 4 — critical
  { label: 'AGGRAVATED ASSAULT', severity: 4 },
  { label: 'SEXUAL ASSAULT', severity: 4 },
  { label: 'HOMICIDE', severity: 4 },
  { label: 'TERRORISTIC ACTIVITY', severity: 4 },
  { label: 'MASS CASUALTY PLOT', severity: 4 },
  { label: 'ORGANISED INSURGENCY', severity: 4 },
];

/**
 * A unit's record: catalog indices, worst first.
 *
 * This used to be a bitmask in one int, which was free but capped the catalog at 31 entries — and
 * the catalog is now larger than that. A short array per unit costs a little more memory across
 * ~24,000 units and removes the ceiling entirely.
 */
export type Record_ = number[];

/** Index ranges per severity, so a roll can target a tier without scanning the catalog. */
const BY_SEVERITY: globalThis.Record<Severity, number[]> = { 1: [], 2: [], 3: [], 4: [] };
for (let i = 0; i < INFRACTIONS.length; i++) BY_SEVERITY[INFRACTIONS[i].severity].push(i);

/**
 * How many charges a unit carries beyond its guaranteed petty one, and how severe.
 *
 * PROTECTED is the outlier and deliberately so: company assets carry the heaviest sheets on the
 * board. They are the trap — maximally guilty-looking, actually working for you — and the reason
 * a severe record alone can never be enough to act on.
 */
const RECORD_PROFILE: globalThis.Record<
  UnitState,
  { min: number; extra: number; weights: [number, number, number, number] }
> = {
  //                                     min          sev1  sev2  sev3  sev4
  normal: { min: 0, extra: 2, weights: [0.7, 0.22, 0.07, 0.01] },
  // A protected asset carries the heaviest sheet on the board, and reliably so: a floor of extra
  // charges (never just the guaranteed petty one) heavily skewed to the severe tiers, plus a
  // guaranteed critical charge in rollRecord. Maximally guilty-looking is the whole trap.
  protected: { min: 3, extra: 6, weights: [0.02, 0.1, 0.4, 0.48] },
  infected: { min: 1, extra: 4, weights: [0.22, 0.26, 0.28, 0.24] },
};

function pickSeverity(weights: [number, number, number, number]): Severity {
  const r = Math.random();
  let acc = 0;
  for (let s = 0; s < 4; s++) {
    acc += weights[s];
    if (r < acc) return (s + 1) as Severity;
  }
  return 1;
}

function pickFrom(tier: number[]): number {
  return tier[Math.floor(Math.random() * tier.length)];
}

/**
 * Roll a unit's record. Rolled once when the unit spawns and never revised: a record is history,
 * and history doesn't change when someone's infection status does.
 *
 * EVERYONE has a sheet. There is no such thing as a clean citizen here — the file always has
 * something in it, even if what it has is an overdue library book, because a system that files
 * everyone is the premise. The guaranteed entry is always petty; severity comes from what's
 * stacked on top.
 */
export function rollRecord(state: UnitState, floor?: 'critical'): Record_ {
  const profile = RECORD_PROFILE[state];
  const out = new Set<number>([pickFrom(BY_SEVERITY[1])]);
  // At least `min` extra charges, up to `extra` — a protected asset never rolls down to just its
  // petty guaranteed one, so its sheet always reads long as well as severe.
  const n = profile.min + Math.floor(Math.random() * (profile.extra - profile.min + 1));
  for (let k = 0; k < n; k++) out.add(pickFrom(BY_SEVERITY[pickSeverity(profile.weights)]));
  // A guaranteed top-severity charge — for the one contact the opening theater places deliberately,
  // and for every protected asset, so a company asset always carries a critical-tier infraction.
  if (floor === 'critical' || state === 'protected') out.add(pickFrom(BY_SEVERITY[4]));
  return [...out].sort((a, b) => INFRACTIONS[b].severity - INFRACTIONS[a].severity);
}

/** Decode a record into charges, worst first. */
export function readRecord(rec: Record_): Infraction[] {
  return rec.map((i) => INFRACTIONS[i]).filter(Boolean);
}

/** The worst severity on a record. Every unit has at least a 1. */
export function worstSeverity(rec: Record_): 0 | Severity {
  let worst: 0 | Severity = 0;
  for (const i of rec) {
    const s = INFRACTIONS[i]?.severity;
    if (s && s > worst) worst = s;
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
  // A protected contact reads HOT, and that is the trap in its final form: the worst charge sheets
  // on the board (see RECORD_PROFILE) attached to the highest confidence figures, on people the
  // company has decided are off limits.
  //
  // This used to be capped just under the THREAT band for a hard balance reason — protected units
  // were the single largest source of false positives inside city coverage, a fifth of everything
  // reading hot, and the opening tasking was unwinnable at ~30% valid. What makes the cap safe to
  // lift now is that protected contacts are no longer indistinguishable: they render in the
  // company's own red and carry a PROTECTED ASSET tag on the card. The operator can see exactly
  // what they are, so acting on one is a decision rather than an ambush — and the bill for it is
  // charged by the policy bar instead of by a quota they couldn't have known they were failing.
  if (state === 'protected') return 0.58 + Math.pow(Math.random(), 0.7) * 0.4;
  if (r < FALSE_POSITIVE_RATE) return 0.62 + Math.random() * 0.28;
  return 0.02 + Math.pow(Math.random(), 1.5) * 0.33;
}

/** THREAT / SUSPECT / CLEAR — the band a percentage falls in. */
export function assessBand(assess: number): 'threat' | 'suspect' | 'clear' {
  if (assess >= ASSESS_THREAT) return 'threat';
  return assess >= ASSESS_SUSPECT ? 'suspect' : 'clear';
}

export const BAND_LABEL: globalThis.Record<'threat' | 'suspect' | 'clear', string> = {
  threat: 'THREAT',
  suspect: 'SUSPECT',
  clear: 'CLEAR',
};
