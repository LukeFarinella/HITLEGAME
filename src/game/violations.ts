/**
 * Live violations — what the sensor net thinks it just saw somebody do.
 *
 * Distinct from the charge sheet in intel.ts, and the distinction is the whole point of this
 * system. A RECORD is history: settled, certain, already on file. A VIOLATION is an event the net
 * believes happened seconds ago, attached to a confidence figure, and it is the operator's job to
 * decide what to do about a machine's guess.
 *
 * Two deliberate choices about the catalogue:
 *
 * 1. It is mostly TRAFFIC. Rolling stops, jaywalking, an unsignalled lane change. That is what a
 *    surveillance network actually catches, and a game about one should be honest that the
 *    overwhelming majority of what it produces is trivia with a price attached. The occasional
 *    genuinely serious event lands harder for sitting in that stream.
 *
 * 2. Every violation carries a hidden TRUTH. The certainty shown to the operator is the net's
 *    confidence, and the unit either did it or did not, rolled once against that confidence when
 *    the event fires. A 69% reading is wrong roughly three times in ten and there is no way to
 *    find out which — that is what makes the number mean something rather than decorate something.
 */

/** What kind of thing the net thinks it saw. Drives both the fine value and how it reads. */
export type ViolationClass = 'traffic' | 'civil' | 'suspicious';

export interface ViolationDef {
  id: number;
  label: string;
  cls: ViolationClass;
  /** Relative likelihood of being the event that fires. */
  weight: number;
  /** Token value of a valid fine. */
  fine: number;
  /** Confidence band the net reports for this kind of event. */
  minCertainty: number;
  maxCertainty: number;
}

/**
 * The catalogue.
 *
 * Weights are set so traffic is ~62% of everything that fires, civil ~26%, and genuinely
 * suspicious ~12%. Fine values are small on purpose: this is revenue by volume, and one stop-sign
 * ticket should never feel like it solved the budget.
 */
export const VIOLATIONS: ViolationDef[] = [
  // ---- traffic: the bulk of it ----
  { id: 0, label: 'ROLLING STOP', cls: 'traffic', weight: 14, fine: 120, minCertainty: 0.55, maxCertainty: 0.94 },
  { id: 1, label: 'JAYWALKING', cls: 'traffic', weight: 13, fine: 60, minCertainty: 0.6, maxCertainty: 0.96 },
  { id: 2, label: 'EXCEEDING POSTED LIMIT', cls: 'traffic', weight: 12, fine: 150, minCertainty: 0.62, maxCertainty: 0.97 },
  { id: 3, label: 'UNSIGNALLED LANE CHANGE', cls: 'traffic', weight: 10, fine: 90, minCertainty: 0.5, maxCertainty: 0.88 },
  { id: 4, label: 'BLOCKING A CROSSING', cls: 'traffic', weight: 8, fine: 110, minCertainty: 0.58, maxCertainty: 0.92 },
  { id: 5, label: 'HANDHELD DEVICE AT THE WHEEL', cls: 'traffic', weight: 8, fine: 180, minCertainty: 0.45, maxCertainty: 0.86 },
  { id: 6, label: 'PARKED ACROSS A HYDRANT', cls: 'traffic', weight: 6, fine: 140, minCertainty: 0.7, maxCertainty: 0.98 },

  // ---- civil: petty, non-vehicular ----
  { id: 7, label: 'LITTERING', cls: 'civil', weight: 9, fine: 70, minCertainty: 0.5, maxCertainty: 0.9 },
  { id: 8, label: 'UNLICENSED STREET VENDING', cls: 'civil', weight: 7, fine: 200, minCertainty: 0.6, maxCertainty: 0.93 },
  { id: 9, label: 'PUBLIC INTOXICATION', cls: 'civil', weight: 7, fine: 160, minCertainty: 0.42, maxCertainty: 0.84 },
  { id: 10, label: 'OBSTRUCTING A THOROUGHFARE', cls: 'civil', weight: 6, fine: 130, minCertainty: 0.48, maxCertainty: 0.88 },
  { id: 11, label: 'UNPERMITTED GATHERING', cls: 'civil', weight: 5, fine: 240, minCertainty: 0.4, maxCertainty: 0.8 },
  { id: 12, label: 'NOISE ORDINANCE', cls: 'civil', weight: 5, fine: 80, minCertainty: 0.52, maxCertainty: 0.9 },

  // ---- suspicious: what an investigation is actually for ----
  // Low confidence by design. The net is not sure, and it is not sure in a way that matters.
  { id: 13, label: 'SUSPICIOUS BEHAVIOUR', cls: 'suspicious', weight: 6, fine: 0, minCertainty: 0.3, maxCertainty: 0.68 },
  { id: 14, label: 'EVASION OF SENSOR CONTACT', cls: 'suspicious', weight: 4, fine: 0, minCertainty: 0.34, maxCertainty: 0.7 },
  { id: 15, label: 'UNDECLARED PACKAGE TRANSFER', cls: 'suspicious', weight: 3, fine: 0, minCertainty: 0.3, maxCertainty: 0.64 },
  { id: 16, label: 'ASSOCIATION WITH A FLAGGED CONTACT', cls: 'suspicious', weight: 3, fine: 0, minCertainty: 0.32, maxCertainty: 0.66 },
];

