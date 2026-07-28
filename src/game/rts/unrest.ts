/**
 * What a data center does to the neighbourhood it is standing in.
 *
 * A DATA CENTER is the most nakedly invasive thing the company plants. An obelisk at least looks
 * like street furniture and catches people running red lights; a data center is a windowless shed
 * full of everything the obelisks saw, and the public works out what it is. So it makes them angry —
 * automatically, continuously, for as long as it stands, and visibly, in a ring around itself.
 *
 * The cost is deliberately NOT a build restriction. Data centers are how you raise your supply cap,
 * which means they are how you field an army at all; gating them would just be a longer opening. The
 * cost is that MILLSTONE COMES FASTER. Every point of unrest shortens the wave clock, so the choice
 * reads as: a bigger army, arriving into a harder fight. That is a decision. "You may not build a
 * fourth data center" is not.
 *
 * One number, so the whole feel is tunable in one place, and nothing here knows about Cesium.
 */

export const UNREST = {
  /**
   * Unrest added per second, per standing data center. At one center the ground reaches boiling in
   * a little over six minutes; at three, in about two. Linear rather than sublinear on purpose —
   * the fourth shed should feel as provocative as the first, because to the people living beside it
   * it is.
   */
  PER_CENTER_S: 0.0026,
  /** Unrest bled off per second when not a single one is standing. Slower than it accrues: the
   *  neighbourhood remembers the shed for longer than it took to notice it. */
  DECAY_S: 0.0012,
  /**
   * How much faster Millstone's wave clock runs at maximum unrest. At 1.8 the 85-second gap between
   * waves closes to about 47.
   */
  MAX_WAVE_SPEEDUP: 1.8,
  /** How far the visible anger spreads around one data center, metres. */
  RING_M: 900,
};

/** Advance unrest for a frame. Pure: the caller owns where the number lives. */
export function stepUnrest(current: number, dataCenters: number, dt: number): number {
  const d = dataCenters > 0 ? UNREST.PER_CENTER_S * dataCenters * dt : -UNREST.DECAY_S * dt;
  return Math.min(1, Math.max(0, current + d));
}

/** Multiplier on how fast Millstone's clock runs. 1 on calm ground. */
export function unrestPressure(level: number): number {
  return 1 + level * (UNREST.MAX_WAVE_SPEEDUP - 1);
}

/** How the HUD says it. Five bands, so a change in the number is a change in the word. */
export function unrestLabel(level: number): string {
  if (level < 0.05) return 'CALM';
  if (level < 0.3) return 'UNEASY';
  if (level < 0.55) return 'ANGRY';
  if (level < 0.8) return 'HOSTILE';
  return 'RIOTOUS';
}
