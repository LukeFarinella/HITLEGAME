import { slotKey, onSlotChange } from './saves';

/**
 * What the CHAIN will sign off on — the second of the two bars every decision is read against.
 *
 * Public tolerance (game/tolerance.ts) is what the street will put up with. This is a different
 * question with a different answer: what the contract, the agencies and the lawyers have actually
 * authorized GORGON to do, and on how thin a case.
 *
 * They are deliberately allowed to disagree, because the disagreement is where the interesting
 * decisions live. Early on the public will forgive far more than the chain has licensed — nobody
 * minds a citation, and nobody has signed the paper that lets a contractor issue one. Late on it
 * inverts: the chain has granted lethal authority and the street has not agreed to be shot at.
 *
 * Like tolerance, this is a PRICE and never a wall. Acting outside policy is always permitted and
 * always costs: it hardens the ground the same way, and — unlike a public shortfall — it makes the
 * chain itself tighten, which is the one feedback loop in the game that can take a power away again.
 */

/** Where the campaign opens: a contract that licenses almost nothing. */
export const POLICY_START = 0.2;

/**
 * Where clearing a tasking that grants an authorization puts the dial, at minimum.
 *
 * Granting custody or lethal authority is a step change in what has been signed, not a nudge, so the
 * grant sets a floor rather than adding to the running total. The floors are placed just under the
 * rung they unlock so the newly-granted power reads as *barely* licensed on a strong case and
 * plainly outside policy on a weak one.
 */
export const AUTH_FLOOR: Record<string, number> = { detain: 0.46, execute: 0.72 };

const SAVE_BASE = 'policy.v1';

class PolicyLatitude {
  /** 0 = nothing is authorized, 1 = the chain no longer asks. */
  private value = POLICY_START;
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
    onSlotChange(() => {
      this.load();
      for (const fn of this.listeners) fn();
    });
  }

  private load(): void {
    this.value = POLICY_START;
    const key = slotKey(SAVE_BASE);
    if (!key) return;
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) this.value = Math.min(1, Math.max(0, parseFloat(raw)));
    } catch {
      // storage unavailable — open at the campaign default
    }
  }

  get level(): number {
    return this.value;
  }

  /** Clearing a tasking widens the licence a little. */
  advance(by: number): void {
    if (by <= 0) return;
    this.value = Math.min(1, this.value + by);
    this.save();
    this.changed();
  }

  /** A granted authorization sets a floor. Never lowers the dial. */
  raiseTo(v: number): void {
    if (v <= this.value) return;
    this.value = Math.min(1, v);
    this.save();
    this.changed();
  }

  /**
   * Acting outside policy makes the chain nervous.
   *
   * The counterweight to `advance`, and the reason a policy shortfall reads differently to a public
   * one: overreach doesn't just cost resistance, it narrows what you are allowed to do next. An
   * operator who executes their way through a campaign will find the licence closing behind them.
   */
  tighten(by: number): void {
    if (by <= 0) return;
    this.value = Math.max(0, this.value - by);
    this.save();
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Dev sandbox only. */
  setLevel(v: number): void {
    this.value = Math.min(1, Math.max(0, v));
    this.save();
    this.changed();
  }

  reset(): void {
    this.value = POLICY_START;
    this.save();
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  private save(): void {
    const key = slotKey(SAVE_BASE);
    if (!key) return;
    try {
      localStorage.setItem(key, String(this.value));
    } catch {
      // not fatal
    }
  }
}

export const policy = new PolicyLatitude();

/** Label for the current licence, for the card's caption. */
export function policyLabel(level: number): string {
  if (level >= 0.9) return 'UNCONDITIONAL';
  if (level >= 0.72) return 'BROAD';
  if (level >= 0.46) return 'CONDITIONAL';
  if (level >= 0.3) return 'NARROW';
  return 'PROBATIONARY';
}
