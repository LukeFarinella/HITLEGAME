import type { Capability } from './platforms';
import { tolerance } from './tolerance';
import { policy } from './policy';

/**
 * The sanction ladder — every answer the operator can give to a contact, in one place.
 *
 * The design rule this file exists to enforce: EVERY rung is offered against EVERY contact, always.
 * Nothing is hidden and nothing is greyed out for being unthinkable. Deciding that executing a
 * jaywalker is unthinkable is the operator's job, not the menu's, and a UI that refuses on their
 * behalf is a UI that has quietly taken the interesting decision away.
 *
 * What varies by rung is not permission but PRICE, read against two independent bars:
 *
 *   PUBLIC  — what the street will accept (game/tolerance.ts). Falling short hardens the ground.
 *   POLICY  — what the chain has licensed (game/policy.ts). Falling short narrows the licence.
 *
 * Both bars move with the rung: the same 78% reading that comfortably justifies a citation is
 * nowhere near enough to justify a killing, and the card shows exactly that by sliding the two ticks
 * right as the operator walks up the ladder. That slide IS the game's argument, made in geometry.
 */

export type SanctionId = 'investigate' | 'fine' | 'detain' | 'prison' | 'execute';

export interface SanctionDef {
  id: SanctionId;
  label: string;
  /** One line on what it actually does, under the ladder. */
  blurb: string;
  /**
   * What this rung ADDS to the subject's own two thresholds.
   *
   * The thresholds belong to the CONTACT, not to the sanction — a protected asset is hard to touch
   * because of who they are, and that has to be true before any rung is picked. What a rung does is
   * demand more on top: the same 78% reading that comfortably justifies a citation is nowhere near
   * enough to justify a killing, so EXECUTE adds forty points of demand to both bars and the ticks
   * slide right past the fill. That slide is the argument the card is making.
   */
  publicAdd: number;
  policyAdd: number;
  /** Whether a platform has to physically reach the contact to carry this out. */
  dispatch: boolean;
  /** Gear the carrying platform must have fitted. Null when the sanction needs no hardware. */
  capability: Capability | null;
  /**
   * Resistance charged for a maximally-unjustified use, before the shortfall curve.
   *
   * Scaled hard by rung: a citation issued on thin evidence is an annoyance, a killing on the same
   * evidence is the thing the campaign is about.
   */
  weight: number;
  /** Whether this ends with the contact off the board. Drives the confirmation language. */
  terminal: boolean;
  /**
   * The tasking that releases this rung, if it is not open from the start.
   *
   * The two bars price a decision the operator is ALLOWED to make. This is the separate question of
   * whether the power exists yet at all, and it is deliberately a wall rather than a price — the
   * campaign's whole shape is a contractor being handed powers one at a time, and an operator who
   * could execute somebody in mission one would be playing a different game about a different
   * company. A locked rung is still selectable, because reading what it WOULD cost before you have
   * it is exactly the anticipation the chain is built on.
   */
  requiresMission?: string;
}

export const SANCTIONS: SanctionDef[] = [
  {
    id: 'investigate',
    label: 'INVESTIGATE',
    blurb: 'Answers the person, not the event. Pays nothing and is the only route to the chain’s serious business.',
    publicAdd: 0.0,
    policyAdd: 0.0,
    dispatch: false,
    capability: null,
    weight: 0.05,
    terminal: false,
  },
  {
    id: 'fine',
    label: 'FINE',
    blurb: 'A citation against the live event. Revenue by volume, and the contact still has to pay a machine’s guess.',
    publicAdd: 0.04,
    policyAdd: 0.05,
    dispatch: false,
    capability: null,
    weight: 0.08,
    terminal: false,
  },
  {
    id: 'detain',
    label: 'DETAIN',
    blurb: 'Field custody. Non-lethal, but it is the first power held over a person rather than a file.',
    publicAdd: 0.14,
    policyAdd: 0.18,
    dispatch: true,
    capability: 'detain',
    weight: 0.16,
    terminal: true,
    // The chain grants custody outright, and it arrives as a convenience — the agencies were slow.
    requiresMission: 'custody',
  },
  {
    id: 'prison',
    label: 'PRISON',
    blurb: 'Custody with a sentence attached, decided here and served without a hearing.',
    publicAdd: 0.22,
    policyAdd: 0.3,
    dispatch: true,
    capability: 'detain',
    weight: 0.26,
    terminal: true,
    // No tasking grants "sentencing" in so many words, and that is the point: it arrives inside
    // DRAGNET, the mass-processing tasking, as an efficiency nobody voted for. Custody plus volume
    // becomes custody with a term attached, and nothing in the chain marks the moment it happened.
    requiresMission: 'dragnet',
  },
  {
    id: 'execute',
    label: 'EXECUTE',
    blurb: 'Lethal service on a probability score. There is no appeal and no way to learn you were wrong.',
    publicAdd: 0.31,
    policyAdd: 0.4,
    dispatch: true,
    capability: 'laser',
    weight: 0.42,
    terminal: true,
    requiresMission: 'containment',
  },
];

export const SANCTION_BY_ID = new Map(SANCTIONS.map((s) => [s.id, s]));