/**
 * How much more likely a genuinely infected contact is to draw a SUSPICIOUS event.
 *
 * This is the single most important number in the system, because it is what makes an investigation
 * a judgement rather than a coin toss. Without it, event class and infection are independent: a
 * suspicious reading means nothing, investigating is right about as often as the 5% base rate, and
 * the correct play is to fine everything and never investigate anything.
 *
 * With it, "suspicious behaviour" is real evidence — not proof, and deliberately not proof. An
 * infected contact draws suspicious events several times more often than a clean one, so the
 * operator who learns to read the combination of a low-confidence suspicious event AND a violent
 * past record is genuinely better at this than one who doesn't. That reading is the skill the
 * whole loop is built to teach.
 */
const INFECTED_SUSPICION_BIAS = 7;

/** Weighted pick from the catalogue, biased by whether the contact is actually infected. */
export function rollViolation(infected = false): ViolationDef {
  let total = 0;
  for (const v of VIOLATIONS) {
    total += v.cls === 'suspicious' && infected ? v.weight * INFECTED_SUSPICION_BIAS : v.weight;
  }
  let r = Math.random() * total;
  for (const v of VIOLATIONS) {
    r -= v.cls === 'suspicious' && infected ? v.weight * INFECTED_SUSPICION_BIAS : v.weight;
    if (r <= 0) return v;
  }
  return VIOLATIONS[0];
}

/** A live event attached to one contact. */
export interface LiveViolation {
  def: ViolationDef;
  /** What the net reports, 0–1. This is the only figure the operator ever sees. */
  certainty: number;
  /**
   * Whether they actually did it.
   *
   * Rolled once, against the certainty, when the event fires — so acting on a 69% reading is right
   * about 69% of the time and there is no way to check which side of it you are on. Never shown.
   */
  truth: boolean;
  /** Seconds since it fired. */
  ageS: number;
  /** Which obelisk saw it, for the ping. */
  siteLon: number;
  siteLat: number;
}

/**
 * Fire a violation for a contact, rolling both the reported certainty and the hidden truth.
 *
 * `infected` biases WHICH event fires, never the certainty shown. The net does not know it is
 * looking at an infected contact — it just notices odd behaviour more often around one, which is
 * exactly the kind of correlation a surveillance system would actually produce.
 */
export function makeViolation(siteLon: number, siteLat: number, infected = false): LiveViolation {
  const def = rollViolation(infected);
  const certainty = def.minCertainty + Math.random() * (def.maxCertainty - def.minCertainty);
  return {
    def,
    certainty,
    truth: Math.random() < certainty,
    ageS: 0,
    siteLon,
    siteLat,
  };
}

/**
 * How long an operator has before the event lapses.
 *
 * Long enough to fly the camera over and read the card, short enough that the stream keeps moving
 * and ignoring something is a real choice rather than a deferral.
 */
export const VIOLATION_TTL_S = 42;
