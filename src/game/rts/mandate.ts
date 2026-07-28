import { AUTHORITY_TIERS, type AuthorityLevel } from './inspect';

/**
 * THE MANDATE — what the public will still put up with, against what the company needs from them.
 *
 * Two systems the mode already runs meet here, and the meeting is the whole point of both:
 *
 *   PUBLIC TOLERANCE   how much patience is left. The inverse of the unrest the data centers
 *                      generate (see {@link ./unrest}) — every shed you plant spends some.
 *   OVERRIDE THRESHOLD how little of it the company can operate on. Falls with every rung of
 *                      AUTHORITY, because that is what authority IS: permission to keep going when
 *                      people have stopped agreeing.
 *
 * Above the threshold the company operates with CONSENT. Below it, it is operating on OVERRIDE — it
 * has not stopped, it has simply stopped being agreed to. That is the arc the whole game is about,
 * expressed as one bar with a line on it.
 *
 * The two numbers are also the two ways out of the same corner, which is what makes the pairing a
 * decision rather than a readout: unrest too high can be answered by tearing down data centers and
 * waiting, or by buying the authority that makes their objection irrelevant. One of those is cheap.
 *
 * NOTE. Crossing into override currently has no mechanical consequence — it is a state, named and
 * measured, for consequences to be hung on later. Nothing in the sim reads `override` yet, and
 * pretending otherwise in the UI would be a lie about the game.
 */

/**
 * Public tolerance the company needs at each authority rung to be operating with consent.
 *
 * Indexed by authority level. The fall from 0.75 to 0.15 is the arc: at the opening you need most
 * of the public with you, and by EMERGENCY POWERS you need almost none of them.
 */
export const OVERRIDE_THRESHOLD: Record<AuthorityLevel, number> = {
  0: 0.75,
  1: 0.62,
  2: 0.5,
  3: 0.38,
  4: 0.26,
  5: 0.15,
};

export interface MandateState {
  authority: AuthorityLevel;
  authorityName: string;
  /** The next rung's name, or null at the top — what more authority would buy. */
  nextName: string | null;
  /** 0–1. What is left of the public's patience. */
  tolerance: number;
  /** 0–1. How little of it this authority can operate on. */
  threshold: number;
  /** Tolerance minus threshold. Negative means operating past consent. */
  margin: number;
  override: boolean;
  /** Short label for the bar: CONSENT / NARROW / OVERRIDE. */
  label: string;
}

export function mandateState(unrest: number, authority: AuthorityLevel): MandateState {
  const tolerance = Math.min(1, Math.max(0, 1 - unrest));
  const threshold = OVERRIDE_THRESHOLD[authority];
  const margin = tolerance - threshold;
  const tier = AUTHORITY_TIERS[authority];
  const next = AUTHORITY_TIERS[authority + 1] ?? null;
  return {
    authority,
    authorityName: tier.name,
    nextName: next ? next.name : null,
    tolerance,
    threshold,
    margin,
    override: margin < 0,
    // NARROW is worth its own word: it is the band where one more data center flips you, and the
    // player should be able to see that coming rather than discover it.
    label: margin < 0 ? 'OVERRIDE' : margin < 0.12 ? 'NARROW' : 'CONSENT',
  };
}