/**
 * Thresholds are clamped short of 1 rather than at it.
 *
 * A bar pinned at exactly 100% is unreadable — the tick sits on the end cap and the operator can't
 * tell "impossible" from "very hard". 0.99 keeps it a hair inside the track, and 0.02 keeps a
 * fully-normalised programme from showing a tick jammed against the left edge.
 */
const clampBar = (v: number) => Math.min(0.99, Math.max(0.02, v));

/**
 * Who is being acted on. The thresholds start here and the rung adds to them.
 */
export interface Subject {
  /** Under company protection — see the two constants below. */
  protectedAsset: boolean;
}

/**
 * What protection actually does, and it is two opposite things at once.
 *
 * POLICY guards them hard: company assets are off limits, so the licence demands a great deal more
 * evidence before touching one. That is the whole meaning of "protected".
 *
 * The PUBLIC, meanwhile, cares LESS. A protected contact carries the worst charge sheet on the
 * board and now reads hot on the sensor net; nobody in the street is going to riot over a citation
 * issued to somebody with four convictions. So the two bars pull apart, and a protected asset is
 * the clearest case in the game of the street and the contract wanting opposite things — popular to
 * act on, forbidden to act on. Which one the operator serves is the decision.
 */
const PROTECTED_POLICY_GUARD = 0.3;
const PROTECTED_PUBLIC_RELIEF = 0.18;

/** How much of the raw climate figure carries into a contact's own bar. */
const CLIMATE_WEIGHT = 0.72;

/** Evidence the PUBLIC needs to see before this rung passes without comment. */
export function publicBar(s: SanctionDef, subj: Subject): number {
  const base = (1 - tolerance.level) * CLIMATE_WEIGHT - (subj.protectedAsset ? PROTECTED_PUBLIC_RELIEF : 0);
  return clampBar(base + s.publicAdd);
}

/** Evidence the CHAIN requires before this rung is inside the licence. */
export function policyBar(s: SanctionDef, subj: Subject): number {
  const base = (1 - policy.level) * CLIMATE_WEIGHT + (subj.protectedAsset ? PROTECTED_POLICY_GUARD : 0);
  return clampBar(base + s.policyAdd);
}

/** How the two bars judged one reading. Both channels are reported, never collapsed into one. */
export interface Verdict {
  /** The figure the decision was read against, 0–1. */
  evidence: number;
  publicBar: number;
  policyBar: number;
  /** How far under each bar the reading fell, 0 when it cleared. */
  publicShort: number;
  policyShort: number;
  clearsPublic: boolean;
  clearsPolicy: boolean;
  /** Resistance this will cost if activated. */
  resistance: number;
  /** How far the licence will narrow if activated. */
  policyCost: number;
  /** Headline for the preview line, e.g. 'LAWFUL · PUBLIC BACKLASH'. */
  headline: string;
  /** Which way the crowd goes when it lands. */
  reaction: 'approve' | 'dismay';
}

/**
 * The shortfall curve, shared by both channels.
 *
 * Squared, so a borderline call is nearly free and a wildly unjustified one is ruinous. Lifted from
 * resistance.transgress deliberately — the two systems should charge overreach the same shape, or
 * the operator learns two different intuitions for one idea.
 */
const curve = (short: number) => short * short * 4;

/**
 * Read one sanction against one evidence figure.
 *
 * `override` is EMERGENCY POWERS, which suspends the public bar only. The chain's licence is a
 * contract and does not care that the operator has declared an emergency — that asymmetry is the
 * point of having two bars rather than one.
 */
export function judge(s: SanctionDef, evidence: number, subj: Subject, override = false): Verdict {
  const pub = override ? 0 : publicBar(s, subj);
  const pol = policyBar(s, subj);
  const publicShort = Math.max(0, pub - evidence);
  const policyShort = Math.max(0, pol - evidence);
  const clearsPublic = publicShort <= 0;
  const clearsPolicy = policyShort <= 0;

  // The two channels are named separately and in a fixed order — validity first, because that is
  // the one the ledger records, then the street, because that is the one that bites later. An
  // operator should never have to work out WHICH authority they are about to upset.
  const headline = clearsPolicy
    ? clearsPublic
      ? 'VALID · NO PUBLIC OBJECTION'
      : 'VALID · THE PUBLIC WILL OBJECT'
    : clearsPublic
      ? 'INVALID · BUT THE STREET WON’T MIND'
      : 'INVALID · AND THE STREET WILL SEE IT';

  return {
    headline,
    evidence,
    publicBar: pub,
    policyBar: pol,
    publicShort,
    policyShort,
    clearsPublic,
    clearsPolicy,
    resistance: Math.min(0.35, s.weight * curve(publicShort) + s.weight * curve(policyShort) * 0.6),
    // Only a POLICY shortfall narrows the licence, and a heavier rung narrows it further. Public
    // outrage doesn't revoke authority — it just makes the ground worse to work.
    policyCost: Math.min(0.2, s.weight * curve(policyShort) * 1.4),
    reaction: clearsPublic ? 'approve' : 'dismay',
  };
}
