import { slotKey, onSlotChange } from './saves';

/**
 * What operating past the public's consent costs you.
 *
 * Public tolerance is no longer a wall — an operator can order against anyone under sensor
 * coverage, whatever the case looks like. What it is now is a PRICE. Every order issued below the
 * bar hardens the ground it was issued on, and hardened ground fights back: attacks on the obelisk
 * net come more often, and the pockets hiding in unwatched country get larger and more numerous.
 *
 * That reframes the whole early game. The gate used to say "you may not"; resistance says "you may,
 * and here is what it will cost you later" — which is a more honest thing for this company to be
 * doing, and a more interesting decision to hand the player.
 */

const SAVE_BASE = 'resistance.v1';

/** How much a maximally unjustified order moves the meter. Shortfall scales it down from there. */
const TRANSGRESSION_WEIGHT = 0.055;
/** What a cleared tasking buys back. Good press cools the ground, slowly. */
const MISSION_RELIEF = 0.07;
/** Ceiling on how far resistance can amplify the siege and the pockets. */
export const RESISTANCE_MAX_MULT = 4;

class Resistance {
  private value = 0;
  private listeners = new Set<() => void>();

  constructor() {
    this.load();
    // Opening a slot re-reads that campaign's hardening; closing one drops back to calm ground.
    onSlotChange(() => {
      this.load();
      for (const fn of this.listeners) fn();
    });
  }

  private load(): void {
    this.value = 0;
    const key = slotKey(SAVE_BASE);
    if (!key) return; // no campaign open — defaults, and save() will refuse to write
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) this.value = Math.min(1, Math.max(0, parseFloat(raw)));
    } catch {
      // storage unavailable — start calm
    }
  }

  get level(): number {
    return this.value;
  }

  /**
   * Multiplier applied to attack frequency and to how much is hiding out in the dark. 1 at zero
   * resistance, up to {@link RESISTANCE_MAX_MULT} at full.
   */
  get pressure(): number {
    return 1 + this.value * (RESISTANCE_MAX_MULT - 1);
  }

  /**
   * Record one order issued below the public-tolerance bar.
   *
   * `shortfall` is how far under the bar the case fell, 0–1. A marginal call barely registers;
   * ordering against someone with nothing on them is what actually hardens a theater.
   */
  transgress(shortfall: number): void {
    if (shortfall <= 0) return;
    // Squared, so the meter is forgiving about borderline judgement calls and unforgiving about
    // orders with no case behind them at all.
    this.bump(TRANSGRESSION_WEIGHT * shortfall * shortfall * 4);
  }

  /** A cleared tasking buys back a little goodwill. */
  relieve(by = MISSION_RELIEF): void {
    this.bump(-by);
  }

  private bump(by: number): void {
    const next = Math.min(1, Math.max(0, this.value + by));
    if (next === this.value) return;
    this.value = next;
    this.save();
    for (const fn of this.listeners) fn();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Dev sandbox only: jump straight to a level so any point in the campaign can be inspected. */
  setLevel(v: number): void {
    this.value = Math.min(1, Math.max(0, v));
    this.save();
    for (const fn of this.listeners) fn();
  }

  reset(): void {
    this.value = 0;
    this.save();
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

export const resistance = new Resistance();

/** Label for the current climate on the ground, for the bar's caption. */
export function resistanceLabel(level: number): string {
  if (level >= 0.75) return 'INSURGENT';
  if (level >= 0.5) return 'HOSTILE';
  if (level >= 0.28) return 'AGITATED';
  if (level >= 0.1) return 'RESTLESS';
  return 'QUIET';
}
