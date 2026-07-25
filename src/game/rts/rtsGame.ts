/**
 * The RTS match — a self-contained skirmish that reuses the theater scene but runs StarCraft-shaped
 * rules instead of the surveillance campaign.
 *
 * This module owns only the MATCH STATE: the money economy and (as the mode grows) structures, tech
 * and the enemy. It deliberately knows nothing about Cesium or the scene — the scene reads it each
 * frame and renders from it, exactly the way it reads {@link ../progression Progression}. Keeping it
 * a plain state object is what lets the RTS mode be purely additive: the campaign singletons are
 * untouched, and an RTS match is just a different object the scene happens to be driving.
 *
 * Design note — the Nexus. The starting obelisk is the Nexus (the main base, in StarCraft terms).
 * Losing it loses the match; razing the enemy's Nexus wins it. Every other obelisk is an economy
 * expansion the player builds at a predetermined site and rebuilds if it falls.
 */

/** Economy tuning. One place, so the whole balance of the opening is a handful of readable numbers. */
export const RTS_ECON = {
  /** What a fresh match opens with — enough to think about a first building, not to skip the opening. */
  START_MONEY: 500,
  /**
   * Money a single obelisk trickles in per second, just for standing. The passive floor of the
   * economy; traffic-incident bonuses (later phases) ride on top of it.
   */
  INCOME_PER_OBELISK_S: 8,
  /**
   * How much banked money ONE obelisk supports before it stops trickling. The cap scales with the
   * obelisk count, so an idle economy fills up and stalls — the pressure to expand and spend is the
   * cap, not a depleting resource. Take more ground (more obelisks) and both the rate and the
   * ceiling rise together.
   */
  CAP_PER_OBELISK: 1500,
};

export type RtsListener = () => void;

export class RtsGame {
  private _money = RTS_ECON.START_MONEY;
  /**
   * Global obelisk index of the Nexus. The scene resolves this from Washington's downtown site and
   * hands it in; the match reads it to know which site's loss ends the game.
   */
  readonly nexusIndex: number;
  private listeners = new Set<RtsListener>();

  constructor(nexusIndex: number) {
    this.nexusIndex = nexusIndex;
  }

  /** Banked money, floored — fractional accrual is real but never shown as a fraction. */
  get money(): number {
    return Math.floor(this._money);
  }

  /** The banked ceiling at the current obelisk count. Shown next to money so the cap is legible. */
  cap(obeliskCount: number): number {
    return Math.max(1, obeliskCount) * RTS_ECON.CAP_PER_OBELISK;
  }

  onChange(fn: RtsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  /**
   * Advance the economy. Called every frame from the scene with the live obelisk count.
   *
   * Each obelisk contributes {@link RTS_ECON.INCOME_PER_OBELISK_S} per second until the bank reaches
   * the scaled cap, then it stalls. Kept idempotent-ish: at the cap this is a cheap no-op.
   */
  tick(dt: number, obeliskCount: number): void {
    const cap = this.cap(obeliskCount);
    if (this._money >= cap) return;
    this._money = Math.min(cap, this._money + obeliskCount * RTS_ECON.INCOME_PER_OBELISK_S * dt);
    this.changed();
  }

  /** Spend money if it's there. Refuses rather than going negative — the caller checks the return. */
  spend(amount: number): boolean {
    if (amount <= 0 || this._money < amount) return false;
    this._money -= amount;
    this.changed();
    return true;
  }

  /** A direct credit — a collected traffic bounty, a bonus. */
  award(amount: number): void {
    if (amount <= 0) return;
    this._money += amount;
    this.changed();
  }
}
